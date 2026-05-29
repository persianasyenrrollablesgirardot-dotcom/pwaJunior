/**
 * AGENTES DERIVADOS V2 — leen la TARJETA y producen su salida por módulo.
 *
 * Regla de costura (ARQUITECTURA_V2.md §3.3): cada derivado LEE la tarjeta y
 * devuelve SU resultado. No tocan la tarjeta (sin loops). Acá solo CALCULAN el
 * resultado (Hito 1 no persiste todavía); el llamador lo escribirá en su tabla
 * más adelante.
 *
 * Hito 1 prioriza que FUNCIONEN y cumplan su módulo, no la calidad del
 * contenido (ver feedback_v2_prioridad_mecanica). Por ahora son LLM puro; el
 * híbrido reglas+LLM (decisión #2) se afina en el Hito 2.
 */
import type { Tarjeta } from './agregador.js';
import { deepseekChat, type ChatMessage } from '../lib/llm.js';

export type EstadoConv = 'cerrado' | 'espera_jhon' | 'espera_cliente' | 'sin_responder';

export interface ResChecklist { estado_conversacion: EstadoConv; proximo_paso: string; costo_usd: number }
export interface ResTareas { tareas: { titulo: string; prioridad: number }[]; costo_usd: number }
export type TipoAgenda = 'visita_medidas' | 'instalacion' | 'reunion_proveedor' | 'personal' | 'otro';
export interface ItemAgenda { titulo: string; fecha: string | null; hora: string; tipo: TipoAgenda; lugar: string }
export interface ResAgenda { agendamientos: ItemAgenda[]; costo_usd: number }

function bloqueTarjeta(t: Tarjeta): string {
  const hechos = t.contexto_estructurado.map(c => `[${c.titulo}] ${c.sintesis}`).join('\n');
  const notas = t.notas.length ? `\nNOTAS DE JHON (verdad): ${t.notas.join(' · ')}` : '';
  return `CLIENTE: ${t.nombre} (tipo: ${t.tipo_contacto})\nESTADO GENERAL: ${t.narrativa}\nHECHOS POR MÓDULO:\n${hechos}${notas}`;
}

async function llmJson(content: string, agente: string): Promise<{ obj: any; costo: number }> {
  const messages: ChatMessage[] = [{ role: 'user', content }];
  const r = await deepseekChat({ messages, agente, max_tokens: 400, response_format: { type: 'json_object' } });
  try { return { obj: JSON.parse(r.contenido), costo: r.costo_usd }; }
  catch { return { obj: {}, costo: r.costo_usd }; }
}

/** CHECKLIST — ¿de quién es la pelota? + próximo paso. */
export async function derivarChecklist(t: Tarjeta): Promise<ResChecklist> {
  const { obj, costo } = await llmJson(
    `Sos el agente CHECKLIST del Visor de Persianas Girardot. Leé la tarjeta y decidí de quién es la pelota.\n\n` +
    `${bloqueTarjeta(t)}\n\n` +
    `Devolvé SOLO JSON: {"estado_conversacion": uno de ["cerrado","espera_jhon","espera_cliente","sin_responder"], "proximo_paso": "frase corta"}.\n` +
    `Criterio: "espera_jhon" si el negocio/equipo debe mover algo · "espera_cliente" si esperamos respuesta del cliente · "sin_responder" si el cliente escribió y nadie contestó · "cerrado" si el caso terminó (vendido+instalado+pagado o cancelado).`,
    'DERIV_CHECKLIST');
  const estados: EstadoConv[] = ['cerrado', 'espera_jhon', 'espera_cliente', 'sin_responder'];
  const estado = estados.includes(obj.estado_conversacion) ? obj.estado_conversacion : 'espera_jhon';
  return { estado_conversacion: estado, proximo_paso: String(obj.proximo_paso ?? 'sin definir'), costo_usd: costo };
}

/** TAREAS — qué hay que hacer, accionable. */
export async function derivarTareas(t: Tarjeta): Promise<ResTareas> {
  const { obj, costo } = await llmJson(
    `Sos el agente TAREAS del Visor de Persianas Girardot. Leé la tarjeta y sacá las tareas accionables que surjan de ella.\n\n` +
    `${bloqueTarjeta(t)}\n\n` +
    `Devolvé SOLO JSON: {"tareas": [{"titulo": "qué hacer", "prioridad": 1-3}]}. 1=urgente, 3=baja. Si no hay tareas claras, [].`,
    'DERIV_TAREAS');
  const tareas = Array.isArray(obj.tareas) ? obj.tareas.map((x: any) => ({ titulo: String(x.titulo ?? ''), prioridad: Number(x.prioridad ?? 2) })).filter((x: any) => x.titulo) : [];
  return { tareas, costo_usd: costo };
}

/** AGENDAMIENTO — qué hay que agendar (con fecha ESTRUCTURADA para el calendario). */
export async function derivarAgenda(t: Tarjeta): Promise<ResAgenda> {
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); // YYYY-MM-DD
  const TIPOS: TipoAgenda[] = ['visita_medidas', 'instalacion', 'reunion_proveedor', 'personal', 'otro'];
  const { obj, costo } = await llmJson(
    `Sos el agente AGENDAMIENTO del Visor de Persianas Girardot. HOY es ${hoy} (zona America/Bogota). ` +
    `Leé la tarjeta y detectá si hay algo CONCRETO para agendar (visita de medidas/técnica, instalación, reunión, llamada con fecha).\n\n` +
    `${bloqueTarjeta(t)}\n\n` +
    `Devolvé SOLO JSON: {"agendamientos": [{"titulo": "qué", "fecha": "YYYY-MM-DD o null si no hay fecha concreta", ` +
    `"hora": "HH:MM — si dicen mañana/tarde/noche usá 09:00/14:00/18:00; si no hay, 09:00", ` +
    `"tipo": "visita_medidas|instalacion|reunion_proveedor|personal|otro", "lugar": "si lo hay, si no ''"}]}. ` +
    `Resolvé fechas relativas (mañana, el sábado, la semana que viene) CONTRA HOY. Si no hay nada concreto que agendar, [].`,
    'DERIV_AGENDA');
  const ags: ItemAgenda[] = Array.isArray(obj.agendamientos) ? obj.agendamientos.map((x: any) => ({
    titulo: String(x.titulo ?? ''),
    fecha: /^\d{4}-\d{2}-\d{2}$/.test(x.fecha ?? '') ? x.fecha : null,
    hora: /^\d{1,2}:\d{2}/.test(x.hora ?? '') ? String(x.hora).slice(0, 5).padStart(5, '0') : '09:00',
    tipo: TIPOS.includes(x.tipo) ? x.tipo : 'otro',
    lugar: String(x.lugar ?? ''),
  })).filter((x: ItemAgenda) => x.titulo) : [];
  return { agendamientos: ags, costo_usd: costo };
}
