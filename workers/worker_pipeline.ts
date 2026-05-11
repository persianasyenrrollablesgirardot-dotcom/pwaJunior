/**
 * Worker pipeline — orquestador del flujo L1 (Identidad).
 *
 * Modelo v2 (2026-05-08): polling como carril principal, Realtime como aceleración.
 * Razón: probado en F1.14.1 que Realtime de Supabase cae cada ~30s y la velocidad
 * del worker degrada con tiempo (1.3 evt/s → 0.55 evt/s tras 90s).
 *
 * Carril 1 — Polling cada 5s (FUERTE):
 *   - SELECT * FROM evento_pg WHERE estado=NUEVO ORDER BY prioridad,ts LIMIT 100
 *   - Procesa los 100 eventos en lotes paralelos por chat (10 chats × 10 eventos = 100)
 *   - Funciona incluso si Realtime está apagado
 *
 * Carril 2 — Realtime (ACELERACIÓN, opcional):
 *   - Si está vivo: dispara polling inmediato cuando llega INSERT
 *   - Si cae: el polling de 5s lo cubre, no perdemos eventos
 *
 * Concurrencia:
 *   - Eventos del mismo chat se procesan SECUENCIALES (anti-race condition de identidad)
 *   - Eventos de chats DIFERENTES se procesan en PARALELO (10 chats max)
 *
 * Uso:
 *   npm run worker:pipeline           # corre indefinido
 *   npm run worker:pipeline:once      # un solo ciclo (debug)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { IdentidadService } from '../identidad/matcher.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Falta VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 10 } },
});

const identidad = new IdentidadService(sb);

const ARGS = process.argv.slice(2);
const ONCE_MODE = ARGS.includes('--once');

// Configuración del polling (conservador para evitar saturar Supabase)
const POLL_INTERVAL_MS  = 5_000;   // cada 5s
const POLL_BATCH_SIZE   = 20;      // máx 20 eventos por ciclo
const PARALLEL_CHATS    = 3;       // 3 chats en paralelo (eventos del mismo chat son seriales)
const STATS_INTERVAL_MS = 30_000;
const QUERY_TIMEOUT_MS  = 10_000;  // timeout duro a queries Supabase para no quedar colgado

const stats = { resueltos: 0, fallidos: 0, ambiguos: 0, ciclos: 0, ultimoCiclo_ms: 0 };

// ─── Robustez global ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[PIPELINE] ⚠ uncaughtException:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[PIPELINE] ⚠ unhandledRejection:', reason);
});

// ─── Helper: timeout duro para promesas que pueden colgar ────────────────
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${label} ${ms}ms`)), ms)),
  ]);
}

// ─── Procesar 1 evento ────────────────────────────────────────────────────
async function procesarEvento(evt: any): Promise<void> {
  try {
    if (evt.estado !== 'NUEVO') return;
    const r = await withTimeout(identidad.resolverEvento(evt), QUERY_TIMEOUT_MS, `resolverEvento(${evt.id})`);
    if (r === null) {
      const updRes = await withTimeout(
        Promise.resolve(sb.from('evento_pg').update({ estado: 'AMBIGUO' }).eq('id', evt.id)),
        QUERY_TIMEOUT_MS, `update AMBIGUO(${evt.id})`
      );
      if (updRes.error) console.error(`[PIPELINE] update AMBIGUO(${evt.id}) falló: ${updRes.error.message}`);
      stats.ambiguos++;
      return;
    }
    await withTimeout(identidad.aplicarResolucion(evt.id, r), QUERY_TIMEOUT_MS, `aplicar(${evt.id})`);
    stats.resueltos++;
  } catch (e: any) {
    stats.fallidos++;
    console.error(`[PIPELINE] evento ${evt.id} ERROR: ${e.message}`);
    // F1.22 fix C2: NO silenciar el error del UPDATE — si falla, el evento queda en NUEVO
    // y el polling lo reprocesa eternamente quemando IA. Loguear y dejar que se vea.
    const errRes = await sb.from('evento_pg').update({ estado: 'ERROR' }).eq('id', evt.id);
    if (errRes.error) console.error(`[PIPELINE] update ERROR(${evt.id}) falló: ${errRes.error.message}`);
  }
}

// ─── 1 ciclo de polling: agarra batch y procesa con paralelismo controlado ─
let cicloEnCurso = false;

async function cicloPolling(): Promise<number> {
  if (cicloEnCurso) return 0;  // evitar overlapping si el anterior aún corre
  cicloEnCurso = true;
  const t0 = Date.now();

  try {
    const { data, error } = await withTimeout(
      Promise.resolve(sb.from('evento_pg')
        .select('*')
        .eq('estado', 'NUEVO')
        .is('deleted_at', null)
        .order('prioridad', { ascending: true })
        .order('ts_creado', { ascending: true })
        .limit(POLL_BATCH_SIZE)),
      QUERY_TIMEOUT_MS,
      'poll SELECT NUEVO',
    );

    if (error) {
      console.error('[PIPELINE] poll error:', error.message);
      return 0;
    }
    if (!data || data.length === 0) {
      console.log(`[PIPELINE] ciclo ${stats.ciclos + 1}: 0 eventos (BD vacía de NUEVO)`);
      stats.ciclos++;
      return 0;
    }

    // Agrupar por chat_id (eventos del mismo chat = secuenciales para anti-race condition)
    const grupos = new Map<string, any[]>();
    for (const evt of data) {
      const key = String(evt.chat_id ?? `solo-${evt.id}`);
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key)!.push(evt);
    }

    // Procesar grupos en lotes de PARALLEL_CHATS
    const claves = [...grupos.keys()];
    for (let i = 0; i < claves.length; i += PARALLEL_CHATS) {
      const lote = claves.slice(i, i + PARALLEL_CHATS);
      await Promise.all(lote.map(async (chatKey) => {
        const eventos = grupos.get(chatKey)!;
        // Eventos del mismo chat: SECUENCIALES (porque Identidad lee/escribe persona+proyecto compartido)
        for (const evt of eventos) await procesarEvento(evt);
      }));
    }

    const dt = Date.now() - t0;
    stats.ciclos++;
    stats.ultimoCiclo_ms = dt;
    console.log(`[PIPELINE] ciclo ${stats.ciclos}: ${data.length} eventos en ${dt}ms (${(data.length / (dt/1000)).toFixed(1)} evt/s) | total resueltos: ${stats.resueltos}`);
    return data.length;
  } finally {
    cicloEnCurso = false;
  }
}

// ─── Realtime opcional: solo despierta el polling, no procesa directo ─────
let realtimeChannel: ReturnType<typeof sb.channel> | null = null;
let realtimeAttempts = 0;
const REALTIME_MAX_BACKOFF_MS = 60_000;

async function suscribirRealtime() {
  if (realtimeChannel) await realtimeChannel.unsubscribe().catch(e => console.warn('[PIPELINE] unsubscribe falló:', e?.message));
  realtimeAttempts++;
  realtimeChannel = sb
    .channel('evento_pg-aceleracion-' + Date.now())
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'evento_pg' },
      () => {
        // No procesa directo. Solo despierta el polling de inmediato.
        cicloPolling().catch(e => console.error('[PIPELINE] ciclo Realtime falló:', e?.message));
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        if (realtimeAttempts > 1) console.log('[PIPELINE] realtime ✓ reconectado');
        realtimeAttempts = 0;
      } else if (status === 'CLOSED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        // Backoff exponencial. NO logueamos cada caída para no inundar.
        const backoff = Math.min(5_000 * realtimeAttempts, REALTIME_MAX_BACKOFF_MS);
        setTimeout(suscribirRealtime, backoff);
      }
    });
}

async function main() {
  console.log(`[PIPELINE] iniciando worker v2 (polling cada ${POLL_INTERVAL_MS}ms, batch=${POLL_BATCH_SIZE}, paralelo=${PARALLEL_CHATS}, supabase=${SUPABASE_URL!.replace(/^https:\/\//, '')})`);

  // Drenar todo lo pendiente al arrancar
  let pendientes = POLL_BATCH_SIZE;
  while (pendientes >= POLL_BATCH_SIZE) {
    pendientes = await cicloPolling().catch(() => 0);
  }

  if (ONCE_MODE) {
    console.log(`[PIPELINE] --once: stats=${JSON.stringify(stats)}`);
    process.exit(0);
  }

  // Polling fuerte cada 5s
  setInterval(() => { cicloPolling().catch(e => console.error('[PIPELINE] ciclo polling falló:', e?.message)); }, POLL_INTERVAL_MS);

  // Realtime como aceleración (opcional)
  suscribirRealtime();

  // Stats periódicos
  setInterval(() => {
    console.log(`[PIPELINE] stats: ${JSON.stringify(stats)}`);
  }, STATS_INTERVAL_MS);

  // Cierre limpio
  process.on('SIGINT', async () => {
    console.log('[PIPELINE] SIGINT → cerrando');
    if (realtimeChannel) await realtimeChannel.unsubscribe().catch(e => console.warn('[PIPELINE] unsubscribe SIGINT falló:', e?.message));
    process.exit(0);
  });
}

main().catch(e => {
  console.error('[PIPELINE] fatal en main:', e);
});
