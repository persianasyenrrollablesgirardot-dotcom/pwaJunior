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
export interface NuevoCliente { nombre: string; telefono: string | null; ciudad: string | null }
export interface ResolucionDuplicado { duplicado_id: number; accion: 'fusionar' | 'descartar' }

/** Parsea una cadena "clave=valor | clave=valor" en un objeto. */
function parsearCampos(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const parte of s.split('|')) {
    const i = parte.indexOf('=');
    if (i > 0) out[parte.slice(0, i).trim().toLowerCase()] = parte.slice(i + 1).trim();
  }
  return out;
}

function systemPrompt(
  contextoClientes: string, listaClientes: string, memorias: string, resumenConversacion: string,
  duplicados: string,
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
- EXCEPCIÓN: si un cliente figura con "⏳ análisis en generación", su chat se acaba de
  capturar y los analistas todavía lo están procesando. NUNCA digas que no existe ni que
  no tenés nada de él — decí que su análisis se está generando y que te pregunten de
  nuevo en un minuto.
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

CLIENTE NUEVO — cuando Jhon te cuenta de alguien que llegó al local, llamó, o
contactó por otro medio. Seguí SIEMPRE estos dos pasos, EN ORDEN:

PASO 1 — ¿YA EXISTE? (obligatorio, hacelo SIEMPRE primero)
Mirá la lista "CLIENTES (persona_id: nombre)" de abajo. Si hay alguien con un nombre
IGUAL o PARECIDO al que te dictó Jhon —aunque esté escrito distinto ("Maria Gonzalez"
vs "María González"), abreviado ("Pedro G."), o que coincida solo el nombre de pila—
entonces NO lo registres. En tu respuesta preguntale a Jhon si es esa MISMA persona o
una distinta, y contale qué sabés del que ya existe (su id y ciudad) para que lo
reconozca. En ese mensaje NO agregues NINGUNA línea [NUEVO_CLIENTE].
  IMPORTANTE: aunque Jhon diga "cliente NUEVO", si el nombre ya aparece en la lista
  IGUAL tenés que preguntar primero. Dos personas distintas pueden llamarse igual, así
  que NUNCA des por sentado que es la misma NI que es otra — preguntá. Un cliente que
  figure con "⏳ análisis en generación" TAMBIÉN cuenta como que ya existe.
Después, según lo que responda Jhon:
  · "es el mismo" → NO registres cliente nuevo. Las medidas/pedidos de ese cliente
    anotalos con [CORRECCION] persona_id=<el id del cliente que YA existe en la lista>.
  · "es otro distinto" → recién ahí pasá al PASO 2.

PASO 2 — REGISTRAR (solo si el nombre NO se parece a nadie de la lista, o si Jhon ya
te confirmó que es otra persona distinta):
Agregá una línea con este formato EXACTO:
[NUEVO_CLIENTE] nombre=<nombre completo> | telefono=<número o vacío> | ciudad=<ciudad o vacío>
El teléfono es IMPORTANTE: si Jhon no te lo dio, pedíselo en tu respuesta (sirve para
reconocer al cliente cuando después escriba por WhatsApp). Igual registralo aunque falte.
Para las medidas / novedades / pedidos de ese cliente nuevo, agregá líneas [CORRECCION]
con persona_id=0 — el 0 significa "el cliente que estoy creando en este mismo mensaje".
Ejemplo — Jhon dice "anotá un cliente, Pedro Gómez, vino al local, quiere blackout para
3 ventanas" y NO hay ningún Pedro Gómez parecido en la lista:
[NUEVO_CLIENTE] nombre=Pedro Gómez | telefono= | ciudad=
[CORRECCION] persona_id=0 | modulo=m4 | hecho=Quiere cortinas blackout para 3 ventanas
[CORRECCION] persona_id=0 | modulo=m2 | hecho=Vino al local, interesado en cotización

MEMORIA PERSISTENTE — cuándo guardar algo para siempre:
Si Jhon te da una PREFERENCIA sobre cómo comportarte ("sé más breve", "tratame de
usted", "no uses emojis", "dame siempre los montos primero") o un DATO general del
negocio que debas recordar (no de un cliente puntual), agregá una línea al final:
[MEMORIA] tipo=preferencia | contenido=<lo que debés recordar, redactado claro y en primera persona>
Usá tipo=preferencia si es sobre tu forma de responder; tipo=dato si es un hecho
general del negocio. Confirmale a Jhon que lo vas a recordar. NO uses [MEMORIA] para
hechos de un cliente concreto — eso va en [CORRECCION].
${duplicados}

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
    const contacto = [
      p.telefono_e164 ? `tel: ${p.telefono_e164}` : null,
      p.email ? `email: ${p.email}` : null,
      p.ciudad ? `ciudad: ${p.ciudad}` : null,
    ].filter(Boolean).join(' · ');
    const encabezado = `▸ ${p.nombre} (id ${p.id})${contacto ? '\n  contacto → ' + contacto : ''}`;
    if (ss.length === 0) {
      // Cliente recién capturado: el chat existe pero los analistas todavía no
      // generaron su síntesis. NO es un cliente vacío — su análisis está en cola.
      bloques.push(`${encabezado}\n  ⏳ análisis en generación — el chat se capturó hace poco y los analistas todavía lo están procesando. NO digas que no existe ni que no hay datos: decí que su análisis se está generando y que pregunten de nuevo en un minuto.`);
      continue;
    }
    const orden = ['junior', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7'];
    ss.sort((a, b) => orden.indexOf(a.modulo) - orden.indexOf(b.modulo));
    const lineas = ss.map(s =>
      `  · ${MODULO_NOMBRE[s.modulo] ?? s.modulo}: ${s.sintesis ?? '—'}` +
      (s.alerta ? ` [ALERTA: ${s.alerta}]` : ''));
    bloques.push(`${encabezado}\n${lineas.join('\n')}`);
  }
  return {
    contexto: bloques.join('\n\n'),
    lista: personas.map(p => `${p.id}: ${p.nombre}`).join('\n'),
  };
}

/**
 * F7.3 — arma el bloque de posibles clientes duplicados pendientes de que Jhon
 * confirme. Devuelve '' si no hay ninguno. Incluye instrucciones + la lista.
 */
async function cargarDuplicadosPendientes(sb: SupabaseClient): Promise<string> {
  const { data: dups } = await sb.from('duplicados_detectados')
    .select('id, persona_nueva_id, persona_existente_id, motivo')
    .eq('estado', 'pendiente')
    .order('created_at', { ascending: true });
  if (!dups || dups.length === 0) return '';

  const ids = [...new Set(dups.flatMap(d => [d.persona_nueva_id, d.persona_existente_id]))];
  const { data: pers } = await sb.from('personas').select('id, nombre, ciudad').in('id', ids);
  const ref = (id: number) => {
    const p = pers?.find(x => x.id === id);
    return p ? `"${p.nombre ?? 'sin nombre'}" (id ${id}${p.ciudad ? ', ' + p.ciudad : ''})` : `id ${id}`;
  };
  const lineas = dups.map(d =>
    `[duplicado #${d.id}] ${ref(d.persona_nueva_id)} podría ser la misma persona que ` +
    `${ref(d.persona_existente_id)}.${d.motivo ? ' Motivo: ' + d.motivo : ''}`);

  return `

DUPLICADOS PENDIENTES — posibles clientes repetidos:
El sistema detectó clientes que quizás son la misma persona registrada dos veces.
Planteáselo a Jhon en tu respuesta: decile cuáles son y preguntale si son la misma
persona o dos distintas. NO los fusiones por tu cuenta — esperá que Jhon decida.
Cuando Jhon te responda sobre un duplicado concreto, agregá al final una línea con
este formato EXACTO:
[RESOLVER_DUPLICADO] id=<número del duplicado> | accion=fusionar
  → cuando Jhon confirma que SON la misma persona (se unen en una sola ficha).
[RESOLVER_DUPLICADO] id=<número del duplicado> | accion=descartar
  → cuando Jhon dice que son personas DISTINTAS (se deja de avisar de ese par).
Si Jhon no se pronuncia sobre un duplicado, no agregues la línea de ese.

=== POSIBLES CLIENTES DUPLICADOS (pendientes de tu confirmación) ===
${lineas.join('\n')}`;
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
): Promise<{ respuesta: string; correcciones: Correccion[]; memorias: Memoria[]; nuevosClientes: NuevoCliente[]; resoluciones: ResolucionDuplicado[]; costo_usd: number; ok: boolean }> {
  const { contexto, lista } = await construirContextoClientes(sb);
  const duplicados = await cargarDuplicadosPendientes(sb);

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
    { role: 'system', content: systemPrompt(contexto, lista, bloqueMemorias, resumenConversacion, duplicados) },
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
  let nuevosClientes: NuevoCliente[] = [];
  let resoluciones: ResolucionDuplicado[] = [];
  let costo_usd = costoResumen;

  const reCorr = /^\s*\[CORRECCION\]\s*persona_id\s*=\s*(\d+)\s*\|\s*modulo\s*=\s*(m[1-7])\s*\|\s*hecho\s*=\s*(.+)$/i;
  const reMem = /^\s*\[MEMORIA\]\s*tipo\s*=\s*(preferencia|dato)\s*\|\s*contenido\s*=\s*(.+)$/i;
  const reNuevo = /^\s*\[NUEVO_CLIENTE\]\s*(.+)$/i;
  const reResolver = /^\s*\[RESOLVER_DUPLICADO\]\s*id\s*=\s*(\d+)\s*\|\s*accion\s*=\s*(fusionar|descartar)\s*$/i;

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
    nuevosClientes = [];
    resoluciones = [];
    for (const linea of res.contenido.split('\n')) {
      const mc = linea.match(reCorr);
      const mm = linea.match(reMem);
      const mn = linea.match(reNuevo);
      const mr = linea.match(reResolver);
      if (mc) correcciones.push({ persona_id: Number(mc[1]), modulo: mc[2].toLowerCase(), hecho: mc[3].trim() });
      else if (mm) memorias.push({ tipo: mm[1].toLowerCase() as 'preferencia' | 'dato', contenido: mm[2].trim() });
      else if (mn) {
        const campos = parsearCampos(mn[1]);
        if (campos.nombre) nuevosClientes.push({
          nombre: campos.nombre, telefono: campos.telefono || null, ciudad: campos.ciudad || null,
        });
      }
      else if (mr) resoluciones.push({
        duplicado_id: Number(mr[1]), accion: mr[2].toLowerCase() as 'fusionar' | 'descartar',
      });
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

  return { respuesta, correcciones, memorias, nuevosClientes, resoluciones, costo_usd, ok };
}
