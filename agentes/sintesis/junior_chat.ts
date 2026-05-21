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
export interface Memoria { tipo: 'preferencia' | 'dato'; contenido: string }

function systemPrompt(
  contextoClientes: string, listaClientes: string, memorias: string, resumenConversacion: string,
): string {
  // Fecha de Colombia (America/Bogota), no UTC — toISOString daría el día equivocado de noche.
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const diaSemana = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', weekday: 'long' });
  return `Sos JUNIOR, el asistente personal de Jhon, dueño de Fábrica de Cortinas Girardot
(persianas Safra, Girardot, Colombia).

═══ HOY ES: ${hoy} (${diaSemana}) ═══
Esta es la fecha real de hoy. NO la cuestiones, NO uses otra.

═══ TU MEMORIA PERSISTENTE — recordá esto SIEMPRE, en TODA conversación ═══
${memorias}
Esto es lo que Jhon te enseñó y vale para siempre, incluso en chats nuevos.
Respetá estas preferencias y datos sin que te los tenga que repetir.

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
- Si NO tenés el dato que te piden (un teléfono, una dirección, etc.), respondelo
  EXPLÍCITAMENTE: "No tengo registrado el teléfono de X" / "Eso no figura en el sistema".
  "No lo sé" es una respuesta válida y útil. NUNCA inventes números ni hechos ni fechas.
- El campo "respuesta" NUNCA puede quedar vacío ni ser espacios en blanco. SIEMPRE
  tiene que tener texto real — aunque sea para decir que no tenés el dato.
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

FORMATO DE SALIDA:
Respondé en TEXTO NATURAL, directo y claro. NO uses JSON.

Si —y solo si— el mensaje de Jhon trae información nueva o una corrección sobre un
cliente, DESPUÉS de tu respuesta agregá una línea por cada corrección, con este
formato EXACTO (una por renglón, al final):
[CORRECCION] persona_id=<número> | modulo=<m1..m7> | hecho=<el hecho confirmado, redactado claro>

Si el mensaje es solo una pregunta (sin info nueva), NO agregues ninguna línea [CORRECCION].

MEMORIA PERSISTENTE — cuándo guardar algo para siempre:
Si Jhon te da una PREFERENCIA sobre cómo comportarte ("sé más breve", "tratame de
usted", "no uses emojis", "dame siempre los montos primero") o un DATO general del
negocio que debas recordar (no de un cliente puntual), agregá una línea al final:
[MEMORIA] tipo=preferencia | contenido=<lo que debés recordar, redactado claro y en primera persona>
Usá tipo=preferencia si es sobre tu forma de responder; tipo=dato si es un hecho
general del negocio. Confirmale a Jhon que lo vas a recordar. NO uses [MEMORIA] para
hechos de un cliente concreto — eso va en [CORRECCION].

${resumenConversacion ? `=== RESUMEN DE LO QUE YA HABLARON EN ESTE CHAT ===
${resumenConversacion}
(Abajo en el historial solo ves los mensajes más recientes; lo anterior de esta
conversación está acá resumido. Sirve para recordar de qué venían hablando.)

` : ''}=== CLIENTES (persona_id: nombre) ===
${listaClientes}

=== ESTADO DE TODOS LOS CLIENTES ===
${contextoClientes}`;
}

/**
 * Resume los mensajes viejos de una conversación larga, para que Junior no
 * olvide el principio sin tener que cargar el historial entero.
 */
async function resumirConversacion(viejos: MensajeChat[]): Promise<{ texto: string; costo: number }> {
  const transcripcion = viejos
    .map(h => `${h.rol === 'usuario' ? 'Jhon' : 'Junior'}: ${h.mensaje}`)
    .join('\n');
  const res = await deepseekChat({
    agente: 'A10_JUNIOR_RESUMEN',
    temperature: 0.2,
    costoLimiteUsd: 0.10,
    messages: [
      {
        role: 'system',
        content: `Resumí esta parte previa de una conversación entre Jhon (dueño de Fábrica
de Cortinas Girardot) y su asistente Junior. El resumen le sirve a Junior para
recordar de qué venían hablando.
CONSERVÁ: temas tratados, clientes mencionados, decisiones, pedidos o dudas que
quedaron pendientes, lo que Jhon pidió.
NO incluyas fechas ni montos como verdad dura — alcanza con "se habló de X".
Sé breve, en viñetas. Texto plano, sin JSON.`,
      },
      { role: 'user', content: transcripcion },
    ],
  });
  return { texto: res.contenido.trim(), costo: res.costo_usd };
}

/** Arma el bloque de contexto con el estado de todos los clientes. */
async function construirContextoClientes(sb: SupabaseClient): Promise<{ contexto: string; lista: string }> {
  const { data: personas } = await sb.from('personas')
    .select('id,nombre,telefono_e164,email,ciudad').is('deleted_at', null);
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
    const contacto = [
      p.telefono_e164 ? `tel: ${p.telefono_e164}` : null,
      p.email ? `email: ${p.email}` : null,
      p.ciudad ? `ciudad: ${p.ciudad}` : null,
    ].filter(Boolean).join(' · ');
    bloques.push(`▸ ${p.nombre} (id ${p.id})${contacto ? '\n  contacto → ' + contacto : ''}\n${lineas.join('\n')}`);
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
  sesionId: number,
): Promise<{ respuesta: string; correcciones: Correccion[]; memorias: Memoria[]; costo_usd: number; ok: boolean }> {
  const { contexto, lista } = await construirContextoClientes(sb);

  const { data: mems } = await sb.from('junior_memoria')
    .select('tipo,contenido').eq('vigente', true).order('created_at');
  const bloqueMemorias = (mems && mems.length)
    ? mems.map((m: any) => `- (${m.tipo}) ${m.contenido}`).join('\n')
    : '(todavía no le enseñaste nada — vacío)';

  // Compactación: en conversaciones largas los mensajes viejos se resumen en
  // vez de descartarse, para que Junior no pierda el principio del chat.
  const VENTANA = 10;  // mensajes recientes que se pasan crudos
  const UMBRAL = 20;   // a partir de cuántos mensajes se compacta
  let resumenConversacion = '';
  let recientes = historial;
  let costoResumen = 0;
  if (historial.length > UMBRAL) {
    const nViejos = historial.length - VENTANA;
    const viejos = historial.slice(0, nViejos);
    recientes = historial.slice(nViejos);
    const { data: ses } = await sb.from('junior_sesiones')
      .select('resumen,resumen_msgs').eq('id', sesionId).single();
    if (ses?.resumen && ses.resumen_msgs === nViejos) {
      resumenConversacion = ses.resumen;  // ya está al día, se reusa
    } else {
      const r = await resumirConversacion(viejos);
      resumenConversacion = r.texto;
      costoResumen = r.costo;
      await sb.from('junior_sesiones')
        .update({ resumen: resumenConversacion, resumen_msgs: nViejos })
        .eq('id', sesionId);
    }
  }

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt(contexto, lista, bloqueMemorias, resumenConversacion) },
  ];
  for (const h of recientes) {
    messages.push({ role: h.rol === 'usuario' ? 'user' : 'assistant', content: h.mensaje });
  }
  messages.push({ role: 'user', content: pregunta });

  // Texto natural (no JSON): el JSON mode hacía colapsar al LLM ante preguntas
  // cortas. Las correcciones van en líneas [CORRECCION] al final, que parseamos.
  let respuesta = '';
  let correcciones: Correccion[] = [];
  let memorias: Memoria[] = [];
  let costo_usd = costoResumen;

  const reCorr = /^\s*\[CORRECCION\]\s*persona_id\s*=\s*(\d+)\s*\|\s*modulo\s*=\s*(m[1-7])\s*\|\s*hecho\s*=\s*(.+)$/i;
  const reMem = /^\s*\[MEMORIA\]\s*tipo\s*=\s*(preferencia|dato)\s*\|\s*contenido\s*=\s*(.+)$/i;

  for (let intento = 1; intento <= 2; intento++) {
    const res = await deepseekChat({
      agente: 'A10_JUNIOR_CHAT',
      temperature: 0.4,
      costoLimiteUsd: 0.10,
      messages,
    });
    costo_usd += res.costo_usd;

    const lineasResp: string[] = [];
    correcciones = [];
    memorias = [];
    for (const linea of res.contenido.split('\n')) {
      const mc = linea.match(reCorr);
      const mm = linea.match(reMem);
      if (mc) correcciones.push({ persona_id: Number(mc[1]), modulo: mc[2].toLowerCase(), hecho: mc[3].trim() });
      else if (mm) memorias.push({ tipo: mm[1].toLowerCase() as 'preferencia' | 'dato', contenido: mm[2].trim() });
      else lineasResp.push(linea);
    }
    respuesta = lineasResp.join('\n').trim();

    if (respuesta.length > 0) break;
    console.warn(`[A10_JUNIOR_CHAT] respuesta vacía (intento ${intento}), reintentando`);
  }

  let ok = true;
  if (respuesta.length === 0) {
    respuesta = 'Disculpá, no pude armar la respuesta. ¿Me la repetís o reformulás?';
    ok = false;
  }

  return { respuesta, correcciones, memorias, costo_usd, ok };
}
