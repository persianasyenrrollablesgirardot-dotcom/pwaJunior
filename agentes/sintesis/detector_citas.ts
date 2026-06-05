/**
 * DETECTOR DE CITAS UNIVERSAL — captura agendamientos de cualquier chat,
 * incluso personales/familia que los agentes M1-M7 ignoran por enfoque comercial.
 *
 * MOTIVO: el flujo viejo (M1-M7 → narrativa → derivarAgenda) solo extraía
 * agendamientos cuando algún módulo comercial los mencionaba. Caso reportado:
 * Lorena (expareja, personal_familia) envió "Hola nos vemos mañana a las 10 am"
 * y Jhon respondió "Perfecto confirmado" — los 7 agentes lo registraron como
 * "logística doméstica" y derivarAgenda no vio la cita por ningún lado.
 *
 * Este detector lee MENSAJES CRUDOS de los últimos 7 días (no el contexto
 * filtrado), un LLM corto pregunta "¿hay citas concretas acá?", e inserta
 * en `agendamientos` con origen='detector_citas'. Idempotente: dedup contra
 * citas ya existentes por (persona, fecha, hora).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat, type ChatMessage } from '../lib/llm.js';

type TipoAgenda = 'visita_medidas' | 'instalacion' | 'reunion_proveedor' | 'personal' | 'otro';
const TIPOS: TipoAgenda[] = ['visita_medidas', 'instalacion', 'reunion_proveedor', 'personal', 'otro'];

interface CitaDetectada {
  titulo: string;
  fecha: string;       // YYYY-MM-DD ('' si pendiente)
  hora: string;        // HH:MM ('' si pendiente)
  pendiente: boolean;  // true = por agendar (sin fecha concreta)
  tipo: TipoAgenda;
  lugar: string;
}

export interface ResDetectorCitas {
  citas_detectadas: number;
  citas_insertadas: number;
  citas_saltadas_por_dedup: number;
  llm_costo_usd: number;
}

// Pre-filtro determinístico: si los últimos mensajes NO contienen palabras de
// cita, evitamos llamar al LLM. Ahorra ~$0.001 por chat sin citas (90% de casos).
const KEYWORDS_CITA = /\b(ma[nñ]ana|hoy|pasado\s+ma[nñ]ana|el\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|este\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|pr[oó]xim[oa]\s+(semana|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|a\s+las?\s+\d|\d{1,2}\s*(am|pm|a\.?m\.?|p\.?m\.?|hs|horas?)|\d{1,2}:\d{2}|nos\s+vemos|nos\s+encontramos|cita|visita|reuni[oó]n|agenda[rd])\b/i;

export async function detectarCitasUniversales(
  sb: SupabaseClient, chatId: number, personaId: number,
): Promise<ResDetectorCitas> {
  const result: ResDetectorCitas = {
    citas_detectadas: 0, citas_insertadas: 0, citas_saltadas_por_dedup: 0, llm_costo_usd: 0,
  };

  // 0. Nombre del contacto (para que el LLM redacte títulos descriptivos en
  //    lugar de "Encuentro con cliente" genérico — caso reportado: Lorena Morales
  //    quedó con título "Encuentro con cliente" cuando es la expareja, no clienta).
  const { data: pers } = await sb.from('personas').select('nombre').eq('id', personaId).maybeSingle();
  const nombreContacto = pers?.nombre ?? 'contacto';

  // 1. Cargar últimos 25 mensajes con texto del chat (últimos 7 días).
  const hace7d = new Date(Date.now() - 7 * 86400_000).toISOString();
  const { data: msgs } = await sb.from('mensajes')
    .select('id, ts_canal, direccion, texto, tipo').eq('chat_id', chatId)
    .eq('tipo', 'texto').gte('ts_canal', hace7d).is('deleted_at', null)
    .order('ts_canal', { ascending: false }).limit(25);
  if (!msgs?.length) return result;

  // 2. Pre-filtro: si ningún mensaje tiene keywords de cita, salir sin LLM.
  const textoCombinado = msgs.map((m: any) => m.texto ?? '').join(' ');
  if (!KEYWORDS_CITA.test(textoCombinado)) return result;

  // 3. Construir conversación ordenada cronológicamente para el LLM.
  const conversacion = (msgs as any[]).reverse()
    .map(m => `[${m.ts_canal.slice(0, 16)}] ${m.direccion === 'entrante' ? 'CLIENTE' : 'JHON'}: ${m.texto}`)
    .join('\n');

  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        `Sos el DETECTOR DE CITAS del Visor PG. Tu único trabajo: leer una conversación entre Jhon y ${nombreContacto} y extraer ` +
        `agendamientos (visitas, reuniones, encuentros, instalaciones) que estén CONFIRMADOS o ACORDADOS. NO inventes citas.\n` +
        `\n` +
        `⚠ FECHAS — REGLA CRÍTICA: resolvé las fechas relativas ("mañana", "el lunes", "pasado mañana", "el sábado") SIEMPRE contra ` +
        `LA FECHA DEL MENSAJE donde aparece la expresión, NUNCA contra "hoy". Cada línea trae su fecha entre corchetes [YYYY-MM-DD HH:MM]. ` +
        `Ej: si un mensaje del [2026-05-28] dice "nos vemos mañana", la fecha es 2026-05-29 (no la de hoy). Esto es vital: el chat puede ` +
        `reprocesarse días después y NO debe correrse la fecha. (Solo de referencia, hoy es ${hoy} zona America/Bogota.)\n` +
        `\n` +
        `FIJA vs PENDIENTE:\n` +
        `  • FIJA = hay fecha CONCRETA acordada (día explícito o relativo resoluble). Devolvé "fecha":"YYYY-MM-DD", "pendiente":false.\n` +
        `  • PENDIENTE = hay intención/acuerdo de agendar pero SIN fecha concreta ("hay que coordinar la visita", "te aviso cuándo", ` +
        `"la semana que viene vemos", "cuando puedas pasás"). Devolvé "fecha":"", "hora":"", "pendiente":true. NO le inventes una fecha.\n` +
        `\n` +
        `Una cita está CONFIRMADA si: una parte la propone Y la otra confirma ("ok", "dale", "perfecto", "confirmado", "listo", 👍, etc) ` +
        `O Jhon mismo dice "agendá X" / "anotame X". Si solo hubo propuesta sin confirmación, NO la incluyas.\n` +
        `Tipo de cita: instalacion, visita_medidas, reunion_proveedor, personal (encuentros personales/familia), otro.\n` +
        `\n` +
        `⚠ TÍTULO DESCRIPTIVO Y ESPECÍFICO — NO genérico:\n` +
        `Mal: "Encuentro con cliente", "Cita", "Reunión", "Visita programada".\n` +
        `Bien: "Encuentro con ${nombreContacto}", "Instalación cortinas en casa de ${nombreContacto}", "${nombreContacto} viene al local", ` +
        `"Visita técnica medidas ${nombreContacto}". USÁ el nombre real del contacto en el título.\n` +
        `Si NO hay citas claras, devolvé citas:[].\n` +
        `Devolvé SOLO JSON: {"citas": [{"titulo": "qué (≤80 chars, INCLUÍ '${nombreContacto}')", "fecha": "YYYY-MM-DD o vacío si pendiente", "hora": "HH:MM (24h) o vacío", "pendiente": true|false, "tipo": "personal|otro|...", "lugar": "si lo hay"}]}`,
    },
    { role: 'user', content: `CONVERSACIÓN (últimos mensajes, orden cronológico):\n${conversacion}` },
  ];

  const r = await deepseekChat({ messages, agente: 'DETECTOR_CITAS', max_tokens: 400, response_format: { type: 'json_object' } });
  result.llm_costo_usd = r.costo_usd;

  let citas: CitaDetectada[] = [];
  try {
    const obj = JSON.parse(r.contenido);
    citas = (Array.isArray(obj.citas) ? obj.citas : []).map((x: any) => {
      const fechaOk = /^\d{4}-\d{2}-\d{2}$/.test(x.fecha ?? '');
      const pendiente = !!x.pendiente || !fechaOk;   // sin fecha válida → pendiente por agendar
      return {
        titulo: String(x.titulo ?? '').trim().slice(0, 200),
        fecha: pendiente ? '' : x.fecha,
        // Fija sin hora explícita: 09:00 por defecto. Pendiente: sin hora.
        hora: pendiente ? '' : (/^\d{1,2}:\d{2}/.test(x.hora ?? '') ? String(x.hora).slice(0, 5).padStart(5, '0') : '09:00'),
        pendiente,
        tipo: TIPOS.includes(x.tipo) ? x.tipo : 'otro',
        lugar: String(x.lugar ?? '').trim(),
      };
    }).filter((c: CitaDetectada) => c.titulo && (c.fecha || c.pendiente));   // ya NO se descartan los pendientes
  } catch {
    return result;
  }
  result.citas_detectadas = citas.length;
  if (!citas.length) return result;

  // 4. Dedup contra lo que ya existe (activo) de esta persona. El detector solo
  //    AGREGA lo nuevo, jamás pisa. Las FIJAS se deduplican por (fecha, hora);
  //    las PENDIENTES por título normalizado (una persona no debe acumular 5
  //    "coordinar visita" idénticos).
  const { data: existentes } = await sb.from('agendamientos')
    .select('fecha, hora_inicio, titulo, pendiente').eq('persona_id', personaId).is('deleted_at', null);
  const norm = (s: string) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const fijasYa = new Set((existentes ?? []).filter((a: any) => a.fecha).map((a: any) => `${a.fecha}|${(a.hora_inicio ?? '').slice(0, 5)}`));
  const pendsYa = new Set((existentes ?? []).filter((a: any) => a.pendiente).map((a: any) => norm(a.titulo)));

  const nuevas = citas.filter(c => {
    if (c.pendiente) {
      if (pendsYa.has(norm(c.titulo))) { result.citas_saltadas_por_dedup++; return false; }
      pendsYa.add(norm(c.titulo));
      return true;
    }
    const k = `${c.fecha}|${c.hora}`;
    if (fijasYa.has(k)) { result.citas_saltadas_por_dedup++; return false; }
    fijasYa.add(k);
    return true;
  });
  if (!nuevas.length) return result;

  // 5. INSERT con origen='detector_citas'. Las instalaciones/visitas FIJAS se
  //    marcan `protegido` (compromisos de campo que la cascada de cierre no debe
  //    borrar). Los pendientes van con fecha/hora NULL + pendiente=true.
  const { error } = await sb.from('agendamientos').insert(nuevas.map(c => ({
    persona_id: personaId, titulo: c.titulo, tipo: c.tipo,
    fecha: c.pendiente ? null : c.fecha,
    hora_inicio: c.pendiente ? null : c.hora,
    direccion: c.lugar || null, origen: 'detector_citas',
    pendiente: c.pendiente,
    protegido: !c.pendiente && (c.tipo === 'instalacion' || c.tipo === 'visita_medidas'),
  })) as any);
  if (!error) result.citas_insertadas = nuevas.length;
  return result;
}
