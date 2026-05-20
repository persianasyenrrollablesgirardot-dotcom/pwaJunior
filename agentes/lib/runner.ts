/**
 * Runner genérico de agentes IA.
 *
 * Cada agente proporciona 4 hooks:
 *   1. cargarContexto(sb, ctx)    — lee BD para preparar el contexto
 *   2. construirPrompt(contexto)  — devuelve los mensajes para el LLM
 *   3. validarOutput(out, ctx)    — opcional: validación específica además del validador estándar
 *   4. postProcesar(sb, out, ctx) — escribe a tablas de negocio si aplica
 *
 * El Runner se encarga de:
 *   - Tope hard de costo por invocación
 *   - Modo shadow (no escribe a tablas, solo loggea)
 *   - Validación estándar (anti-alucinación + anti-contaminación + reglas duras)
 *   - Lock de evento (procesando_por) para evitar doble-procesamiento concurrente
 *   - Idempotencia + retry: si un evento falla 3 veces se manda a dead_letter_queue
 *   - Persistencia de `agente_invocaciones` para tope diario y métricas
 *   - Inyección de correcciones previas al prompt (memoria de errores pasados)
 *   - Mandar al buzón si confianza < CONFIRMADO con FK polimórfica
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat, type ChatMessage, type DeepSeekResult } from './llm.js';
import { validarOutput, parsearJSONSeguro, type OutputAgente, type ContextoValidacion, ValidacionError } from './validador.js';

export interface AgenteDefinicion {
  codigo: string;                    // 'A1', 'A5', 'JUNIOR'
  nombre: string;
  proposito: string;
  ambitos: string[];
  prompt_especifico: string;
  costo_limite_usd: number;
  shadow: boolean;
  reglas_duras: string[];
  version: number;
}

export interface ContextoAgente {
  agente: AgenteDefinicion;
  evento_id: number;
  chat_id: number;
  persona_id: number;
  proyecto_id: number | null;
  ambito: string;
  datos: any;
  identificadores_otros_clientes: string[];
  msg_ids_disponibles: Set<string>;
  correcciones_previas: { campo: string; valor_nuevo: any; ts: string }[];
}

export interface ResultadoEjecucion {
  ok: boolean;
  output?: OutputAgente;
  costo_usd: number;
  latencia_ms: number;
  shadow: boolean;
  error?: string;
  fue_al_buzon: boolean;
  motivo_skip?: 'lock' | 'dlq' | 'desactivado';
}

/**
 * Resultado de procesarSinLLM — para agentes que NO usan chat LLM
 * (ej. A1_AUDIO con Whisper, A1_OCR con Vision, o agentes que solo leen BD).
 */
export interface ResultadoNoLLM {
  output: OutputAgente;
  costo_usd: number;
  latencia_ms: number;
  modelo: string;            // 'whisper-1', 'gpt-4o-mini', 'lookup', etc.
  tokens_in?: number;
  tokens_out?: number;
  tokens_cached?: number;
}

export interface AgenteHooks<TDatos = any> {
  cargarContexto(sb: SupabaseClient, params: { evento_id: number; chat_id: number; persona_id: number; proyecto_id: number | null; correcciones_previas: any[] }): Promise<TDatos>;

  /**
   * Construye los mensajes para el chat LLM (DeepSeek).
   * REQUERIDO si el agente usa chat LLM. OMITIR si el agente define procesarSinLLM.
   */
  construirPrompt?(datos: TDatos, agente: AgenteDefinicion): ChatMessage[];

  /**
   * Ruta alternativa al chat LLM: el agente produce output directamente
   * (Whisper, Vision, búsqueda en BD, regex). Si está definido, el runner
   * lo usa Y SALTEA deepseekChat + parseo JSON. La validación estándar
   * y postProcesar siguen corriendo.
   */
  procesarSinLLM?(
    sb: SupabaseClient,
    datos: TDatos,
    agente: AgenteDefinicion,
    params: { evento_id: number; chat_id: number; persona_id: number; proyecto_id: number | null; ambito: string },
  ): Promise<ResultadoNoLLM>;

  validarOutputEspecifico?(out: OutputAgente, datos: TDatos): void;
  postProcesar(sb: SupabaseClient, out: OutputAgente, ctx: ContextoAgente): Promise<{ entidad_tipo?: string; entidad_id?: number } | void>;
}

const MAX_INTENTOS_AGENTE = 3;
const LEASE_SEGUNDOS = 300;

/**
 * Mapea tipo_evento del output a tipo_decision válido para buzon_validacion.
 * El CHECK del buzón solo permite ciertos valores; mapeamos los que vienen
 * del agente a los enums del buzón.
 */
const TIPO_EVENTO_A_DECISION: Record<string, string> = {
  'cotizacion':           'cotizacion_propuesta',
  'cotizacion_item':      'cotizacion_item_propuesto',
  'cotizacion_objecion':  'cotizacion_objecion_propuesta',
  'abono':                'abono_propuesto',
  'medida':               'medida_propuesta',
  'instalacion':          'instalacion_propuesta',
  'tarea':                'tarea_propuesta',
  'garantia':             'garantia_propuesta',
  'mantenimiento':        'mantenimiento_propuesto',
  'review':               'review_propuesta',
  'reclamo':              'reclamo_propuesto',
  'evidencia':            'evidencia_propuesta',
  'costo':                'costo_propuesto',
  'variacion':            'variacion_propuesta',
  'pago':                 'abono_propuesto',
  'dato_extraido':        'dato_extraido',
  'cambio_estado':        'cambio_estado',
  'pregunta_humano':      'pregunta_humano',
  'correccion_humana':    'correccion_humana',
};

function mapTipoDecision(tipo_evento: string): string {
  return TIPO_EVENTO_A_DECISION[tipo_evento] ?? 'otro';
}

/**
 * Ejecuta un agente sobre un evento específico.
 *
 * `opts.skipLock=true` salta el lock del evento — el caller (típicamente
 * pipeline.ts cuando lo invoca el worker) ya tomó el lock global del evento
 * y coordina la concurrencia entre agentes paralelos. Sin esto, agentes en
 * fase 'paralelo' del pipeline fallan todos con "evento ya tomado".
 */
export async function ejecutarAgente<TDatos = any>(
  sb: SupabaseClient,
  agente: AgenteDefinicion,
  params: { evento_id: number; chat_id: number; persona_id: number; proyecto_id: number | null; ambito: string },
  hooks: AgenteHooks<TDatos>,
  opts: { skipLock?: boolean } = {},
): Promise<ResultadoEjecucion> {
  const t0 = Date.now();
  const tag = `${agente.codigo}/ev${params.evento_id}`;
  let invocacionId: number | null = null;
  let intentosPrevios = 0;

  // ─── 1. LOCK DEL EVENTO ─────────────────────────────────────────────
  // Tomar lease específico de este agente. Si otro worker ya lo tomó, salir.
  // Si skipLock=true: leer intentos_agente sin tomar lock (caller ya lockeó).
  if (opts.skipLock) {
    const { data: row } = await sb.from('evento_pg')
      .select('intentos_agente')
      .eq('id', params.evento_id)
      .maybeSingle();
    intentosPrevios = Number(row?.intentos_agente ?? 0);
  } else {
  const procesandoHasta = new Date(Date.now() + LEASE_SEGUNDOS * 1000).toISOString();
  const procesandoPor = `${agente.codigo}@${process.pid}`;
  const { data: lockData, error: lockErr } = await sb
    .from('evento_pg')
    .update({ procesando_por: procesandoPor, procesando_hasta: procesandoHasta })
    .eq('id', params.evento_id)
    .or(`procesando_hasta.is.null,procesando_hasta.lt.${new Date().toISOString()}`)
    .select('id, intentos_agente')
    .maybeSingle();

  if (lockErr) {
    console.error(`[${tag}] lock error:`, lockErr.message);
  } else if (!lockData) {
    console.log(`[${tag}] evento ya tomado por otro worker — skip`);
    return { ok: false, error: 'lock-busy', costo_usd: 0, latencia_ms: Date.now() - t0, shadow: agente.shadow, fue_al_buzon: false, motivo_skip: 'lock' };
  } else {
    intentosPrevios = Number(lockData.intentos_agente ?? 0);
  }
  } // fin del else (lock path)

  // ─── 2. CHECK DEAD LETTER + 3. INCREMENTAR INTENTOS ───────────────
  // Estos pasos SOLO aplican fuera del pipeline. Dentro del pipeline,
  // `intentos_agente` cuenta los pasos del pipeline (no reintentos reales),
  // así que un evento con 4 agentes se iría a DLQ en el 4to. Cada agente
  // tiene su propio contador en `agente_invocaciones.intentos`.
  if (!opts.skipLock) {
    if (intentosPrevios >= MAX_INTENTOS_AGENTE) {
      console.warn(`[${tag}] evento con ${intentosPrevios} intentos previos — moviendo a DLQ`);
      await sb.from('dead_letter_queue').insert({
        evento_id: params.evento_id,
        agente_codigo: agente.codigo,
        ultimo_error: `Reintentos agotados (${intentosPrevios})`,
        stack_trace: null,
        intentos: intentosPrevios,
      } as any);
      await sb.from('evento_pg').update({ estado: 'ERROR', procesando_por: null, procesando_hasta: null }).eq('id', params.evento_id);
      return { ok: false, error: 'max-intentos', costo_usd: 0, latencia_ms: Date.now() - t0, shadow: agente.shadow, fue_al_buzon: false, motivo_skip: 'dlq' };
    }
    await sb.from('evento_pg')
      .update({ intentos_agente: intentosPrevios + 1 } as any)
      .eq('id', params.evento_id);
  }

  // ─── 4. CARGAR CORRECCIONES PREVIAS (memoria de errores pasados) ───
  const { data: correccionesRaw } = await sb
    .from('correcciones')
    .select('campo, valor_nuevo, ts')
    .eq('persona_id', params.persona_id)
    .eq('agente_codigo', agente.codigo)
    .order('ts', { ascending: false })
    .limit(20);
  const correcciones_previas = (correccionesRaw ?? []).map(c => ({ campo: c.campo, valor_nuevo: c.valor_nuevo, ts: c.ts }));

  // ─── 5. CARGAR CONTEXTO ────────────────────────────────────────────
  let datos: TDatos;
  try {
    datos = await hooks.cargarContexto(sb, { ...params, correcciones_previas });
  } catch (e: any) {
    return await finalizarConError(sb, agente, params, t0, 0, intentosPrevios + 1, 'cargarContexto: ' + e.message, tag);
  }

  // ─── 6. ANTI-CONTAMINACIÓN: cargar identificadores de otros clientes
  const identificadores_otros_clientes = await cargarOtrosClientes(sb, params.persona_id);

  // ─── 7. CARGAR msg_ids del chat para validar evidencia
  const { data: msgs } = await sb
    .from('mensajes')
    .select('canal_msg_id')
    .eq('chat_id', params.chat_id)
    .is('deleted_at', null);
  const msg_ids_disponibles = new Set((msgs ?? []).map(m => m.canal_msg_id));

  // ─── 8-11. OBTENER OUTPUT — vía LLM o vía procesarSinLLM
  // Dos caminos: si el hook define procesarSinLLM (Whisper, Vision, lookup),
  // lo usamos y salteamos chat LLM + parse JSON. Si no, flujo normal con DeepSeek.
  let output: OutputAgente;
  let costoInvocacion = 0;
  let latenciaInvocacion = 0;
  let modeloInvocacion = 'deepseek-chat';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let tokensCached: number | null = null;

  if (hooks.procesarSinLLM) {
    // Camino non-LLM
    try {
      const r = await hooks.procesarSinLLM(sb, datos, agente, params);
      output = r.output;
      costoInvocacion = r.costo_usd;
      latenciaInvocacion = r.latencia_ms;
      modeloInvocacion = r.modelo;
      tokensIn = r.tokens_in ?? null;
      tokensOut = r.tokens_out ?? null;
      tokensCached = r.tokens_cached ?? null;
    } catch (e: any) {
      return await finalizarConError(sb, agente, params, t0, 0, intentosPrevios + 1, 'procesarSinLLM: ' + e.message, tag);
    }
  } else if (hooks.construirPrompt) {
    // Camino chat LLM (DeepSeek)
    let messages: ChatMessage[];
    try {
      messages = hooks.construirPrompt(datos, agente);
      if (correcciones_previas.length > 0 && messages.length > 0 && messages[0].role === 'system') {
        const correccionesTexto = correcciones_previas
          .slice(0, 5)
          .map(c => `- ${c.campo}: ${JSON.stringify(c.valor_nuevo)}`)
          .join('\n');
        messages[0] = {
          ...messages[0],
          content: messages[0].content +
            `\n\n# CORRECCIONES PREVIAS DEL HUMANO PARA ESTA PERSONA\n` +
            `Tenelas en cuenta. NO repitas errores corregidos antes:\n${correccionesTexto}`,
        };
      }
    } catch (e: any) {
      return await finalizarConError(sb, agente, params, t0, 0, intentosPrevios + 1, 'construirPrompt: ' + e.message, tag);
    }

    let llm: DeepSeekResult;
    try {
      llm = await deepseekChat({
        messages,
        response_format: { type: 'json_object' },
        max_tokens: 1000,
        costoLimiteUsd: agente.costo_limite_usd,
        agente: agente.codigo,
      });
    } catch (e: any) {
      return await finalizarConError(sb, agente, params, t0, 0, intentosPrevios + 1, 'LLM: ' + e.message, tag);
    }
    costoInvocacion = llm.costo_usd;
    latenciaInvocacion = llm.latencia_ms;
    modeloInvocacion = 'deepseek-chat';
    tokensIn = llm.tokens_in;
    tokensOut = llm.tokens_out;
    tokensCached = llm.tokens_cached;

    // Parsear JSON del LLM
    const parsed = parsearJSONSeguro(llm.contenido);
    if (!parsed.ok) {
      const parseErr = (parsed as { ok: false; error: string }).error;
      // Persistir invocación fallida antes de salir
      const { data: invErr } = await sb.from('agente_invocaciones').insert({
        agente_codigo: agente.codigo, evento_id: params.evento_id, persona_id: params.persona_id,
        modelo: modeloInvocacion, tokens_in: tokensIn, tokens_out: tokensOut, tokens_cached: tokensCached,
        costo_usd: costoInvocacion, latencia_ms: latenciaInvocacion, intentos: intentosPrevios + 1,
        ok: false, error_msg: 'parse: ' + parseErr, shadow: agente.shadow,
      } as any).select('id').maybeSingle();
      invocacionId = invErr?.id ?? null;
      return await finalizarConError(sb, agente, params, t0, costoInvocacion, intentosPrevios + 1, 'parse: ' + parseErr, tag);
    }
    output = parsed.data as OutputAgente;
  } else {
    return await finalizarConError(sb, agente, params, t0, 0, intentosPrevios + 1,
      `agente ${agente.codigo} no define construirPrompt ni procesarSinLLM`, tag);
  }

  // ─── PERSISTIR agente_invocaciones (común a ambos caminos)
  const { data: invRow } = await sb.from('agente_invocaciones').insert({
    agente_codigo: agente.codigo,
    evento_id: params.evento_id,
    persona_id: params.persona_id,
    modelo: modeloInvocacion,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    tokens_cached: tokensCached,
    costo_usd: costoInvocacion,
    latencia_ms: latenciaInvocacion,
    intentos: intentosPrevios + 1,
    ok: true,
    shadow: agente.shadow,
  } as any).select('id').maybeSingle();
  invocacionId = invRow?.id ?? null;

  // ─── 12. VALIDAR (estándar + específico)
  const ctxVal: ContextoValidacion = {
    persona_id_actual: params.persona_id,
    identificadores_otros_clientes,
    msg_ids_disponibles,
    agente: agente.codigo,
  };
  try {
    validarOutput(output, ctxVal);
    if (hooks.validarOutputEspecifico) hooks.validarOutputEspecifico(output, datos);
  } catch (e: any) {
    if (e instanceof ValidacionError) {
      await sb.from('evento_pg').insert({
        canal: 'interno', ambito: params.ambito, tipo_evento: 'alerta',
        estado: 'PROCESADO', persona_id: params.persona_id, proyecto_id: params.proyecto_id, chat_id: params.chat_id,
        agente_origen: agente.codigo, evento_padre_id: params.evento_id,
        confianza: 'RECHAZADO', costo_usd: costoInvocacion,
        payload: { regla_violada: e.regla, mensaje: e.message, output_intentado: output },
        ts_canal: new Date().toISOString(),
      } as any);
      await marcarInvocacionError(sb, invocacionId, `validación: ${e.regla} ${e.message}`);
      await sb.from('evento_pg').update({ procesando_por: null, procesando_hasta: null }).eq('id', params.evento_id);
      console.error(`[${tag}] validación falló (${e.regla}):`, e.message);
      return { ok: false, error: e.message, costo_usd: costoInvocacion, latencia_ms: Date.now() - t0, shadow: agente.shadow, fue_al_buzon: false };
    }
    throw e;
  }

  // ─── 13. MODO SHADOW: NO escribe a tablas de negocio, solo loggea
  const ctxAgente: ContextoAgente = {
    agente, evento_id: params.evento_id, chat_id: params.chat_id, persona_id: params.persona_id,
    proyecto_id: params.proyecto_id, ambito: params.ambito,
    datos, identificadores_otros_clientes, msg_ids_disponibles, correcciones_previas,
  };

  if (agente.shadow) {
    console.log(`[${tag}] SHADOW · ${latenciaInvocacion}ms · $${costoInvocacion.toFixed(6)} · ${modeloInvocacion} · out:`, JSON.stringify(output).slice(0, 200));
    await sb.from('evento_pg').insert({
      canal: 'interno', ambito: params.ambito, tipo_evento: output.tipo_evento,
      estado: 'PROCESADO', persona_id: params.persona_id, proyecto_id: params.proyecto_id, chat_id: params.chat_id,
      agente_origen: agente.codigo, evento_padre_id: params.evento_id,
      confianza: output.confianza, costo_usd: costoInvocacion,
      shadow: true,
      payload: output.payload,
      evidencia_ids: { msg_ids: output.evidencia_msg_ids },
      ts_canal: new Date().toISOString(),
    } as any);
    // Liberar lock
    await sb.from('evento_pg').update({ procesando_por: null, procesando_hasta: null }).eq('id', params.evento_id);
    return { ok: true, output, costo_usd: costoInvocacion, latencia_ms: Date.now() - t0, shadow: true, fue_al_buzon: false };
  }

  // ─── 14. POST-PROCESAR (escribir a tablas de negocio)
  let entidadInfo: { entidad_tipo?: string; entidad_id?: number } = {};
  try {
    const ret = await hooks.postProcesar(sb, output, ctxAgente);
    if (ret) entidadInfo = ret;
  } catch (e: any) {
    await marcarInvocacionError(sb, invocacionId, 'postProcesar: ' + e.message);
    return await finalizarConError(sb, agente, params, t0, costoInvocacion, intentosPrevios + 1, 'postProcesar: ' + e.message, tag);
  }

  // ─── 15. REGISTRAR evento_pg de la inferencia
  const { data: evtNew } = await sb.from('evento_pg').insert({
    canal: 'interno', ambito: params.ambito, tipo_evento: output.tipo_evento,
    estado: 'PROCESADO', persona_id: params.persona_id, proyecto_id: params.proyecto_id, chat_id: params.chat_id,
    agente_origen: agente.codigo, evento_padre_id: params.evento_id,
    confianza: output.confianza, costo_usd: costoInvocacion,
    payload: output.payload,
    evidencia_ids: { msg_ids: output.evidencia_msg_ids },
    ts_canal: new Date().toISOString(),
  } as any).select('id').maybeSingle();

  // ─── 16. SOLO confianza=ALERTA va al buzón (contradicción / riesgo grave).
  //         CONFIRMADO / INFERIDO / DUDOSO escriben directo al módulo, visibles.
  //         Decisión de Jhon (2026-05-19): cero aprobación rutinaria — los
  //         agentes trabajan solos, Jhon corrige post-hoc en el módulo.
  let fue_al_buzon = false;
  if (output.confianza === 'ALERTA') {
    await sb.from('buzon_validacion').insert({
      evento_id: evtNew?.id,
      proyecto_id: params.proyecto_id,
      persona_id: params.persona_id,
      ambito: params.ambito,
      tipo_decision: mapTipoDecision(output.tipo_evento),
      entidad_tipo: entidadInfo.entidad_tipo ?? null,
      entidad_id: entidadInfo.entidad_id ?? null,
      resumen: (output.payload as any)?.resumen ?? (output.payload as any)?.preview ?? `${output.tipo_evento} inferido por ${agente.codigo}`,
      detalle: output.payload,
      evidencia_ids: { msg_ids: output.evidencia_msg_ids },
      reglas_aplicadas: output.reglas_aplicadas ?? [],
      prioridad: output.confianza === 'ALERTA' ? 1 : (output.confianza === 'DUDOSO' ? 4 : 3),
      estado: 'pendiente',
    } as any);
    fue_al_buzon = true;
  }

  // ─── 17. Liberar lock + reset intentos (éxito)
  await sb.from('evento_pg')
    .update({ procesando_por: null, procesando_hasta: null, intentos_agente: 0 } as any)
    .eq('id', params.evento_id);

  console.log(`[${tag}] ✓ ${output.tipo_evento} · ${output.confianza} · $${costoInvocacion.toFixed(6)} · ${modeloInvocacion} · ${fue_al_buzon ? 'AL BUZÓN' : 'directo'}`);
  return { ok: true, output, costo_usd: costoInvocacion, latencia_ms: Date.now() - t0, shadow: false, fue_al_buzon };
}

// ── Helpers privados ─────────────────────────────────────────────────

async function marcarInvocacionError(sb: SupabaseClient, invId: number | null, errorMsg: string) {
  if (!invId) return;
  await sb.from('agente_invocaciones').update({ ok: false, error_msg: errorMsg }).eq('id', invId);
}

async function finalizarConError(
  sb: SupabaseClient,
  agente: AgenteDefinicion,
  params: { evento_id: number; chat_id: number; persona_id: number; proyecto_id: number | null; ambito: string },
  t0: number,
  costo_usd: number,
  intentos: number,
  errorMsg: string,
  tag: string,
): Promise<ResultadoEjecucion> {
  console.error(`[${tag}]`, errorMsg);
  // Liberar lock para que el siguiente reintento lo pueda tomar
  await sb.from('evento_pg').update({ procesando_por: null, procesando_hasta: null }).eq('id', params.evento_id);
  // Si llegamos al máximo en este intento → DLQ
  if (intentos >= MAX_INTENTOS_AGENTE) {
    await sb.from('dead_letter_queue').insert({
      evento_id: params.evento_id,
      agente_codigo: agente.codigo,
      ultimo_error: errorMsg,
      intentos,
    } as any);
    await sb.from('evento_pg').update({ estado: 'ERROR' }).eq('id', params.evento_id);
  }
  return { ok: false, error: errorMsg, costo_usd, latencia_ms: Date.now() - t0, shadow: agente.shadow, fue_al_buzon: false };
}

/**
 * Carga identificadores (nombres, telefonos, emails) de OTROS clientes.
 * Usado para validación anti-contaminación cross-cliente.
 */
async function cargarOtrosClientes(sb: SupabaseClient, persona_id_actual: number): Promise<string[]> {
  const { data } = await sb
    .from('personas')
    .select('nombre, alias, telefono_e164, email, empresa')
    .neq('id', persona_id_actual)
    .is('deleted_at', null)
    .limit(500);
  const out: string[] = [];
  for (const p of data ?? []) {
    if (p.nombre) out.push(p.nombre);
    if (p.alias) out.push(p.alias);
    if (p.telefono_e164) out.push(p.telefono_e164);
    if (p.email) out.push(p.email);
    if (p.empresa) out.push(p.empresa);
  }
  return out;
}

/**
 * Carga la definición de un agente desde BD (con cache).
 * Hot reload: cuando se actualiza el prompt, en la próxima invocación se relee.
 *
 * NUEVO: si agente.activo=false PERO agente.shadow=true → se permite correr
 * (modo dry-run para testing antes de activar).
 */
const cacheAgentes = new Map<string, { agente: AgenteDefinicion; ts: number }>();
const AGENT_CACHE_TTL_MS = 30_000;

export async function cargarAgenteDefinicion(sb: SupabaseClient, codigo: string): Promise<AgenteDefinicion> {
  const cached = cacheAgentes.get(codigo);
  if (cached && Date.now() - cached.ts < AGENT_CACHE_TTL_MS) return cached.agente;

  const { data, error } = await sb
    .from('agentes_definicion')
    .select('codigo, nombre, proposito, ambitos, prompt_especifico, costo_limite_usd, shadow, reglas_duras, version, activo')
    .eq('codigo', codigo)
    .maybeSingle();

  if (error || !data) throw new Error(`Agente '${codigo}' no encontrado: ${error?.message}`);
  // Solo bloquea si está desactivado Y NO está en shadow (shadow=true es modo dry-run permitido)
  if (!data.activo && !data.shadow) throw new Error(`Agente '${codigo}' desactivado y no en shadow — no puede correr`);

  const agente: AgenteDefinicion = {
    codigo: data.codigo,
    nombre: data.nombre,
    proposito: data.proposito,
    ambitos: data.ambitos ?? [],
    prompt_especifico: data.prompt_especifico,
    costo_limite_usd: Number(data.costo_limite_usd ?? 0.05),
    shadow: !!data.shadow,
    reglas_duras: data.reglas_duras ?? [],
    version: data.version ?? 1,
  };
  cacheAgentes.set(codigo, { agente, ts: Date.now() });
  return agente;
}
