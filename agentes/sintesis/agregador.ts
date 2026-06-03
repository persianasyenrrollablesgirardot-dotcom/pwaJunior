/**
 * AGREGADOR V2 — construye la "tarjeta" (contexto materializado) de UN cliente.
 *
 * Lee lo que los 32 agentes YA dejaron en `modulo_sintesis` + las notas de Jhon
 * (`notas_libres`, verdad prioritaria) y arma la tarjeta:
 *   · contexto_estructurado: los hechos por módulo VERBATIM (no se reescriben).
 *   · narrativa: única parte LLM — un párrafo corto de "estado general".
 *
 * Principio (ARQUITECTURA_V2.md §2): ENSAMBLAR, no resumir. Lo estructurado se
 * ordena tal cual; el LLM solo redacta el estado general y NO inventa hechos.
 *
 * Hito 1: por ahora solo CONSTRUYE y devuelve la tarjeta (no persiste tablas).
 * Sirve para que Jhon valide que la tarjeta refleja bien al cliente real.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat, type ChatMessage } from '../lib/llm.js';

const MODULO_NOMBRE: Record<string, string> = {
  m1: 'Identidad', m2: 'Comercial', m3: 'Financiero', m4: 'Técnico',
  m5: 'Operativo', m6: 'Postventa', m7: 'Evidencias',
};
const ORDEN = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];

export interface ModuloCtx { modulo: string; titulo: string; sintesis: string; alerta: string | null }
/** Insumos de la tarjeta SIN LLM — baratos de leer, sirven para calcular el hash. */
export interface Insumos {
  persona_id: number;
  nombre: string;
  tipo_contacto: string;
  contexto_estructurado: ModuloCtx[];
  notas: string[];
}
export interface Tarjeta extends Insumos {
  narrativa: string;
  costo_usd: number;
}

/**
 * ¿El evento de un agente trae un HALLAZGO sustantivo? (señales genéricas sobre
 * el payload, no sobre el texto). Sirve para que el módulo "qué entendieron los
 * agentes" muestre SOLO los que aportan algo, y no se llene de "no hay X".
 */
function aportaHallazgo(payload: any): boolean {
  if (!payload || typeof payload !== 'object') return false;
  // 1. Algún array de resultados con contenido.
  const ARRAYS = ['items', 'objeciones', 'menciones', 'menciones_terceros', 'tareas',
    'riesgos_detectados', 'candidatos_fusion', 'validaciones', 'alertas',
    'referidos_propuestos', 'medidas_adicionales', 'montos', 'medidas', 'entidades'];
  for (const k of ARRAYS) if (Array.isArray(payload[k]) && payload[k].length > 0) return true;
  // 2. Flags de hallazgo en true.
  const FLAGS = ['hay_reclamo', 'hay_abono', 'hay_comprobante', 'hay_reporte_falla',
    'hay_referidos', 'tiene_riesgos_altos', 'tiene_alertas_criticas', 'cambio_propuesto'];
  for (const k of FLAGS) if (payload[k] === true) return true;
  // 3. Valores puntuales presentes / clasificaciones que aportan contexto.
  if (payload.alto_m != null || payload.ancho_m != null) return true;     // A6_MEDIDAS
  if (payload.abono != null) return true;                                  // A5_ABONO
  if (payload.es_cliente === false) return true;                           // A2_NOCLIENTE marca no-cliente
  if (payload.rol_emisor && payload.rol_emisor !== 'cliente') return true; // A2_ROL ≠ cliente (familiar/intermediario…)
  if (payload.ambito_propuesto) return true;                               // A2_AMBITO propone cambio
  if (typeof payload.intencion === 'string' && !['otro', 'saludo', ''].includes(payload.intencion)) return true; // A2_INTENCION útil
  return false;
}

/**
 * Lee los insumos de la tarjeta (hechos por módulo + notas). NO llama al LLM,
 * así el motor puede calcular el hash y decidir si hace falta rehacer ANTES de
 * gastar en la narrativa.
 */
export async function leerInsumosTarjeta(sb: SupabaseClient, personaId: number): Promise<Insumos> {
  const { data: persona, error } = await sb.from('personas')
    .select('id, nombre, ambito_principal, notas').eq('id', personaId).maybeSingle();
  if (error) throw new Error(`leer persona ${personaId}: ${error.message}`);
  if (!persona) throw new Error(`persona ${personaId} no existe`);

  // Hechos por módulo (verbatim) que dejaron los 32 agentes.
  const { data: sints } = await sb.from('modulo_sintesis')
    .select('modulo, sintesis, alerta').eq('persona_id', personaId);
  const porModulo = new Map((sints ?? []).map((s: any) => [s.modulo, s]));
  const contexto_estructurado: ModuloCtx[] = ORDEN.filter(m => porModulo.has(m)).map(m => {
    const s = porModulo.get(m);
    return { modulo: m, titulo: MODULO_NOMBRE[m] ?? m, sintesis: s.sintesis, alerta: s.alerta ?? null };
  });

  // Modelo híbrido: "qué entendió cada agente" (verbatim) desde el payload de
  // sus eventos. Tomamos el contexto_entendido más reciente por agente y
  // filtramos el ruido de "no aplica" para no inflar la tarjeta. Se suma como un
  // módulo más → aparece en la UI sin migración ni tocar el front.
  const { data: evCtx } = await sb.from('evento_pg')
    .select('agente_origen, payload, ts_creado')
    .eq('persona_id', personaId)
    .is('deleted_at', null)
    .order('ts_creado', { ascending: false })
    .limit(120);
  const ctxPorAgente = new Map<string, string>();
  for (const e of evCtx ?? []) {
    const txt = String((e.payload as any)?.contexto_entendido ?? '').trim();
    // Solo incluir agentes que aportan un HALLAZGO real (por payload, no por texto):
    // así el módulo queda conciso y no se llena de "no hay X de mi dominio".
    if (txt && e.agente_origen && !ctxPorAgente.has(e.agente_origen) && aportaHallazgo(e.payload)) {
      ctxPorAgente.set(e.agente_origen, txt);
    }
  }
  if (ctxPorAgente.size) {
    const texto = [...ctxPorAgente.entries()].map(([ag, t]) => `• ${ag}: ${t}`).join('\n');
    contexto_estructurado.push({ modulo: 'agentes', titulo: '🧩 Qué entendieron los agentes', sintesis: texto, alerta: null });
  }

  // Notas de Jhon (verdad prioritaria): columna personas.notas + tabla notas_libres.
  const { data: notasRows } = await sb.from('notas_libres')
    .select('contenido').eq('persona_id', personaId).is('deleted_at', null);
  const notas = [persona.notas, ...((notasRows ?? []).map((n: any) => n.contenido))]
    .filter(Boolean) as string[];

  const tipo_contacto = (persona.ambito_principal && persona.ambito_principal !== 'comercial')
    ? persona.ambito_principal : 'comercial';

  return { persona_id: personaId, nombre: persona.nombre, tipo_contacto, contexto_estructurado, notas };
}

/**
 * Redacta la narrativa "estado general" — ÚNICA parte LLM. Recibe los insumos y
 * NO inventa nada nuevo. Solo se llama si el hash cambió (decisión del motor).
 */
export async function redactarNarrativa(ins: Insumos): Promise<{ narrativa: string; costo_usd: number }> {
  if (ins.contexto_estructurado.length === 0 && ins.notas.length === 0) {
    return { narrativa: '(sin datos suficientes para redactar el estado general)', costo_usd: 0 };
  }
  const bloqueHechos = ins.contexto_estructurado.length
    ? ins.contexto_estructurado.map(c => `[${c.titulo}] ${c.sintesis}${c.alerta ? ` (⚠ ${c.alerta})` : ''}`).join('\n')
    : '(sin síntesis por módulo todavía)';
  const bloqueNotas = ins.notas.length ? `\n\nNOTAS DE JHON (verdad — si contradicen un hecho, mandan): ${ins.notas.join(' · ')}` : '';

  const messages: ChatMessage[] = [{
    role: 'user',
    content:
      `Sos el AGREGADOR del Visor de Persianas Girardot (Girardot, Colombia · pesos COP). ` +
      `Te paso los HECHOS ya extraídos por los analistas sobre un cliente. NO inventes nada nuevo ni agregues datos que no estén abajo. ` +
      `Redactá SOLO un párrafo corto (máx 4 frases) de "estado general": en qué punto está el caso y de quién es la pelota (Jhon o el cliente). ` +
      `Si las notas de Jhon contradicen un hecho, las notas mandan.\n\n` +
      `❌ PROHIBIDO editorializar la AUSENCIA de algo. NO escribas "no hay cotización registrada, lo que contradice…", "falta pago, sugiriendo…", ni interpretaciones tipo "esto indica que…". Un hecho ausente NO es una contradicción ni un problema por sí solo — un cambio simple, una garantía o un servicio operativo NUNCA requieren cotización/pago previo nuevo. Solo decí "no hay cotización" si es FÁCTICAMENTE relevante (cliente nuevo pidiendo precios), no como crítica.\n` +
      `❌ PROHIBIDO redactar instrucciones para el siguiente agente o para Jhon ("Jhon debe confirmar X", "Jhon debe decidir Y", "es necesario verificar Z"). Vos describís el ESTADO ACTUAL, no decidís qué hacer — eso lo hacen los derivados (checklist, tareas, agenda).\n\n` +
      `CLIENTE: ${ins.nombre}\n\nHECHOS:\n${bloqueHechos}${bloqueNotas}`,
  }];
  const r = await deepseekChat({ messages, agente: 'AGREGADOR_V2', max_tokens: 320 });
  return { narrativa: r.contenido.trim(), costo_usd: r.costo_usd };
}

/** Conveniencia: insumos + narrativa en un solo paso (para runners/diagnóstico). */
export async function construirTarjeta(sb: SupabaseClient, personaId: number): Promise<Tarjeta> {
  const ins = await leerInsumosTarjeta(sb, personaId);
  const { narrativa, costo_usd } = await redactarNarrativa(ins);
  return { ...ins, narrativa, costo_usd };
}
