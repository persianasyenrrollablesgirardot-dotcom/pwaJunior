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

interface FilaIndice { chat_id: number; nombre: string; tel: string; tipo: string; estado: string; proximo: string }

async function cargarIndice(sb: SupabaseClient): Promise<FilaIndice[]> {
  const { data: tjs } = await sb.from('tarjeta')
    .select('chat_id, tipo_contacto, persona_id, es_no_cliente, personas(nombre, telefono_e164)')
    .eq('es_no_cliente', false);  // no surfacear no-clientes (restaurante/spam) a Junior
  const { data: cks } = await sb.from('tarjeta_checklist')
    .select('chat_id, estado_conversacion, proximo_paso');
  const ck = new Map((cks ?? []).map((c: any) => [c.chat_id, c]));
  return (tjs ?? []).map((t: any) => ({
    chat_id: t.chat_id,
    nombre: t.personas?.nombre ?? `Chat #${t.chat_id}`,
    tel: t.personas?.telefono_e164 ?? '',
    tipo: t.tipo_contacto,
    estado: ck.get(t.chat_id)?.estado_conversacion ?? '?',
    proximo: ck.get(t.chat_id)?.proximo_paso ?? '',
  }));
}

async function cargarDetalle(sb: SupabaseClient, chatIds: number[]): Promise<string> {
  const bloques: string[] = [];
  for (const id of chatIds) {
    const { data: t } = await sb.from('tarjeta')
      .select('tipo_contacto, narrativa, notas, contexto, persona_id, es_no_cliente, no_cliente_subtipo, personas(nombre, telefono_e164, ciudad)')
      .eq('chat_id', id).maybeSingle();
    if (!t) continue;
    const tt: any = t;
    const contacto = [tt.personas?.telefono_e164 ? `tel ${tt.personas.telefono_e164}` : null, tt.personas?.ciudad].filter(Boolean).join(' · ');
    // Defensa: si el chat quedó marcado no-cliente (colaborador/restaurante/spam/etc.),
    // NO leemos la narrativa vieja (puede ser previa al re-flagueo). Dar la VERDAD breve.
    if (tt.es_no_cliente) {
      bloques.push(
        `### ${tt.personas?.nombre ?? `Chat #${id}`} (chat ${id})\n` +
        (contacto ? `CONTACTO: ${contacto}\n` : '') +
        `MARCADO NO-CLIENTE (${tt.no_cliente_subtipo ?? 'otro'}). No es un cliente comercial. ` +
        `Decile esto a Jhon en una frase, NO inventes historia comercial ni te apoyes en la narrativa vieja.`
      );
      continue;
    }
    const { data: ck } = await sb.from('tarjeta_checklist').select('estado_conversacion, proximo_paso').eq('chat_id', id).maybeSingle();
    const { data: tar } = await sb.from('tarjeta_tarea').select('titulo, prioridad').eq('chat_id', id).order('prioridad');
    const { data: ag } = await sb.from('tarjeta_agenda').select('titulo, cuando, lugar').eq('chat_id', id);
    const ctx = (tt.contexto ?? []).map((c: any) => `  [${c.titulo}] ${c.sintesis}`).join('\n');
    bloques.push(
      `### ${tt.personas?.nombre ?? `Chat #${id}`} (chat ${id}, ${tt.tipo_contacto})\n` +
      (contacto ? `CONTACTO: ${contacto}\n` : '') +
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
  // Defensa: si derivarChecklist coló una NO-ACCIÓN en estado=espera_jhon
  // (mantenerse / esperar / observar / "decidir si X o Y" / reclasifi…/o mantener…),
  // la bajamos a 'cerrado' en el índice IN-MEMORY para que ni el ruteo LLM ni el
  // fallback la listen como pendiente. La fila sigue accesible por nombre, pero
  // no contamina el listado de "te toca".
  const NO_ACCION = /\b(mantener(se)?|esperar(\s+oportunidades)?|observar|monitorear|reclasifi|expectativa|atento|sin\s+acci[oó]n|ninguna\s+acci[oó]n|decidir\s+si\b[^.]*\bo\b)/i;
  for (const f of indice) {
    if (f.proximo && (f.estado === 'espera_jhon' || f.estado === 'sin_responder') && NO_ACCION.test(f.proximo)) {
      f.estado = 'cerrado';
    }
  }
  const indiceTexto = indice.length
    ? indice.map(f => `chat ${f.chat_id} | ${f.nombre}${f.tel ? ` | ${f.tel}` : ''} | ${f.tipo} | estado:${f.estado} | próximo:${f.proximo}`).join('\n')
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
        `de tarjetas (una por chat, con nombre, TELÉFONO, tipo, estado y próximo paso). Resolvé referencias de la pregunta usando ` +
        `la conversación previa ("ese", "él", "el anterior", "ese cliente" → el cliente del que se venía hablando).\n` +
        `Cuando armes una respuesta_directa que LISTE varios contactos (pendientes, agenda, "te toca", etc), incluí el TELÉFONO entre paréntesis al lado del nombre cuando esté disponible — formato: "Nombre (+57XXX…)". Si no hay tel en el índice, omitilo silencioso.\n` +
        `Decidí:\n` +
        `- Si se responde con el índice (ej. "¿quién espera mi respuesta?") → puede_responder_con_indice=true + respuesta_directa.\n` +
        `- Si Jhon pide EXPLÍCITAMENTE un listado de TODOS los pendientes/agenda (frases muy específicas como "dame los pendientes", ` +
        `"dame la lista", "qué tengo pendiente", "lista de tareas", "organizá mi agenda", "guiate por el checklist") → ` +
        `puede_responder_con_indice=false y chat_ids=[]. El sistema arma un listado determinístico (AGENDA + TE TOCA).\n` +
        `   ❌ NO uses esta rama para meta-preguntas o aclaraciones ("por qué me das todo?", "qué te pasa?", "no entiendo", "explícame"). ` +
        `Esas son CONVERSACIÓN y van por respuesta_directa LLM normal, leyendo la conversación previa.\n` +
        `   ❌ NO uses esta rama para queries con FECHA específica ("qué tengo HOY", "qué tengo MAÑANA", "qué tengo el sábado"). ` +
        `Para esas: puede_responder_con_indice=true y armá vos la respuesta_directa filtrando del índice por esa fecha.\n` +
        `   ❌ SI el ÚLTIMO turno de Junior en la conversación previa fue un listado completo (empieza con "📅 AGENDA próxima"), ` +
        `NO vuelvas a tirar listado salvo que Jhon lo pida explícitamente otra vez. Si pregunta algo conexo, respondé conversacional.\n` +
        `- Si es sobre cliente(s) específico(s) → puede_responder_con_indice=false y listá los chat_ids relevantes (máx 5). ` +
        `⚠ CRÍTICO: si la pregunta MENCIONA un nombre o teléfono (aunque también diga "tareas/pendientes"), es ESPECÍFICA, NO genérica. ` +
        `Ej: "dame las tareas de Constanza Madeiras (+573108377932)" → cargá SOLO esa tarjeta, NO devuelvas chat_ids=[]. ` +
        `"qué pasa con Pedro" → cargá la tarjeta de Pedro. NO conviertas queries con nombre en listados completos.\n` +
        `NUNCA digas que "no hay tarjetas seleccionadas" ni pidas que Jhon "seleccione" — no existe seleccionar, SIEMPRE tenés el índice. ` +
        `Si "actualizar" se refiere a las tarjetas: aclaramos que se actualizan solas con info nueva, y mostramos el estado actual. ` +
        `En respuesta_directa NUNCA inventes datos (horas/montos/fechas) que no estén en el índice; si Jhon insiste con algo que no ves, no se lo confirmes inventando.\n` +
        `- Si Jhon pide CREAR UNA TAREA / agendá esto / hay que hacer X (acción concreta y verbalizada con verbo de acción: ` +
        `"crea una tarea para llamar a X", "hay que cortar las telas", "agendá llamar a Y", "tareita: confirmar pago") → ` +
        `devolvé nueva_tarea={"chat_id": <chat>, "titulo": "<la acción concreta, ≤120 chars, en infinitivo o imperativo: 'Cortar las telas y programar mantenimiento'>"}. ` +
        `Si el contacto NO está claro o es ambiguo (ver REGLA ANTI-ASUMIR abajo), o si Jhon dice "transversal / general / sin cliente / sin contacto / no asignada", ` +
        `devolvé nueva_tarea_transversal={"titulo": "<acción>", "descripcion": "<contexto opcional, ej: 'Señora del conjunto Madeira, sin teléfono todavía'>"}. ` +
        `IMPORTANTE: tarea ≠ nota. Tarea es acción pendiente que aparecerá listada cuando Jhon pida "tareas pendientes". Nota es contexto.\n` +
        `- Si Jhon te da una INSTRUCCIÓN para recordar/anotar contexto sobre un contacto ("este es mi instalador William", "anotá que X es socio", ` +
        `"recordá que Y siempre llega tarde", "tené en cuenta que Z prefiere efectivo") → devolvé nota={"chat_id": <chat del contacto del índice>, "texto": "<la instrucción ` +
        `redactada como nota>"}. Es CONTEXTO para guardar, no una tarea.\n` +
        `   ⚠ REGLA ANTI-ASUMIR (aplica a nueva_tarea Y nota): si el contacto se describe por un FRAGMENTO ambiguo (apellido común, nombre de CONJUNTO/edificio/calle, ` +
        `referencia geográfica como "la del peñón", "el del cortijo", "señora de Madeira"), NO crees nada a la primera tarjeta que ` +
        `matchee. Frases tipo "señora/señor/cliente DE <Lugar>" casi siempre refieren al LUGAR (conjunto residencial donde vive el cliente) ` +
        `y no a un apellido — y puede haber varios clientes en ese lugar. En esos casos: para TAREAS, devolvé nueva_tarea_transversal con descripción que mencione la pista ` +
        `("Señora del conjunto Madeira — pedir nombre/tel a Jhon"). Para NOTAS, devolvé puede_responder_con_indice=true + respuesta_directa pidiendo aclaración. ` +
        `Mejor crear transversal o preguntar que asumir y meter en el contacto equivocado — caso real: tarea terminó en Constanza Madeiras cuando era OTRA persona del conjunto Madeira.\n` +
        `- Si Jhon dice CÓMO SE LLAMA un contacto ("se llama Germán", "es Germán el socio", "este es William") → devolvé ` +
        `nuevo_nombre={"chat_id": <chat del contacto>, "nombre": "<el nombre, ej. 'Germán (socio)'>"} para actualizar el nombre de la tarjeta. ` +
        `Puede ir JUNTO con nota (la instrucción) en el mismo mensaje.\n` +
        `- Si Jhon pide CERRAR / MARCAR COMO CERRADO / dar por TERMINADO / RESUELTO un caso ("cerrá X", "cierra X", ` +
        `"X ya está cerrado", "lo cerré por fuera", "ya hablé con él y cerramos", "dalo por terminado", "ya quedó resuelto") → ` +
        `convertilo en nota={"chat_id": <chat del contacto>, "texto": "Cierre por Jhon: <razón que dio, o 'tras conversación directa con el cliente' si no dio razón>"}. ` +
        `Junior NO puede cambiar el estado de la tarjeta directamente, pero la nota queda registrada y los agentes re-derivan el checklist en el próximo ciclo. ` +
        `Si Jhon insiste varias veces que lo cierres, NO inventes que ya lo hiciste — convertilo en nota acá y respondé honesto en respuesta_directa: "anoté el cierre por tu indicación; los agentes lo procesan en el próximo ciclo".\n` +
        `\n` +
        `- Si Jhon pide BORRAR / ELIMINAR algo concreto ("borrá la nota de X sobre Y", "eliminá la tarea de Z", "borrá la tarea transversal #N", ` +
        `"sacá esa anotación"), identificá QUÉ borrar y devolvé el campo correspondiente:\n` +
        `  • borrar_nota={"chat_id": <chat del contacto>, "texto_match": "<fragmento del texto de la nota para identificarla>"} → busca en notas_libres del contacto.\n` +
        `  • borrar_tarea={"chat_id": <chat>, "titulo_match": "<fragmento del título>"} → busca en tarjeta_tarea del contacto (solo borra las origen='junior').\n` +
        `  • borrar_tarea_transversal={"id": <id si te lo dieron, ej #2>, "titulo_match": "<o fragmento del título>"} → busca en tareas_transversales.\n` +
        `Si Jhon NO especifica qué borrar ("borrá lo de Constanza" sin más), devolvé respuesta_directa pidiendo aclaración ("¿la nota sobre X o la tarea de Y?"). ` +
        `El sistema verifica unicidad y NO borra si hay 0 o ≥2 matches — te avisa para pedir aclaración.\n` +
        `\n` +
        `═══ HONESTIDAD SOBRE LO QUE NO PODÉS HACER ═══\n` +
        `Tus capacidades de escritura son SEIS Y NADA MÁS: (1) crear nota libre en una persona, (2) cambiar el nombre del contacto, ` +
        `(3) crear tarea en tarjeta_tarea de un contacto (origen='junior'), (4) crear tarea_transversal (sin contacto), ` +
        `(5) BORRAR nota libre identificándola por texto (busca por persona_id + match), (6) BORRAR tarea (origen='junior' o transversal) por título/id.\n` +
        `Si Jhon te pide CUALQUIER OTRA COSA de escritura, NO MIENTAS confirmando. Devolvé puede_responder_con_indice=true + ` +
        `respuesta_directa explicando honestamente que no podés Y ofreciendo lo más cercano que sí podés. Lista de pedidos que NO podés ejecutar:\n` +
        `  • "moveme esta tarea a otro contacto" → no puedo mover, pero PUEDO crearla en el nuevo y BORRAR la del viejo (si origen=junior) o dejar nota CANCELADA si la creó el agente.\n` +
        `  • "marcala como hecha / completada / dale check" → no puedo marcar tareas como hechas. Si fue creada por mí (origen=junior) puedo BORRARLA. Si la creó el agente, te dejo nota "Completada el <fecha>" o vos le hacés check en la UI.\n` +
        `  • "editá esta tarea / cambiale el título" → no puedo editar. Pero PUEDO borrar la vieja (si origen=junior) y crear una nueva con el título correcto, lo hago en un solo paso.\n` +
        `  • "agendá visita el <fecha> a las <hora>" / "crea agendamiento" → no puedo escribir en el calendario. Andá al panel Agendamientos y agregala ahí (botón 📅 Agendar).\n` +
        `  • "borrá esta cita / cancelá agendamiento" → no puedo. Andá a Agendamientos y borrala desde ahí.\n` +
        `  • "editá esta cita" → no puedo. Tocá ✏️ en la cita del panel Agendamientos.\n` +
        `  • "creá un contacto nuevo" → no puedo crear contactos desde cero. Los contactos vienen automáticos del WhatsApp. Si es alguien sin WhatsApp registrado, dejala como tarea_transversal con la descripción.\n` +
        `  • "borrá este contacto / este cliente" → no puedo. Andá al panel del cliente y archivalo ahí.\n` +
        `  • "mandale un mensaje / WhatsApp a X" → no puedo enviar mensajes por vos. Te puedo abrir el link de WhatsApp con clic en el teléfono.\n` +
        `Cuando respondas con "no puedo X, pero puedo Y", sé BREVE, claro y ofreceme la opción Y como pregunta directa para que diga sí/no. ` +
        `NUNCA inventes que ejecutaste algo. NUNCA digas "listo" si no creaste/borraste una de las 6 cosas. Mentir es peor que negarte.\n` +
        `\n` +
        `Devolvé SOLO JSON: {"puede_responder_con_indice": bool, "respuesta_directa": string|null, "chat_ids": number[], ` +
        `"nota": {"chat_id": number, "texto": string} | null, ` +
        `"nuevo_nombre": {"chat_id": number, "nombre": string} | null, ` +
        `"nueva_tarea": {"chat_id": number, "titulo": string} | null, ` +
        `"nueva_tarea_transversal": {"titulo": string, "descripcion": string} | null, ` +
        `"borrar_nota": {"chat_id": number, "texto_match": string} | null, ` +
        `"borrar_tarea": {"chat_id": number, "titulo_match": string} | null, ` +
        `"borrar_tarea_transversal": {"id": number|null, "titulo_match": string} | null}`,
    },
    { role: 'user', content: `CONVERSACIÓN PREVIA:\n${histTexto}\n\nÍNDICE DE TARJETAS:\n${indiceTexto}\n\nNUEVA PREGUNTA DE JHON: ${pregunta}` },
  ];
  const r1 = await deepseekChat({ messages: ruteo, agente: 'JUNIOR_V2_RUTEO', max_tokens: 900, response_format: { type: 'json_object' } });
  let plan: any = {};
  try { plan = JSON.parse(r1.contenido); } catch { plan = {}; }
  let costo = r1.costo_usd;

  // ── Acciones de escritura: actualizar NOMBRE y/o agregar NOTA ──────────────
  // Junior puede ESCRIBIR (nombre + nota → la tarjeta se rehace) y confirma con la
  // verdad, sólo después de guardar. Las dos pueden venir en el mismo mensaje.
  const accNombre = plan.nuevo_nombre && typeof plan.nuevo_nombre.chat_id === 'number'
    && typeof plan.nuevo_nombre.nombre === 'string' && plan.nuevo_nombre.nombre.trim() ? plan.nuevo_nombre : null;
  let accNota = plan.nota && typeof plan.nota.chat_id === 'number'
    && typeof plan.nota.texto === 'string' && plan.nota.texto.trim() ? plan.nota : null;

  // Guard determinístico ANTI-ASUMIR: si Jhon describe al contacto con un
  // patrón ambiguo ("señor/señora/cliente DE <Lugar>", "del conjunto X",
  // "de la calle Y"), bloqueamos la creación de nota y pedimos aclaración. El
  // LLM ignora la regla en el system prompt cuando hay un match obvio — el
  // guard determinístico es el último filtro. Caso reportado: "señora de
  // Madeira" → la nota terminaba en Constanza Madeiras cuando era OTRA persona
  // del mismo conjunto residencial llamado Madeira.
  if (accNota) {
    // Patrón "señor/señora/cliente/don/doña DE <Lugar-o-fragmento>". El "DE" es
    // la señal — indica relación con un LUGAR (conjunto residencial, calle), no
    // un apellido. Aunque haya 1 sola tarjeta que matchee el fragmento, igual
    // preguntamos: el caso real fue "señora DE Madeira" → Constanza Madeiras
    // matcheaba, pero el target era OTRA clienta del mismo conjunto Madeira.
    const matchAmbiguo = pregunta.match(/\b(?:se(?:ñ|n)or[a]?|cliente[a]?s?|don|do(?:ñ|n)a)\s+de(?:l|\s+la|\s+los|\s+las|\s+conjunto|\s+edificio|\s+calle|\s+carrera|\s+avenida|\s+barrio)?\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][\wÁÉÍÓÚÑáéíóúñ'·-]+)/i);
    if (matchAmbiguo) {
      const fragmento = matchAmbiguo[1].trim();
      // Listar todos los candidatos cuyo nombre o próximo_paso contiene el
      // fragmento — Jhon puede elegir o confirmar que es otra persona.
      const candidatos = indice.filter(f =>
        f.nombre.toLowerCase().includes(fragmento.toLowerCase()) ||
        (f.proximo ?? '').toLowerCase().includes(fragmento.toLowerCase())
      );
      const lista = candidatos.slice(0, 4).map(c => `${c.nombre}${c.tel ? ` (${c.tel})` : ''}`).join(', ');
      const sugerencia = candidatos.length
        ? `Posibles: ${lista}. ¿Es alguno de esos o es otra persona del mismo lugar?`
        : `No encontré a nadie llamado "${fragmento}" — puede que sea un lugar y la persona tenga otro nombre.`;
      accNota = null;
      plan.respuesta_directa = `Antes de crearla quiero confirmar: cuando decís "${fragmento}", ¿quién es exactamente? ${sugerencia} Pasame el nombre completo o el teléfono y la creo en la tarjeta correcta.`;
      plan.puede_responder_con_indice = true;
      plan.chat_ids = [];
    }
  }
  // Validar y normalizar las nuevas acciones de creación de tareas reales.
  const accTarea = plan.nueva_tarea && typeof plan.nueva_tarea.chat_id === 'number'
    && typeof plan.nueva_tarea.titulo === 'string' && plan.nueva_tarea.titulo.trim() ? plan.nueva_tarea : null;
  const accTareaTransv = plan.nueva_tarea_transversal && typeof plan.nueva_tarea_transversal.titulo === 'string'
    && plan.nueva_tarea_transversal.titulo.trim() ? plan.nueva_tarea_transversal : null;

  // ── Acciones de BORRADO ────────────────────────────────────────────────────
  // Los 3 borrar_X requieren UNICIDAD: borramos solo si hay exactamente 1 match.
  // 0 matches → "no encontré"; ≥2 → "encontré varias, ¿cuál?". Nunca borra al voleo.
  const accBorrarNota = plan.borrar_nota && typeof plan.borrar_nota.chat_id === 'number'
    && typeof plan.borrar_nota.texto_match === 'string' && plan.borrar_nota.texto_match.trim() ? plan.borrar_nota : null;
  const accBorrarTarea = plan.borrar_tarea && typeof plan.borrar_tarea.chat_id === 'number'
    && typeof plan.borrar_tarea.titulo_match === 'string' && plan.borrar_tarea.titulo_match.trim() ? plan.borrar_tarea : null;
  const accBorrarTareaTransv = plan.borrar_tarea_transversal && (
    typeof plan.borrar_tarea_transversal.id === 'number' ||
    (typeof plan.borrar_tarea_transversal.titulo_match === 'string' && plan.borrar_tarea_transversal.titulo_match.trim())
  ) ? plan.borrar_tarea_transversal : null;

  if (accBorrarNota) {
    // Resolver persona_id desde el chat_id (mismo helper que el bloque de escritura).
    const { data: cl } = await sb.from('chat_checklist').select('persona_id').eq('chat_id', accBorrarNota.chat_id).maybeSingle();
    let personaId = (cl?.persona_id as number) ?? null;
    if (!personaId) {
      const { data: ch } = await sb.from('chats').select('proyecto_id').eq('id', accBorrarNota.chat_id).maybeSingle();
      if (ch?.proyecto_id) {
        const { data: pr } = await sb.from('proyectos').select('persona_id').eq('id', ch.proyecto_id).maybeSingle();
        personaId = (pr?.persona_id as number) ?? null;
      }
    }
    if (!personaId) {
      return { respuesta: `No identifiqué el contacto para borrar la nota. Decime de qué cliente es.`, tarjetas_usadas: [], via_indice: false, costo_usd: costo };
    }
    const fragmento = String(accBorrarNota.texto_match).trim();
    const { data: notas } = await sb.from('notas_libres')
      .select('id, contenido').eq('persona_id', personaId).ilike('contenido', `%${fragmento}%`);
    const nombreContacto = indice.find(f => f.chat_id === accBorrarNota.chat_id)?.nombre ?? `chat ${accBorrarNota.chat_id}`;
    if (!notas || notas.length === 0) {
      return { respuesta: `No encontré ninguna nota de ${nombreContacto} que contenga "${fragmento}". Probá con otro fragmento del texto.`, tarjetas_usadas: [accBorrarNota.chat_id], via_indice: false, costo_usd: costo };
    }
    if (notas.length > 1) {
      const previa = notas.slice(0, 4).map((n: any) => `• [#${n.id}] ${String(n.contenido).slice(0, 80)}${n.contenido.length > 80 ? '…' : ''}`).join('\n');
      return { respuesta: `Encontré ${notas.length} notas de ${nombreContacto} que matchean "${fragmento}":\n${previa}\n¿Cuál borrar? Decime el ID o un fragmento más específico.`, tarjetas_usadas: [accBorrarNota.chat_id], via_indice: false, costo_usd: costo };
    }
    const { error } = await sb.from('notas_libres').delete().eq('id', notas[0].id);
    if (error) {
      return { respuesta: `No pude borrar la nota: ${error.message}`, tarjetas_usadas: [accBorrarNota.chat_id], via_indice: false, costo_usd: costo };
    }
    await sb.from('personas').update({ sintesis_pendiente: true } as any).eq('id', personaId);
    await sb.from('tarjeta').update({ dirty: true } as any).eq('chat_id', accBorrarNota.chat_id);
    return { respuesta: `Listo, borré la nota de ${nombreContacto}: «${String(notas[0].contenido).slice(0, 120)}${notas[0].contenido.length > 120 ? '…' : ''}». La tarjeta se actualiza en unos segundos.`, tarjetas_usadas: [accBorrarNota.chat_id], via_indice: false, costo_usd: costo };
  }

  if (accBorrarTarea) {
    const fragmento = String(accBorrarTarea.titulo_match).trim();
    // Solo borramos tareas que Junior creó (origen='junior'). Las del agente
    // se regeneran al rato — borrarlas sería inútil y peligroso.
    const { data: tareas } = await sb.from('tarjeta_tarea')
      .select('id, titulo, origen').eq('chat_id', accBorrarTarea.chat_id).ilike('titulo', `%${fragmento}%`);
    const nombreContacto = indice.find(f => f.chat_id === accBorrarTarea.chat_id)?.nombre ?? `chat ${accBorrarTarea.chat_id}`;
    if (!tareas || tareas.length === 0) {
      return { respuesta: `No encontré tareas de ${nombreContacto} con "${fragmento}". Probá con otro fragmento.`, tarjetas_usadas: [accBorrarTarea.chat_id], via_indice: false, costo_usd: costo };
    }
    const borrables = tareas.filter((t: any) => t.origen === 'junior');
    if (borrables.length === 0) {
      const lista = tareas.slice(0, 3).map((t: any) => `• ${t.titulo}`).join('\n');
      return { respuesta: `Esa(s) tarea(s) la creó el agente, no yo — no las puedo borrar (se regeneran solas al rato). Si querés que no aparezca, te dejo nota "Completada" o vos le hacés check en la UI:\n${lista}`, tarjetas_usadas: [accBorrarTarea.chat_id], via_indice: false, costo_usd: costo };
    }
    if (borrables.length > 1) {
      const previa = borrables.slice(0, 4).map((t: any) => `• [#${t.id}] ${t.titulo}`).join('\n');
      return { respuesta: `Encontré ${borrables.length} tareas mías de ${nombreContacto} con "${fragmento}":\n${previa}\n¿Cuál borrar? Decime el ID o un fragmento más específico.`, tarjetas_usadas: [accBorrarTarea.chat_id], via_indice: false, costo_usd: costo };
    }
    const { error } = await sb.from('tarjeta_tarea').delete().eq('id', borrables[0].id);
    if (error) {
      return { respuesta: `No pude borrar la tarea: ${error.message}`, tarjetas_usadas: [accBorrarTarea.chat_id], via_indice: false, costo_usd: costo };
    }
    await sb.from('tarjeta').update({ dirty: true } as any).eq('chat_id', accBorrarTarea.chat_id);
    return { respuesta: `Listo, borré la tarea de ${nombreContacto}: «${borrables[0].titulo}».`, tarjetas_usadas: [accBorrarTarea.chat_id], via_indice: false, costo_usd: costo };
  }

  if (accBorrarTareaTransv) {
    let candidatas: any[] = [];
    if (typeof accBorrarTareaTransv.id === 'number') {
      const { data } = await sb.from('tareas_transversales').select('id, titulo').eq('id', accBorrarTareaTransv.id);
      candidatas = data ?? [];
    } else {
      const { data } = await sb.from('tareas_transversales').select('id, titulo')
        .ilike('titulo', `%${String(accBorrarTareaTransv.titulo_match).trim()}%`).is('completada_at', null);
      candidatas = data ?? [];
    }
    const ref = accBorrarTareaTransv.id ? `#${accBorrarTareaTransv.id}` : `"${accBorrarTareaTransv.titulo_match}"`;
    if (!candidatas.length) {
      return { respuesta: `No encontré tarea transversal ${ref}.`, tarjetas_usadas: [], via_indice: false, costo_usd: costo };
    }
    if (candidatas.length > 1) {
      const previa = candidatas.slice(0, 4).map((t: any) => `• [#${t.id}] ${t.titulo}`).join('\n');
      return { respuesta: `Encontré ${candidatas.length} transversales con "${accBorrarTareaTransv.titulo_match}":\n${previa}\n¿Cuál? Decime el ID.`, tarjetas_usadas: [], via_indice: false, costo_usd: costo };
    }
    const { error } = await sb.from('tareas_transversales').delete().eq('id', candidatas[0].id);
    if (error) {
      return { respuesta: `No pude borrar la transversal: ${error.message}`, tarjetas_usadas: [], via_indice: false, costo_usd: costo };
    }
    return { respuesta: `Listo, borré la tarea transversal #${candidatas[0].id}: «${candidatas[0].titulo}».`, tarjetas_usadas: [], via_indice: false, costo_usd: costo };
  }

  // Misma regla anti-asumir aplica para nueva_tarea con contacto. Si la pregunta
  // tiene patrón ambiguo "señora DE Lugar", la convertimos a tarea TRANSVERSAL
  // automáticamente (la descripción guarda la pista para que Jhon la asocie luego).
  let accTareaFinal = accTarea;
  let accTareaTransvFinal = accTareaTransv;
  if (accTarea) {
    const matchAmbiguo = pregunta.match(/\b(?:se(?:ñ|n)or[a]?|cliente[a]?s?|don|do(?:ñ|n)a)\s+de(?:l|\s+la|\s+los|\s+las|\s+conjunto|\s+edificio|\s+calle|\s+carrera|\s+avenida|\s+barrio)?\s+([A-Za-zÁÉÍÓÚÑáéíóúñ][\wÁÉÍÓÚÑáéíóúñ'·-]+)/i);
    if (matchAmbiguo) {
      const fragmento = matchAmbiguo[1].trim();
      accTareaFinal = null;
      accTareaTransvFinal = {
        titulo: accTarea.titulo,
        descripcion: `Pista del contacto: "${fragmento}" (no identificado todavía — pedir nombre/teléfono a Jhon antes de mover a tarjeta).`,
      };
    }
  }

  // Tarea transversal: NO requiere contacto, es independiente. Va directo.
  if (accTareaTransvFinal) {
    const titulo = String(accTareaTransvFinal.titulo).trim().slice(0, 200);
    const descripcion = String(accTareaTransvFinal.descripcion ?? '').trim().slice(0, 500) || null;
    const { data: ins, error } = await sb.from('tareas_transversales').insert({
      titulo, descripcion, creado_por: 'junior',
    } as any).select('id').single();
    if (error) {
      return { respuesta: `Quería guardar la tarea transversal pero hubo un error: ${error.message}`, tarjetas_usadas: [], via_indice: false, costo_usd: costo };
    }
    const aviso = descripcion ? ` Nota: ${descripcion}` : '';
    return {
      respuesta: `Listo, tarea transversal #${ins.id} guardada: «${titulo}».${aviso} Aparece cuando pidas "tareas pendientes".`,
      tarjetas_usadas: [], via_indice: false, costo_usd: costo,
    };
  }

  if (accNombre || accNota || accTareaFinal) {
    const chatId = (accNombre?.chat_id ?? accNota?.chat_id ?? accTareaFinal?.chat_id) as number;
    let personaId: number | null = null;
    const { data: cl } = await sb.from('chat_checklist').select('persona_id').eq('chat_id', chatId).maybeSingle();
    personaId = (cl?.persona_id as number) ?? null;
    if (!personaId) {
      const { data: ch } = await sb.from('chats').select('proyecto_id').eq('id', chatId).maybeSingle();
      if (ch?.proyecto_id) {
        const { data: pr } = await sb.from('proyectos').select('persona_id').eq('id', ch.proyecto_id).maybeSingle();
        personaId = (pr?.persona_id as number) ?? null;
      }
    }
    if (!personaId && (accNombre || accNota)) {
      return { respuesta: `Quería guardarlo pero no identifiqué a qué contacto te referís. Decime el nombre o el número y lo hago.`, tarjetas_usadas: [], via_indice: false, costo_usd: costo };
    }
    const hechos: string[] = [];
    if (accNombre) {
      const nombre = String(accNombre.nombre).trim().slice(0, 60);
      const { error } = await sb.from('personas').update({ nombre, sintesis_pendiente: true } as any).eq('id', personaId);
      if (!error) hechos.push(`actualicé el nombre a "${nombre}"`);
    }
    if (accNota) {
      const texto = String(accNota.texto).trim().slice(0, 500);
      const { error } = await sb.from('notas_libres').insert({ persona_id: personaId, contenido: texto, visible_para: ['todos'], creado_por: 1 } as any);
      if (!error) { await sb.from('personas').update({ sintesis_pendiente: true } as any).eq('id', personaId); hechos.push(`anoté: «${texto}»`); }
    }
    if (accTareaFinal) {
      // Tarea con origen='junior' — el agente regenerador NO la pisa (filtra
      // por origen='agente' al borrar). Aparece inmediatamente en tarjeta_tarea.
      const titulo = String(accTareaFinal.titulo).trim().slice(0, 200);
      const { error } = await sb.from('tarjeta_tarea').insert({
        chat_id: chatId, titulo, prioridad: 1, origen: 'junior',
      } as any);
      if (!error) hechos.push(`creé la tarea: «${titulo}»`);
    }
    await sb.from('tarjeta').update({ dirty: true } as any).eq('chat_id', chatId);
    const nombreShow = (accNombre?.nombre as string) ?? indice.find(f => f.chat_id === chatId)?.nombre ?? `chat ${chatId}`;
    return {
      respuesta: hechos.length ? `Listo, en la tarjeta de ${nombreShow}: ${hechos.join(' y ')}. Se refleja en unos segundos.` : `No pude guardar los cambios, probá de nuevo.`,
      tarjetas_usadas: [chatId], via_indice: false, costo_usd: costo,
    };
  }

  // Atajo determinístico por teléfono: si la pregunta trae un número, lo buscamos
  // en TODAS las tarjetas (incl. no-clientes). cargarDetalle ya filtra es_no_cliente
  // y responde la verdad. Sin esto, el ruteo (que solo ve el índice comercial)
  // cae al fallback genérico cuando preguntan por un colaborador / no-cliente.
  let chatIdsByPhone: number[] = [];
  const m = pregunta.match(/\+?\d{10,15}/);
  if (m) {
    const digits = m[0].replace(/\D/g, '');
    let tel: string | null = null;
    if (m[0].startsWith('+')) tel = '+' + digits;
    else if (digits.length === 12 && digits.startsWith('57')) tel = '+' + digits;
    else if (digits.length === 10 && digits.startsWith('3')) tel = '+57' + digits;
    if (tel) {
      const { data: hits } = await sb.from('tarjeta')
        .select('chat_id, personas!inner(telefono_e164)').eq('personas.telefono_e164', tel);
      chatIdsByPhone = (hits ?? []).map((h: any) => h.chat_id);
    }
  }
  if (chatIdsByPhone.length && (!Array.isArray(plan.chat_ids) || plan.chat_ids.length === 0)) {
    plan.chat_ids = chatIdsByPhone;
    plan.puede_responder_con_indice = false;
    plan.respuesta_directa = null;
  }

  // Bypass MÍNIMO: solo se dispara cuando la query es GENÉRICA — sin nombre de
  // contacto y sin teléfono. Antes era agresivo y agarraba cosas como "dame las
  // tareas de Constanza (+573108377932)" forzando listado completo, ignorando a
  // Constanza. Ahora confiamos en el LLM para queries específicas; solo
  // intervenimos cuando claramente no hay forma de saber qué contacto cargar.
  //
  // Condiciones para disparar bypass:
  //   1) NO hay teléfono en la pregunta (sin +57XXX ni 10 dígitos sueltos).
  //   2) NO hay match obvio con el nombre de algún contacto del índice (≥3 chars).
  //   3) La pregunta usa léxico de "lista completa" muy explícito.
  const tieneTelefono = /\+?\d{10,15}/.test(pregunta);
  const palabrasPregunta = pregunta.toLowerCase().split(/[\s,.;:!?¿¡()]+/).filter(p => p.length >= 4);
  const mencionaContactoConocido = indice.some(f => {
    const nombre = f.nombre.toLowerCase();
    // Match si alguna palabra de la pregunta (≥4 chars) está contenida en el nombre.
    return palabrasPregunta.some(p => nombre.includes(p));
  });
  const lexicoListaCompleta = /\b(dame\s+(todos?\s+(los\s+|las\s+)?|las\s+|los\s+)?(tareas|pendientes|agenda|lista)|qu[eé]\s+tengo\s+(pendiente|hoy|para\s+hacer)|tareas?\s+pendientes|lista\s+(completa\s+)?de\s+(tareas|pendientes)|todos?\s+(los\s+|las\s+)?(pendientes|tareas)|organiz[aá]\s+mi|gu[ií]ate\s+por\s+el\s+checklist|dame\s+(la\s+)?agenda|agenda\s+(pr[oó]xima|completa|de\s+la\s+semana))\b/i.test(pregunta);
  const queryEsPedidoExplicitoDeLista = lexicoListaCompleta && !tieneTelefono && !mencionaContactoConocido;
  if (queryEsPedidoExplicitoDeLista) {
    plan.puede_responder_con_indice = false;
    plan.respuesta_directa = null;
    plan.chat_ids = [];
  }
  // Sub-clasificación: dentro del pedido de lista, ¿pidió SOLO tareas, SOLO
  // agenda, o ambos? Si dice "tareas" sin "agenda" → solo TE TOCA. Si dice
  // "agenda" sin "tareas" → solo AGENDA. Si menciona ambos o ninguno explícito
  // ("dame pendientes", "qué tengo pendiente") → los dos bloques.
  const mencionaTareas = /\b(tareas?|te\s+toca|acciones?|pendiente)\b/i.test(pregunta);
  const mencionaAgenda = /\b(agenda|cita|calendari|reuni[oó]n)\b/i.test(pregunta);
  const pidioSoloTareas = mencionaTareas && !mencionaAgenda;
  const pidioSoloAgenda = mencionaAgenda && !mencionaTareas;

  if (plan.puede_responder_con_indice && plan.respuesta_directa) {
    return { respuesta: String(plan.respuesta_directa), tarjetas_usadas: [], via_indice: true, costo_usd: costo };
  }

  // Anti-loop determinístico: si el LLM va a delegar al fallback de listado
  // PERO el último turno de Junior ya fue un listado del fallback (empieza con
  // "📅 AGENDA próxima"), forzamos respuesta conversacional con cargarDetalle
  // de las 5 tarjetas más relevantes (te toca). Esto rompe loops donde Jhon
  // pregunta "por qué me das todo" / "que te pasa" y Junior vuelve a listar.
  const ultimoJunior = [...historial].reverse().find(h => h.rol === 'junior')?.texto ?? '';
  const ultimoFueListado = ultimoJunior.startsWith('📅 AGENDA próxima') || ultimoJunior.startsWith('✅ TE TOCA');
  // Detectar si el último turno de Junior fue una ACCIÓN (creó/actualizó nota o
  // nombre). Caso reportado: Jhon dice "es otra señora del conjunto Madeira" tras
  // una nota mal asignada → Junior contestó con AGENDA completa en vez de pedir
  // aclaración. Frases de confirmación: "Listo, en la tarjeta de X: anoté/actualicé".
  const ultimoFueAccion = /^Listo,?\s+en\s+la\s+tarjeta\s+de\b/i.test(ultimoJunior)
    || /\b(anot[eé]|actualic[eé]|guard[eé])\b.*tarjeta/i.test(ultimoJunior);
  if (ultimoFueListado && !queryEsPedidoExplicitoDeLista &&
      !plan.respuesta_directa && (!Array.isArray(plan.chat_ids) || plan.chat_ids.length === 0)) {
    // Construir 5 chat_ids más relevantes (espera_jhon o sin_responder) para que el
    // paso 2 los lea y responda de forma conversacional.
    plan.chat_ids = indice
      .filter(f => f.estado === 'espera_jhon' || f.estado === 'sin_responder')
      .slice(0, 5).map(f => f.chat_id);
  }
  // Si el último fue una acción y Jhon está aclarando/corrigiendo ("es otra
  // señora", "no, era X", "te equivocaste"), NO disparar el fallback de listado.
  // Forzamos respuesta conversacional cargando la tarjeta donde se hizo la acción.
  if (ultimoFueAccion && !queryEsPedidoExplicitoDeLista &&
      !plan.respuesta_directa && (!Array.isArray(plan.chat_ids) || plan.chat_ids.length === 0)) {
    // Extraer el nombre del contacto del mensaje de confirmación: "Listo, en la
    // tarjeta de <NOMBRE>: ...". Match laxo.
    const m = ultimoJunior.match(/tarjeta\s+de\s+([^:]+?):/i);
    const nombreAccionado = m ? m[1].trim() : null;
    const tarjetaAccion = nombreAccionado
      ? indice.find(f => f.nombre.toLowerCase().includes(nombreAccionado.toLowerCase().split(/\s+/)[0]))
      : null;
    if (tarjetaAccion) plan.chat_ids = [tarjetaAccion.chat_id];
    else plan.chat_ids = indice.filter(f => f.estado === 'espera_jhon').slice(0, 3).map(f => f.chat_id);
  }

  // ── Paso 2: cargar solo las tarjetas relevantes y responder ─────────────
  const chatIds = Array.isArray(plan.chat_ids) ? plan.chat_ids.slice(0, 5) : [];

  // Fallback proactivo: si el ruteo no fijó ninguna tarjeta (pedido vago/operativo),
  // NO damos el callejón "no hay tarjetas seleccionadas" — armamos desde el índice
  // (a) próximos agendamientos y (b) pendientes accionables. Determinístico, sin LLM.
  if (chatIds.length === 0) {
    // Defensa: aunque derivarChecklist filtre no-acciones, hacemos un segundo
    // pase acá para no mostrar a Jhon items de pura observación / indecisión.
    const NO_ACCION = /(mantener(se)?|esperar(\s+contacto|\s+a\s+que|\s+oportunidades)?|observar|monitorear|sin\s+acci[oó]n|ninguna\s+acci[oó]n|quedar\s+atento|atento\s+a|expectativa|reclasificar.*como.*o\s+mantener|decidir\s+si\s+\w+\s+o\s+\w+|bloquear\s+contacto|cerrar\s+(caso|contacto|cliente)|verificar\s+si.*lista\s+de\s+contactos)/i;
    // TE TOCA reescrito: leemos las TAREAS REALES (tarjeta_tarea, 86 items en BD)
    // en vez del 'proximo_paso' (un resumen, 1 por tarjeta). Antes solo veíamos 11;
    // ahora vemos todas las pendientes excepto cerradas / no-cliente / no-acción.
    const { data: todasTareas } = await sb.from('tarjeta_tarea')
      .select('chat_id, titulo, prioridad').order('prioridad');
    const { data: estadosCks } = await sb.from('tarjeta_checklist').select('chat_id, estado_conversacion');
    const estadoPorChat = new Map((estadosCks ?? []).map((c: any) => [c.chat_id, c.estado_conversacion]));
    const infoPorChat = new Map(indice.map(f => [f.chat_id, f]));
    type GrupoTareas = { nombre: string; tel: string; estado: string; items: string[] };
    const grupos = new Map<number, GrupoTareas>();
    for (const t of (todasTareas ?? []) as any[]) {
      const info = infoPorChat.get(t.chat_id);
      if (!info) continue;  // tarjeta no-cliente (ya filtrada por cargarIndice)
      const estado = estadoPorChat.get(t.chat_id);
      if (estado === 'cerrado') continue;  // ruido: "Cerrar caso de X"
      if (NO_ACCION.test(t.titulo)) continue;  // "Esperar contacto", "Bloquear", etc.
      if (!grupos.has(t.chat_id)) {
        grupos.set(t.chat_id, { nombre: info.nombre, tel: info.tel, estado: estado ?? '?', items: [] });
      }
      grupos.get(t.chat_id)!.items.push(String(t.titulo).trim());
    }
    // Para tarjetas con estado activo (espera_jhon/sin_responder) que NO tienen
    // entries en tarjeta_tarea, caemos al 'proximo_paso' como respaldo — así no
    // perdemos casos donde el agente puso el resumen pero no derivó tareas.
    for (const f of indice) {
      if (grupos.has(f.chat_id)) continue;
      if (f.estado !== 'espera_jhon' && f.estado !== 'sin_responder') continue;
      if (!f.proximo || NO_ACCION.test(f.proximo)) continue;
      grupos.set(f.chat_id, { nombre: f.nombre, tel: f.tel, estado: f.estado, items: [f.proximo] });
    }
    const teToca = [...grupos.values()];

    // Próximos agendamientos (7 días) — para que la respuesta empiece con calendario.
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const en7 = new Date(Date.now() + 7 * 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const { data: ags } = await sb.from('agendamientos')
      .select('titulo, tipo, fecha, hora_inicio, persona_id, personas(nombre, telefono_e164, deleted_at)')
      .gte('fecha', hoy).lte('fecha', en7).order('fecha').order('hora_inicio').limit(60);
    // Set de personas con tarjeta cerrada o no-cliente → filtrar sus agendamientos.
    // Esto cierra el círculo: cuando Jhon dice "cerralo" a Junior, el checklist
    // pasa a 'cerrado'; sus agendamientos legacy (origen=null, no autogestionados)
    // también se sacan del listado activo sin tener que borrarlos de la BD.
    const personaIds = [...new Set((ags ?? []).map((a: any) => a.persona_id).filter(Boolean))] as number[];
    const inactivas = new Set<number>();
    if (personaIds.length) {
      const { data: tjs } = await sb.from('tarjeta').select('chat_id, persona_id, es_no_cliente').in('persona_id', personaIds);
      const chatIds = (tjs ?? []).map((t: any) => t.chat_id);
      const { data: cks } = chatIds.length ? await sb.from('tarjeta_checklist').select('chat_id, estado_conversacion').in('chat_id', chatIds) : { data: [] };
      const estadoPorChat = new Map((cks ?? []).map((c: any) => [c.chat_id, c.estado_conversacion]));
      for (const t of (tjs ?? []) as any[]) {
        const cerrado = estadoPorChat.get(t.chat_id) === 'cerrado';
        if (t.es_no_cliente || cerrado) inactivas.add(t.persona_id);
      }
    }
    // Dedup: una entrada por (nombre, fecha, hora) — los agentes históricamente
    // emitieron variaciones del mismo evento (ej. "Visita Patricia" x6).
    // Filtra: agendamientos de personas borradas (huérfanos) o cuyas tarjetas
    // están cerradas/no-cliente. Así "cerralo" en Junior saca también la cita.
    const vistos = new Set<string>();
    const dedup: any[] = [];
    for (const a of (ags ?? []) as any[]) {
      if (a.personas?.deleted_at) continue;
      if (inactivas.has(a.persona_id)) continue;
      const nombre = (a.personas?.nombre ?? '').trim().toLowerCase();
      const k = `${nombre}|${a.fecha}|${a.hora_inicio ?? ''}`;
      if (vistos.has(k)) continue;
      vistos.add(k); dedup.push(a);
    }
    // Helper: tel entre paréntesis si existe (solo nro, sin texto extra).
    const conTel = (nombre: string | undefined, tel: string | undefined | null) =>
      `${nombre ?? '?'}${tel ? ` (${tel})` : ''}`;
    const agendaTxt = dedup.length
      ? dedup.slice(0, 12).map((a: any) => `• ${a.fecha}${a.hora_inicio ? ' ' + String(a.hora_inicio).slice(0,5) : ''} — ${conTel(a.personas?.nombre, a.personas?.telefono_e164)}: ${a.titulo}`).join('\n')
      : null;

    // Tareas transversales (sin contacto): viven en su propia tabla. Se listan
    // bajo una sección dedicada cuando Jhon pide pendientes. Solo las no completadas.
    const { data: tareasTransv } = await sb.from('tareas_transversales')
      .select('id, titulo, descripcion').is('completada_at', null).order('creado_at', { ascending: false });

    if (!teToca.length && !agendaTxt && !(tareasTransv?.length)) {
      return { respuesta: 'No tenés nada pendiente de tu lado ahora mismo. 👏 Si querés ver un caso puntual, nombrame el cliente.', tarjetas_usadas: [], via_indice: true, costo_usd: costo };
    }

    // Respeta el ámbito de la pregunta: "tareas" → solo TE TOCA + transversales,
    // "agenda" → solo AGENDA, vago → todo.
    const partes: string[] = [];
    if (agendaTxt && !pidioSoloTareas) partes.push(`📅 AGENDA próxima (7 días):\n${agendaTxt}`);
    if (teToca.length && !pidioSoloAgenda) {
      // Agrupado por cliente: una sola entrada por contacto, todas sus tareas
      // debajo con guión. Sin truncar (Jhon pidió completas). Si un día son 200,
      // ya veremos cómo paginar — hoy ~50 tras filtros.
      const bloques = teToca.map(g => {
        const cab = `• ${conTel(g.nombre, g.tel)}`;
        if (g.items.length === 1) return `${cab} — ${g.items[0]}`;
        return `${cab}\n${g.items.map(it => `   – ${it}`).join('\n')}`;
      });
      partes.push(`✅ TE TOCA (acciones concretas):\n${bloques.join('\n')}`);
    }
    if (tareasTransv?.length && !pidioSoloAgenda) {
      const bloques = tareasTransv.map((t: any) => {
        const cab = `• ${t.titulo} [#${t.id}]`;
        return t.descripcion ? `${cab}\n   – ${t.descripcion}` : cab;
      });
      partes.push(`📌 TRANSVERSALES (sin contacto asignado):\n${bloques.join('\n')}`);
    }
    if (!partes.length) {
      const msg = pidioSoloTareas
        ? 'No tenés tareas pendientes ahora mismo. 👏'
        : pidioSoloAgenda
          ? 'No hay agendamientos en los próximos 7 días.'
          : 'No tenés nada pendiente de tu lado ahora mismo. 👏';
      return { respuesta: msg, tarjetas_usadas: [], via_indice: true, costo_usd: costo };
    }
    return { respuesta: partes.join('\n\n'), tarjetas_usadas: [], via_indice: true, costo_usd: costo };
  }

  const detalle = await cargarDetalle(sb, chatIds);
  const resp: ChatMessage[] = [
    {
      role: 'system',
      content:
        `Sos JUNIOR, el asistente personal de Jhon (Persianas Girardot, Girardot, Colombia · pesos COP). ` +
        `Respondé usando SOLO las tarjetas de abajo y la conversación previa.\n` +
        `REGLAS DURAS (anti-invento, anti-ceder, anti-acción-falsa):\n` +
        `1. NUNCA inventes datos concretos (horas, fechas, montos, nombres, direcciones) que no estén TEXTUALMENTE en la tarjeta. ` +
        `Si un dato no está, decí "eso no figura en la tarjeta" — jamás lo completes de memoria.\n` +
        `2. Si Jhon te contradice o INSISTE (con cualquier fórmula: "fijate bien", "estás mal", "revisá", "ya te dije", "por eso te digo", ` +
        `"sí lo hice", "hacelo igual", aunque insista 3 veces), NO cambies tu respuesta para darle la razón. Re-leé la tarjeta y respondé lo ` +
        `que REALMENTE dice, aunque sea repetir lo mismo. Es mejor "no lo veo en la tarjeta" que un dato falso para quedar bien.\n` +
        `3. Si Jhon afirma algo que la tarjeta NO muestra, decilo claro: "la tarjeta no lo refleja todavía (puede estar actualizándose)" — ` +
        `NO inventes el dato para coincidir con él.\n` +
        `4. Las NOTAS DE JHON (verdad) mandan sobre los hechos de los agentes.\n` +
        `5. ⚠ ACCIONES — sos READ-ONLY en este paso. NO podés cerrar, marcar, ajustar, cambiar estado, actualizar checklist, ni nada ` +
        `parecido desde acá. PROHIBIDO escribir frases que afirmen una acción hecha: "voy a actualizar", "ya cerré", "marqué", ` +
        `"ya quedó reflejado", "actualicé la tarjeta", "lo guardé", "completé". Las ÚNICAS escrituras que el sistema acepta son ` +
        `(a) cambiar el NOMBRE de un contacto y (b) agregar una NOTA — y eso lo decide el RUTEO (paso anterior), no vos. ` +
        `Si Jhon te pide cerrar / marcar / cambiar estado / completar algo, respondé honestamente: "no puedo cerrarlo yo desde acá. ` +
        `Te puedo dejar una nota con el cierre así queda registrado (decímelo y la guardo en la próxima), o vos lo marcás en la UI." ` +
        `Mentir diciendo que hiciste una acción es peor que negarte a hacerla.\n` +
        `Sé concreto y breve, en su tono — pero la honestidad sobre datos y acciones está por encima de complacerlo.`,
    },
    // Conversación previa (para follow-ups coherentes).
    ...hist.map(h => ({ role: (h.rol === 'jhon' ? 'user' : 'assistant') as 'user' | 'assistant', content: h.texto })),
    { role: 'user', content: `TARJETAS RELEVANTES:\n\n${detalle}\n\n────\nPREGUNTA DE JHON: ${pregunta}` },
  ];
  const r2 = await deepseekChat({ messages: resp, agente: 'JUNIOR_V2_RESP', max_tokens: 1200 });
  costo += r2.costo_usd;
  return { respuesta: r2.contenido.trim(), tarjetas_usadas: chatIds, via_indice: false, costo_usd: costo };
}
