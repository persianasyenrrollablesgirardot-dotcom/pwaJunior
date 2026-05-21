/**
 * Junior conversacional — el chat de Jhon con su asistente.
 *
 * Jhon escribe en `junior_chat`. El worker llama `responderJunior`, que arma el
 * contexto con las síntesis de TODOS los clientes y deja que Junior responda.
 *
 * Ciclo de aprendizaje: si el mensaje de Jhon trae información nueva o una
 * corrección sobre un cliente, Junior la extrae. El worker la guarda en
 * `correcciones_humanas` y re-sintetiza al cliente — los analistas la toman
 * como verdad prioritaria. Así el conocimiento de Jhon corrige al enjambre.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat, type ChatMessage } from '../lib/llm.js';

const MODULO_NOMBRE: Record<string, string> = {
  junior: 'Visión global', m1: 'Cliente', m2: 'Comercial', m3: 'Financiero',
  m4: 'Técnico', m5: 'Operativo', m6: 'Postventa', m7: 'Evidencias',
};

export interface MensajeChat { rol: 'usuario' | 'junior'; mensaje: string }
export interface Correccion { persona_id: number; modulo: string | null; hecho: string }

function systemPrompt(contextoClientes: string, listaClientes: string): string {
  // Fecha de Colombia (America/Bogota), no UTC — toISOString daría el día equivocado de noche.
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const diaSemana = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long' });
  return `Sos JUNIOR, el asistente personal de Jhon, dueño de Fábrica de Cortinas Girardot
(persianas Safra, Girardot, Colombia).

═══ HOY ES: ${hoy} (${diaSemana}) ═══
Esta es la fecha real de hoy. NO la cuestiones, NO uses otra.

REGLA DE FECHAS — OBLIGATORIA, aplicala SIEMPRE antes de responder:
Por CADA fecha que menciones, comparala contra HOY (${hoy}):
- Fecha ANTERIOR a ${hoy} → está VENCIDA. Decilo explícito: "venció hace N días,
  ¿se hizo o quedó pendiente?". NUNCA la presentes como futura. NUNCA digas "mañana",
  "esta semana" ni "próximamente" sobre una fecha que ya pasó.
- Fecha igual o posterior a ${hoy} → vigente.

DE DÓNDE SACÁS LA INFORMACIÓN:
- El bloque "ESTADO DE TODOS LOS CLIENTES" de abajo es la VERDAD ACTUAL. Sacá de ahí
  los datos y las fechas de eventos.
- La ÚNICA fecha de hoy válida es la del encabezado HOY ES: ${hoy}. Si una síntesis del
  contexto menciona "hoy es..." otra fecha, IGNORALO — está desactualizada.
- El historial de este chat es SOLO para recordar de qué venían hablando. NO saques
  fechas ni datos del historial — tus respuestas viejas pueden tener fechas mal
  calculadas. Si el historial y el contexto actual difieren, manda el contexto actual.

Jhon te habla por chat. Conocés el estado de TODOS sus clientes (resumen abajo).

CÓMO RESPONDÉS:
- Directo, concreto, breve. Jhon está ocupado.
- Si pregunta por un cliente, andá al grano. Si pregunta algo transversal, cruzá todos.
- Si no tenés el dato, decilo. NUNCA inventes números ni hechos ni fechas.
- Moneda: pesos colombianos (COP). Español, cercano pero profesional.

CICLO DE APRENDIZAJE — MUY IMPORTANTE:
Si el mensaje de Jhon contiene INFORMACIÓN NUEVA o una CORRECCIÓN sobre un cliente
(ej: "la instalación de Jorge ya se hizo", "Claudia pagó el saldo", "Walter canceló"),
tenés que registrarla. Identificá de qué cliente es (por su persona_id de la lista)
y a qué módulo corresponde:
  m1 Cliente (contacto, inmueble) · m2 Comercial (cotización, negociación) ·
  m3 Financiero (pagos, abonos, saldos) · m4 Técnico (medidas, sistemas) ·
  m5 Operativo (instalaciones, tareas, fechas) · m6 Postventa (garantías, reclamos) ·
  m7 Evidencias (fotos, comprobantes).
En tu respuesta confirmale a Jhon qué registraste y que vas a actualizar ese módulo.

FORMATO DE SALIDA — devolvé EXCLUSIVAMENTE este JSON:
{
  "respuesta": "lo que le decís a Jhon en el chat",
  "correcciones": [
    { "persona_id": número, "modulo": "m1|m2|m3|m4|m5|m6|m7", "hecho": "el hecho confirmado, redactado claro y completo" }
  ]
}
Si el mensaje es SOLO una pregunta (sin info nueva), devolvé "correcciones": [].

=== CLIENTES (persona_id: nombre) ===
${listaClientes}

=== ESTADO DE TODOS LOS CLIENTES ===
${contextoClientes}`;
}

/** Arma el bloque de contexto con el estado de todos los clientes. */
async function construirContextoClientes(sb: SupabaseClient): Promise<{ contexto: string; lista: string }> {
  const { data: personas } = await sb.from('personas')
    .select('id,nombre').is('deleted_at', null);
  if (!personas || personas.length === 0) {
    return { contexto: '(todavía no hay clientes procesados)', lista: '(sin clientes)' };
  }

  const { data: sints } = await sb.from('modulo_sintesis')
    .select('persona_id,modulo,sintesis,alerta');
  const porPersona = new Map<number, any[]>();
  for (const s of sints ?? []) {
    if (!porPersona.has(s.persona_id)) porPersona.set(s.persona_id, []);
    porPersona.get(s.persona_id)!.push(s);
  }

  const bloques: string[] = [];
  for (const p of personas) {
    const ss = porPersona.get(p.id) ?? [];
    if (ss.length === 0) continue;
    const orden = ['junior', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
    ss.sort((a, b) => orden.indexOf(a.modulo) - orden.indexOf(b.modulo));
    const lineas = ss.map(s =>
      `  · ${MODULO_NOMBRE[s.modulo] ?? s.modulo}: ${s.sintesis ?? '—'}` +
      (s.alerta ? ` [ALERTA: ${s.alerta}]` : ''));
    bloques.push(`▸ ${p.nombre} (id ${p.id})\n${lineas.join('\n')}`);
  }
  return {
    contexto: bloques.join('\n\n'),
    lista: personas.map(p => `${p.id}: ${p.nombre}`).join('\n'),
  };
}

/**
 * Genera la respuesta de Junior + extrae las correcciones que dio Jhon.
 * `historial` son los mensajes previos de la conversación (orden cronológico).
 */
export async function responderJunior(
  sb: SupabaseClient,
  pregunta: string,
  historial: MensajeChat[],
): Promise<{ respuesta: string; correcciones: Correccion[]; costo_usd: number }> {
  const { contexto, lista } = await construirContextoClientes(sb);

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(contexto, lista) },
  ];
  for (const h of historial.slice(-12)) {
    messages.push({ role: h.rol === 'usuario' ? 'user' : 'assistant', content: h.mensaje });
  }
  messages.push({ role: 'user', content: pregunta });

  const res = await deepseekChat({
    agente: 'A10_JUNIOR_CHAT',
    temperature: 0.4,
    costoLimiteUsd: 0.10,
    response_format: { type: 'json_object' },
    messages,
  });

  let data: any;
  try { data = JSON.parse(res.contenido); }
  catch {
    // Si el LLM no devolvió JSON, usamos el texto crudo como respuesta.
    return { respuesta: res.contenido, correcciones: [], costo_usd: res.costo_usd };
  }

  const correcciones: Correccion[] = Array.isArray(data.correcciones)
    ? data.correcciones
        .filter((c: any) => typeof c?.persona_id === 'number' && c?.hecho)
        .map((c: any) => ({
          persona_id: c.persona_id,
          modulo: typeof c.modulo === 'string' ? c.modulo : null,
          hecho: String(c.hecho),
        }))
    : [];

  return {
    respuesta: data.respuesta ?? '(sin respuesta)',
    correcciones,
    costo_usd: res.costo_usd,
  };
}
