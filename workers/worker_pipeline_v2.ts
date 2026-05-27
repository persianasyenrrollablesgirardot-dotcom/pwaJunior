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
import { fusionarPersonas } from '../identidad/fusionar_personas.js';

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

async function drenarSintesis(): Promise<void> {
  if (personasSintesisPendiente.size === 0) return;
  const pendientes = [...personasSintesisPendiente];
  personasSintesisPendiente.clear();
  for (const pid of pendientes) {
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
let sintesisPendienteEnCurso = false;
async function cicloSintesisPendiente(): Promise<void> {
  if (sintesisPendienteEnCurso) return;
  sintesisPendienteEnCurso = true;
  try {
    const { data } = await sb.from('personas')
      .select('id').eq('sintesis_pendiente', true).is('deleted_at', null).limit(10);
    for (const p of data ?? []) {
      try {
        const r = await sintetizarPersona(sb, p.id);
        stats.pi_costo_usd += r.costo_usd;
        console.log(`[V2/SINT-MANUAL] persona ${p.id}: ${r.ok}/7 módulos · $${r.costo_usd.toFixed(4)}`);
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
        for (const evt of grupos.get(chatKey)!) await procesarEventoPipeline(evt);
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

/** Crea una persona de origen manual (cliente del local / otro medio) + su proyecto. */
async function crearPersonaManual(nc: NuevoCliente): Promise<number | null> {
  const { data: persona, error } = await sb.from('personas').insert({
    nombre: nc.nombre,
    telefono_e164: normalizarTelefono(nc.telefono),
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

let juniorChatEnCurso = false;
async function cicloJuniorChat(): Promise<void> {
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
        // Detección defensiva — Junior promete acciones pero deja el array vacío.
        // No bloquea la respuesta (puede ser frase ambigua) pero queda visible en el
        // log para auditar el patrón. Si esto se repite mucho, hay que reforzar el prompt.
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
        if (r.memorias.length > 0) {
          for (const mem of r.memorias) {
            await sb.from('junior_memoria').insert({
              tipo: mem.tipo, contenido: mem.contenido,
            } as any);
            await registrarInstruccion('memoria', `Le enseñaste: "${mem.contenido}"`, {
              sesion_id: msg.sesion_id, mensaje_chat_id: msg.id,
            });
          }
          console.log(`[V2/JUNIOR] ${r.memorias.length} memoria(s) persistente(s) guardada(s)`);
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
        for (const nt of r.nuevasTareas) {
          try {
            let pid = nt.persona_id;
            if (pid === 0 && idClienteNuevo != null) pid = idClienteNuevo;
            const tiposValidos = ['llamar','enviar_cotizacion','confirmar_pago','pedir_ficha','agendar_instalacion','reclamar_proveedor','pedir_resena','otro'];
            const tipo = nt.tipo && tiposValidos.includes(nt.tipo) ? nt.tipo : 'otro';
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

        // Agendamientos (Calendario) que Jhon dictó por chat
        for (const na of r.nuevosAgendamientos) {
          try {
            let pid = na.persona_id;
            if (pid === 0 && idClienteNuevo != null) pid = idClienteNuevo;
            const tiposValidos = ['visita_medidas', 'instalacion', 'reunion_proveedor', 'personal', 'otro'];
            const tipo = na.tipo && tiposValidos.includes(na.tipo) ? na.tipo : 'otro';
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
            if (np.tipo === 'no_comercial' || np.tipo === 'saltear') {
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
        for (const cc of r.cierresChecklist ?? []) {
          try {
            const motivo = (cc.motivo ?? '').trim() || 'Cerrado manualmente por Jhon';
            const { error, data } = await sb.from('chat_checklist')
              .update({
                tipo: 'no_aplica',
                estado: 'cerrada',
                proximo_paso: null,
                motivo_cierre: motivo,
                cerrado_manual: true,
                actualizado_at: new Date().toISOString(),
              } as any)
              .eq('chat_id', cc.chat_id)
              .select('chat_id').maybeSingle();
            if (error) {
              console.error(`[V2/JUNIOR] cerrar checklist chat ${cc.chat_id}: ${error.message}`);
            } else if (!data) {
              console.warn(`[V2/JUNIOR] cerrar checklist chat ${cc.chat_id}: no había fila en chat_checklist (skip)`);
            } else {
              console.log(`[V2/JUNIOR] checklist chat ${cc.chat_id} cerrado manualmente: "${motivo.slice(0, 60)}"`);
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
  setInterval(() => { cicloJuniorChat().catch(e => console.error('[V2/JUNIOR]', e?.message)); }, 3000);
  setInterval(() => { cicloChecklist().catch(e => console.error('[V2/CHK]', e?.message)); }, POLL_CHECKLIST_MS);
  setInterval(() => { cicloSintesisPendiente().catch(e => console.error('[V2/SINT-MANUAL]', e?.message)); }, 4000);

  setInterval(() => console.log(`[V2] stats: ${JSON.stringify(stats)}`), STATS_INTERVAL_MS);

  process.on('SIGINT', () => { console.log('[V2] SIGINT → exit'); process.exit(0); });
}

main().catch(e => { console.error('[V2] fatal:', e); process.exit(1); });
