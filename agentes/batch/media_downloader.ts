/**
 * DESCARGA + DESCIFRADO DE MEDIA SERVER-SIDE (CDN de WhatsApp).
 *
 * Problema: el extractor de la extensión a veces NO baja el media SALIENTE
 * (los PDF/cotizaciones que ENVÍA Jhon quedan con download_status='failed') →
 * nunca se transcriben y ni siquiera llegan al caché del navegador, así que el
 * `pdf_worker` (que lee el blob) tampoco los encuentra.
 *
 * Solución (probada 2026-06-04 con el contacto Esperanza): con las claves que la
 * extensión SÍ captura (`media_key` + `direct_path`/`mms_url`, ahora subidas a
 * `mensajes.metadata`), el worker descarga el archivo cifrado del CDN de WhatsApp
 * (`mmg.whatsapp.net`) y lo descifra con el algoritmo estándar de WhatsApp
 * (HKDF-SHA256 → AES-256-CBC). No depende de la extensión ni del navegador.
 *
 * Hoy extrae PDFs (cotizaciones/facturas) con pdf.js. Imágenes/audio podrían
 * sumarse luego (mismo algoritmo, distinto `info` de HKDF + Vision/Whisper).
 *
 * Limitación: el `direct_path` trae un token (`oh=`) que EXPIRA — hay que bajar
 * el media relativamente fresco. El worker corre seguido (cada pocos min), así
 * que normalmente lo agarra a tiempo. Si el CDN devuelve 403/404 (expirado o
 * borrado), se reintenta con backoff y tras varios fallos se marca irrecuperable.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

// info de HKDF por tipo de media (string oficial de WhatsApp)
const HKDF_INFO: Record<string, string> = {
  documento: 'WhatsApp Document Keys',
  imagen:    'WhatsApp Image Keys',
  video:     'WhatsApp Video Keys',
  audio:     'WhatsApp Audio Keys',
};
const MAX_POR_CICLO = Number(process.env.MEDIA_DL_MAX) || 6;
const TRIED_TTL_MS  = 3 * 3600 * 1000;   // reintento cada 3h
const MAX_INTENTOS  = 6;                 // tras 6 fallos → media_inexistente
const RE_FALLO = /dañad|no es legible|no se pudo extraer|ilegible|no contiene inform/i;

// ─── Cripto de WhatsApp ───────────────────────────────────────────────────────
function hkdf(key: Buffer, length: number, info: string): Buffer {
  const salt = Buffer.alloc(32, 0);
  const prk = crypto.createHmac('sha256', salt).update(key).digest();
  let okm = Buffer.alloc(0), t = Buffer.alloc(0);
  for (let i = 0; okm.length < length; i++) {
    t = crypto.createHmac('sha256', prk).update(Buffer.concat([t, Buffer.from(info, 'utf8'), Buffer.from([i + 1])])).digest();
    okm = Buffer.concat([okm, t]);
  }
  return okm.subarray(0, length);
}

/** Descarga del CDN + descifra. Devuelve los bytes en claro o null si falla. */
async function descargarYDescifrar(mediaKeyB64: string, url: string, info: string): Promise<Buffer | null> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': 'WhatsApp/2.2412.54', 'Origin': 'https://web.whatsapp.com', 'Referer': 'https://web.whatsapp.com/' } });
  } catch { return null; }
  if (!res.ok) return null;
  const enc = Buffer.from(await res.arrayBuffer());
  if (enc.length < 20) return null;
  try {
    const expanded = hkdf(Buffer.from(mediaKeyB64, 'base64'), 112, info);
    const iv = expanded.subarray(0, 16), cipherKey = expanded.subarray(16, 48);
    const decipher = crypto.createDecipheriv('aes-256-cbc', cipherKey, iv);
    return Buffer.concat([decipher.update(enc.subarray(0, enc.length - 10)), decipher.final()]); // últimos 10 = MAC
  } catch { return null; }
}

async function textoDePdf(bytes: Buffer, maxPages = 2): Promise<{ texto: string; numPages: number } | null> {
  try {
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
    let texto = ''; const n = Math.min(maxPages, doc.numPages);
    for (let p = 1; p <= n; p++) { const pg = await doc.getPage(p); const tc = await pg.getTextContent(); texto += tc.items.map((i: any) => i.str).join(' ') + '\n'; pg.cleanup(); }
    const numPages = doc.numPages; await doc.destroy();
    const limpio = texto.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    return limpio.length >= 20 ? { texto: limpio.slice(0, 6000), numPages } : null;
  } catch { return null; }
}

// ─── Ciclo principal ──────────────────────────────────────────────────────────
export interface ResultadoMediaDL { pendientes: number; recuperados: number; fallidos: number; }

export async function cicloMediaDescarga(sb: SupabaseClient, log: (m: string) => void = () => {}): Promise<ResultadoMediaDL> {
  // Por ahora solo documentos (PDFs). Con media_key + url, sin texto, no descartados.
  const { data: msgs } = await sb.from('mensajes')
    .select('id, chat_id, tipo, texto, metadata').eq('tipo', 'documento').is('deleted_at', null);
  const ahora = Date.now();
  const pend = (msgs ?? []).filter((m: any) => {
    const md = m.metadata || {};
    if (md.pdf_via) return false;                                  // ya recuperado
    if (md.media_inexistente) return false;                        // sin media o irrecuperable
    if (!md.media_key || !(md.mms_url || md.direct_path)) return false;  // sin claves → no podemos bajar
    const t = md.ai_text || m.texto || '';
    if (t.length > 20 && !RE_FALLO.test(t)) return false;          // ya tiene texto bueno
    const tried = md.media_dl_tried ? Date.parse(md.media_dl_tried) : 0;
    if (tried && ahora - tried < TRIED_TTL_MS) return false;       // throttle
    return true;
  });
  if (!pend.length) return { pendientes: 0, recuperados: 0, fallidos: 0 };

  let recuperados = 0, fallidos = 0;
  for (const m of pend.slice(0, MAX_POR_CICLO)) {
    const md = m.metadata || {};
    const url = md.mms_url || ('https://mmg.whatsapp.net' + md.direct_path);
    const info = HKDF_INFO[m.tipo] || HKDF_INFO.documento;
    const plain = await descargarYDescifrar(md.media_key, url, info);

    if (!plain || plain.subarray(0, 5).toString('latin1') !== '%PDF-') {
      fallidos++;
      const intentos = (md.media_dl_intentos || 0) + 1;
      const patch: any = { ...md, media_dl_tried: new Date().toISOString(), media_dl_intentos: intentos };
      if (intentos >= MAX_INTENTOS) { patch.media_inexistente = true; patch.media_inexistente_motivo = 'media saliente no descargable del CDN (expiró o no es PDF) tras ' + intentos + ' intentos'; }
      await sb.from('mensajes').update({ metadata: patch } as any).eq('id', m.id);
      log(`msg ${m.id}: descarga/descifrado falló (intento ${intentos}${intentos >= MAX_INTENTOS ? ' → marcado irrecuperable' : ''})`);
      continue;
    }

    const doc = await textoDePdf(plain, 2);
    if (!doc) { fallidos++; await sb.from('mensajes').update({ metadata: { ...md, media_dl_tried: new Date().toISOString() } } as any).eq('id', m.id); log(`msg ${m.id}: PDF bajado pero sin texto extraíble`); continue; }

    const texto = `📄 Documento PDF (${doc.numPages} pág.):\n${doc.texto}`;
    const meta = { ...md, ai_text: texto, ai_kind: 'pdf', ai_status: 'processed', pdf_via: 'server_decrypt' };
    delete (meta as any).extractor_done;   // re-extracción de los agentes (montos, etc.)
    const { error } = await sb.from('mensajes').update({ texto, metadata: meta } as any).eq('id', m.id);
    if (error) { fallidos++; log(`msg ${m.id}: error al escribir ${error.message}`); continue; }
    await sb.from('chats').update({ ia_historico_procesado: true } as any).eq('id', m.chat_id);
    // disparar reconstrucción de tarjeta de la persona del chat
    const { data: cl } = await sb.from('chat_checklist').select('persona_id').eq('chat_id', m.chat_id).maybeSingle();
    if (cl?.persona_id) await sb.from('personas').update({ sintesis_pendiente: true } as any).eq('id', cl.persona_id);
    await sb.from('tarjeta').update({ dirty: true } as any).eq('chat_id', m.chat_id);
    recuperados++;
    log(`msg ${m.id} ✓ PDF descargado+descifrado del CDN (${doc.numPages} pág.)`);
  }
  return { pendientes: pend.length, recuperados, fallidos };
}
