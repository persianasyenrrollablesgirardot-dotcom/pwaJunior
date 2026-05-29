/**
 * Arreglo de "nombres feos" — contactos cuyo personas.nombre quedó como el
 * status de WhatsApp ("Hey there I am using WhatsApp"), solo el número o el jid.
 *
 * Extrae un nombre ÚTIL de la conversación: el nombre real si lo dicen; si no,
 * una etiqueta corta del contexto (ej. "Cliente Heliconias A10"). Nunca el
 * status de WhatsApp ni solo el número. Conservador: si no encuentra algo
 * mejor, no toca el nombre.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat, type ChatMessage } from '../lib/llm.js';

export function esNombreFeo(nombre: string | null | undefined): boolean {
  const n = (nombre ?? '').trim();
  if (!n) return true;
  if (/^\+?\d{6,}$/.test(n)) return true;                                   // solo número
  if (/@c\.us|@g\.us/i.test(n)) return true;                                // jid crudo
  if (/Hey there I am using|I am using WhatsApp|usando WhatsApp|^Available$|^Disponible$/i.test(n)) return true; // status WA
  if (/^(NEGOCIO|Cliente WhatsApp|Contacto sin nombre|Sin nombre|Cliente|Contacto)$/i.test(n)) return true;     // etiqueta vacía/genérica
  if (/base64|data:image|imagen base64/i.test(n)) return true;             // basura técnica que se filtró
  if (!/[a-záéíóúñ]/i.test(n)) return true;                                 // sin letras
  return false;
}

/** Limpia base64 / data-URIs / tokens larguísimos del texto de un mensaje. */
function limpiarTexto(s: string): string {
  return String(s)
    .replace(/data:[^\s]+/gi, ' ')
    .replace(/[A-Za-z0-9+/]{40,}={0,2}/g, ' ')   // blobs base64
    .replace(/\s+/g, ' ').trim();
}

export async function arreglarNombreSiFeo(
  sb: SupabaseClient, personaId: number,
): Promise<{ cambiado: boolean; nombre?: string; costo_usd: number }> {
  const { data: p } = await sb.from('personas').select('nombre').eq('id', personaId).maybeSingle();
  if (!p || !esNombreFeo(p.nombre)) return { cambiado: false, costo_usd: 0 };

  const { data: proys } = await sb.from('proyectos').select('id').eq('persona_id', personaId);
  const proyIds = (proys ?? []).map((x: any) => x.id);
  if (!proyIds.length) return { cambiado: false, costo_usd: 0 };
  const { data: chats } = await sb.from('chats').select('id').in('proyecto_id', proyIds).is('deleted_at', null);
  const chatIds = (chats ?? []).map((x: any) => x.id);
  if (!chatIds.length) return { cambiado: false, costo_usd: 0 };
  const { data: msgs } = await sb.from('mensajes')
    .select('direccion, texto').in('chat_id', chatIds).is('deleted_at', null).not('texto', 'is', null)
    .order('ts_canal').limit(30);
  const conv = (msgs ?? [])
    .map((m: any) => ({ dir: m.direccion, t: limpiarTexto(m.texto) }))
    .filter((m: any) => m.t.length > 1)
    .map((m: any) => `${m.dir === 'saliente' ? 'NEGOCIO' : 'CONTACTO'}: ${m.t.slice(0, 160)}`).join('\n');
  if (!conv.trim()) return { cambiado: false, costo_usd: 0 };

  const messages: ChatMessage[] = [{
    role: 'user',
    content:
      `Conversación de WhatsApp de Persianas Girardot (Girardot, Colombia). El "NEGOCIO" es Persianas Girardot (Jhon, el dueño); el CONTACTO es la otra persona. Dame el MEJOR nombre para mostrar al CONTACTO:\n` +
      `- Si el contacto dice su nombre real, usalo (ej. "Walter Estancia", "Doña Marta").\n` +
      `- Si no aparece el nombre, una etiqueta corta y específica del contexto del contacto: qué pidió o su ubicación (ej. "Cliente Heliconias A10", "Cliente cortinas blackout", "Proveedor telas Melgar").\n` +
      `- PROHIBIDO devolver: "NEGOCIO", "Jhon", "Cliente WhatsApp", "Contacto sin nombre", "Cliente" o "Contacto" a secas, el status de WhatsApp, o solo el número.\n` +
      `Devolvé SOLO JSON: {"nombre": "..."} (máx 40 caracteres, en español).\n\nCONVERSACIÓN:\n${conv}`,
  }];
  const r = await deepseekChat({ messages, agente: 'NOMBRE_REAL', max_tokens: 60, response_format: { type: 'json_object' } });
  let nombre = '';
  try { nombre = String(JSON.parse(r.contenido).nombre ?? '').trim().slice(0, 60); } catch { /* ignore */ }
  if (!nombre || esNombreFeo(nombre)) return { cambiado: false, costo_usd: r.costo_usd };

  await sb.from('personas').update({ nombre }).eq('id', personaId);
  return { cambiado: true, nombre, costo_usd: r.costo_usd };
}
