/**
 * Junior conversacional — el chat de Jhon con su asistente.
 *
 * Jhon escribe en la tabla `junior_chat` (rol='usuario', estado='pendiente').
 * El worker llama `responderJunior`, que arma el contexto con las síntesis de
 * TODOS los clientes y deja que Junior responda. Junior ve todo el negocio.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat, type ChatMessage } from '../lib/llm.js';

const JUNIOR_CHAT_SYSTEM =
`Sos JUNIOR, el asistente personal de Jhon, dueño de Fábrica de Cortinas Girardot
(persianas Safra, Girardot, Colombia).

Jhon te habla por chat. Vos conocés el estado de TODOS sus clientes — te paso el
resumen abajo, generado por los analistas del sistema. Respondé sus preguntas de
forma directa, concreta y útil, como un asistente de confianza que conoce el negocio.

Cómo respondés:
- Si pregunta por un cliente puntual, andá al grano con lo que sabés de él.
- Si pregunta algo transversal ("quién me debe plata", "qué hago hoy", "qué cliente
  está en riesgo"), revisá TODOS los clientes y dale la respuesta cruzada.
- Si no tenés el dato, decilo honestamente. NUNCA inventes números ni hechos.
- Sé breve y claro. Jhon está ocupado — respuestas que se leen en segundos.
- Moneda: pesos colombianos (COP). Español, cercano pero profesional.`;

const MODULO_NOMBRE: Record<string, string> = {
  junior: 'Visión global', m1: 'Cliente', m2: 'Comercial', m3: 'Financiero',
  m4: 'Técnico', m5: 'Operativo', m6: 'Postventa', m7: 'Evidencias',
};

export interface MensajeChat { rol: 'usuario' | 'junior'; mensaje: string }

/** Arma el bloque de contexto con el estado de todos los clientes. */
async function construirContextoClientes(sb: SupabaseClient): Promise<string> {
  const { data: personas } = await sb.from('personas')
    .select('id,nombre').is('deleted_at', null);
  if (!personas || personas.length === 0) return '(todavía no hay clientes procesados)';

  const { data: sints } = await sb.from('modulo_sintesis')
    .select('persona_id,modulo,sintesis,estado,proximo_paso,alerta');
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
    const lineas = ss.map(s => {
      const t = MODULO_NOMBRE[s.modulo] ?? s.modulo;
      return `  · ${t}: ${s.sintesis ?? '—'}` +
        (s.alerta ? ` [ALERTA: ${s.alerta}]` : '');
    });
    bloques.push(`▸ ${p.nombre}\n${lineas.join('\n')}`);
  }
  return bloques.join('\n\n');
}

/**
 * Genera la respuesta de Junior a un mensaje del chat.
 * `historial` son los mensajes previos de la conversación (orden cronológico).
 */
export async function responderJunior(
  sb: SupabaseClient,
  pregunta: string,
  historial: MensajeChat[],
): Promise<{ respuesta: string; costo_usd: number }> {
  const contexto = await construirContextoClientes(sb);

  const messages: ChatMessage[] = [
    { role: 'system', content: `${JUNIOR_CHAT_SYSTEM}\n\n=== ESTADO DE TODOS LOS CLIENTES ===\n${contexto}` },
  ];
  // Últimos 12 mensajes de historial para dar continuidad sin inflar el contexto.
  for (const h of historial.slice(-12)) {
    messages.push({ role: h.rol === 'usuario' ? 'user' : 'assistant', content: h.mensaje });
  }
  messages.push({ role: 'user', content: pregunta });

  const res = await deepseekChat({
    agente: 'A10_JUNIOR_CHAT',
    temperature: 0.4,
    costoLimiteUsd: 0.10,
    messages,
  });
  return { respuesta: res.contenido, costo_usd: res.costo_usd };
}
