/**
 * A_CHECKLIST — Agente de estado conversacional ("Checklist por chat" de Junior).
 *
 * Lee la conversación de UN chat y produce su estado: de quién es la pelota
 * (sin_responder / te_toca / frio / esperando_cliente / cerrada), el tipo de
 * conversación (venta / garantía / consulta) con su checklist de pasos, el
 * próximo paso concreto y los compromisos que el negocio prometió y no cumplió.
 *
 * Se ejecuta por CHAT. El worker (cicloChecklist) lo llama cuando un chat tiene
 * actividad nueva. Una fila por chat en `chat_checklist`, regenerada entera.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat } from '../lib/llm.js';

/** El flujo de pasos de cada tipo de conversación. Secuencial.
 * `no_aplica` se usa cuando el contacto NO es un cliente comercial
 * (proveedor, contacto personal, equipo interno): sin pasos, cerrado. */
export const PLANTILLAS: Record<string, string[]> = {
  venta: [
    'Hizo contacto', 'Atendido', 'Necesidad entendida', 'Medidas',
    'Cotización enviada', 'Cliente respondió la cotización', 'Cierre (ganó / perdió)',
  ],
  garantia: [
    'Reclamo recibido', 'Diagnóstico', 'Visita / revisión',
    'Solución aplicada', 'Confirmado por el cliente',
  ],
  consulta: ['Pregunta recibida', 'Respondida', 'Cerrada'],
  no_aplica: [],
};

export interface ResultadoChecklist { ok: boolean; costo_usd: number }

function promptSistema(hoy: string): string {
  return `Sos el AGENTE DE ESTADO CONVERSACIONAL de Fábrica de Cortinas Girardot
(persianas Safra, Girardot, Colombia). Tu trabajo: mirar UNA conversación de
WhatsApp con un cliente y decir en qué estado está.

HOY ES: ${hoy}. Usá esta fecha para calcular cuántos días pasaron desde el último mensaje.

PASO 0 — ¿APLICA gestión comercial?
SI te llega un bloque "QUÉ ES ESTE CONTACTO" indicando que NO es un cliente
comercial (es PROVEEDOR, contacto PERSONAL, EQUIPO INTERNO) → devolvé:
  tipo="no_aplica", estado="cerrada", pasos_completados=0,
  responsable_proximo=null, proximo_paso=null, compromisos=[],
  motivo_cierre="No es cliente comercial — no aplica gestión de venta/garantía/consulta".
NO inventes pasos de venta para un contacto que no es comprador.
Igual mirá las NOTAS DEL HUMANO y las CORRECCIONES: si dicen que es proveedor,
familiar, mecánico, contadora, instalador, amigo, etc. → tipo="no_aplica".

PASO 1 — TIPO de conversación (solo si APLICA, sino salteá al output):
- "venta": el cliente quiere comprar o cotizar cortinas.
- "garantia": el cliente reclama algo que YA compró (falla, daño, mal funcionamiento).
- "consulta": una pregunta suelta, sin intención de compra clara todavía.

PASO 2 — CHECKLIST. Según el tipo, este es el flujo de pasos EN ORDEN:
- venta (7 pasos): Hizo contacto · Atendido · Necesidad entendida · Medidas · Cotización enviada · Cliente respondió la cotización · Cierre (ganó/perdió)
- garantia (5 pasos): Reclamo recibido · Diagnóstico · Visita/revisión · Solución aplicada · Confirmado por el cliente
- consulta (3 pasos): Pregunta recibida · Respondida · Cerrada
Devolvé "pasos_completados": cuántos pasos están cumplidos (de 0 al total). Es
SECUENCIAL: si el paso 4 está hecho, los 1-2-3 también.

PASO 3 — ESTADO. ¿De quién es la pelota ahora?
- "sin_responder": el último mensaje es del CLIENTE y el negocio todavía no le contestó.
- "te_toca": el negocio contestó pero quedó debiendo algo concreto (el próximo paso lo
  hace el negocio: cotización, medidas, info, una respuesta real). Un "ya te atiendo"
  o "un momento" NO cuenta como cumplido: sigue siendo te_toca.
- "esperando_cliente": el negocio hizo su parte; el próximo paso depende del cliente.
- "frio": como esperando_cliente pero pasaron MÁS DE 7 DÍAS desde el último mensaje
  sin que el cliente conteste. Hay que recontactar.
- "cerrada": la conversación terminó: venta ganada (con abono/cierre), venta perdida
  (el cliente dijo que no), garantía resuelta y confirmada, o consulta ya respondida.

PASO 4 — "responsable_proximo": quién hace el próximo paso pendiente: "jhon" (el
negocio), "cliente", o null si está cerrada.

PASO 5 — "proximo_paso": UNA acción concreta y corta. Si está cerrada, describí cómo cerró.

PASO 6 — COMPROMISOS. Buscá promesas que el NEGOCIO le hizo al cliente y todavía NO
cumplió ("te paso la cotización", "mañana te confirmo", "el lunes paso a revisar",
"te llamo más tarde"). Por cada una sin cumplir devolvé {texto, prometido_at}. Si una
promesa ya se cumplió en un mensaje posterior, NO la incluyas. Si no hay, array vacío.

Devolvé EXCLUSIVAMENTE este JSON (nada de texto fuera):
{
  "tipo": "venta|garantia|consulta|no_aplica",
  "estado": "sin_responder|te_toca|frio|esperando_cliente|cerrada",
  "pasos_completados": <entero>,
  "responsable_proximo": "jhon|cliente|null",
  "proximo_paso": "<frase corta y concreta>",
  "motivo_cierre": "<texto breve si estado=cerrada, o null>",
  "compromisos": [ { "texto": "<lo que prometió el negocio>", "prometido_at": "YYYY-MM-DD o null" } ]
}`;
}

export async function analizarChecklist(
  sb: SupabaseClient,
  chatId: number,
): Promise<ResultadoChecklist> {
  // 1. Chat + mensajes
  const { data: chat } = await sb.from('chats')
    .select('id, proyecto_id').eq('id', chatId).maybeSingle();
  if (!chat) return { ok: false, costo_usd: 0 };

  const { data: msgs } = await sb.from('mensajes')
    .select('direccion, tipo, texto, metadata, ts_canal')
    .eq('chat_id', chatId).is('deleted_at', null).order('ts_canal');
  if (!msgs || msgs.length === 0) return { ok: false, costo_usd: 0 };

  // 2. Persona del chat (vía su proyecto)
  let personaId: number | null = null;
  if (chat.proyecto_id) {
    const { data: proy } = await sb.from('proyectos')
      .select('persona_id').eq('id', chat.proyecto_id).maybeSingle();
    personaId = proy?.persona_id ?? null;
  }

  // 2.b Contexto humano: ámbito + notas libres + correcciones de Junior.
  // El agente debe saber si este contacto NO es cliente comercial para no
  // inventar checklist de venta. Mismo patrón que sintetizarPersona.
  let ambitoPersona: string | null = null;
  let notasContacto: string[] = [];
  let correccionesContacto: string[] = [];
  if (personaId) {
    const { data: persona } = await sb.from('personas')
      .select('notas,ambito_principal').eq('id', personaId).maybeSingle();
    ambitoPersona = (persona?.ambito_principal as string) ?? null;
    if (persona?.notas) notasContacto.push(persona.notas as string);
    const { data: notas } = await sb.from('notas_libres')
      .select('contenido').eq('persona_id', personaId).is('deleted_at', null)
      .order('ts_creado', { ascending: true });
    for (const n of notas ?? []) if (n.contenido) notasContacto.push(n.contenido as string);
    const { data: corr } = await sb.from('correcciones_humanas')
      .select('modulo,hecho').eq('persona_id', personaId).eq('vigente', true)
      .order('created_at', { ascending: true });
    for (const c of corr ?? []) correccionesContacto.push(`[${c.modulo ?? 'general'}] ${c.hecho}`);
  }
  const AMBITO_DESC: Record<string, string> = {
    comercial:        'CLIENTE del negocio (cotiza / compra persianas).',
    proveedor:        'PROVEEDOR — NO es cliente. Le vende o le presta un servicio al negocio.',
    personal_familia: 'CONTACTO PERSONAL (familia) — NO es cliente.',
    personal_amigos:  'CONTACTO PERSONAL (amigo) — NO es cliente.',
    personal_otros:   'Contacto personal sin clasificar — probablemente NO es cliente.',
    interno_equipo:   'EQUIPO INTERNO (instalador / técnico / contadora) — NO es cliente.',
  };
  const ambitoCtx = AMBITO_DESC[ambitoPersona ?? ''] ?? 'Sin clasificar (asumir cliente comercial salvo evidencia en notas).';
  const bloqueNotas = notasContacto.length > 0
    ? notasContacto.map(n => `- ${n}`).join('\n') : '(ninguna)';
  const bloqueCorrecciones = correccionesContacto.length > 0
    ? correccionesContacto.map(c => `- ${c}`).join('\n') : '(ninguna)';

  // 3. Transcripción — cada mensaje con su fecha real (para resolver "el jueves").
  const fechaMsg = (ts: string | null) => ts
    ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })
    : '????-??-??';
  const conversacion = msgs.map(m => {
    const quien = m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE';
    const t = m.texto || (m.metadata as any)?.ai_text || `[${m.tipo} sin texto]`;
    return `[${fechaMsg(m.ts_canal)}] ${quien}: ${String(t).replace(/\n/g, ' ').trim()}`;
  }).join('\n');
  const ultimo = msgs[msgs.length - 1];
  const ultimoTs = ultimo.ts_canal as string;
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });

  // 4. LLM
  const res = await deepseekChat({
    agente: 'A_CHECKLIST',
    temperature: 0.2,
    costoLimiteUsd: 0.05,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: promptSistema(hoy) },
      {
        role: 'user',
        content:
          `=== QUÉ ES ESTE CONTACTO (ámbito) ===\n${ambitoCtx}\n\n` +
          `=== NOTAS DEL HUMANO SOBRE ESTE CONTACTO (verdad prioritaria — las escribió Jhon) ===\n${bloqueNotas}\n\n` +
          `=== CORRECCIONES DE JHON A JUNIOR (verdad prioritaria) ===\n${bloqueCorrecciones}\n\n` +
          `=== CONVERSACIÓN (cada línea: [fecha aaaa-mm-dd] QUIÉN: texto) ===\n${conversacion}\n\n` +
          `El ÚLTIMO mensaje lo mandó: ${ultimo.direccion === 'saliente' ? 'EL NEGOCIO' : 'EL CLIENTE'}.\n\n` +
          `Generá el JSON con el estado de este chat. Si el ámbito o las notas dicen que NO es cliente comercial, devolvé tipo="no_aplica".`,
      },
    ],
  });

  // 5. Parsear y normalizar
  let p: any;
  try { p = JSON.parse(res.contenido); }
  catch { console.error(`[A_CHECKLIST] chat ${chatId}: JSON inválido`); return { ok: false, costo_usd: res.costo_usd }; }

  let tipo = ['venta', 'garantia', 'consulta', 'no_aplica'].includes(p?.tipo) ? p.tipo : 'consulta';
  let estado = ['sin_responder', 'te_toca', 'frio', 'esperando_cliente', 'cerrada'].includes(p?.estado)
    ? p.estado : 'te_toca';
  let motivoCierreForzado: string | null = null;

  // Guard rail: si el ámbito del contacto es claramente NO comercial
  // (proveedor / personal / equipo interno) forzamos no_aplica + cerrada,
  // sin importar lo que el LLM haya decidido. Defensa dura contra el
  // PASO 0 del prompt cuando el LLM no lo obedece.
  if (ambitoPersona && ambitoPersona !== 'comercial' && tipo !== 'no_aplica') {
    console.log(`[A_CHECKLIST] chat ${chatId}: ámbito=${ambitoPersona} → forzando tipo='no_aplica' (LLM había dicho '${tipo}')`);
    tipo = 'no_aplica';
    estado = 'cerrada';
    motivoCierreForzado = 'No es cliente comercial — no aplica gestión de venta/garantía/consulta';
  }
  const labels = PLANTILLAS[tipo];
  const completados = Math.max(0, Math.min(labels.length, Math.round(Number(p?.pasos_completados) || 0)));
  const respProx = ['jhon', 'cliente'].includes(p?.responsable_proximo) ? p.responsable_proximo : null;
  const pasos = labels.map((label, i) => ({
    label,
    hecho: i < completados,
    responsable: i === completados ? respProx : null,
  }));
  const compromisos = Array.isArray(p?.compromisos)
    ? p.compromisos
        .filter((c: any) => c && typeof c.texto === 'string' && c.texto.trim())
        .map((c: any) => ({ texto: String(c.texto).trim(), prometido_at: c.prometido_at || null }))
    : [];

  // 6. Upsert — una fila por chat, regenerada entera.
  const proxFinal = tipo === 'no_aplica'
    ? null
    : (typeof p?.proximo_paso === 'string' ? p.proximo_paso.trim() : null);
  const motivoFinal = motivoCierreForzado
    ?? (estado === 'cerrada' && typeof p?.motivo_cierre === 'string' ? p.motivo_cierre.trim() : null);
  const { error } = await sb.from('chat_checklist').upsert({
    chat_id: chatId, persona_id: personaId, tipo, estado,
    proximo_paso: proxFinal,
    motivo_cierre: motivoFinal,
    pasos,
    compromisos: tipo === 'no_aplica' ? [] : compromisos,
    ultimo_mensaje_ts: ultimoTs,
    generado_por: 'A_CHECKLIST', modelo: res.modelo, costo_usd: res.costo_usd,
    actualizado_at: new Date().toISOString(),
  } as any, { onConflict: 'chat_id' });
  if (error) { console.error(`[A_CHECKLIST] chat ${chatId}: upsert ${error.message}`); return { ok: false, costo_usd: res.costo_usd }; }

  return { ok: true, costo_usd: res.costo_usd };
}
