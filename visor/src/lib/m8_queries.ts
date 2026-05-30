/**
 * Queries del MÓDULO 8 — Agentes.
 *
 * 5 sub-tabs:
 *   8.1 Lista agentes      → agentes_definicion + vw_centro_control_agentes
 *   8.2 Pipelines          → agente_pipelines
 *   8.3 Invocaciones       → agente_invocaciones
 *   8.4 DLQ                → dead_letter_queue
 *   8.5 Correcciones       → correcciones
 *
 * Todo es GLOBAL (no requiere persona/chat/proyecto activo).
 */
import { supabase } from './supabase';

// ─── 8.1 Lista agentes ─────────────────────────────────────────────────────

export interface AgenteRow {
  codigo: string;
  nombre: string;
  proposito: string | null;
  ambitos: string[];
  criticidad: 'alta' | 'media' | 'baja';
  costo_limite_usd: number;
  activo: boolean;
  shadow: boolean;
  version: number;
  // métricas de la vista
  invocaciones_hoy: number;
  exitos_hoy: number;
  errores_hoy: number;
  costo_hoy_usd: number;
  latencia_promedio_ms: number;
  ultima_invocacion: string | null;
  en_dead_letter_queue: number;
}

export async function fetchAgentes(): Promise<AgenteRow[]> {
  // Join: definicion + métricas. La vista ya une ambos.
  const { data: vista, error: vErr } = await supabase
    .from('vw_centro_control_agentes')
    .select('*');
  if (vErr) throw vErr;

  // Trae proposito/ambitos/version desde la tabla original
  const { data: defs, error: dErr } = await supabase
    .from('agentes_definicion')
    .select('codigo, proposito, ambitos, version, costo_limite_usd, criticidad');
  if (dErr) throw dErr;
  const defByCod = new Map((defs ?? []).map((d: any) => [d.codigo, d]));

  return (vista ?? []).map((v: any): AgenteRow => {
    const d = defByCod.get(v.agente_codigo) ?? {};
    return {
      codigo: v.agente_codigo,
      nombre: v.agente_nombre,
      proposito: (d as any).proposito ?? null,
      ambitos: (d as any).ambitos ?? [],
      criticidad: (v.criticidad ?? (d as any).criticidad ?? 'media') as 'alta' | 'media' | 'baja',
      costo_limite_usd: Number(v.costo_limite_usd ?? (d as any).costo_limite_usd ?? 0),
      activo: !!v.activo,
      shadow: !!v.modo_shadow,
      version: (d as any).version ?? 1,
      invocaciones_hoy: Number(v.invocaciones_hoy ?? 0),
      exitos_hoy: Number(v.exitos_hoy ?? 0),
      errores_hoy: Number(v.errores_hoy ?? 0),
      costo_hoy_usd: Number(v.costo_hoy_usd ?? 0),
      latencia_promedio_ms: Number(v.latencia_promedio_ms ?? 0),
      ultima_invocacion: v.ultima_invocacion ?? null,
      en_dead_letter_queue: Number(v.en_dead_letter_queue ?? 0),
    };
  }).sort((a, b) => a.codigo.localeCompare(b.codigo));
}

export async function toggleAgenteActivo(codigo: string, activo: boolean): Promise<void> {
  const { error } = await supabase
    .from('agentes_definicion')
    .update({ activo })
    .eq('codigo', codigo);
  if (error) throw error;
}

export async function toggleAgenteShadow(codigo: string, shadow: boolean): Promise<void> {
  const { error } = await supabase
    .from('agentes_definicion')
    .update({ shadow })
    .eq('codigo', codigo);
  if (error) throw error;
}

// ─── 8.2 Pipelines ─────────────────────────────────────────────────────────

export interface PipelineRow {
  id: number;
  codigo: string;
  descripcion: string | null;
  trigger_tipo_evento: string;
  trigger_condiciones: Record<string, any> | null;
  pasos: { fases: Array<{ id: string; modo: string; agentes?: string[]; switch_on?: string; rutas?: Record<string, string[]> }> };
  activo: boolean;
  shadow: boolean;
  prioridad: number;
  costo_max_estimado_usd: number;
  version: number;
}

export async function fetchPipelines(): Promise<PipelineRow[]> {
  const { data, error } = await supabase
    .from('agente_pipelines')
    .select('*')
    .order('prioridad', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PipelineRow[];
}

// ─── 8.3 Invocaciones ──────────────────────────────────────────────────────

export interface InvocacionRow {
  id: number;
  agente_codigo: string;
  evento_id: number | null;
  persona_id: number | null;
  modelo: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
  costo_usd: number;
  latencia_ms: number | null;
  intentos: number;
  ok: boolean;
  error_msg: string | null;
  shadow: boolean;
  created_at: string;
}

export async function fetchInvocaciones(filtros: {
  agente?: string;
  soloErrores?: boolean;
  limite?: number;
} = {}): Promise<InvocacionRow[]> {
  let q = supabase
    .from('agente_invocaciones')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(filtros.limite ?? 100);
  if (filtros.agente) q = q.eq('agente_codigo', filtros.agente);
  if (filtros.soloErrores) q = q.eq('ok', false);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as InvocacionRow[];
}

// ─── 8.4 Dead Letter Queue ─────────────────────────────────────────────────

export interface DLQRow {
  id: number;
  evento_id: number;
  agente_codigo: string | null;
  intentos: number;
  ultimo_error: string;
  stack_trace: string | null;
  ts_primer_fallo: string;
  ts_ultimo_fallo: string;
  resuelto_at: string | null;
}

export async function fetchDLQ(soloPendientes: boolean = true): Promise<DLQRow[]> {
  let q = supabase
    .from('dead_letter_queue')
    .select('*')
    .order('ts_ultimo_fallo', { ascending: false });
  if (soloPendientes) q = q.is('resuelto_at', null);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as DLQRow[];
}

export async function resolverDLQ(id: number): Promise<void> {
  const { error } = await supabase
    .from('dead_letter_queue')
    .update({ resuelto_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function reintentarDLQ(id: number, eventoId: number): Promise<void> {
  // Marcar resuelto + resetear evento a NUEVO para que el worker lo agarre
  const { error: dErr } = await supabase
    .from('dead_letter_queue')
    .update({ resuelto_at: new Date().toISOString() })
    .eq('id', id);
  if (dErr) throw dErr;
  const { error: eErr } = await supabase
    .from('evento_pg')
    .update({ estado: 'NUEVO', procesando_por: null, procesando_hasta: null, intentos_agente: 0 })
    .eq('id', eventoId);
  if (eErr) throw eErr;
}

// ─── 8.5 Correcciones ──────────────────────────────────────────────────────

export interface CorreccionRow {
  id: number;
  evento_origen_id: number | null;
  persona_id: number | null;
  proyecto_id: number | null;
  agente_codigo: string | null;
  campo: string;
  valor_anterior: any;
  valor_nuevo: any;
  motivo: string | null;
  corregido_por: number | null;
  ts: string;
}

export async function fetchCorrecciones(filtros: { agente?: string; limite?: number } = {}): Promise<CorreccionRow[]> {
  let q = supabase
    .from('correcciones')
    .select('*')
    .order('ts', { ascending: false })
    .limit(filtros.limite ?? 100);
  if (filtros.agente) q = q.eq('agente_codigo', filtros.agente);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as CorreccionRow[];
}
