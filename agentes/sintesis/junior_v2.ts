/**
 * JUNIOR V2 — interfaz delgada que RECUPERA y razona, NO carga las 75 tarjetas.
 *
 * El Junior viejo metía el contexto de TODOS los clientes en cada llamada (~41k
 * tokens → alucinaba, lento, caro). Acá:
 *   1. Índice liviano: una línea por tarjeta (nombre · tipo · estado · próximo paso).
 *   2. Ruteo (LLM): dada la pregunta, decide qué tarjetas leer en detalle. Si la
 *      pregunta se responde con el índice (ej. "¿quién espera mi respuesta?"),
 *      contesta directo sin cargar nada más.
 *   3. Respuesta (LLM): carga SOLO las tarjetas relevantes (narrativa + contexto +
 *      notas + checklist/tareas/agenda) y responde.
 *
 * Recuperar-y-razonar, no cargar-todo. Hito 1 (Junior leyendo la tarjeta).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat, type ChatMessage } from '../lib/llm.js';

export interface RespuestaJuniorV2 {
  respuesta: string;
  tarjetas_usadas: number[];   // chat_ids que se cargaron en detalle
  via_indice: boolean;         // true si respondió solo con el índice
  costo_usd: number;
}

export interface TurnoHistorial { rol: 'jhon' | 'junior'; texto: string }

interface FilaIndice { chat_id: number; nombre: string; tipo: string; estado: string; proximo: string }

async function cargarIndice(sb: SupabaseClient): Promise<FilaIndice[]> {
  const { data: tjs } = await sb.from('tarjeta')
    .select('chat_id, tipo_contacto, persona_id, es_no_cliente, personas(nombre)')
    .eq('es_no_cliente', false);  // no surfacear no-clientes (restaurante/spam) a Junior
  const { data: cks } = await sb.from('tarjeta_checklist')
    .select('chat_id, estado_conversacion, proximo_paso');
  const ck = new Map((cks ?? []).map((c: any) => [c.chat_id, c]));
  return (tjs ?? []).map((t: any) => ({
    chat_id: t.chat_id,
    nombre: t.personas?.nombre ?? `Chat #${t.chat_id}`,
    tipo: t.tipo_contacto,
    estado: ck.get(t.chat_id)?.estado_conversacion ?? '?',
    proximo: ck.get(t.chat_id)?.proximo_paso ?? '',
  }));
}

async function cargarDetalle(sb: SupabaseClient, chatIds: number[]): Promise<string> {
  const bloques: string[] = [];
  for (const id of chatIds) {
    const { data: t } = await sb.from('tarjeta')
      .select('tipo_contacto, narrativa, notas, contexto, persona_id, personas(nombre)')
      .eq('chat_id', id).maybeSingle();
    if (!t) continue;
    const { data: ck } = await sb.from('tarjeta_checklist').select('estado_conversacion, proximo_paso').eq('chat_id', id).maybeSingle();
    const { data: tar } = await sb.from('tarjeta_tarea').select('titulo, prioridad').eq('chat_id', id).order('prioridad');
    const { data: ag } = await sb.from('tarjeta_agenda').select('titulo, cuando, lugar').eq('chat_id', id);
    const tt: any = t;
    const ctx = (tt.contexto ?? []).map((c: any) => `  [${c.titulo}] ${c.sintesis}`).join('\n');
    bloques.push(
      `### ${tt.personas?.nombre ?? `Chat #${id}`} (chat ${id}, ${tt.tipo_contacto})\n` +
      `ESTADO GENERAL: ${tt.narrativa ?? '(sin narrativa)'}\n` +
      (tt.notas?.length ? `NOTAS DE JHON (verdad): ${tt.notas.join(' · ')}\n` : '') +
      `CHECKLIST: ${ck?.estado_conversacion ?? '?'} → ${ck?.proximo_paso ?? '-'}\n` +
      `TAREAS: ${(tar ?? []).map((x: any) => x.titulo).join(' · ') || '(ninguna)'}\n` +
      `AGENDA: ${(ag ?? []).map((x: any) => `${x.titulo} (${x.cuando})`).join(' · ') || '(nada)'}\n` +
      `CONTEXTO POR MÓDULO:\n${ctx || '  (sin detalle)'}`
    );
  }
  return bloques.join('\n\n');
}

export async function responderJuniorTarjeta(
  sb: SupabaseClient, pregunta: string, historial: TurnoHistorial[] = [],
): Promise<RespuestaJuniorV2> {
  const indice = await cargarIndice(sb);
  const indiceTexto = indice.length
    ? indice.map(f => `chat ${f.chat_id} | ${f.nombre} | ${f.tipo} | estado:${f.estado} | próximo:${f.proximo}`).join('\n')
    : '(no hay tarjetas todavía)';

  // Historial reciente (para resolver follow-ups: "¿y de ese cuánto debe?").
  const hist = historial.slice(-6);
  const histTexto = hist.length
    ? hist.map(h => `${h.rol === 'jhon' ? 'JHON' : 'JUNIOR'}: ${h.texto}`).join('\n')
    : '(sin conversación previa)';

  // ── Paso 1: ruteo ──────────────────────────────────────────────────────
  const ruteo: ChatMessage[] = [
    {
      role: 'system',
      content:
        `Sos el RUTEO de Junior, asistente de Jhon (Persianas Girardot, COP). Tenés la CONVERSACIÓN PREVIA y el ÍNDICE ` +
        `de tarjetas (una por chat, con nombre, tipo, estado y próximo paso). Resolvé referencias de la pregunta usando ` +
        `la conversación previa ("ese", "él", "el anterior", "ese cliente" → el cliente del que se venía hablando). Decidí:\n` +
        `- Si se responde con el índice (ej. "¿quién espera mi respuesta?") → puede_responder_con_indice=true + respuesta_directa.\n` +
        `- Si Jhon pide algo AMPLIO u OPERATIVO sin nombrar un cliente ("organizá", "qué hago hoy", "actualizá", "guiame", ` +
        `"ordená esto", "guiate por el checklist") → puede_responder_con_indice=true y en respuesta_directa armá un PLAN: ` +
        `listá las tarjetas que necesitan la acción de Jhon (estado espera_jhon o sin_responder), cada una con su próximo paso, ` +
        `ordenadas por urgencia.\n` +
        `- Si es sobre cliente(s) específico(s) → puede_responder_con_indice=false y listá los chat_ids relevantes (máx 5).\n` +
        `NUNCA digas que "no hay tarjetas seleccionadas" ni pidas que Jhon "seleccione" — no existe seleccionar, SIEMPRE tenés el índice. ` +
        `Si "actualizar" se refiere a las tarjetas: aclaramos que se actualizan solas con info nueva, y mostramos el estado actual. ` +
        `En respuesta_directa NUNCA inventes datos (horas/montos/fechas) que no estén en el índice; si Jhon insiste con algo que no ves, no se lo confirmes inventando.\n` +
        `Devolvé SOLO JSON: {"puede_responder_con_indice": bool, "respuesta_directa": string|null, "chat_ids": number[]}`,
    },
    { role: 'user', content: `CONVERSACIÓN PREVIA:\n${histTexto}\n\nÍNDICE DE TARJETAS:\n${indiceTexto}\n\nNUEVA PREGUNTA DE JHON: ${pregunta}` },
  ];
  const r1 = await deepseekChat({ messages: ruteo, agente: 'JUNIOR_V2_RUTEO', max_tokens: 900, response_format: { type: 'json_object' } });
  let plan: any = {};
  try { plan = JSON.parse(r1.contenido); } catch { plan = {}; }
  let costo = r1.costo_usd;

  if (plan.puede_responder_con_indice && plan.respuesta_directa) {
    return { respuesta: String(plan.respuesta_directa), tarjetas_usadas: [], via_indice: true, costo_usd: costo };
  }

  // ── Paso 2: cargar solo las tarjetas relevantes y responder ─────────────
  const chatIds = Array.isArray(plan.chat_ids) ? plan.chat_ids.slice(0, 5) : [];

  // Fallback proactivo: si el ruteo no fijó ninguna tarjeta (pedido vago/operativo),
  // NO damos el callejón "no hay tarjetas seleccionadas" — armamos desde el índice
  // lo que necesita la acción de Jhon. Determinístico, sin LLM extra.
  if (chatIds.length === 0) {
    const teToca = indice.filter(f => f.estado === 'espera_jhon' || f.estado === 'sin_responder');
    if (!teToca.length) {
      return { respuesta: 'No tenés nada pendiente de tu lado ahora mismo. 👏 Si querés ver un caso puntual, nombrame el cliente.', tarjetas_usadas: [], via_indice: true, costo_usd: costo };
    }
    const lista = teToca.slice(0, 25).map(f => `• ${f.nombre}${f.proximo ? ` — ${f.proximo}` : ''}`).join('\n');
    const extra = teToca.length > 25 ? `\n…y ${teToca.length - 25} más` : '';
    return { respuesta: `Esto es lo que te toca mover (según los checklists):\n${lista}${extra}`, tarjetas_usadas: [], via_indice: true, costo_usd: costo };
  }

  const detalle = await cargarDetalle(sb, chatIds);
  const resp: ChatMessage[] = [
    {
      role: 'system',
      content:
        `Sos JUNIOR, el asistente personal de Jhon (Persianas Girardot, Girardot, Colombia · pesos COP). ` +
        `Respondé usando SOLO las tarjetas de abajo y la conversación previa.\n` +
        `REGLAS DURAS (anti-invento, anti-ceder):\n` +
        `1. NUNCA inventes datos concretos (horas, fechas, montos, nombres, direcciones) que no estén TEXTUALMENTE en la tarjeta. ` +
        `Si un dato no está, decí "eso no figura en la tarjeta" — jamás lo completes de memoria.\n` +
        `2. Si Jhon te contradice o insiste ("fijate bien", "tenés razón", "estás mal", "revisá de nuevo"), NO cambies tu respuesta ` +
        `solo para darle la razón. Re-leé la tarjeta y respondé lo que REALMENTE dice, aunque sea repetir lo mismo o decir que no figura. ` +
        `Es mejor "no lo veo en la tarjeta" que un dato falso para quedar bien.\n` +
        `3. Si Jhon afirma algo que la tarjeta NO muestra, decilo claro: "la tarjeta no lo refleja todavía (puede estar actualizándose)" — ` +
        `NO inventes el dato para coincidir con él.\n` +
        `4. Las NOTAS DE JHON (verdad) mandan sobre los hechos de los agentes.\n` +
        `Sé concreto y breve, en su tono — pero la honestidad sobre los datos está por encima de complacerlo.`,
    },
    // Conversación previa (para follow-ups coherentes).
    ...hist.map(h => ({ role: (h.rol === 'jhon' ? 'user' : 'assistant') as 'user' | 'assistant', content: h.texto })),
    { role: 'user', content: `TARJETAS RELEVANTES:\n\n${detalle}\n\n────\nPREGUNTA DE JHON: ${pregunta}` },
  ];
  const r2 = await deepseekChat({ messages: resp, agente: 'JUNIOR_V2_RESP', max_tokens: 1200 });
  costo += r2.costo_usd;
  return { respuesta: r2.contenido.trim(), tarjetas_usadas: chatIds, via_indice: false, costo_usd: costo };
}
