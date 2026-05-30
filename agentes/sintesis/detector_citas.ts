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
  fecha: string;       // YYYY-MM-DD
  hora: string;        // HH:MM
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
        `Sos el DETECTOR DE CITAS del Visor PG. Tu único trabajo: leer una conversación y extraer agendamientos concretos ` +
        `(visitas, reuniones, encuentros, llamadas con hora) que estén CONFIRMADOS o ACORDADOS. NO inventes citas.\n` +
        `HOY es ${hoy} (zona America/Bogota). Resolvé fechas relativas contra HOY:\n` +
        `  • "mañana" → ${new Date(Date.now() + 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })}\n` +
        `  • "pasado mañana" → ${new Date(Date.now() + 2 * 86400_000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })}\n` +
        `  • "el lunes/martes/...", "este sábado", "próxima semana" — calculá vos.\n` +
        `Una cita está CONFIRMADA si: una parte la propone Y la otra confirma ("ok", "dale", "perfecto", "confirmado", "listo", emoji 👍, etc) ` +
        `O Jhon mismo dice "agendá X" / "anotame X". Si solo hubo propuesta sin confirmación, NO la incluyas.\n` +
        `Tipo de cita: instalacion, visita_medidas, reunion_proveedor, personal (encuentros personales/familia), otro.\n` +
        `Si NO hay citas claras, devolvé citas:[].\n` +
        `Devolvé SOLO JSON: {"citas": [{"titulo": "qué (≤80 chars)", "fecha": "YYYY-MM-DD", "hora": "HH:MM (24h)", "tipo": "personal|otro|...", "lugar": "si lo hay"}]}`,
    },
    { role: 'user', content: `CONVERSACIÓN (últimos mensajes, orden cronológico):\n${conversacion}` },
  ];

  const r = await deepseekChat({ messages, agente: 'DETECTOR_CITAS', max_tokens: 400, response_format: { type: 'json_object' } });
  result.llm_costo_usd = r.costo_usd;

  let citas: CitaDetectada[] = [];
  try {
    const obj = JSON.parse(r.contenido);
    citas = (Array.isArray(obj.citas) ? obj.citas : []).map((x: any) => ({
      titulo: String(x.titulo ?? '').trim().slice(0, 200),
      fecha: /^\d{4}-\d{2}-\d{2}$/.test(x.fecha ?? '') ? x.fecha : '',
      hora: /^\d{1,2}:\d{2}/.test(x.hora ?? '') ? String(x.hora).slice(0, 5).padStart(5, '0') : '09:00',
      tipo: TIPOS.includes(x.tipo) ? x.tipo : 'otro',
      lugar: String(x.lugar ?? '').trim(),
    })).filter((c: CitaDetectada) => c.titulo && c.fecha);
  } catch {
    return result;
  }
  result.citas_detectadas = citas.length;
  if (!citas.length) return result;

  // 4. Dedup: traer agendamientos existentes de esta persona (activos) y descartar
  //    cualquier cita detectada que choque por (fecha, hora). No tocamos lo que
  //    ya está — el detector solo AGREGA lo nuevo, jamás pisa.
  const { data: existentes } = await sb.from('agendamientos')
    .select('fecha, hora_inicio, titulo, origen').eq('persona_id', personaId).is('deleted_at', null);
  const yaAgendado = new Set((existentes ?? []).map((a: any) =>
    `${a.fecha}|${(a.hora_inicio ?? '').slice(0, 5)}`));

  const nuevas = citas.filter(c => {
    const k = `${c.fecha}|${c.hora}`;
    if (yaAgendado.has(k)) { result.citas_saltadas_por_dedup++; return false; }
    return true;
  });
  if (!nuevas.length) return result;

  // 5. INSERT con origen='detector_citas' (no pisa nada porque dedup arriba).
  const { error } = await sb.from('agendamientos').insert(nuevas.map(c => ({
    persona_id: personaId, titulo: c.titulo, tipo: c.tipo, fecha: c.fecha,
    hora_inicio: c.hora, direccion: c.lugar || null, origen: 'detector_citas',
  })) as any);
  if (!error) result.citas_insertadas = nuevas.length;
  return result;
}
