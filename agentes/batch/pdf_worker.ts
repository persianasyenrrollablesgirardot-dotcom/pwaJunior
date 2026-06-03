/**
 * PROCESAMIENTO DE PDFs EN EL WORKER (server-side) — reemplaza al extractor
 * frágil de la extensión.
 *
 * Problema: el extractor de la extensión NO descomprime PDFs (FlateDecode) →
 * devolvía "texto dañado". Y la extensión quedó pegada en código viejo (Chrome
 * MV3 no la actualizaba en caliente). pdf.js SÍ lee los PDFs perfecto.
 *
 * Solución: el worker corre en la MISMA máquina que Chrome. Lee los PDFs
 * descifrados desde el almacenamiento local de la extensión (IndexedDB `.blob`),
 * extrae el texto con pdfjs-dist y lo mete por el pipeline normal
 * (`mensajes.texto` + reset `extractor_done`) → los agentes lo procesan → la
 * tarjeta lo refleja. No requiere tocar ni recargar la extensión.
 *
 * Matching PDF→mensaje: por CONTENIDO. Las cotizaciones traen el nombre del
 * cliente y la dirección; se matchea contra el nombre de la persona del chat.
 * Conservador: si no hay match fuerte, NO escribe y loguea (Jhon es juez).
 *
 * Limitación: lee el formato interno de Chrome (carpeta `.blob`). Es un acceso
 * pragmático que evita cambiar la extensión; si Chrome cambia el layout o se
 * corre en otra máquina, configurar CHROME_EXT_BLOB_DIR o desactivar el ciclo.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

// ─── Config ──────────────────────────────────────────────────────────────────
const EXT_ID = process.env.CHROME_EXT_ID || 'oomdmlhadnonedbdjdcfkpceaijpkelj';
const BLOB_DIR = process.env.CHROME_EXT_BLOB_DIR || join(
  process.env.LOCALAPPDATA || 'C:\\Users\\jhon\\AppData\\Local',
  'Google', 'Chrome', 'User Data', 'Default', 'IndexedDB',
  `chrome-extension_${EXT_ID}_0.indexeddb.blob`,
);
const MAX_POR_CICLO = Number(process.env.PDF_WORKER_MAX) || 8;
// Un nombre cuenta como "match" si ≥60% de los tokens del nombre de la persona
// aparecen en el texto del PDF, y al menos 2 tokens distintos.
const MATCH_RATIO_MIN = 0.6;
const MATCH_TOKENS_MIN = 2;

const RE_FALLO = /dañad|no es legible|no se pudo extraer|ilegible|no puedo (ayudar|procesar)|no contiene inform|sin suficiente inform|no hay suficiente/i;
// Stopwords: artículos + términos que aparecen en TODA cotización/factura
// (nombre del vendedor, negocio, plantilla, productos genéricos). Si no se
// excluyen, generan falsos matches (ej. "jhon" = Jhon Cubides, el que firma
// todas las cotizaciones; "cliente"/"persiana" están en todos los documentos).
const STOPWORDS = new Set([
  'del', 'los', 'las', 'casa', 'señor', 'senor', 'sra', 'don', 'doña', 'dona', 'the', 'con', 'sin', 'numero', 'alterno',
  // vendedor / negocio
  'jhon', 'cubides', 'girardot', 'fabrica', 'cortinas', 'cortina', 'persianas', 'persiana', 'melgar', 'homecenter', 'nit',
  // plantilla de documento
  'cliente', 'cotizacion', 'comercial', 'factura', 'recibo', 'caja', 'fecha', 'direccion', 'total', 'subtotal',
  'descripcion', 'cant', 'firma', 'autorizada', 'admin', 'condiciones', 'oferta', 'iva', 'impuestos',
  // productos / ubicaciones genéricas
  'ventana', 'ventanas', 'instalacion', 'screen', 'blackout', 'enrollable', 'enrollables', 'standar', 'standard',
  'habitacion', 'habitaciones', 'sala', 'piso', 'frente', 'interna', 'vano', 'mantenimiento', 'tareas', 'persianas',
]);

// ─── Lectura de PDFs del blob de la extensión ────────────────────────────────
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const MAGIC = Buffer.from('%PDF-');
const EOF = Buffer.from('%%EOF');

/** Escanea los blobs y devuelve los bytes de cada PDF embebido (por firma). */
function extraerPdfBytes(): Buffer[] {
  if (!existsSync(BLOB_DIR)) return [];
  const pdfs: Buffer[] = [];
  for (const f of walk(BLOB_DIR)) {
    let buf: Buffer;
    try { buf = readFileSync(f); } catch { continue; }
    let from = 0;
    while (true) {
      const start = buf.indexOf(MAGIC, from);
      if (start === -1) break;
      let end = buf.indexOf(EOF, start);
      if (end === -1) { from = start + 5; break; }
      let last = end, nxt = end;
      while ((nxt = buf.indexOf(EOF, last + 5)) !== -1 && nxt - start < 50_000_000) last = nxt;
      pdfs.push(buf.slice(start, last + 6));
      from = last + 6;
    }
  }
  return pdfs;
}

export interface PdfDoc { texto: string; numPages: number; }

/** Texto de las primeras `maxPages` páginas de un PDF (pdf.js descomprime FlateDecode). */
async function textoDePdf(bytes: Buffer, maxPages = 2): Promise<PdfDoc | null> {
  try {
    const data = new Uint8Array(bytes);
    const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
    let texto = '';
    const n = Math.min(maxPages, doc.numPages);
    for (let p = 1; p <= n; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      texto += tc.items.map((i: any) => i.str).join(' ') + '\n';
      page.cleanup();
    }
    const numPages = doc.numPages;
    await doc.destroy();
    const limpio = texto.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
    return limpio.length >= 20 ? { texto: limpio.slice(0, 6000), numPages } : null;
  } catch { return null; }
}

// ─── Matching por nombre ─────────────────────────────────────────────────────
function normaliza(s: string): string {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function tokens(nombre: string): string[] {
  return [...new Set(normaliza(nombre).split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOPWORDS.has(t)))];
}

/** Score 0..1: fracción de tokens del nombre de la persona presentes en el texto del PDF. */
function scoreMatch(personaNombre: string, pdfTextoNorm: string): { score: number; matched: number; total: number } {
  const toks = tokens(personaNombre);
  if (!toks.length) return { score: 0, matched: 0, total: 0 };
  const matched = toks.filter(t => pdfTextoNorm.includes(t)).length;
  return { score: matched / toks.length, matched, total: toks.length };
}

async function nombrePersona(sb: SupabaseClient, chatId: number): Promise<{ id: number; nombre: string } | null> {
  const { data: cl } = await sb.from('chat_checklist').select('persona_id').eq('chat_id', chatId).maybeSingle();
  let personaId = cl?.persona_id as number | undefined;
  if (!personaId) {
    const { data: ch } = await sb.from('chats').select('proyecto_id').eq('id', chatId).maybeSingle();
    if (ch?.proyecto_id) {
      const { data: pr } = await sb.from('proyectos').select('persona_id').eq('id', ch.proyecto_id).maybeSingle();
      personaId = pr?.persona_id as number | undefined;
    }
  }
  if (!personaId) return null;
  const { data: per } = await sb.from('personas').select('id, nombre').eq('id', personaId).maybeSingle();
  return per?.nombre ? { id: per.id as number, nombre: per.nombre as string } : null;
}

// ─── Ciclo principal ─────────────────────────────────────────────────────────
export interface ResultadoPdfWorker { pendientes: number; recuperados: number; sinMatch: number; pdfsEnDisco: number; }

export async function cicloPdfWorker(sb: SupabaseClient, log: (m: string) => void = () => {}, opts: { dryRun?: boolean } = {}): Promise<ResultadoPdfWorker> {
  // 1) Mensajes 'documento' con transcripción fallida/vacía y aún no recuperados.
  const { data: msgs } = await sb.from('mensajes')
    .select('id, chat_id, metadata, ts_canal').eq('tipo', 'documento').is('deleted_at', null);
  const pendientes = (msgs ?? []).filter((m: any) => {
    const md = m.metadata || {};
    if (md.pdf_via) return false;                          // ya recuperado por el worker
    const t = md.ai_text || '';
    return !t || RE_FALLO.test(t);
  });
  if (!pendientes.length) return { pendientes: 0, recuperados: 0, sinMatch: 0, pdfsEnDisco: 0 };

  // 2) Extraer todos los PDFs del blob + su texto (una vez por ciclo). Dedup por texto.
  if (!existsSync(BLOB_DIR)) { log(`blob dir no existe (${BLOB_DIR}); ¿Chrome/extensión en otra máquina? skip`); return { pendientes: pendientes.length, recuperados: 0, sinMatch: 0, pdfsEnDisco: 0 }; }
  const bytesList = extraerPdfBytes();
  const docs: { texto: string; norm: string; numPages: number }[] = [];
  const vistos = new Set<string>();
  for (const b of bytesList) {
    const d = await textoDePdf(b, 2);
    if (!d) continue;
    const key = d.texto.slice(0, 200);
    if (vistos.has(key)) continue;
    vistos.add(key);
    docs.push({ texto: d.texto, norm: normaliza(d.texto), numPages: d.numPages });
  }
  log(`${pendientes.length} PDFs pendientes · ${docs.length} PDFs legibles en disco`);

  // 3) Matchear cada mensaje pendiente con su PDF por nombre del cliente.
  let recuperados = 0, sinMatch = 0;
  const lote = pendientes.slice(0, MAX_POR_CICLO);
  for (const m of lote) {
    const per = await nombrePersona(sb, m.chat_id);
    if (!per) { sinMatch++; log(`msg ${m.id}: sin persona resoluble`); continue; }
    // Score contra cada PDF; quedarse con el mejor + verificar margen vs 2º.
    const scored = docs.map(d => ({ d, ...scoreMatch(per.nombre, d.norm) }))
      .sort((a, b) => b.score - a.score || b.matched - a.matched);
    const best = scored[0];
    const segundo = scored[1];
    const ok = best && best.score >= MATCH_RATIO_MIN && best.matched >= MATCH_TOKENS_MIN
      && (!segundo || best.matched > segundo.matched || best.score > segundo.score + 0.15);
    if (!ok) {
      sinMatch++;
      log(`msg ${m.id} (${per.nombre}): sin match confiable (mejor ${best ? `${best.matched}/${best.total}` : '—'}) → NO toco`);
      continue;
    }
    // 4) Escribir la transcripción al pipeline: texto + ai_text + reset extractor.
    const texto = `📄 Documento PDF (${best.d.numPages} pág.):\n${best.d.texto}`;
    if (opts.dryRun) {
      recuperados++;
      const cli = (best.d.texto.match(/CLIENTE:\s*([^\n]*?)\s*(?:CC\/NIT|Dirección|Direccion|Fecha)/i) || [])[1] || '?';
      log(`[DRY] msg ${m.id}: persona "${per.nombre}" ↔ PDF CLIENTE: "${cli.slice(0, 40)}" (${best.matched}/${best.total} tok)`);
      continue;
    }
    const md = { ...(m.metadata || {}), ai_text: texto, ai_kind: 'pdf', ai_status: 'processed', pdf_via: 'worker_pdfjs' };
    delete (md as any).extractor_done;                     // fuerza re-extracción de los agentes
    const { error } = await sb.from('mensajes').update({ texto, metadata: md } as any).eq('id', m.id);
    if (error) { sinMatch++; log(`msg ${m.id}: error al escribir ${error.message}`); continue; }
    // Disparar reconstrucción de la tarjeta de esa persona.
    await sb.from('personas').update({ sintesis_pendiente: true } as any).eq('id', per.id);
    await sb.from('tarjeta').update({ dirty: true } as any).eq('chat_id', m.chat_id);
    recuperados++;
    log(`msg ${m.id} ✓ ${per.nombre} ← PDF (${best.matched}/${best.total} tokens, ${best.d.numPages} pág.)`);
  }
  return { pendientes: pendientes.length, recuperados, sinMatch, pdfsEnDisco: docs.length };
}
