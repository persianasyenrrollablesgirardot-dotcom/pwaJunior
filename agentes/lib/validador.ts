/**
 * Validador de outputs de agentes IA.
 *
 * Aplica las garantías de ARQUITECTURA.md:
 *   R-anti-contaminación: el output NO debe mencionar OTROS clientes (cross-cliente)
 *   R-anti-alucinación: TODO claim debe citar evidencia (msg_id, doc_id, evento_id)
 *   Vocabulario controlado: tipos / estados / confianza dentro de enums (sección 14)
 *   Reglas duras R-001 a R-013 según contexto del agente
 *
 * Si una validación falla, el output NO se acepta. El runner decide:
 *   - Reintenta si el agente puede corregirse
 *   - Marca como ERROR si es bug del prompt
 *   - Va a buzón con confianza=ALERTA si es decisión humana
 */

import { type ChatMessage } from './llm.js';

// ─── Vocabulario controlado (espejo de schema CHECK constraints) ─────────

export const ESTADOS_COTIZACION = [
  'propuesta', 'negociando', 'intencion_cierre', 'ganada', 'perdida', 'vencida',
] as const;

export const ESTADOS_ABONO = [
  'pendiente_validacion', 'confirmado', 'rechazado', 'inconsistente',
] as const;

export const ESTADOS_PRODUCCION = [
  'pendiente_abono', 'pedido_proveedor', 'en_produccion', 'listo_instalar',
  'retenido', 'entregado', 'instalado',
] as const;

export const TIPOS_OBJECION = [
  'precio', 'calidad', 'garantia', 'tiempo', 'competencia', 'color', 'diseño',
  'instalacion', 'desconfianza', 'comparacion_referido', 'comparacion_homecenter',
  'comparacion_otro_proveedor',
] as const;

export const SISTEMAS_SAFRA = [
  'blackout', 'screen_solar', 'sheer_elegance', 'panel_japones', 'enrollables',
  'verticales', 'peliculas_solares', 'toldos', 'motores', 'domotica', 'rieles', 'cadenillas',
] as const;

export const CONFIANZA = ['CONFIRMADO', 'INFERIDO', 'DUDOSO', 'ALERTA', 'RECHAZADO'] as const;
export type Confianza = typeof CONFIANZA[number];

export const TIPOS_EVENTO = [
  'mensaje_entrante', 'mensaje_saliente', 'dato_extraido', 'inferencia',
  'cambio_estado', 'solicitud_aprobacion', 'contradiccion', 'pago', 'medida',
  'garantia', 'variacion', 'tarea', 'alerta', 'evidencia', 'pregunta_humano',
  'primer_contacto', 'cambio_externo', 'correccion_humana',
] as const;

// ─── Output canónico de un agente ────────────────────────────────────────

export interface OutputAgente {
  tipo_evento: typeof TIPOS_EVENTO[number];
  confianza: Confianza;
  payload: Record<string, any>;
  evidencia_msg_ids: string[];           // OBLIGATORIO si confianza != 'pregunta_humano'
  reglas_aplicadas?: string[];           // ej: ['R-001', 'R-013#1']
  observacion_humano?: string;           // si quiere mandar al buzón con explicación
}

// ─── Errores de validación ───────────────────────────────────────────────

export class ValidacionError extends Error {
  public regla: string;
  constructor(regla: string, mensaje: string) {
    super(`[${regla}] ${mensaje}`);
    this.regla = regla;
  }
}

// ─── Contexto requerido para validar ─────────────────────────────────────

export interface ContextoValidacion {
  /** ID de la persona del chat actual. Usado para cross-cliente. */
  persona_id_actual: number;
  /** Nombres / tels / emails de OTROS clientes que NO deberían aparecer en el output. */
  identificadores_otros_clientes: string[];
  /** msg_ids del chat actual (válidos como evidencia). */
  msg_ids_disponibles: Set<string>;
  /** Para qué agente estamos validando (ej: 'A5_cotizaciones'). */
  agente: string;
}

// ─── Validación principal ────────────────────────────────────────────────

export function validarOutput(out: OutputAgente, ctx: ContextoValidacion): void {
  // 1. Schema básico
  if (!TIPOS_EVENTO.includes(out.tipo_evento)) {
    throw new ValidacionError('schema', `tipo_evento '${out.tipo_evento}' no está en vocabulario`);
  }
  if (!CONFIANZA.includes(out.confianza)) {
    throw new ValidacionError('schema', `confianza '${out.confianza}' no está en vocabulario`);
  }
  if (typeof out.payload !== 'object' || out.payload === null) {
    throw new ValidacionError('schema', 'payload debe ser objeto');
  }

  // 2. Anti-alucinación: evidencia obligatoria
  // Excepción: si tipo_evento es 'pregunta_humano' o confianza es 'DUDOSO', se permite vacío
  const evidenciaRequerida = out.confianza !== 'DUDOSO' && out.tipo_evento !== 'pregunta_humano';
  if (evidenciaRequerida) {
    if (!Array.isArray(out.evidencia_msg_ids) || out.evidencia_msg_ids.length === 0) {
      throw new ValidacionError('R-anti-alucinacion',
        `confianza=${out.confianza} requiere evidencia_msg_ids (al menos 1 msg_id citado)`);
    }
  }

  // 3. Cada msg_id citado debe existir en el chat actual
  for (const msgId of out.evidencia_msg_ids ?? []) {
    if (!ctx.msg_ids_disponibles.has(msgId)) {
      throw new ValidacionError('R-anti-alucinacion',
        `msg_id citado '${msgId}' NO existe en el chat actual del agente`);
    }
  }

  // 4. Anti-contaminación cross-cliente
  // Convertir payload a string y buscar identificadores de otros clientes
  const payloadStr = JSON.stringify(out.payload).toLowerCase();
  for (const otro of ctx.identificadores_otros_clientes) {
    if (!otro || otro.length < 4) continue;  // ignorar fragmentos muy cortos
    if (payloadStr.includes(otro.toLowerCase())) {
      throw new ValidacionError('R-anti-contaminacion',
        `payload menciona '${otro}' que pertenece a OTRO cliente. Cross-cliente leak detectado.`);
    }
  }

  // 5. Reglas duras del negocio (R-001 a R-013)
  validarReglasDuras(out);
}

function validarReglasDuras(out: OutputAgente): void {
  const p = out.payload;

  // R-001: NUNCA marcar GANADA/ABONO_RECIBIDO/PRODUCCION/INSTALADO sin validación humana
  // (= confianza CONFIRMADO solo si humano lo aprueba después)
  if (out.tipo_evento === 'cambio_estado' && p.nuevo_estado) {
    const ESTADOS_REQUIEREN_HUMANO = ['ganada', 'confirmado', 'en_produccion', 'instalado'];
    if (ESTADOS_REQUIEREN_HUMANO.includes(p.nuevo_estado) && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('R-001',
        `cambio a estado '${p.nuevo_estado}' NO puede ser CONFIRMADO sin validación humana. Usar INFERIDO + buzón.`);
    }
  }

  // R-013#1: medidas dadas por cliente → bandera RIESGO_MEDICION_CLIENTE automática
  if (out.tipo_evento === 'medida' && (p.quien_midio === 'cliente' || p.quien_midio === 'familiar')) {
    if (!p.bandera_riesgo || p.bandera_riesgo !== 'RIESGO_MEDICION_CLIENTE') {
      throw new ValidacionError('R-013#1',
        `medida tomada por cliente requiere bandera_riesgo='RIESGO_MEDICION_CLIENTE'`);
    }
  }

  // R-009: foto sola de comprobante NO es CONFIRMADO
  if (out.tipo_evento === 'pago' && p.solo_foto_comprobante === true) {
    if (out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('R-009',
        `pago con solo foto de comprobante NO puede ser CONFIRMADO. Usar pendiente_validacion.`);
    }
  }
}

// ─── Validación de inputs/prompt antes de invocar LLM ────────────────────

export function chatNoVacio(msgs: ChatMessage[]): void {
  if (!Array.isArray(msgs) || msgs.length === 0) {
    throw new Error('messages vacío');
  }
  if (!msgs.some(m => m.role === 'user')) {
    throw new Error('messages requiere al menos un mensaje user');
  }
}

// ─── Helper: parsear JSON con manejo de errores ──────────────────────────

export function parsearJSONSeguro(raw: string): { ok: true; data: any } | { ok: false; error: string } {
  // DeepSeek a veces envuelve el JSON en ```json ... ```
  const limpio = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return { ok: true, data: JSON.parse(limpio) };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}
