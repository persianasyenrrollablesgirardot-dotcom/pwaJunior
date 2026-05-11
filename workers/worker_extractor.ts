/**
 * Worker Extractor (L1.5).
 *
 * Polling cada 10s sobre `mensajes` con texto NO procesado todavía.
 * Aplica el extractor regex y, por cada mensaje con extracciones, inserta UN evento_pg
 * con tipo='dato_extraido' y payload={extracciones:[...]}.
 *
 * Idempotencia: marca `mensajes.metadata.extractor_done=true` cuando termina.
 *
 * Costo: $0 (sin LLM).
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { extraer } from '../agentes/extractor/extractor.js';

const SUPABASE_URL = process.env.VITE_SUPABASE_URL!;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_KEY) { console.error('Faltan vars .env'); process.exit(1); }

const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const POLL_INTERVAL_MS  = 10_000;
const POLL_BATCH_SIZE   = 200;
const STATS_INTERVAL_MS = 60_000;

const stats = { ciclos: 0, mensajes: 0, extracciones: 0, eventos_creados: 0, fallidos: 0 };

const ARGS = process.argv.slice(2);
const ONCE_MODE = ARGS.includes('--once');

process.on('uncaughtException', (e) => console.error('[EXTRACTOR] uncaughtException:', e));
process.on('unhandledRejection', (r) => console.error('[EXTRACTOR] unhandledRejection:', r));

let cicloEnCurso = false;

async function ciclo(): Promise<number> {
  if (cicloEnCurso) return 0;
  cicloEnCurso = true;
  const t0 = Date.now();

  try {
    // Tomar mensajes con texto cuyo metadata NO tenga extractor_done=true.
    // Solo de chats procesados (ia_historico_procesado=true) — cero costo igual,
    // pero respeta política IA: no procesamos chats que el humano no autorizó
    const { data: msgs, error } = await sb
      .from('mensajes')
      .select(`id, canal_msg_id, texto, chat_id, metadata, persona_autor_id,
               chats!inner(id, ia_historico_procesado, proyecto_id, ambito)`)
      .not('texto', 'is', null)
      .not('texto', 'eq', '')
      .is('deleted_at', null)
      .filter('chats.ia_historico_procesado', 'eq', true)
      .or('metadata->>extractor_done.is.null,metadata->>extractor_done.eq.false')
      .limit(POLL_BATCH_SIZE);

    if (error) {
      console.error('[EXTRACTOR] poll error:', error.message);
      return 0;
    }
    if (!msgs || msgs.length === 0) {
      stats.ciclos++;
      return 0;
    }

    let conExtracciones = 0;
    let totalEx = 0;

    for (const m of msgs) {
      const exts = extraer(m.texto, m.canal_msg_id);
      const meta = { ...(m.metadata ?? {}), extractor_done: true };

      // Si hay extracciones, crear evento_pg
      if (exts.length > 0) {
        conExtracciones++;
        totalEx += exts.length;
        const chat: any = (m as any).chats;
        const ambito = chat?.ambito ?? 'comercial';
        const proyecto_id = chat?.proyecto_id ?? null;

        const { error: eErr } = await sb.from('evento_pg').insert({
          canal: 'interno',
          ambito,
          tipo_evento: 'dato_extraido',
          estado: 'PROCESADO',
          chat_id: m.chat_id,
          persona_id: m.persona_autor_id ?? null,
          proyecto_id,
          agente_origen: 'EXTRACTOR',
          confianza: 'INFERIDO',
          costo_usd: 0,
          payload: {
            preview: exts.length + ' extracciones de regex',
            extracciones: exts.map(e => ({
              tipo: e.tipo, valor: e.valor, valor_raw: e.valor_raw,
              confianza: e.confianza, meta: e.meta,
            })),
            mensaje_id: m.id,
          },
          evidencia_ids: { msg_ids: [m.canal_msg_id] },
          ts_canal: new Date().toISOString(),
        });
        if (eErr) {
          console.error(`[EXTRACTOR] insert evento_pg msg ${m.id}: ${eErr.message}`);
          stats.fallidos++;
          continue;
        }
        stats.eventos_creados++;
      }

      // Marcar mensaje como procesado por extractor (con o sin extracciones)
      const { error: uErr } = await sb.from('mensajes').update({ metadata: meta }).eq('id', m.id);
      if (uErr) {
        console.error(`[EXTRACTOR] update meta msg ${m.id}: ${uErr.message}`);
        stats.fallidos++;
      }
    }

    stats.mensajes += msgs.length;
    stats.extracciones += totalEx;
    stats.ciclos++;
    const dt = Date.now() - t0;
    console.log(`[EXTRACTOR] ciclo ${stats.ciclos}: ${msgs.length} msgs (${conExtracciones} con extracciones, ${totalEx} datos) en ${dt}ms`);
    return msgs.length;
  } finally {
    cicloEnCurso = false;
  }
}

async function main() {
  console.log(`[EXTRACTOR] iniciando (polling ${POLL_INTERVAL_MS}ms, batch ${POLL_BATCH_SIZE})`);

  // Drenar todo lo pendiente al arrancar
  let pendientes = POLL_BATCH_SIZE;
  while (pendientes >= POLL_BATCH_SIZE) {
    pendientes = await ciclo().catch(() => 0);
  }

  if (ONCE_MODE) {
    console.log(`[EXTRACTOR] --once: stats=${JSON.stringify(stats)}`);
    process.exit(0);
  }

  setInterval(() => { ciclo().catch(() => {}); }, POLL_INTERVAL_MS);
  setInterval(() => console.log(`[EXTRACTOR] stats: ${JSON.stringify(stats)}`), STATS_INTERVAL_MS);

  process.on('SIGINT', () => process.exit(0));
}

main().catch(e => { console.error('[EXTRACTOR] fatal:', e); });
