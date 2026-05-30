/**
 * Orquestador de pipelines de agentes.
 *
 * Un pipeline define un DAG de agentes que se ejecutan sobre un evento.
 * Soporta tres modos por fase:
 *   - "paralelo": todos los agentes corren a la vez con Promise.all
 *   - "serial":   uno tras otro (cada uno recibe el output del anterior)
 *   - "routing":  switch por un campo del output acumulado
 *
 * Forma del JSONB `pasos`:
 *   {
 *     "fases": [
 *       { "id": "extraccion",  "modo": "paralelo", "agentes": ["A1_ENTIDADES","A1_MEDIDAS"] },
 *       { "id": "clasificar",  "modo": "serial",   "agentes": ["A2_INTENCION"] },
 *       { "id": "operativo",   "modo": "routing",  "switch_on": "intencion",
 *         "rutas": { "cotizar": ["A4_COTIZ"], "_default": ["A7_TAREAS"] } }
 *     ]
 *   }
 *
 * Filosofía:
 *   - Si UN agente falla, el pipeline NO se aborta. Se loggea, se sigue.
 *     (Cada agente persiste su error en agente_invocaciones.)
 *   - Los outputs de cada agente se acumulan en un objeto `contextoAcumulado`
 *     que las fases posteriores pueden leer (especialmente routing).
 *   - El validador.ts ya corre dentro de cada `ejecutarAgente`, no acá.
 *   - shadow del pipeline OVERRIDES shadow del agente: si el pipeline está
 *     en shadow=true, todos los agentes corren shadow aunque su definición
 *     diga shadow=false. (Defensa adicional contra escrituras prematuras.)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ejecutarAgente, cargarAgenteDefinicion, type AgenteHooks, type ResultadoEjecucion, type AgenteDefinicion } from './runner.js';

export interface PipelineDefinicion {
  id: number;
  codigo: string;
  descripcion: string | null;
  trigger_tipo_evento: string;
  trigger_condiciones: Record<string, any> | null;
  pasos: { fases: FaseDefinicion[] };
  activo: boolean;
  shadow: boolean;
  prioridad: number;
  costo_max_estimado_usd: number;
  version: number;
}

export interface FaseDefinicion {
  id: string;
  modo: 'paralelo' | 'serial' | 'routing';
  agentes?: string[];                            // para paralelo/serial
  switch_on?: string;                            // para routing: key del contextoAcumulado
  rutas?: Record<string, string[]>;              // para routing: valor → lista de agentes
  comentario?: string;
}

export interface ParametrosEvento {
  evento_id: number;
  chat_id: number;
  persona_id: number;
  proyecto_id: number | null;
  ambito: string;
}

export interface ResultadoPipeline {
  pipeline_codigo: string;
  ok: boolean;
  fases_completadas: number;
  fases_total: number;
  resultados_por_agente: Record<string, ResultadoEjecucion>;
  contexto_final: Record<string, any>;
  costo_usd_total: number;
  latencia_ms_total: number;
  errores: { agente: string; error: string }[];
}

// ─── Carga de pipeline desde BD ─────────────────────────────────────

const cachePipelines = new Map<string, { p: PipelineDefinicion; ts: number }>();
const PIPELINE_CACHE_TTL_MS = 30_000;

export async function cargarPipeline(sb: SupabaseClient, codigo: string): Promise<PipelineDefinicion> {
  const cached = cachePipelines.get(codigo);
  if (cached && Date.now() - cached.ts < PIPELINE_CACHE_TTL_MS) return cached.p;
  const { data, error } = await sb.from('agente_pipelines').select('*').eq('codigo', codigo).maybeSingle();
  if (error || !data) throw new Error(`Pipeline '${codigo}' no encontrado: ${error?.message}`);
  const p = data as PipelineDefinicion;
  cachePipelines.set(codigo, { p, ts: Date.now() });
  return p;
}

/**
 * Busca el pipeline aplicable a un evento según trigger_tipo_evento +
 * trigger_condiciones. Devuelve el de mayor prioridad activo que matchee.
 *
 * Si NO hay pipeline activo, devuelve null (el worker decide si correr en
 * shadow o saltarlo).
 */
export async function pipelineAplicable(
  sb: SupabaseClient,
  tipoEvento: string,
  contextoEvento: Record<string, any>,
): Promise<PipelineDefinicion | null> {
  const { data, error } = await sb
    .from('agente_pipelines')
    .select('*')
    .eq('trigger_tipo_evento', tipoEvento)
    .order('prioridad', { ascending: false });
  if (error) return null;
  for (const p of (data ?? []) as PipelineDefinicion[]) {
    if (!p.activo && !p.shadow) continue;
    const cond = p.trigger_condiciones ?? {};
    const matchea = Object.entries(cond).every(([k, v]) => contextoEvento[k] === v);
    if (matchea) return p;
  }
  return null;
}

// ─── Registro de hooks por agente ───────────────────────────────────
// Cada agente concreto (a1_entidades.ts, a4_cotiz.ts, etc.) se registra
// con su código y sus hooks. Si un código no está registrado al ejecutar
// un pipeline, se loggea como NOT_IMPLEMENTED pero el pipeline continúa.

const registroAgentes = new Map<string, AgenteHooks>();

export function registrarAgente(codigo: string, hooks: AgenteHooks): void {
  registroAgentes.set(codigo, hooks);
}

export function listarAgentesRegistrados(): string[] {
  return Array.from(registroAgentes.keys()).sort();
}

// ─── Ejecución del pipeline ─────────────────────────────────────────

export async function ejecutarPipeline(
  sb: SupabaseClient,
  pipeline: PipelineDefinicion,
  params: ParametrosEvento,
): Promise<ResultadoPipeline> {
  const t0 = Date.now();
  const tag = `[pipe ${pipeline.codigo}/ev${params.evento_id}]`;
  console.log(`${tag} ▸ inicio · ${pipeline.pasos.fases.length} fases`);

  const contexto: Record<string, any> = {};   // outputs acumulados de todas las fases
  const resultadosAgente: Record<string, ResultadoEjecucion> = {};
  const errores: { agente: string; error: string }[] = [];
  let fasesCompletadas = 0;
  let costoTotal = 0;

  for (const fase of pipeline.pasos.fases) {
    console.log(`${tag}   ▸ fase '${fase.id}' (${fase.modo})`);
    let agentesACorrer: string[] = [];

    if (fase.modo === 'paralelo' || fase.modo === 'serial') {
      agentesACorrer = fase.agentes ?? [];
    } else if (fase.modo === 'routing') {
      const valor = contexto[fase.switch_on ?? ''];
      const ruta = fase.rutas?.[valor as string] ?? fase.rutas?._default ?? [];
      agentesACorrer = ruta;
      console.log(`${tag}     · routing ${fase.switch_on}=${valor} → ${ruta.length} agente(s)`);
    }

    if (agentesACorrer.length === 0) {
      console.log(`${tag}     · sin agentes en esta fase, skip`);
      fasesCompletadas++;
      continue;
    }

    // Ejecutar agentes (paralelo o serial)
    const ejecuciones = agentesACorrer.map(codigo => () => correrUnAgente(sb, codigo, params, pipeline.shadow, contexto, tag));
    let resultados: { codigo: string; result: ResultadoEjecucion | null; error?: string }[] = [];

    if (fase.modo === 'paralelo') {
      resultados = await Promise.all(ejecuciones.map((f, i) =>
        f().then(r => ({ codigo: agentesACorrer[i], result: r }))
          .catch(e => ({ codigo: agentesACorrer[i], result: null, error: e.message }))));
    } else {
      for (let i = 0; i < ejecuciones.length; i++) {
        try {
          const r = await ejecuciones[i]();
          resultados.push({ codigo: agentesACorrer[i], result: r });
        } catch (e: any) {
          resultados.push({ codigo: agentesACorrer[i], result: null, error: e.message });
        }
      }
    }

    // Acumular outputs y errores
    for (const { codigo, result, error } of resultados) {
      if (error) {
        errores.push({ agente: codigo, error });
        continue;
      }
      if (result) {
        resultadosAgente[codigo] = result;
        costoTotal += result.costo_usd;
        // Si el agente devolvió output, lo merge-amos al contexto
        const payload = result.output?.payload as Record<string, any> | undefined;
        if (payload) {
          for (const [k, v] of Object.entries(payload)) {
            if (contexto[k] === undefined) contexto[k] = v;        // primer agente que setea una key gana
          }
        }
      }
    }

    fasesCompletadas++;
  }

  const latencia = Date.now() - t0;
  console.log(`${tag} ✓ ${fasesCompletadas}/${pipeline.pasos.fases.length} fases · ${latencia}ms · $${costoTotal.toFixed(6)} · ${errores.length} errores`);

  return {
    pipeline_codigo: pipeline.codigo,
    ok: errores.length === 0,
    fases_completadas: fasesCompletadas,
    fases_total: pipeline.pasos.fases.length,
    resultados_por_agente: resultadosAgente,
    contexto_final: contexto,
    costo_usd_total: costoTotal,
    latencia_ms_total: latencia,
    errores,
  };
}

async function correrUnAgente(
  sb: SupabaseClient,
  codigo: string,
  params: ParametrosEvento,
  pipelineShadow: boolean,
  contextoPipeline: Record<string, any>,
  tag: string,
): Promise<ResultadoEjecucion> {
  const hooks = registroAgentes.get(codigo);
  if (!hooks) {
    console.warn(`${tag}     ⚠ agente '${codigo}' NO_IMPLEMENTED — skip`);
    return {
      ok: false, error: 'NOT_IMPLEMENTED',
      costo_usd: 0, latencia_ms: 0, shadow: true, fue_al_buzon: false,
    };
  }

  const agente = await cargarAgenteDefinicion(sb, codigo);
  // El shadow del pipeline OVERRIDES el shadow del agente (defensa adicional)
  const agenteEfectivo: AgenteDefinicion = pipelineShadow ? { ...agente, shadow: true } : agente;

  // Inyectamos el contexto del pipeline en los hooks: el agente lo recibe
  // dentro del primer parámetro de cargarContexto vía un wrapper.
  const hooksConContexto: AgenteHooks = {
    ...hooks,
    cargarContexto: async (sbInner, p) => {
      const datos = await hooks.cargarContexto(sbInner, p);
      // Mezclar con el contexto acumulado del pipeline (solo lectura)
      return { ...datos, _contexto_pipeline: contextoPipeline } as any;
    },
  };

  // skipLock=true: el worker_pipeline_v2 ya tomó el lock del evento_pg antes
  // de invocar el pipeline. Si cada agente intentara tomar su propio lock,
  // todos fallarían con "ya tomado" (especialmente en fases paralelo).
  return await ejecutarAgente(sb, agenteEfectivo, params, hooksConContexto, { skipLock: true });
}
