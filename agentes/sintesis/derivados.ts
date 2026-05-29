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

/** CHECKLIST — ¿de quién es la pelota? + próximo paso concreto. */
export async function derivarChecklist(t: Tarjeta): Promise<ResChecklist> {
  const { obj, costo } = await llmJson(
    `Sos el agente CHECKLIST del Visor de Persianas Girardot (Girardot, COP). Leé la tarjeta y decidí (a) de quién es la pelota y (b) cuál es el próximo paso CONCRETO.\n\n` +
    `${bloqueTarjeta(t)}\n\n` +
    `IDENTIFICÁ EL ESCENARIO antes de elegir próximo paso. Buscá señales positivas para clasificarlo:\n` +
    `  · POST-VENTA / OPERATIVO (DEFAULT cuando hay agendamiento próximo): la tarjeta menciona "cambio", "cambiar", "mantenimiento", "garantía", "reparar", "ajustar", "visita técnica", "instalación de X" sin precio nuevo, o el cliente coordina logística (acceso, hora, persona presente). NO requiere cotización, medidas ni pago previo nuevo (la relación / venta ya existe en otro momento). proximo_paso = acción operativa concreta (ej. "Confirmar hora final con cliente y ejecutar instalación sábado 30/05").\n` +
    `  · VENTA NUEVA (SOLO si hay señales explícitas de venta nueva): el cliente pide cotización, pregunta precios, discute productos a comprar, o claramente está en fase inicial sin haber comprado. proximo_paso = la próxima etapa concreta (cotizar / medir / pagar / fabricar / instalar).\n` +
    `  · INSTALADOR / PROVEEDOR / COLABORADOR (tipo_contacto ≠ comercial o las notas lo dicen): coordinación operativa, NO flujo comercial.\n` +
    `  · TERMINADO: vendido+instalado+pagado, cancelado, o Jhon dejó nota de cierre → "cerrado".\n\n` +
    `Heurística clave: la ausencia de cotización/pago en la tarjeta NO implica venta nueva ni un pendiente — un cambio o servicio operativo NUNCA los requiere. Solo es venta nueva si VES explícitamente lenguaje de cotizar/comprar/precios/producto-nuevo.\n\n` +
    `REGLAS DURAS:\n` +
    `1. Las NOTAS DE JHON son VERDAD y mandan. Si dicen "ya está coordinado", "ya hablé y cerré", "es mi instalador", honralo y NO pidas confirmar lo que ya está decidido.\n` +
    `2. ❌ "Si hay cotización/pago/medidas" NUNCA es una decisión pendiente. Es un HECHO observable de la tarjeta. NO escribas proximo_paso tipo "Jhon debe confirmar/decidir si hay cotización/pago/medidas" ni "Jhon debe confirmar si el servicio se ejecuta sin ellos" (ni reformulaciones equivalentes). Si el caso es operativo y ya está coordinado, no requerir cotización/pago previo NO es una pregunta — es un hecho normal. La narrativa puede editorializar ("contradice que esté avanzada"); IGNORÁ ese editorial y mirá los hechos: ¿hay fecha agendada? ¿hay nota de coordinación? → entonces se ejecuta, punto.\n` +
    `3. Si hay agendamiento futuro y el caso es operativo (cambio/garantía/postventa/instalación), estado normal es espera_cliente (esperando la fecha) o espera_jhon SOLO si hay algo OPERATIVO por hacer antes (verificar hora puntual, confirmar acceso, asignar instalador, despachar materiales).\n` +
    `4. proximo_paso debe ser ACCIONABLE y CONCRETO (verbo + objeto + cuándo si aplica), no filosófico ni pregunta abstracta. Ejemplos buenos: "Confirmar hora final con cliente y ejecutar instalación sábado 30/05", "Solicitar a William fecha concreta para el cambio en garantía", "Enviar cotización de 6 cortinas blackout". Ejemplos malos: "Decidir si proceder", "Confirmar si hay cotización", "Evaluar el caso".\n` +
    `5. ❌ NO-ACCIÓN no es espera_jhon. Si tu proximo_paso describe NO HACER NADA, ESPERAR pasivamente u OBSERVAR ("mantenerse a la expectativa", "esperar oportunidades", "monitorear", "observar la evolución", "quedar atento", "sin acción inmediata", "ninguna acción pendiente", "reclasificar a no comercial o mantener" / "definir si X o Y"), entonces el estado NO es espera_jhon. Es:\n` +
    `     · espera_cliente — si esperamos respuesta o iniciativa del cliente.\n` +
    `     · cerrado — si no hay nada pendiente real.\n` +
    `   espera_jhon REQUIERE que Jhon EJECUTE algo concreto AHORA. "Esperar / mantener / observar / decidir si reclasificar" NO son ejecuciones — son indecisión del agente disfrazada de tarea.\n\n` +
    `Estados: espera_jhon = el negocio debe EJECUTAR algo concreto · espera_cliente = esperamos respuesta o fecha del cliente · sin_responder = el cliente escribió y nadie contestó · cerrado = terminó o no hay nada pendiente.\n\n` +
    `Devolvé SOLO JSON: {"estado_conversacion": "cerrado|espera_jhon|espera_cliente|sin_responder", "proximo_paso": "frase corta y accionable"}.`,
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
