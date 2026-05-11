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
 *   - Tope hard de costo
 *   - Modo shadow (no escribe a tablas, solo loggea)
 *   - Validación estándar (anti-alucinación + anti-contaminación + reglas duras)
 *   - Idempotencia (no re-procesa el mismo evento si ya tiene output)
 *   - Registrar costo en evento_pg
 *   - Mandar al buzón si confianza < CONFIRMADO
 *   - Logging consistente
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat, type ChatMessage, type DeepSeekResult } from './llm.js';
import { validarOutput, parsearJSONSeguro, type OutputAgente, type ContextoValidacion, ValidacionError } from './validador.js';

export interface AgenteDefinicion {
  codigo: string;                    // 'A5', 'B1', 'TRANSCRIBOR'
  nombre: string;                    // 'A5_cotizaciones'
  proposito: string;
  ambitos: string[];                 // ['comercial']
  prompt_especifico: string;
  costo_limite_usd: number;          // default 0.05
  shadow: boolean;                   // si true, NO escribe a tablas (R-IA-001)
  reglas_duras: string[];            // ['R-001', 'R-013#1']
  version: number;
}

export interface ContextoAgente {
  agente: AgenteDefinicion;
  evento_id: number;                 // evento que dispara la invocación
  chat_id: number;
  persona_id: number;
  proyecto_id: number | null;
  ambito: string;
  // Datos del contexto cargados por el hook cargarContexto
  datos: any;
  // Para validación cross-cliente
  identificadores_otros_clientes: string[];
  msg_ids_disponibles: Set<string>;
}

export interface ResultadoEjecucion {
  ok: boolean;
  output?: OutputAgente;
  costo_usd: number;
  latencia_ms: number;
  shadow: boolean;
  error?: string;
  fue_al_buzon: boolean;
}

/**
 * Hooks que cada agente provee.
 */
export interface AgenteHooks<TDatos = any> {
  cargarContexto(sb: SupabaseClient, params: { evento_id: number; chat_id: number; persona_id: number; proyecto_id: number | null }): Promise<TDatos>;
  construirPrompt(datos: TDatos, agente: AgenteDefinicion): ChatMessage[];
  validarOutputEspecifico?(out: OutputAgente, datos: TDatos): void;
  postProcesar(sb: SupabaseClient, out: OutputAgente, ctx: ContextoAgente): Promise<void>;
}

const TIPOS_VAN_AL_BUZON: ReadonlyArray<string> = [
  // todo lo que NO sea CONFIRMADO o que toque dinero/medida/instalación va al buzón
];

/**
 * Ejecuta un agente sobre un evento específico.
 */
export async function ejecutarAgente<TDatos = any>(
  sb: SupabaseClient,
  agente: AgenteDefinicion,
  params: { evento_id: number; chat_id: number; persona_id: number; proyecto_id: number | null; ambito: string },
  hooks: AgenteHooks<TDatos>,
): Promise<ResultadoEjecucion> {
  const t0 = Date.now();
  const tag = `${agente.codigo}/ev${params.evento_id}`;

  // 1. Cargar contexto
  let datos: TDatos;
  try {
    datos = await hooks.cargarContexto(sb, params);
  } catch (e: any) {
    console.error(`[${tag}] cargarContexto error:`, e.message);
    return { ok: false, error: 'cargarContexto: ' + e.message, costo_usd: 0, latencia_ms: Date.now() - t0, shadow: agente.shadow, fue_al_buzon: false };
  }

  // 2. Cargar identificadores de otros clientes (para anti-contaminación)
  const identificadores_otros_clientes = await cargarOtrosClientes(sb, params.persona_id);

  // 3. Cargar msg_ids del chat actual (para validar evidencia)
  const { data: msgs } = await sb
    .from('mensajes')
    .select('canal_msg_id')
    .eq('chat_id', params.chat_id)
    .is('deleted_at', null);
  const msg_ids_disponibles = new Set((msgs ?? []).map(m => m.canal_msg_id));

  // 4. Construir prompt
  const messages = hooks.construirPrompt(datos, agente);

  // 5. Llamar LLM
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
    console.error(`[${tag}] LLM error:`, e.message);
    return { ok: false, error: 'LLM: ' + e.message, costo_usd: 0, latencia_ms: Date.now() - t0, shadow: agente.shadow, fue_al_buzon: false };
  }

  // 6. Parsear JSON
  const parsed = parsearJSONSeguro(llm.contenido);
  if (!parsed.ok) {
    console.error(`[${tag}] parse error:`, parsed.error);
    return { ok: false, error: 'parse: ' + parsed.error, costo_usd: llm.costo_usd, latencia_ms: Date.now() - t0, shadow: agente.shadow, fue_al_buzon: false };
  }
  const output = parsed.data as OutputAgente;

  // 7. Validar (estándar + específico)
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
      console.error(`[${tag}] validación falló (${e.regla}):`, e.message);
      // Registrar el rechazo como evento_pg con tipo='alerta'
      await sb.from('evento_pg').insert({
        canal: 'interno', ambito: params.ambito, tipo_evento: 'alerta',
        estado: 'PROCESADO', persona_id: params.persona_id, proyecto_id: params.proyecto_id, chat_id: params.chat_id,
        agente_origen: agente.codigo, evento_padre_id: params.evento_id,
        confianza: 'RECHAZADO', costo_usd: llm.costo_usd,
        payload: { regla_violada: e.regla, mensaje: e.message, output_intentado: output },
        ts_canal: new Date().toISOString(),
      });
      return { ok: false, error: e.message, costo_usd: llm.costo_usd, latencia_ms: Date.now() - t0, shadow: agente.shadow, fue_al_buzon: false };
    }
    throw e;
  }

  // 8. Si modo shadow: NO escribe a tablas de negocio. Solo loggea.
  if (agente.shadow) {
    console.log(`[${tag}] SHADOW · ${llm.latencia_ms}ms · $${llm.costo_usd.toFixed(6)} · output:`, JSON.stringify(output).slice(0, 200));
    await sb.from('evento_pg').insert({
      canal: 'interno', ambito: params.ambito, tipo_evento: output.tipo_evento,
      estado: 'PROCESADO', persona_id: params.persona_id, proyecto_id: params.proyecto_id, chat_id: params.chat_id,
      agente_origen: agente.codigo, evento_padre_id: params.evento_id,
      confianza: output.confianza, costo_usd: llm.costo_usd,
      shadow: true,
      payload: output.payload,
      evidencia_ids: { msg_ids: output.evidencia_msg_ids },
      ts_canal: new Date().toISOString(),
    });
    return { ok: true, output, costo_usd: llm.costo_usd, latencia_ms: Date.now() - t0, shadow: true, fue_al_buzon: false };
  }

  // 9. Modo activo: escribir a evento_pg + post-procesar tablas de negocio
  const ctxAgente: ContextoAgente = {
    agente, evento_id: params.evento_id, chat_id: params.chat_id, persona_id: params.persona_id,
    proyecto_id: params.proyecto_id, ambito: params.ambito,
    datos, identificadores_otros_clientes, msg_ids_disponibles,
  };

  try {
    await hooks.postProcesar(sb, output, ctxAgente);
  } catch (e: any) {
    console.error(`[${tag}] postProcesar error:`, e.message);
    return { ok: false, error: 'postProcesar: ' + e.message, costo_usd: llm.costo_usd, latencia_ms: Date.now() - t0, shadow: false, fue_al_buzon: false };
  }

  // 10. Registrar evento_pg
  const { data: evtNew } = await sb.from('evento_pg').insert({
    canal: 'interno', ambito: params.ambito, tipo_evento: output.tipo_evento,
    estado: 'PROCESADO', persona_id: params.persona_id, proyecto_id: params.proyecto_id, chat_id: params.chat_id,
    agente_origen: agente.codigo, evento_padre_id: params.evento_id,
    confianza: output.confianza, costo_usd: llm.costo_usd,
    payload: output.payload,
    evidencia_ids: { msg_ids: output.evidencia_msg_ids },
    ts_canal: new Date().toISOString(),
  }).select('id').single();

  // 11. Si confianza no es CONFIRMADO → al buzón
  let fue_al_buzon = false;
  if (output.confianza !== 'CONFIRMADO' && output.confianza !== 'RECHAZADO') {
    await sb.from('buzon_validacion').insert({
      evento_id: evtNew?.id,
      proyecto_id: params.proyecto_id,
      persona_id: params.persona_id,
      ambito: params.ambito,
      tipo_decision: output.tipo_evento,
      resumen: output.payload?.resumen ?? output.payload?.preview ?? `${output.tipo_evento} inferido por ${agente.codigo}`,
      detalle: output.payload,
      evidencia_ids: { msg_ids: output.evidencia_msg_ids },
      reglas_aplicadas: output.reglas_aplicadas ?? [],
      prioridad: output.confianza === 'ALERTA' ? 1 : (output.confianza === 'DUDOSO' ? 4 : 3),
      estado: 'pendiente',
    });
    fue_al_buzon = true;
  }

  console.log(`[${tag}] ✓ ${output.tipo_evento} · ${output.confianza} · $${llm.costo_usd.toFixed(6)} · ${fue_al_buzon ? 'AL BUZÓN' : 'directo'}`);

  return { ok: true, output, costo_usd: llm.costo_usd, latencia_ms: Date.now() - t0, shadow: false, fue_al_buzon };
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
    .single();

  if (error || !data) throw new Error(`Agente '${codigo}' no encontrado: ${error?.message}`);
  if (!data.activo) throw new Error(`Agente '${codigo}' está desactivado`);

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
