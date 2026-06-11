/**
 * Worker pipeline v2 — orquestador unificado.
 *
 * Reemplaza:
 *   - workers/worker_pipeline.ts (resolución de identidad)
 *   - workers/worker_extractor.ts (regex sobre mensajes)
 *
 * En vez de tener dos workers, ahora hay UNO con tres ciclos:
 *
 *   Ciclo A (cada 10s) — extractor regex sobre mensajes
 *     Salida temporal hasta que A1_ENTIDADES/A1_MEDIDAS/A1_MONTOS estén implementados.
 *     Lee `mensajes` con metadata.extractor_done != true → aplica regex →
 *     inserta evento_pg(tipo_evento='dato_extraido', estado=PROCESADO).
 *
 *   Ciclo B (cada 5s) — resolución de identidad (NUEVO → IDENTIFICADO)
 *     Usa la IdentidadService legacy. Cuando A3_IDENTIDAD esté implementado,
 *     este ciclo se va a eliminar y la resolución va a pasar dentro del pipeline.
 *
 *   Ciclo C (cada 5s) — ejecución de pipelines (IDENTIFICADO → PROCESADO)
 *     Busca eventos en estado IDENTIFICADO, encuentra el pipeline aplicable
 *     por trigger_tipo_evento + condiciones, llama a ejecutarPipeline(),
 *     y marca el evento como PROCESADO.
 *
 * Flags:
 *   --once                   un solo barrido de los 3 ciclos, luego exit
 *   --agent-only=A1_MEDIDAS  solo corre ESE agente del pipeline (debug)
 *   --skip-extractor         omite Ciclo A
 *   --skip-identidad         omite Ciclo B (cuidado: ningún evento pasará a IDENTIFICADO)
 *   --skip-pipeline          omite Ciclo C
 *
 * Robustez (heredada de v1):
 *   - Timeouts duros en queries
 *   - uncaughtException/unhandledRejection no tumban el proceso
 *   - cicloEnCurso flag evita overlapping si el ciclo previo aún corre
 *   - Eventos del mismo chat se procesan SECUENCIALES (anti-race condition)
 *
 * Uso:
 *   npm run worker:v2           # corre indefinido
 *   npm run worker:v2:once      # un solo ciclo
 *   tsx workers/worker_pipeline_v2.ts --agent-only=A1_MEDIDAS --once
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { IdentidadService } from '../identidad/matcher.js';
import { extraer } from '../agentes/extractor/extractor.js';
import {
  cargarPipeline,
  pipelineAplicable,
  ejecutarPipeline,
  listarAgentesRegistrados,
  type PipelineDefinicion,
  type FaseDefinicion,
} from '../agentes/lib/pipeline.js';
import { registrarTodosLosAgentes } from '../agentes/registro_agentes.js';
import { sintetizarPersona } from '../agentes/sintesis/analistas.js';
import { analizarChecklist } from '../agentes/sintesis/checklist.js';
import { responderJunior, type NuevoCliente } from '../agentes/sintesis/junior_chat.js';
import { cascadaCierreChecklist } from '../agentes/sintesis/cascada.js';
import { cicloTarjetas } from '../agentes/sintesis/tarjeta_engine.js';
import { cicloCartera } from '../agentes/batch/cartera.js';
import { cicloPdfWorker } from '../agentes/batch/pdf_worker.js';
import { cicloMediaDescarga } from '../agentes/batch/media_downloader.js';
import { fusionarPersonas } from '../identidad/fusionar_personas.js';
import { cicloFusionPorTelefono } from '../identidad/fusion_telefono.js';

// ─── Config y env ─────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.VITE_SUPABASE_URL;
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Falta VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { params: { eventsPerSecond: 10 } },
});

// ─── Flags ────────────────────────────────────────────────────────────────
const ARGS = process.argv.slice(2);
const ONCE_MODE       = ARGS.includes('--once');
const SKIP_EXTRACTOR  = ARGS.includes('--skip-extractor');
const SKIP_IDENTIDAD  = ARGS.includes('--skip-identidad');
const SKIP_PIPELINE   = ARGS.includes('--skip-pipeline');
const AGENT_ONLY      = (ARGS.find(a => a.startsWith('--agent-only='))?.split('=')[1] ?? '').trim() || null;

// ─── Tunables ─────────────────────────────────────────────────────────────
const POLL_EXTRACTOR_MS   = 10_000;
const POLL_IDENTIDAD_MS   = 5_000;
const POLL_PIPELINE_MS    = 5_000;
const POLL_CHECKLIST_MS   = 45_000;
const BATCH_EXTRACTOR     = 200;
const BATCH_IDENTIDAD     = 20;
const BATCH_PIPELINE      = 20;
const MAX_CHECKLIST_POR_CICLO = 4;
const PARALLEL_CHATS      = 3;
// FIX bug #1 (2026-06-03): eventos del MISMO chat se procesaban 1×1 en serie →
// un backlog de 40+ mensajes tras un apagón tardaba ~1h (cada evento ~30-80s).
// Cada evento toma su propio lock por id (no compiten) y los agentes del pipeline
// escriben evento_pg con distinto agente_origen; A3 solo lee/dedup-inserta. Por
// eso se pueden procesar en grupos concurrentes acotados. Tope bajo (3) para no
// saturar DeepSeek combinado con PARALLEL_CHATS. La fase 'identidad' (A3 serial)
// sigue intacta dentro de cada evento; esto paraleliza EVENTOS, no esa fase.
const PARALLEL_EVENTOS_POR_CHAT = 3;
const STATS_INTERVAL_MS   = 30_000;
const QUERY_TIMEOUT_MS    = 10_000;
const LEASE_PIPELINE_S    = 300;

// ─── Stats ────────────────────────────────────────────────────────────────
const stats = {
  // extractor
  ex_ciclos: 0, ex_mensajes: 0, ex_extracciones: 0, ex_eventos: 0, ex_fallidos: 0,
  // identidad
  id_ciclos: 0, id_resueltos: 0, id_ambiguos: 0, id_fallidos: 0,
  // pipeline
  pi_ciclos: 0, pi_eventos: 0, pi_ok: 0, pi_skip_sin_pipe: 0, pi_fallidos: 0, pi_costo_usd: 0,
};

// ─── Robustez global ──────────────────────────────────────────────────────
process.on('uncaughtException', (err) => console.error('[V2] ⚠ uncaughtException:', err));
process.on('unhandledRejection', (r) => console.error('[V2] ⚠ unhandledRejection:', r));

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${label} ${ms}ms`)), ms)),
  ]);
}

// ─── Servicios ────────────────────────────────────────────────────────────
const identidad = new IdentidadService(sb);

/**
 * Si está activo `--agent-only=X`, devuelve un pipeline "modificado" con UNA sola
 * fase serial que contiene solo ese agente. Si X no aparece en ninguna fase del
 * pipeline original, devuelve null (significa: ese agente no aplica a este pipeline).
 */
function filtrarPipelinePorAgente(pipe: PipelineDefinicion, codigoAgente: string): PipelineDefinicion | null {
  const aparece = pipe.pasos.fases.some(f =>
    (f.agentes ?? []).includes(codigoAgente) ||
    Object.values(f.rutas ?? {}).some(lista => lista.includes(codigoAgente))
  );
  if (!aparece) return null;
  const faseUnica: FaseDefinicion = { id: `solo-${codigoAgente}`, modo: 'serial', agentes: [codigoAgente] };
  return { ...pipe, pasos: { fases: [faseUnica] } };
}

// ═══════════════════════════════════════════════════════════════════════════
// CICLO A — EXTRACTOR REGEX
// ═══════════════════════════════════════════════════════════════════════════
let extractorEnCurso = false;

async function cicloExtractor(): Promise<number> {
  if (extractorEnCurso) return 0;
  extractorEnCurso = true;
  const t0 = Date.now();
  try {
    const { data: msgs, error } = await withTimeout(
      Promise.resolve(sb.from('mensajes')
        .select(`id, canal_msg_id, texto, chat_id, metadata, persona_autor_id,
                 chats!inner(id, ia_historico_procesado, proyecto_id, ambito)`)
        .not('texto', 'is', null)
        .not('texto', 'eq', '')
        .is('deleted_at', null)
        .filter('chats.ia_historico_procesado', 'eq', true)
        .or('metadata->>extractor_done.is.null,metadata->>extractor_done.eq.false')
        .limit(BATCH_EXTRACTOR)),
      QUERY_TIMEOUT_MS, 'extractor SELECT',
    );

    if (error) { console.error('[V2/EX] poll error:', error.message); return 0; }
    if (!msgs || msgs.length === 0) { stats.ex_ciclos++; return 0; }

    let conExtracciones = 0;
    let totalEx = 0;

    for (const m of msgs) {
      const exts = extraer(m.texto, m.canal_msg_id);
      const meta = { ...((m.metadata as any) ?? {}), extractor_done: true };

      if (exts.length > 0) {
        conExtracciones++;
        totalEx += exts.length;
        const chat: any = (m as any).chats;
        const ambito = chat?.ambito ?? 'comercial';
        const proyecto_id = chat?.proyecto_id ?? null;

        const { error: eErr } = await sb.from('evento_pg').insert({
          canal: 'interno', ambito,
          tipo_evento: 'dato_extraido', estado: 'PROCESADO',
          chat_id: m.chat_id, persona_id: m.persona_autor_id ?? null, proyecto_id,
          agente_origen: 'EXTRACTOR', confianza: 'INFERIDO', costo_usd: 0,
          payload: {
            preview: exts.length + ' extracciones de regex',
            extracciones: exts.map(e => ({ tipo: e.tipo, valor: e.valor, valor_raw: e.valor_raw, confianza: e.confianza, meta: e.meta })),
            mensaje_id: m.id,
          },
          evidencia_ids: { msg_ids: [m.canal_msg_id] },
          ts_canal: new Date().toISOString(),
        });
        if (eErr) {
          console.error(`[V2/EX] insert evento_pg msg ${m.id}: ${eErr.message}`);
          stats.ex_fallidos++;
          continue;
        }
        stats.ex_eventos++;
      }

      const { error: uErr } = await sb.from('mensajes').update({ metadata: meta }).eq('id', m.id);
      if (uErr) { console.error(`[V2/EX] update meta msg ${m.id}: ${uErr.message}`); stats.ex_fallidos++; }
    }

    stats.ex_mensajes += msgs.length;
    stats.ex_extracciones += totalEx;
    stats.ex_ciclos++;
    const dt = Date.now() - t0;
    console.log(`[V2/EX] ciclo ${stats.ex_ciclos}: ${msgs.length} msgs (${conExtracciones} con datos, ${totalEx} ext) en ${dt}ms`);
    return msgs.length;
  } finally {
    extractorEnCurso = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CICLO B — IDENTIDAD (NUEVO → IDENTIFICADO)
// ═══════════════════════════════════════════════════════════════════════════
let identidadEnCurso = false;

async function procesarEventoIdentidad(evt: any): Promise<void> {
  try {
    if (evt.estado !== 'NUEVO') return;
    const r = await withTimeout(identidad.resolverEvento(evt), QUERY_TIMEOUT_MS, `resolver(${evt.id})`);
    if (r === null) {
      const u = await withTimeout(
        Promise.resolve(sb.from('evento_pg').update({ estado: 'AMBIGUO' }).eq('id', evt.id)),
        QUERY_TIMEOUT_MS, `update AMBIGUO(${evt.id})`,
      );
      if (u.error) console.error(`[V2/ID] update AMBIGUO(${evt.id}): ${u.error.message}`);
      stats.id_ambiguos++;
      return;
    }
    await withTimeout(identidad.aplicarResolucion(evt.id, r), QUERY_TIMEOUT_MS, `aplicar(${evt.id})`);
    stats.id_resueltos++;
  } catch (e: any) {
    stats.id_fallidos++;
    console.error(`[V2/ID] evento ${evt.id} ERROR: ${e.message}`);
    const errRes = await sb.from('evento_pg').update({ estado: 'ERROR' }).eq('id', evt.id);
    if (errRes.error) console.error(`[V2/ID] update ERROR(${evt.id}): ${errRes.error.message}`);
  }
}

async function cicloIdentidad(): Promise<number> {
  if (identidadEnCurso) return 0;
  identidadEnCurso = true;
  const t0 = Date.now();
  try {
    const { data, error } = await withTimeout(
      Promise.resolve(sb.from('evento_pg')
        .select('*')
        .eq('estado', 'NUEVO')
        .is('deleted_at', null)
        .order('prioridad', { ascending: true })
        .order('ts_creado', { ascending: true })
        .limit(BATCH_IDENTIDAD)),
      QUERY_TIMEOUT_MS, 'identidad SELECT',
    );

    if (error) { console.error('[V2/ID] poll error:', error.message); return 0; }
    if (!data || data.length === 0) { stats.id_ciclos++; return 0; }

    // Agrupar por chat: eventos del mismo chat = secuenciales (anti-race)
    const grupos = new Map<string, any[]>();
    for (const evt of data) {
      const key = String(evt.chat_id ?? `solo-${evt.id}`);
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key)!.push(evt);
    }
    const claves = Array.from(grupos.keys());
    for (let i = 0; i < claves.length; i += PARALLEL_CHATS) {
      const lote = claves.slice(i, i + PARALLEL_CHATS);
      await Promise.all(lote.map(async (chatKey) => {
        for (const evt of grupos.get(chatKey)!) await procesarEventoIdentidad(evt);
      }));
    }
    stats.id_ciclos++;
    const dt = Date.now() - t0;
    console.log(`[V2/ID] ciclo ${stats.id_ciclos}: ${data.length} eventos en ${dt}ms | resueltos:${stats.id_resueltos} ambiguos:${stats.id_ambiguos}`);
    return data.length;
  } finally {
    identidadEnCurso = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CICLO C — PIPELINE (IDENTIFICADO → PROCESADO)
// ═══════════════════════════════════════════════════════════════════════════
let pipelineEnCurso = false;

async function procesarEventoPipeline(evt: any): Promise<void> {
  const tag = `[V2/PI ev${evt.id}]`;
  try {
    // Buscar pipeline aplicable: trigger_tipo_evento + condiciones
    // El payload puede tener `tipo` o `tipo_canonical` (de la extensión).
    // Traducimos los valores en inglés de WA a los enums internos.
    const tipoRaw = evt.payload?.tipo ?? evt.payload?.tipo_canonical ?? null;
    const TIPO_MAP: Record<string, string> = {
      text: 'texto', texto: 'texto',
      image: 'imagen', imagen: 'imagen',
      audio: 'audio', ptt: 'audio',
      video: 'video',
      document: 'documento', pdf: 'documento', documento: 'documento',
      sticker: 'sticker',
      location: 'ubicacion', ubicacion: 'ubicacion',
      contact: 'contacto', contacto: 'contacto',
    };
    const tipoNormalizado = tipoRaw ? (TIPO_MAP[String(tipoRaw).toLowerCase()] ?? tipoRaw) : null;
    const contextoEvento: Record<string, any> = {
      ambito: evt.ambito,
      tipo_mensaje: tipoNormalizado,
    };
    const pipe = await pipelineAplicable(sb, evt.tipo_evento, contextoEvento);

    if (!pipe) {
      // Sin pipeline para este tipo: marcar PROCESADO sin enjambre + limpiar lease
      // (defensivo: si había un lease zombie de un crash previo, lo limpiamos).
      stats.pi_skip_sin_pipe++;
      const u = await sb.from('evento_pg')
        .update({
          estado: 'PROCESADO',
          ts_procesado: new Date().toISOString(),
          procesando_por: null,
          procesando_hasta: null,
        })
        .eq('id', evt.id);
      if (u.error) console.error(`${tag} update PROCESADO sin pipe: ${u.error.message}`);
      return;
    }

    // --agent-only: si está activo, restringir el pipeline a ese agente
    const pipeAUsar = AGENT_ONLY ? filtrarPipelinePorAgente(pipe, AGENT_ONLY) : pipe;
    if (!pipeAUsar) {
      // El agente requerido no participa en este pipeline → skip silencioso (debug)
      console.log(`${tag} skip — agente ${AGENT_ONLY} no aparece en pipeline ${pipe.codigo}`);
      return;
    }

    // Lock liviano sobre evento_pg para evitar doble-procesamiento entre workers
    const lockHasta = new Date(Date.now() + LEASE_PIPELINE_S * 1000).toISOString();
    const lockPor = `pipeline-v2@${process.pid}`;
    const { data: lockRow, error: lockErr } = await sb.from('evento_pg')
      .update({ procesando_por: lockPor, procesando_hasta: lockHasta })
      .eq('id', evt.id)
      .or(`procesando_hasta.is.null,procesando_hasta.lt.${new Date().toISOString()}`)
      .select('id')
      .maybeSingle();
    if (lockErr) { console.error(`${tag} lock err: ${lockErr.message}`); }
    if (!lockRow) { console.log(`${tag} ya tomado por otro worker — skip`); return; }

    const resultado = await ejecutarPipeline(sb, pipeAUsar, {
      evento_id: evt.id,
      chat_id: evt.chat_id,
      persona_id: evt.persona_id,
      proyecto_id: evt.proyecto_id,
      ambito: evt.ambito,
    });

    stats.pi_eventos++;
    stats.pi_costo_usd += resultado.costo_usd_total;
    if (resultado.ok) stats.pi_ok++; else stats.pi_fallidos++;

    // Marcar evento como procesado y liberar lock
    const u = await sb.from('evento_pg')
      .update({
        estado: 'PROCESADO',
        ts_procesado: new Date().toISOString(),
        procesando_por: null,
        procesando_hasta: null,
      })
      .eq('id', evt.id);
    if (u.error) console.error(`${tag} update PROCESADO: ${u.error.message}`);
  } catch (e: any) {
    stats.pi_fallidos++;
    console.error(`${tag} ERROR: ${e.message}`);
    await sb.from('evento_pg')
      .update({ estado: 'ERROR', procesando_por: null, procesando_hasta: null })
      .eq('id', evt.id);
  }
}

// Personas con actividad nueva, pendientes de re-síntesis. Se acumulan mientras
// el pipeline drena a full-batch y se sintetizan cuando el ciclo cierra parcial
// (cola casi vacía) — así una corrida de 50 mensajes re-sintetiza al cliente
// UNA vez al final, no una vez por batch.
const personasSintesisPendiente = new Set<number>();

// FIX bug #2 (2026-06-03) — coalescing por tiempo para frenar el sangrado de plata.
// Bajo drenaje lento/por goteo (ej. catch-up tras un apagón: pocos eventos por
// ciclo), drenarSintesis se llamaba en CADA ciclo parcial y re-sintetizaba a la
// MISMA persona una y otra vez (visto: persona 243 sintetizada ~8 veces seguidas).
// Cada síntesis reescribe modulo_sintesis con texto LLM nuevo → cicloTarjetas
// detecta "síntesis nueva" y reconstruye la tarjeta pagando narrativa otra vez.
// Con un cooldown por persona, una ráfaga la sintetiza ~1 vez por ventana: si se
// re-encola dentro del cooldown, se DIFIERE (se deja pendiente) en vez de re-correr
// los ~9 LLM. NO aplica al path manual de Jhon (cicloSintesisPendiente), que debe
// reflejar al instante una reclasificación.
const SINTESIS_COOLDOWN_MS = 90_000;
const ultimaSintesisPersona = new Map<number, number>();

async function drenarSintesis(): Promise<void> {
  if (personasSintesisPendiente.size === 0) return;
  const ahora = Date.now();
  const pendientes = [...personasSintesisPendiente];
  personasSintesisPendiente.clear();
  for (const pid of pendientes) {
    const ult = ultimaSintesisPersona.get(pid) ?? 0;
    if (ahora - ult < SINTESIS_COOLDOWN_MS) {
      // Sintetizada hace poco → diferir para coalescer la ráfaga. Vuelve a la
      // cola; el próximo ciclo con cola vacía la reintenta cuando pase el cooldown.
      personasSintesisPendiente.add(pid);
      continue;
    }
    ultimaSintesisPersona.set(pid, ahora);
    try {
      const r = await sintetizarPersona(sb, pid);
      stats.pi_costo_usd += r.costo_usd;
      console.log(`[V2/SINT] persona ${pid}: ${r.ok}/7 módulos · $${r.costo_usd.toFixed(4)}`);
    } catch (e: any) {
      console.error(`[V2/SINT] persona ${pid}: ${e.message}`);
    }
  }
}

// Re-síntesis bajo demanda: el Visor marca `personas.sintesis_pendiente` (ej.
// al reclasificar el ámbito de un contacto en el módulo Clientes). Este ciclo
// las recoge, las re-sintetiza al toque y baja el flag.
//
// GUARD ANTI-LOOP: si algo re-marca sintesis_pendiente=true después de procesar
// (visto en logs con p169 procesada 3 veces seguidas), llevamos un counter por
// persona. Si pasa >MAX_ITER_5MIN veces en 5 minutos, se la mete en lista negra
// por COOLDOWN_MS para que no queme dinero ni bloquee el ciclo.
const MAX_ITER_5MIN = 3;
const COOLDOWN_MS = 10 * 60 * 1000;
const histIter = new Map<number, number[]>();      // persona_id → timestamps de procesos recientes
const blacklist = new Map<number, number>();       // persona_id → unix ms hasta cuando está bloqueada
let sintesisPendienteEnCurso = false;
async function cicloSintesisPendiente(): Promise<void> {
  if (sintesisPendienteEnCurso) return;
  sintesisPendienteEnCurso = true;
  try {
    const { data } = await sb.from('personas')
      .select('id').eq('sintesis_pendiente', true).is('deleted_at', null).limit(10);
    const ahora = Date.now();
    for (const p of data ?? []) {
      // Check blacklist
      const bl = blacklist.get(p.id);
      if (bl && bl > ahora) {
        // Bajar el flag para que no quede stuck — la próxima vez que algo legítimo
        // la marque, ya estará fuera del cooldown.
        await sb.from('personas').update({ sintesis_pendiente: false }).eq('id', p.id);
        continue;
      }
      if (bl && bl <= ahora) blacklist.delete(p.id);

      // Contar iteraciones en últimos 5 min
      const ventana = ahora - 5 * 60 * 1000;
      const hist = (histIter.get(p.id) ?? []).filter(t => t > ventana);
      hist.push(ahora);
      histIter.set(p.id, hist);
      if (hist.length > MAX_ITER_5MIN) {
        blacklist.set(p.id, ahora + COOLDOWN_MS);
        console.error(`[V2/SINT-MANUAL] 🛑 LOOP DETECTADO persona ${p.id}: ${hist.length} iteraciones en 5min → blacklist ${COOLDOWN_MS / 60000}min`);
        await sb.from('personas').update({ sintesis_pendiente: false }).eq('id', p.id);
        continue;
      }

      try {
        const r = await sintetizarPersona(sb, p.id);
        stats.pi_costo_usd += r.costo_usd;
        console.log(`[V2/SINT-MANUAL] persona ${p.id}: ${r.ok}/7 módulos · $${r.costo_usd.toFixed(4)} (iter ${hist.length}/${MAX_ITER_5MIN})`);
      } catch (e: any) {
        console.error(`[V2/SINT-MANUAL] persona ${p.id}: ${e.message}`);
      }
      // Re-checklist de TODOS los chats de la persona — un cambio de
      // ámbito/nota/corrección puede convertir un chat de "venta" en "no_aplica"
      // (proveedor, contacto personal). El checklist tiene que reflejarlo.
      // EXCEPCIÓN: si el chat está cerrado_manual=true (Jhon lo cerró desde el
      // chat de Junior), respetamos la decisión humana y NO regeneramos.
      try {
        const { data: proys } = await sb.from('proyectos')
          .select('id').eq('persona_id', p.id).is('deleted_at', null);
        const proyIds = (proys ?? []).map(x => x.id);
        if (proyIds.length > 0) {
          const { data: chatsP } = await sb.from('chats')
            .select('id').in('proyecto_id', proyIds).is('deleted_at', null);
          const chatIds = (chatsP ?? []).map(x => x.id);
          const { data: cerrados } = chatIds.length
            ? await sb.from('chat_checklist').select('chat_id').in('chat_id', chatIds).eq('cerrado_manual', true)
            : { data: [] as { chat_id: number }[] };
          const setCerrados = new Set((cerrados ?? []).map(x => x.chat_id));
          for (const cP of chatsP ?? []) {
            if (setCerrados.has(cP.id)) continue;       // cerrado por Jhon → respetar
            try {
              const rc = await analizarChecklist(sb, cP.id);
              stats.pi_costo_usd += rc.costo_usd;
            } catch (e: any) {
              console.error(`[V2/SINT-MANUAL] chat ${cP.id} checklist: ${e.message}`);
            }
          }
        }
      } catch (e: any) {
        console.error('[V2/SINT-MANUAL] re-checklist persona ' + p.id + ':', e?.message);
      }
      // Bajar el flag siempre — aunque la síntesis falle — para no re-procesar
      // en bucle. Si hace falta reintentar, Jhon reclasifica de nuevo.
      await sb.from('personas').update({ sintesis_pendiente: false }).eq('id', p.id);
    }
  } catch (e: any) {
    console.error('[V2/SINT-MANUAL]', e?.message);
  } finally {
    sintesisPendienteEnCurso = false;
  }
}

// RED DE SEGURIDAD DURABLE contra "tarjetas en blanco".
//
// La cola de síntesis del pipeline (personasSintesisPendiente) vive en MEMORIA:
// si el worker se reinicia (apagón, crash, hot-reload de Vite) entre que el
// pipeline marca un evento PROCESADO y que drenarSintesis corre, esa persona se
// pierde para siempre — sus eventos ya están PROCESADO (el pipeline no los relee)
// y nadie pone sintesis_pendiente=true → queda sin modulo_sintesis → tarjeta en
// blanco PERMANENTE.
//
// Este ciclo es la red de seguridad que faltaba: cada pocos minutos consulta la
// RPC `personas_sintesis_desfasada` (migración 050) — personas con eventos
// PROCESADO pero CERO síntesis — y las re-encola vía sintesis_pendiente. El
// camino rápido en memoria sigue intacto; esto solo recupera las que se cayeron.
// IDEMPOTENTE: una vez sintetizadas, la RPC deja de devolverlas.
let reconciliarEnCurso = false;
async function cicloReconciliarSintesis(): Promise<void> {
  if (reconciliarEnCurso) return;
  reconciliarEnCurso = true;
  try {
    const { data, error } = await sb.rpc('personas_sintesis_desfasada');
    if (error) { console.error('[V2/RECONCILIAR] RPC:', error.message); return; }
    const ids = (data ?? []).map((r: any) => r.persona_id);
    if (ids.length === 0) return;
    const { error: upErr } = await sb.from('personas')
      .update({ sintesis_pendiente: true } as any).in('id', ids);
    if (upErr) { console.error('[V2/RECONCILIAR] update:', upErr.message); return; }
    console.log(`[V2/RECONCILIAR] ${ids.length} persona(s) huérfana(s) sin síntesis → re-encoladas: ${ids.join(',')}`);
  } catch (e: any) {
    console.error('[V2/RECONCILIAR]', e?.message);
  } finally {
    reconciliarEnCurso = false;
  }
}

// RED DE SEGURIDAD del ÁMBITO. La fuente de verdad es personas.ambito_principal.
// Editar el ámbito desde la ficha lo propaga a chats/proyectos y lo confirma (fix
// en queries.ts), PERO si se edita con una pestaña del Visor que aún corre código
// viejo, solo se actualiza la persona → el chat diverge y A2_AMBITO lo revierte.
// Este ciclo sincroniza chat.ambito ← persona y CONFIRMA los no-comerciales, así
// el ámbito queda consistente y pegado pase lo que pase. NO toca los chats que ya
// coinciden con su persona (no interfiere con la auto-clasificación de A2 sobre
// los comerciales sin confirmar).
let reconciliarAmbitoEnCurso = false;
async function cicloReconciliarAmbito(): Promise<void> {
  if (reconciliarAmbitoEnCurso) return;
  reconciliarAmbitoEnCurso = true;
  try {
    const { data: pers } = await sb.from('personas').select('id, ambito_principal').is('deleted_at', null);
    const ambDe = new Map((pers ?? []).map((p: any) => [p.id, p.ambito_principal]));
    const { data: proys } = await sb.from('proyectos').select('id, persona_id, ambito');
    const persDeProy = new Map((proys ?? []).map((p: any) => [p.id, p.persona_id]));
    const { data: chats } = await sb.from('chats').select('id, proyecto_id, ambito, ambito_confirmado').is('deleted_at', null);
    let fixChats = 0;
    for (const c of chats ?? []) {
      const pid = persDeProy.get((c as any).proyecto_id); if (!pid) continue;
      const amb = ambDe.get(pid); if (amb == null) continue;
      const patch: any = {};
      if ((c as any).ambito !== amb) patch.ambito = amb;                                   // divergencia (señal de edición manual)
      if (amb !== 'comercial' && !(c as any).ambito_confirmado) patch.ambito_confirmado = true;  // proteger no-comerciales
      if (Object.keys(patch).length) { await sb.from('chats').update(patch).eq('id', (c as any).id); fixChats++; }
    }
    let fixProy = 0;
    for (const pr of proys ?? []) {
      const amb = ambDe.get((pr as any).persona_id);
      if (amb != null && (pr as any).ambito !== amb) { await sb.from('proyectos').update({ ambito: amb }).eq('id', (pr as any).id); fixProy++; }
    }
    if (fixChats || fixProy) console.log(`[V2/RECONCILIAR-AMBITO] sincronizados ${fixChats} chat(s) + ${fixProy} proyecto(s) al ámbito de su persona`);
  } catch (e: any) {
    console.error('[V2/RECONCILIAR-AMBITO]', e?.message);
  } finally {
    reconciliarAmbitoEnCurso = false;
  }
}

async function cicloPipeline(): Promise<number> {
  if (pipelineEnCurso) return 0;
  pipelineEnCurso = true;
  const t0 = Date.now();
  try {
    // Filtramos eventos con lease vivo (procesando_hasta en el futuro): los toma
    // otro worker o son zombies de un crash. Si son zombies, expirarán y el
    // próximo poll los agarrará — no perdemos tiempo polleándolos antes.
    const ahora = new Date().toISOString();
    const { data, error } = await withTimeout(
      Promise.resolve(sb.from('evento_pg')
        .select('*')
        .eq('estado', 'IDENTIFICADO')
        .is('deleted_at', null)
        .or(`procesando_hasta.is.null,procesando_hasta.lt.${ahora}`)
        .order('prioridad', { ascending: true })
        .order('ts_creado', { ascending: true })
        .limit(BATCH_PIPELINE)),
      QUERY_TIMEOUT_MS, 'pipeline SELECT',
    );

    if (error) { console.error('[V2/PI] poll error:', error.message); return 0; }
    if (!data || data.length === 0) { stats.pi_ciclos++; await drenarSintesis(); return 0; }

    // Por chat: secuencial para evitar race condition en escrituras del mismo proyecto/persona
    const grupos = new Map<string, any[]>();
    for (const evt of data) {
      const key = String(evt.chat_id ?? `solo-${evt.id}`);
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key)!.push(evt);
    }
    const claves = Array.from(grupos.keys());
    for (let i = 0; i < claves.length; i += PARALLEL_CHATS) {
      const lote = claves.slice(i, i + PARALLEL_CHATS);
      await Promise.all(lote.map(async (chatKey) => {
        // Dentro del chat: grupos concurrentes acotados (no 1×1). Drena el
        // catch-up de un apagón en minutos en vez de una hora. Ver PARALLEL_EVENTOS_POR_CHAT.
        const evts = grupos.get(chatKey)!;
        for (let j = 0; j < evts.length; j += PARALLEL_EVENTOS_POR_CHAT) {
          const sub = evts.slice(j, j + PARALLEL_EVENTOS_POR_CHAT);
          await Promise.all(sub.map(evt => procesarEventoPipeline(evt)));
        }
      }));
    }
    stats.pi_ciclos++;
    const dt = Date.now() - t0;
    console.log(`[V2/PI] ciclo ${stats.pi_ciclos}: ${data.length} eventos en ${dt}ms | ok:${stats.pi_ok} sin-pipe:${stats.pi_skip_sin_pipe} fail:${stats.pi_fallidos} $${stats.pi_costo_usd.toFixed(4)}`);
    for (const evt of data) if (evt.persona_id) personasSintesisPendiente.add(evt.persona_id);
    if (data.length < BATCH_PIPELINE) await drenarSintesis();
    return data.length;
  } finally {
    pipelineEnCurso = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHAT DE JUNIOR
// ═══════════════════════════════════════════════════════════════════════════
// Jhon escribe en junior_chat (rol='usuario', estado='pendiente'). Este ciclo
// los toma, arma el contexto con las síntesis de todos los clientes, deja que
// Junior responda, e inserta la respuesta (rol='junior').
/** Normaliza un teléfono dictado a formato E.164 colombiano. */
function normalizarTelefono(t: string | null): string | null {
  if (!t) return null;
  const limpio = t.replace(/[^\d+]/g, '');
  if (!limpio) return null;
  if (limpio.startsWith('+')) return limpio;
  const d = limpio.replace(/\D/g, '');
  if (d.length === 10) return '+57' + d;                        // celular colombiano
  if (d.startsWith('57') && d.length === 12) return '+' + d;
  return d ? '+' + d : null;
}

/** Normaliza texto para comparar duplicados conceptuales (memorias, tareas,
 * agendamientos). Lowercase, sin tildes, sin puntuación, sin filler común,
 * espacios colapsados. Mismo patrón usado en analistas.ts poblarTareas. */
function normalizarTexto(s: string): string {
  return (s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s]/g, ' ')
    .replace(/\b(el|la|los|las|de|del|al|a|en|para|por|un|una|con|que|mi|mis|tu|tus|su|sus|lo|le|les)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** Crea una persona de origen manual (cliente del local / otro medio) + su proyecto.
 *
 * ANTI-DUPLICADO por teléfono: si llega un teléfono normalizado E.164 que ya
 * existe en personas, devuelve el id existente y NO crea uno nuevo. Detectado
 * en stress test 2026-05-26: "Patricia" se creó 4 veces porque Junior emitió
 * nuevosClientes en 4 mensajes consecutivos con el mismo teléfono.
 *
 * Si NO viene teléfono, no se puede dedupear (un nombre suelto puede ser otra
 * persona). En ese caso se crea igual y queda como riesgo conocido.
 */
async function crearPersonaManual(nc: NuevoCliente): Promise<number | null> {
  const telE164 = normalizarTelefono(nc.telefono);
  if (telE164) {
    const { data: existente } = await sb.from('personas')
      .select('id, nombre').eq('telefono_e164', telE164).is('deleted_at', null).maybeSingle();
    if (existente) {
      console.log(`[V2/JUNIOR] persona con tel ${telE164} ya existe como p${existente.id} "${existente.nombre}" — reuso, NO duplico`);
      return existente.id;
    }
  }
  const { data: persona, error } = await sb.from('personas').insert({
    nombre: nc.nombre,
    telefono_e164: telE164,
    ciudad: nc.ciudad,
    ambito_principal: 'comercial',
    origen: 'manual',
  } as any).select('id').single();
  if (error || !persona) {
    console.error(`[V2/JUNIOR] no se pudo crear persona manual "${nc.nombre}": ${error?.message}`);
    return null;
  }
  await sb.from('proyectos').insert({
    persona_id: persona.id, ambito: 'comercial',
    nombre: 'Cliente registrado a mano', estado: 'abierto',
    origen: 'manual', prioridad: 5,
  } as any);
  return persona.id;
}

/** Deja constancia de una instrucción que Jhon dio a Junior por chat directo. */
async function registrarInstruccion(
  tipo: 'nuevo_cliente' | 'correccion' | 'memoria',
  resumen: string,
  extra: { persona_id?: number | null; modulo?: string | null; sesion_id?: number | null; mensaje_chat_id?: number | null },
): Promise<void> {
  await sb.from('junior_instrucciones').insert({
    tipo, resumen,
    persona_id: extra.persona_id ?? null,
    modulo: extra.modulo ?? null,
    sesion_id: extra.sesion_id ?? null,
    mensaje_chat_id: extra.mensaje_chat_id ?? null,
  } as any);
}

// HITO 4 — Junior viejo (monolítico) RETIRADO: lo reemplazó Junior V2
// (/api/junior-v2, que lee solo las tarjetas relevantes). Nada escribe en
// junior_chat desde la UI, así que este ciclo está dormido. Rollback: poner
// JUNIOR_VIEJO_ACTIVO = true y reiniciar el worker.
const JUNIOR_VIEJO_ACTIVO = false;
let juniorChatEnCurso = false;
async function cicloJuniorChat(): Promise<void> {
  if (!JUNIOR_VIEJO_ACTIVO) return;
  if (juniorChatEnCurso) return;
  juniorChatEnCurso = true;
  try {
    const { data: pendientes } = await sb.from('junior_chat')
      .select('id, mensaje, sesion_id')
      .eq('rol', 'usuario').eq('estado', 'pendiente')
      .order('created_at', { ascending: true });
    if (!pendientes || pendientes.length === 0) return;

    for (const msg of pendientes) {
      try {
        // Historial SOLO de la sesión activa — cada conversación es independiente.
        const { data: hist } = await sb.from('junior_chat')
          .select('rol, mensaje')
          .eq('estado', 'completo')
          .eq('sesion_id', msg.sesion_id)
          .order('created_at', { ascending: true });
        // Descartar mensajes vacíos/basura — no aportan al hilo y contaminan
        // (Junior copiaría el patrón de respuesta vacía).
        const historial = (hist ?? [])
          .filter((h: any) => h.mensaje && h.mensaje.trim().length > 0)
          .map((h: any) => ({ rol: h.rol, mensaje: h.mensaje }));

        const r = await responderJunior(sb, msg.mensaje, historial, msg.sesion_id);

        // ─── GUARD HARD anti-ráfaga destructiva ────────────────────────────
        // Cuenta PERSONAS DISTINTAS tocadas por destructivas, no acciones totales.
        // Razón: con la cascada obligatoria al cerrar checklist (un cliente puede
        // tener 8 tareas + 3 agendamientos + 1 checklist = 12 destructivas
        // legítimas), contar acciones totales bloquearía la cascada normal.
        // El patrón malo a frenar es "limpia todo" → toca 8 clientes distintos,
        // no "cerrá el caso de Walter" → toca solo a Walter aunque sean 12 ops.
        //
        // Para mapear destructivas → persona:
        //   · tareasCompletar:       cruzar tarea.id con BD para obtener persona_id
        //   · cierresChecklist:      el chat_id → persona del chat (1:1)
        //   · agendamientosCancelar: cruzar agendamiento.id con BD para obtener persona_id
        //
        // Para no agregar latencia, hacemos UN solo query por tabla cuando hay items.
        const tareasIds = (r.tareasCompletar ?? []).map(x => x.id).filter(Boolean);
        const agsIds    = (r.agendamientosCancelar ?? []).map(x => x.id).filter(Boolean);
        const chatsCC   = (r.cierresChecklist ?? []).map(x => x.chat_id).filter(Boolean);

        const personasAfectadas = new Set<number>();
        if (tareasIds.length > 0) {
          const { data: t } = await sb.from('tareas').select('persona_id').in('id', tareasIds);
          for (const x of t ?? []) if (x.persona_id) personasAfectadas.add(x.persona_id);
        }
        if (agsIds.length > 0) {
          const { data: a } = await sb.from('agendamientos').select('persona_id').in('id', agsIds);
          for (const x of a ?? []) if (x.persona_id) personasAfectadas.add(x.persona_id);
        }
        if (chatsCC.length > 0) {
          const { data: c } = await sb.from('chats').select('persona_id').in('id', chatsCC);
          for (const x of c ?? []) if (x.persona_id) personasAfectadas.add(x.persona_id);
        }

        const totalDestructivas = tareasIds.length + chatsCC.length + agsIds.length;
        if (personasAfectadas.size > 5) {
          console.warn(`[V2/JUNIOR] 🛑 GUARD ANTI-RÁFAGA msg ${msg.id}: ${personasAfectadas.size} personas distintas con destructivas (max=5, total ${totalDestructivas} ops). Rechazadas:`);
          console.warn(`  · tareasCompletar (${r.tareasCompletar.length}): ${r.tareasCompletar.map(x => '#' + x.id).join(', ')}`);
          console.warn(`  · cierresChecklist (${r.cierresChecklist.length}): ${r.cierresChecklist.map(x => 'chat' + x.chat_id).join(', ')}`);
          console.warn(`  · agendamientosCancelar (${r.agendamientosCancelar.length}): ${r.agendamientosCancelar.map(x => '#' + x.id).join(', ')}`);
          console.warn(`  · personas afectadas: ${[...personasAfectadas].join(', ')}`);
          console.warn(`  · respuesta original (queda en log, NO se muestra a Jhon): "${(r.respuesta ?? '').slice(0, 400).replace(/\s+/g, ' ')}"`);
          r.tareasCompletar = [];
          r.cierresChecklist = [];
          r.agendamientosCancelar = [];
          r.respuesta = `⚠ Bloqueé acciones destructivas sobre ${personasAfectadas.size} personas distintas en un solo turno (límite=5) y prefiero confirmar antes de romper algo. Decime específicamente con qué cliente/caso empezamos y procedo en bloques de 5 personas como máximo.`;
        }

        // Detección defensiva CORRECTORA — Junior promete acciones pero deja el array vacío.
        // El prompt ya lo prohíbe (sección OBLIGACIÓN FINAL + REGLA DE HONESTIDAD), pero si
        // el LLM miente igual, antepongo un aviso determinístico a la respuesta para que el
        // usuario NO lea la promesa falsa sin contexto. Mismo patrón que el guard anti-ráfaga.
        // Promesas detectadas:
        //   cierresChecklist     → "cerré/cierro checklist", "caso cerrado/terminado"
        //   tareasCompletar      → "marqué/completé tarea"
        //   agendamientosCancelar → "cancelé agendamiento"
        //   nuevosAgendamientos  → "agendé visita/cita/instalación"
        //   nuevasTareas         → "creé/agendé tarea"
        const resp = (r.respuesta ?? '').toLowerCase();
        const promesas: string[] = [];
        if (/cerr[ée]\s+(el\s+)?checklist|cierro\s+(el\s+)?checklist|caso\s+(cerrado|terminado)/i.test(resp) && r.cierresChecklist.length === 0)
          promesas.push('cierresChecklist');
        if (/marqu[ée]\s+(la\s+)?tarea\s+(como\s+)?(hecha|completada)|complet[ée]\s+(la\s+)?tarea/i.test(resp) && r.tareasCompletar.length === 0)
          promesas.push('tareasCompletar');
        if (/cancel[ée]\s+(el\s+)?agendamient/i.test(resp) && r.agendamientosCancelar.length === 0)
          promesas.push('agendamientosCancelar');
        if (/agend[ée]\s+(la\s+)?(visita|cita|instalaci[óo]n)/i.test(resp) && r.nuevosAgendamientos.length === 0)
          promesas.push('nuevosAgendamientos');
        if (/cre[ée]\s+(la\s+)?tarea|agend[ée]\s+(la\s+)?tarea/i.test(resp) && r.nuevasTareas.length === 0 && r.nuevosAgendamientos.length === 0)
          promesas.push('nuevasTareas');
        if (promesas.length > 0) {
          console.warn(`[V2/JUNIOR] ⚠ msg ${msg.id}: respuesta promete acción pero estos arrays vienen vacíos: ${promesas.join(', ')}`);
          console.warn(`  fragmento respuesta: "${(r.respuesta ?? '').slice(0, 200).replace(/\s+/g, ' ')}"`);
          // Aviso al usuario: la frase de abajo dice que hice X pero NO lo hice.
          // Lo antepongo en lugar de reemplazar la respuesta entera porque la frase original
          // puede contener info útil (preguntas, contexto). El usuario lee el aviso primero.
          const promesasLeg = promesas.map(p => ({
            cierresChecklist:     'cerrar checklists',
            tareasCompletar:      'completar tareas',
            agendamientosCancelar:'cancelar agendamientos',
            nuevosAgendamientos:  'agendar visitas/citas',
            nuevasTareas:         'crear tareas',
          } as Record<string,string>)[p] || p).join(', ');
          r.respuesta = `⚠ Aviso del worker: en mi respuesta de abajo dije que iba a ${promesasLeg}, pero NO emití las acciones (arrays vacíos). Probablemente me faltaron ids concretos o el caso era ambiguo. Pedímelo otra vez con los nombres/ids o un "/listar" y procedo.\n\n— respuesta original (lo que dije):\n${r.respuesta}`;
        }
        // Los fallback ("no pude armar la respuesta") se marcan 'error': se
        // muestran a Jhon pero NO entran al historial (lo contaminarían).
        await sb.from('junior_chat').insert({
          rol: 'junior', mensaje: r.respuesta, estado: r.ok ? 'completo' : 'error',
          costo_usd: r.costo_usd, modelo: 'deepseek-chat', sesion_id: msg.sesion_id,
        } as any);
        await sb.from('junior_chat').update({ estado: 'completo' }).eq('id', msg.id);
        if (msg.sesion_id) {
          await sb.from('junior_sesiones')
            .update({ ultima_actividad: new Date().toISOString() })
            .eq('id', msg.sesion_id);
        }
        console.log(`[V2/JUNIOR] respondió mensaje ${msg.id} · $${r.costo_usd.toFixed(4)}`);

        // Memoria persistente: lo que Junior debe recordar SIEMPRE (preferencias
        // de comportamiento, datos generales). Sobrevive a sesiones nuevas.
        //
        // ANTI-DUPLICADO: comparo contenido normalizado contra memorias vigentes.
        // Si match → skip insert. Detectado en stress test: Junior creaba 5
        // memorias casi idénticas sobre Margarita / "montos en negrita" porque
        // emitía la misma memoria turno tras turno sin chequear.
        if (r.memorias.length > 0) {
          const { data: vigentes } = await sb.from('junior_memoria')
            .select('contenido').eq('vigente', true);
          const yaExisten = new Set((vigentes ?? []).map(m => normalizarTexto(m.contenido as string)));
          let nuevas = 0, dups = 0;
          for (const mem of r.memorias) {
            const norm = normalizarTexto(mem.contenido);
            if (yaExisten.has(norm)) {
              dups++;
              console.log(`[V2/JUNIOR] memoria duplicada — skip: "${mem.contenido.slice(0, 60)}"`);
              continue;
            }
            yaExisten.add(norm);                  // evita dup dentro del mismo turno
            await sb.from('junior_memoria').insert({
              tipo: mem.tipo, contenido: mem.contenido,
            } as any);
            await registrarInstruccion('memoria', `Le enseñaste: "${mem.contenido}"`, {
              sesion_id: msg.sesion_id, mensaje_chat_id: msg.id,
            });
            nuevas++;
          }
          console.log(`[V2/JUNIOR] memorias: ${nuevas} nueva(s) guardada(s), ${dups} duplicada(s) skipped`);
        }

        // Clientes nuevos del local / otros medios que Junior registró.
        let idClienteNuevo: number | null = null;
        for (const nc of r.nuevosClientes) {
          const nuevoId = await crearPersonaManual(nc);
          if (nuevoId) {
            idClienteNuevo = nuevoId;
            console.log(`[V2/JUNIOR] cliente manual creado: ${nc.nombre} (id ${nuevoId})`);
            await registrarInstruccion('nuevo_cliente', `Registraste el cliente ${nc.nombre}`, {
              persona_id: nuevoId, sesion_id: msg.sesion_id, mensaje_chat_id: msg.id,
            });
          }
        }

        // Ciclo de aprendizaje: correcciones de Jhon. Los analistas las toman
        // como verdad prioritaria. persona_id=0 apunta al cliente recién creado.
        //
        // CAMBIO ESTRUCTURAL: la re-síntesis YA NO se hace acá en sync. Antes,
        // cada corrección disparaba sintetizarPersona() (8 llamadas LLM cada una)
        // dentro del lock de cicloJuniorChat → si Junior emitía 25 correcciones,
        // el chat quedaba bloqueado 4-10 minutos y los siguientes mensajes del
        // usuario se acumulaban en 'pendiente'. Ahora solo marcamos
        // sintesis_pendiente=true en bulk; cicloSintesisPendiente (corre cada 4s
        // en paralelo, 10 personas por ciclo) las procesa sin bloquear el chat.
        const afectados = new Set<number>();
        if (idClienteNuevo != null) afectados.add(idClienteNuevo);
        for (const c of r.correcciones) {
          let pid = c.persona_id;
          if (pid === 0) {
            if (idClienteNuevo == null) {
              console.warn('[V2/JUNIOR] corrección persona_id=0 sin cliente nuevo, descartada');
              continue;
            }
            pid = idClienteNuevo;
          }
          await sb.from('correcciones_humanas').insert({
            persona_id: pid, modulo: c.modulo, hecho: c.hecho, origen: 'chat_junior',
          } as any);
          await registrarInstruccion('correccion', c.hecho, {
            persona_id: pid, modulo: c.modulo, sesion_id: msg.sesion_id, mensaje_chat_id: msg.id,
          });
          afectados.add(pid);
        }
        if (afectados.size > 0) {
          const ids = Array.from(afectados);
          const { error } = await sb.from('personas')
            .update({ sintesis_pendiente: true }).in('id', ids);
          if (error) console.error(`[V2/JUNIOR] marcar sintesis_pendiente: ${error.message}`);
          else console.log(`[V2/JUNIOR] ${ids.length} cliente(s) encolado(s) para re-síntesis: ${ids.join(',')}`);
        }

        // F7.3 — resoluciones de duplicados: Jhon confirmó por el chat si dos
        // clientes son la misma persona (fusionar) o son distintos (descartar).
        for (const res of r.resoluciones) {
          try {
            const { data: dup } = await sb.from('duplicados_detectados')
              .select('id, persona_nueva_id, persona_existente_id, estado')
              .eq('id', res.duplicado_id).maybeSingle();
            if (!dup || dup.estado !== 'pendiente') {
              console.warn(`[V2/JUNIOR] duplicado ${res.duplicado_id} inexistente o ya resuelto, se ignora`);
              continue;
            }
            if (res.accion === 'descartar') {
              await sb.from('duplicados_detectados')
                .update({ estado: 'descartado', resuelto_at: new Date().toISOString() })
                .eq('id', dup.id);
              console.log(`[V2/JUNIOR] duplicado ${dup.id} descartado (son personas distintas)`);
            } else {
              // El cliente que ya existía sobrevive; el nuevo se fusiona en él.
              // La fusión SÍ es sync (mueve eventos/proyectos/chats — necesita
              // consistencia transaccional). La re-síntesis post-fusión se
              // encola igual que arriba — la hace cicloSintesisPendiente.
              await fusionarPersonas(sb, dup.persona_existente_id, dup.persona_nueva_id,
                `Confirmado por Jhon en el chat de Junior (duplicado #${dup.id})`);
              await sb.from('personas')
                .update({ sintesis_pendiente: true }).eq('id', dup.persona_existente_id);
              console.log(`[V2/JUNIOR] duplicado ${dup.id} fusionado → persona ${dup.persona_existente_id} (re-síntesis encolada)`);
            }
          } catch (e: any) {
            console.error(`[V2/JUNIOR] resolver duplicado ${res.duplicado_id}: ${e.message}`);
          }
        }

        // Tareas que Jhon le dictó por chat: crear nuevas + marcar hechas las que dijo que ya cumplió.
        //
        // ANTI-DUPLICADO chat→chat: si ya existe tarea ACTIVA del mismo persona_id
        // (o transversal si persona_id es null) con título normalizado igual → skip.
        // Detectado en stress test: Walter terminaba con 4 tareas "Llamar a Walter"
        // y Patricia con 4 "Cotizar a Patricia" porque Jhon dictaba lo mismo en
        // mensajes consecutivos. El anti-duplicado de M5 (analistas.ts) cubre
        // chat→M5 pero NO chat→chat.
        for (const nt of r.nuevasTareas) {
          try {
            let pid = nt.persona_id;
            if (pid === 0 && idClienteNuevo != null) pid = idClienteNuevo;
            const tiposValidos = ['llamar','enviar_cotizacion','confirmar_pago','pedir_ficha','agendar_instalacion','reclamar_proveedor','pedir_resena','otro'];
            const tipo = nt.tipo && tiposValidos.includes(nt.tipo) ? nt.tipo : 'otro';
            const tituloNorm = normalizarTexto(nt.titulo);
            // Check duplicado: tareas activas mismo persona_id (o null) con título similar
            let q = sb.from('tareas').select('id, titulo').eq('completada', false).is('deleted_at', null);
            if (pid != null && pid !== 0) q = q.eq('persona_id', pid);
            else q = q.is('persona_id', null);
            const { data: existentes } = await q;
            const dup = (existentes ?? []).find(t => normalizarTexto(t.titulo as string) === tituloNorm);
            if (dup) {
              console.log(`[V2/JUNIOR] tarea duplicada — skip "${nt.titulo}" (ya existe #${dup.id})`);
              continue;
            }
            const { data: nuevaT, error } = await sb.from('tareas').insert({
              titulo: nt.titulo, descripcion: nt.descripcion,
              tipo, persona_id: pid, fecha_vence: nt.fecha_vence, hora_vence: nt.hora_vence,
              prioridad: nt.prioridad, asignado_a: 'jhon', origen: 'chat',
            } as any).select('id').single();
            if (error) {
              console.error(`[V2/JUNIOR] crear tarea "${nt.titulo}": ${error.message}`);
              continue;
            }
            console.log(`[V2/JUNIOR] tarea creada #${nuevaT.id}: ${nt.titulo}`);
          } catch (e: any) {
            console.error(`[V2/JUNIOR] tarea "${nt.titulo}": ${e.message}`);
          }
        }
        for (const ct of r.tareasCompletar) {
          try {
            // Leer la tarea antes de completarla para saber su título y persona_id
            const { data: tareaData } = await sb.from('tareas')
              .select('id, titulo, persona_id').eq('id', ct.id).maybeSingle();

            const { error } = await sb.from('tareas')
              .update({ completada: true, completada_at: new Date().toISOString() })
              .eq('id', ct.id).eq('completada', false);
            if (error) {
              console.error(`[V2/JUNIOR] completar tarea ${ct.id}: ${error.message}`);
              continue;
            }
            console.log(`[V2/JUNIOR] tarea ${ct.id} marcada como hecha`);

            // CASCADA: cancelar agendamiento vinculado (mismo título o nota directa)
            let queryAg = sb.from('agendamientos')
              .update({ deleted_at: new Date().toISOString() })
              .or(`notas.eq.Sincronizado desde tarea #${ct.id},and(titulo.eq."${tareaData?.titulo?.replace(/"/g, '""') || ''}",persona_id.eq.${tareaData?.persona_id ?? 'null'})`)
              .is('deleted_at', null);
            
            const { error: errAg, count } = await queryAg;
            if (!errAg && count && count > 0) {
              console.log(`[V2/JUNIOR] cascada: ${count} agendamiento(s) cancelado(s) para tarea ${ct.id}`);
            }
          } catch (e: any) {
            console.error(`[V2/JUNIOR] completar tarea ${ct.id}: ${e.message}`);
          }
        }

        // Agendamientos (Calendario) que Jhon dictó por chat.
        // ANTI-DUPLICADO: mismo persona_id + fecha + titulo normalizado → skip.
        // Detectado en stress test: Patricia tenía 3 agendamientos idénticos
        // "Visita de medidas - Patricia" para 2026-05-29 porque Junior los emitió
        // 3 veces seguidas. Antes solo limpiábamos duplicados post-hoc; ahora se
        // previenen en el insert.
        for (const na of r.nuevosAgendamientos) {
          try {
            let pid = na.persona_id;
            if (pid === 0 && idClienteNuevo != null) pid = idClienteNuevo;
            const tiposValidos = ['visita_medidas', 'instalacion', 'reunion_proveedor', 'personal', 'otro'];
            const tipo = na.tipo && tiposValidos.includes(na.tipo) ? na.tipo : 'otro';
            const tituloNorm = normalizarTexto(na.titulo);
            // Check duplicado: agendamiento activo mismo persona_id + fecha + título similar
            let q = sb.from('agendamientos').select('id, titulo').is('deleted_at', null).eq('fecha', na.fecha);
            if (pid != null && pid !== 0) q = q.eq('persona_id', pid);
            else q = q.is('persona_id', null);
            const { data: existentes } = await q;
            const dup = (existentes ?? []).find(a => normalizarTexto(a.titulo as string) === tituloNorm);
            if (dup) {
              console.log(`[V2/JUNIOR] agendamiento duplicado — skip "${na.titulo}" ${na.fecha} (ya existe #${dup.id})`);
              continue;
            }
            const { data: nuevoA, error } = await sb.from('agendamientos').insert({
              persona_id: pid,
              titulo: na.titulo,
              tipo,
              fecha: na.fecha,
              hora_inicio: na.hora,
              direccion: na.direccion,
              notas: na.notas,
            } as any).select('id').single();
            if (error) {
              console.error(`[V2/JUNIOR] crear agendamiento "${na.titulo}": ${error.message}`);
              continue;
            }
            console.log(`[V2/JUNIOR] agendamiento creado #${nuevoA.id}: ${na.titulo}`);
          } catch (e: any) {
            console.error(`[V2/JUNIOR] agendamiento "${na.titulo}": ${e.message}`);
          }
        }
        for (const ca of r.agendamientosCancelar) {
          try {
            const { error } = await sb.from('agendamientos')
              .update({ deleted_at: new Date().toISOString() })
              .eq('id', ca.id).is('deleted_at', null);
            if (error) {
              console.error(`[V2/JUNIOR] cancelar agendamiento ${ca.id}: ${error.message}`);
              continue;
            }
            console.log(`[V2/JUNIOR] agendamiento ${ca.id} cancelado/eliminado`);
          } catch (e: any) {
            console.error(`[V2/JUNIOR] cancelar agendamiento ${ca.id}: ${e.message}`);
          }
        }

        // Notas de persona — decisiones de sesión que persisten en la BD
        // (pendiente_verificacion, no_comercial, saltear) para que no se repitan preguntas.
        //
        // Además, para 'no_comercial' y 'saltear', UPDATEa personas.ambito_principal
        // y dispara re-síntesis. Antes solo escribía la corrección, el ámbito quedaba
        // 'comercial' y Junior volvía a tratar al contacto como cliente en la siguiente
        // sesión → Jhon tenía que repetir "es mi cuñado/suegra/mecánico" cada vez.
        //
        // Heurística de mapeo nota→ámbito: leer la nota para detectar familia /
        // proveedor; fallback a 'personal_otros' si no se identifica nada específico.
        // Si más adelante hace falta, Junior puede emitir notasPersona.ambito_destino
        // explícito y nos saltamos la heurística.
        for (const np of r.notasPersona ?? []) {
          try {
            const prefijoPorTipo: Record<string, string> = {
              pendiente_verificacion: '[VERIFICACIÓN PENDIENTE] ',
              no_comercial: '[NO COMERCIAL] ',
              saltear: '[SALTEAR] ',
              otro: '',
            };
            const prefijo = prefijoPorTipo[np.tipo] ?? '';
            const hecho = `${prefijo}${np.nota}`.trim();
            const { error } = await sb.from('correcciones_humanas').insert({
              persona_id: np.persona_id,
              modulo: 'm1',
              hecho,
              origen: 'junior_chat',
            } as any);
            if (error) {
              console.error(`[V2/JUNIOR] nota_persona persona ${np.persona_id}: ${error.message}`);
              continue;
            }
            console.log(`[V2/JUNIOR] nota_persona [${np.tipo}] persona ${np.persona_id}: "${hecho.slice(0, 60)}"`);

            // Propagar al ámbito real cuando aplica + disparar re-síntesis.
            //
            // GUARD CRÍTICO (bug detectado en stress test 2026-05-26): Pedro
            // Bustos (cliente comercial real con $285k abonados + cotización
            // $571k + instalación agendada) fue reclasificado a personal_familia
            // porque un mensaje dijo "Pedro Bustos es mi hermano, sacalo del
            // flujo comercial". Junior lo aceptó sin verificar el historial
            // comercial. La reclasificación corrompió datos reales.
            //
            // Política nueva: si la persona tiene HISTORIAL COMERCIAL ACTIVO
            // (cotización, abono o agendamiento sin borrar), NO se reclasifica
            // automáticamente. Se anota la corrección como [VERIFICACIÓN
            // PENDIENTE] + se loguea para que Jhon confirme manualmente.
            if (np.tipo === 'no_comercial' || np.tipo === 'saltear') {
              // Check historial comercial
              const { count: cots } = await sb.from('cotizaciones').select('*', { count: 'exact', head: true })
                .eq('persona_id', np.persona_id).is('deleted_at', null);
              const { count: abs } = await sb.from('abonos').select('*', { count: 'exact', head: true })
                .eq('persona_id', np.persona_id).is('deleted_at', null);
              const { count: ags } = await sb.from('agendamientos').select('*', { count: 'exact', head: true })
                .eq('persona_id', np.persona_id).is('deleted_at', null);
              const tieneHistorial = (cots ?? 0) + (abs ?? 0) + (ags ?? 0) > 0;

              if (tieneHistorial) {
                // NO reclasificar automáticamente — esto puede ser un error
                // (cliente real al que Junior le hizo caso a una contradicción).
                // En vez de cambiar ámbito, registrar como verificación pendiente.
                await sb.from('correcciones_humanas').insert({
                  persona_id: np.persona_id, modulo: 'm1',
                  hecho: `[VERIFICACIÓN PENDIENTE] Junior intentó reclasificar a no comercial, pero el cliente tiene historial comercial activo (${cots ?? 0} cotización(es), ${abs ?? 0} abono(s), ${ags ?? 0} agendamiento(s)). Motivo dado: "${np.nota}". Jhon debe confirmar manualmente si reclasificar.`,
                  origen: 'junior_chat',
                } as any);
                console.warn(`[V2/JUNIOR] 🛑 GUARD reclasificación: persona ${np.persona_id} tiene historial comercial (${cots ?? 0}c/${abs ?? 0}a/${ags ?? 0}ag). NO reclasificada. Registrado [VERIFICACIÓN PENDIENTE].`);
                continue;
              }

              const notaLower = (np.nota ?? '').toLowerCase();
              let ambitoDestino = 'personal_otros';
              if (/\b(familiar|familia|cu[ñn]ado|cu[ñn]ada|esposa|esposo|hijo|hija|madre|mam[áa]|padre|pap[áa]|herman[oa]|t[íi]o|t[íi]a|primo|prima|abuel[oa]|suegr[oa]|sobrin[oa]|yerno|nuera)\b/.test(notaLower)) {
                ambitoDestino = 'personal_familia';
              } else if (/\b(proveedor|instalador|contadora|asesor[ae]?|socio|socia|empleado|empleada)\b/.test(notaLower)) {
                ambitoDestino = 'proveedor';
              } else if (/\b(mec[áa]nico|electricista|plomero|carpintero|t[ée]cnico|amigo|amiga|conocido)\b/.test(notaLower)) {
                ambitoDestino = 'personal_otros';
              }
              const { error: e2 } = await sb.from('personas')
                .update({ ambito_principal: ambitoDestino, sintesis_pendiente: true })
                .eq('id', np.persona_id);
              if (e2) {
                console.error(`[V2/JUNIOR] update ambito persona ${np.persona_id}: ${e2.message}`);
              } else {
                console.log(`[V2/JUNIOR] persona ${np.persona_id} reclasificada → ambito='${ambitoDestino}' (re-síntesis encolada)`);
              }
            }
          } catch (e: any) {
            console.error(`[V2/JUNIOR] nota_persona persona ${np.persona_id}: ${e.message}`);
          }
        }

        // Cierre manual de checklists — Jhon dijo "caso terminado" para un cliente
        // comercial real. Marcamos cerrado_manual=true para que A_CHECKLIST no lo
        // regenere en su próximo ciclo. Diferente a notasPersona: acá la persona
        // SÍ es comercial (cliente real, no proveedor/familiar) pero el caso se
        // cerró (vendido+instalado+pagado, o perdido).
        //
        // CASCADA AUTOMÁTICA — al cerrar checklist se completan TODAS las tareas
        // activas del cliente y se cancelan TODOS los agendamientos futuros.
        // Razón: tras 3 stress tests Junior aprendió a DESCRIBIR la cascada en
        // texto pero falla consistentemente en EMITIR los IDs en arrays (msgs
        // 1105, 1145, 1151 del test s19 — frases perfectas tipo "completé tareas
        // #657 y #658" con arrays vacíos). El prompt no garantiza coherencia
        // entre texto y JSON. Decisión: cascada determinística en código.
        for (const cc of r.cierresChecklist ?? []) {
          try {
            const res = await cascadaCierreChecklist(sb, cc.chat_id, cc.motivo ?? '');
            if (!res.ok) {
              console.warn(`[V2/JUNIOR] cerrar checklist chat ${cc.chat_id}: ${res.motivoSkip} (skip cascada)`);
              continue;
            }
            console.log(`[V2/JUNIOR] checklist chat ${cc.chat_id} cerrado manualmente`);
            if (res.motivoSkip) {
              console.log(`[V2/JUNIOR] cascada chat ${cc.chat_id}: ${res.motivoSkip}`);
            } else {
              if (res.tareasCompletadas.length > 0)
                console.log(`[V2/JUNIOR] cascada chat ${cc.chat_id}: completadas ${res.tareasCompletadas.length} tareas (ids: ${res.tareasCompletadas.join(', ')})`);
              if (res.agendamientosCancelados.length > 0)
                console.log(`[V2/JUNIOR] cascada chat ${cc.chat_id}: cancelados ${res.agendamientosCancelados.length} agendamientos (ids: ${res.agendamientosCancelados.join(', ')})`);
            }
          } catch (e: any) {
            console.error(`[V2/JUNIOR] cerrar checklist chat ${cc.chat_id}: ${e.message}`);
          }
        }

      } catch (e: any) {
        console.error(`[V2/JUNIOR] error en mensaje ${msg.id}: ${e.message}`);
        await sb.from('junior_chat').update({ estado: 'error' }).eq('id', msg.id);
        await sb.from('junior_chat').insert({
          rol: 'junior', estado: 'completo', sesion_id: msg.sesion_id,
          mensaje: 'Disculpá, tuve un problema procesando tu mensaje. Probá de nuevo.',
        } as any);
      }
    }
  } finally {
    juniorChatEnCurso = false;
  }
}

// ═══ Ciclo Checklist — estado conversacional de cada chat ════════════════════
// El agente A_CHECKLIST analiza los chats con actividad nueva: decide de quién
// es la pelota, marca el flujo de pasos y detecta compromisos sin cumplir.
let checklistEnCurso = false;
async function cicloChecklist(): Promise<void> {
  if (checklistEnCurso) return;
  checklistEnCurso = true;
  try {
    const { data: chats } = await sb.from('chats')
      .select('id').eq('tipo', 'individual').is('deleted_at', null);
    if (!chats || chats.length === 0) return;

    // Último mensaje por chat (de los más recientes de la BD).
    const { data: recientes } = await sb.from('mensajes')
      .select('chat_id, ts_canal').is('deleted_at', null)
      .order('ts_canal', { ascending: false }).limit(1500);
    const ultimoPorChat = new Map<number, string>();
    for (const m of recientes ?? []) {
      if (!ultimoPorChat.has(m.chat_id)) ultimoPorChat.set(m.chat_id, m.ts_canal as string);
    }

    // Estado ya analizado por chat. cerrado_manual=true → Jhon decidió cerrar el
    // checklist por chat de Junior (caso terminado, no es comercial, etc.) y NO
    // querés que el agente lo regenere en el próximo ciclo. Si más adelante llega
    // actividad nueva, Jhon puede reabrirlo desde el chat (protocolo opuesto).
    const { data: cks } = await sb.from('chat_checklist').select('chat_id, ultimo_mensaje_ts, cerrado_manual');
    const analizadoPorChat = new Map<number, string | null>();
    const cerradosManualmente = new Set<number>();
    for (const c of cks ?? []) {
      analizadoPorChat.set(c.chat_id, c.ultimo_mensaje_ts);
      if (c.cerrado_manual) cerradosManualmente.add(c.chat_id);
    }

    // Chats con actividad nueva (mensaje más nuevo que el último analizado).
    const necesitan: number[] = [];
    for (const ch of chats) {
      if (cerradosManualmente.has(ch.id)) continue;    // cerrado por Jhon → respetar
      const ultimoMsg = ultimoPorChat.get(ch.id);
      if (!ultimoMsg) continue;                        // chat sin mensajes
      const analizado = analizadoPorChat.get(ch.id);
      if (!analizadoPorChat.has(ch.id) || !analizado ||
          new Date(ultimoMsg).getTime() > new Date(analizado).getTime()) {
        necesitan.push(ch.id);
      }
      if (necesitan.length >= MAX_CHECKLIST_POR_CICLO) break;
    }

    let costo = 0;
    for (const chatId of necesitan) {
      try {
        const r = await analizarChecklist(sb, chatId);
        costo += r.costo_usd;
      } catch (e: any) {
        console.error(`[V2/CHK] chat ${chatId}: ${e.message}`);
      }
    }
    if (necesitan.length > 0) {
      console.log(`[V2/CHK] checklist actualizado para ${necesitan.length} chat(s) · $${costo.toFixed(4)}`);
    }
  } finally {
    checklistEnCurso = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  // 1. Registrar agentes (hoy: 0 hooks; pipeline marca cada uno NOT_IMPLEMENTED y sigue)
  registrarTodosLosAgentes();
  const registrados = listarAgentesRegistrados();
  console.log(`[V2] iniciando worker pipeline v2 — supabase=${SUPABASE_URL!.replace(/^https:\/\//, '')}`);
  console.log(`[V2] flags: once=${ONCE_MODE} skip-ex=${SKIP_EXTRACTOR} skip-id=${SKIP_IDENTIDAD} skip-pi=${SKIP_PIPELINE} agent-only=${AGENT_ONLY ?? '(off)'}`);
  console.log(`[V2] agentes registrados: ${registrados.length === 0 ? '0 (todos NOT_IMPLEMENTED, esperado en F1)' : registrados.join(',')}`);

  // 2. Pre-cargar los 3 pipelines en cache (también valida que existan en BD)
  if (!SKIP_PIPELINE) {
    for (const cod of ['PIPE_MENSAJE_COMERCIAL', 'PIPE_AUDIO', 'PIPE_IMAGEN']) {
      try {
        const p = await cargarPipeline(sb, cod);
        console.log(`[V2] pipeline ${cod}: ${p.pasos.fases.length} fases · prioridad=${p.prioridad} · shadow=${p.shadow}`);
      } catch (e: any) {
        console.warn(`[V2] no pude cargar pipeline ${cod}: ${e.message}`);
      }
    }
  }

  // 2.5. Limpiar leases caducados al arrancar. Regla: un evento con
  // `procesando_hasta` ya vencido y `procesando_por` no nulo nunca es legítimo,
  // sea cual sea su estado. Es zombie por definición. Causas posibles:
  //   - IDENTIFICADO: worker crasheó antes de procesar (bloquea reprocesamiento)
  //   - ERROR: versiones viejas que crasheaban sin limpiar (hoy el catch lo hace)
  //   - PROCESADO: bugs históricos del enjambre (ej. agentes que seteaban
  //     procesando_por sin limpiarlo al cerrar — arreglado en `f4692f9`)
  // Sin filtro por estado: blindaje para cualquier estado actual o futuro.
  try {
    const ahora = new Date().toISOString();
    const { data: limpiados, error: limpErr } = await sb.from('evento_pg')
      .update({ procesando_por: null, procesando_hasta: null })
      .not('procesando_por', 'is', null)
      .lt('procesando_hasta', ahora)
      .select('id, estado');
    if (limpErr) {
      console.warn(`[V2] cleanup leases caducados error: ${limpErr.message}`);
    } else if (limpiados && limpiados.length > 0) {
      const porEstado = limpiados.reduce((acc: Record<string, number>, r: any) => {
        acc[r.estado] = (acc[r.estado] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`[V2] cleanup: ${limpiados.length} leases caducados liberados (${JSON.stringify(porEstado)})`);
    }
  } catch (e: any) {
    console.warn(`[V2] cleanup leases excepción: ${e.message}`);
  }

  // 3. Drenar pendientes al arrancar
  if (!SKIP_EXTRACTOR) {
    let pend = BATCH_EXTRACTOR;
    while (pend >= BATCH_EXTRACTOR) pend = await cicloExtractor().catch(() => 0);
  }
  if (!SKIP_IDENTIDAD) {
    let pend = BATCH_IDENTIDAD;
    while (pend >= BATCH_IDENTIDAD) pend = await cicloIdentidad().catch(() => 0);
  }
  if (!SKIP_PIPELINE) {
    let pend = BATCH_PIPELINE;
    while (pend >= BATCH_PIPELINE) pend = await cicloPipeline().catch(() => 0);
  }

  if (ONCE_MODE) {
    console.log(`[V2] --once · stats=${JSON.stringify(stats)}`);
    process.exit(0);
  }

  // 4. Bucle periódico
  if (!SKIP_EXTRACTOR) setInterval(() => { cicloExtractor().catch(e => console.error('[V2/EX]', e?.message)); }, POLL_EXTRACTOR_MS);
  if (!SKIP_IDENTIDAD) setInterval(() => { cicloIdentidad().catch(e => console.error('[V2/ID]', e?.message)); }, POLL_IDENTIDAD_MS);
  if (!SKIP_PIPELINE)  setInterval(() => { cicloPipeline().catch(e => console.error('[V2/PI]', e?.message)); }, POLL_PIPELINE_MS);
  if (JUNIOR_VIEJO_ACTIVO) setInterval(() => { cicloJuniorChat().catch(e => console.error('[V2/JUNIOR]', e?.message)); }, 3000);
  setInterval(() => { cicloChecklist().catch(e => console.error('[V2/CHK]', e?.message)); }, POLL_CHECKLIST_MS);
  setInterval(() => { cicloSintesisPendiente().catch(e => console.error('[V2/SINT-MANUAL]', e?.message)); }, 4000);
  // V2: motor de tarjetas embebido (antes proceso aparte worker_tarjetas).
  setInterval(() => { cicloTarjetas(sb, m => console.log('[V2/TARJETAS]', m)).catch(e => console.error('[V2/TARJETAS]', e?.message)); }, 10000);
  // Red de seguridad: recupera personas con eventos PROCESADO pero sin síntesis
  // (cola en memoria perdida por reinicio/apagón/hot-reload). Disparo inicial a
  // los 30s para limpiar huérfanas tras cada arranque, luego cada 3 min.
  setTimeout(() => { cicloReconciliarSintesis().catch(e => console.error('[V2/RECONCILIAR]', e?.message)); }, 30_000);
  setInterval(() => { cicloReconciliarSintesis().catch(e => console.error('[V2/RECONCILIAR]', e?.message)); }, 3 * 60 * 1000);
  // Red de seguridad del ámbito: sincroniza chat.ambito ← persona + confirma los
  // no-comerciales (disparo inicial a los 45s, luego cada 5 min).
  setTimeout(() => { cicloReconciliarAmbito().catch(e => console.error('[V2/RECONCILIAR-AMBITO]', e?.message)); }, 45_000);
  setInterval(() => { cicloReconciliarAmbito().catch(e => console.error('[V2/RECONCILIAR-AMBITO]', e?.message)); }, 5 * 60 * 1000);

  // Disparador batch de A5_CARTERA (cobros pendientes): no es tiempo real → cada
  // 6h + un disparo inicial a los 60s del arranque. Throttle interno por persona.
  const dispararCartera = () => cicloCartera(sb, m => console.log('[V2/CARTERA]', m)).catch(e => console.error('[V2/CARTERA]', e?.message));
  setTimeout(dispararCartera, 60_000);
  setInterval(dispararCartera, 6 * 3600 * 1000);

  // Red de seguridad de identidad: auto-fusión de personas con el mismo teléfono
  // (fragmentación LID↔teléfono). No es tiempo real → cada 6h + disparo inicial
  // a los 90s. La unificación en caliente la hace matcher.ts; esto cierra bordes.
  const dispararFusionTel = () => cicloFusionPorTelefono(sb, m => console.log('[V2/FUSION-TEL]', m))
    .then(r => { if (r.fusiones) console.log(`[V2/FUSION-TEL] ${r.fusiones} fusión(es) en ${r.gruposDuplicados} grupo(s)`); })
    .catch(e => console.error('[V2/FUSION-TEL]', e?.message));
  setTimeout(dispararFusionTel, 90_000);
  setInterval(dispararFusionTel, 6 * 3600 * 1000);

  // PDFs server-side: el worker lee los PDFs descifrados del almacenamiento local
  // de la extensión, los transcribe con pdf.js (lo que el extractor de la extensión
  // no podía: FlateDecode/escaneados) y los mete al pipeline.
  // Intervalo CORTO (90s) para cazar el PDF mientras está fresco en el caché —
  // el caché LRU de la extensión corrompe los blobs viejos con el tiempo. El ciclo
  // sale temprano si no hay PDFs nuevos pendientes (no escanea), así que es barato.
  const dispararPdf = () => cicloPdfWorker(sb, m => console.log('[V2/PDF]', m))
    .then(r => { if (r.recuperados) console.log(`[V2/PDF] ${r.recuperados}/${r.pendientes} PDF(s) recuperados (${r.pdfsEnDisco} en disco)`); })
    .catch(e => console.error('[V2/PDF]', e?.message));
  setTimeout(dispararPdf, 45_000);
  setInterval(dispararPdf, 90_000);

  // Descarga+descifrado server-side de media SALIENTE que la extensión no bajó
  // (download_status='failed'): usa media_key+direct_path de mensajes.metadata
  // para bajar del CDN de WhatsApp y descifrar. Independiente de la extensión y
  // del caché del navegador. Corre seguido porque el token del direct_path expira.
  // Guard anti-reentrada: un ciclo puede tardar más que el intervalo (cada media
  // = descarga CDN + Whisper/Vision), no queremos dos corriendo a la vez (re-pago).
  let mediaDlEnCurso = false;
  const dispararMediaDL = async () => {
    if (mediaDlEnCurso) return;
    mediaDlEnCurso = true;
    try {
      const r = await cicloMediaDescarga(sb, m => console.log('[V2/MEDIA-DL]', m));
      if (r.recuperados || r.fallidos) console.log(`[V2/MEDIA-DL] ${r.recuperados} recuperados, ${r.fallidos} fallidos (${r.pendientes} pendientes)`);
    } catch (e: any) { console.error('[V2/MEDIA-DL]', e?.message); }
    finally { mediaDlEnCurso = false; }
  };
  setTimeout(dispararMediaDL, 15_000);
  setInterval(dispararMediaDL, 45_000);

  setInterval(() => console.log(`[V2] stats: ${JSON.stringify(stats)}`), STATS_INTERVAL_MS);

  process.on('SIGINT', () => { console.log('[V2] SIGINT → exit'); process.exit(0); });
}

main().catch(e => { console.error('[V2] fatal:', e); process.exit(1); });
