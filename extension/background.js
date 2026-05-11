/* ═══════════════════════════════════════════════════════════
 * WhatsApp Captura Safra — Service Worker
 *
 * Corre en background. Recibe snapshots del content script y:
 *   - Sincroniza con Supabase (DELETE + INSERT por contacto/fecha)
 *   - Transcribe audios con OpenAI Whisper (lee el blob en el
 *     contexto MAIN de la página para bypassear el CSP)
 *   - Organiza conversaciones con DeepSeek y las guarda al CRM
 * ════════════════════════════════════════════════════════ */

'use strict';

const SETTINGS_KEY = 'ws_settings';
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const SUPABASE_URL = 'https://olububjdvboiqgmihsmk.supabase.co';
const WHISPER_URL  = 'https://api.openai.com/v1/audio/transcriptions';

const DEFAULT_DEEPSEEK_KEY = '***REMOVED_SECRET***';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9sdWJ1YmpkdmJvaXFnbWloc21rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MzM0NjcsImV4cCI6MjA5MjMwOTQ2N30.xfTNUQwc-SkL4P0WVvdg8V2rGMhDWdpYTgXEsAEo23E';
const DEFAULT_OPENAI_KEY   = '***REMOVED_SECRET***';

// ═══ Instalación — setea keys por defecto ══════════════════

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([SETTINGS_KEY]).then(r => {
    const s = r[SETTINGS_KEY] || {};
    chrome.storage.local.set({
      [SETTINGS_KEY]: {
        deepseekKey: s.deepseekKey || DEFAULT_DEEPSEEK_KEY,
        supabaseKey: s.supabaseKey || DEFAULT_SUPABASE_KEY,
        openaiKey:   s.openaiKey   || DEFAULT_OPENAI_KEY,
      },
    });
  });
});

async function getSettings() {
  const r = await chrome.storage.local.get([SETTINGS_KEY]);
  const s = r[SETTINGS_KEY] || {};
  return {
    deepseekKey: s.deepseekKey || DEFAULT_DEEPSEEK_KEY,
    supabaseKey: s.supabaseKey || DEFAULT_SUPABASE_KEY,
    openaiKey:   s.openaiKey   || DEFAULT_OPENAI_KEY,
  };
}

// ═══ Transcripción — lee blob en MAIN world y llama Whisper ═

// Se inyecta en world MAIN para LISTAR todos los blobs capturados
// por el patch (URL + owner + tamaño). Background poll esto cada
// pocos segundos para saber qué transcribir.
function listCapturedBlobs() {
  const blobs  = window.__wsCaptura?.blobs;
  const owners = window.__wsCaptura?.owners;
  if (!blobs) return [];
  const out = [];
  for (const [url, blob] of blobs) {
    out.push({ url, size: blob.size, type: blob.type, owner: owners?.get(url) || null });
  }
  return out;
}

async function readBlobInPage(url) {
  try {
    let blob = null;
    if (window.__wsCaptura?.blobs?.has(url)) {
      blob = window.__wsCaptura.blobs.get(url);
    } else {
      const res = await fetch(url);
      blob = await res.blob();
    }
    if (!blob) return { error: 'blob no encontrado' };

    const buffer = await blob.arrayBuffer();
    const bytes  = new Uint8Array(buffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    return { base64: btoa(bin), mimeType: blob.type || 'audio/ogg', size: blob.size };
  } catch (e) {
    return { error: e.message };
  }
}

async function transcribeAudio(tabId, blobUrl, owner = null) {
  const txKey = `ws_tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const shortUrl = blobUrl.slice(-12);
  console.log(`[WS] ▶ transcribe start ...${shortUrl} owner="${owner}" tab=${tabId}`);
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world:  'MAIN',
      func:   readBlobInPage,
      args:   [blobUrl],
    });
    const data = injection?.result;
    console.log(`[WS]   executeScript result ...${shortUrl}: base64=${!!data?.base64} size=${data?.size} error=${data?.error || '-'}`);

    if (!data?.base64) {
      await chrome.storage.local.set({ [txKey]: { blobUrl, text: null, owner, error: data?.error || 'no base64' } });
      console.warn(`[WS] ✗ sin base64 para ...${shortUrl}`);
      return false;
    }

    const { openaiKey } = await getSettings();
    console.log(`[WS]   openaiKey length=${openaiKey?.length || 0}`);

    const binary = atob(data.base64);
    const buf    = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    const audioBlob = new Blob([buf], { type: data.mimeType });

    const form = new FormData();
    form.append('file', audioBlob, 'audio.ogg');
    form.append('model', 'whisper-1');
    form.append('language', 'es');

    console.log(`[WS]   → Whisper (size=${audioBlob.size}, type=${data.mimeType}) ...${shortUrl}`);
    const res = await fetch(WHISPER_URL, {
      method:  'POST',
      headers: { Authorization: `Bearer ${openaiKey}` },
      body:    form,
    });
    console.log(`[WS]   ← Whisper HTTP ${res.status} ...${shortUrl}`);
    const json = await res.json();

    if (!res.ok) {
      console.warn(`[WS] ✗ Whisper rechazó ...${shortUrl}:`, JSON.stringify(json).slice(0, 300));
    } else {
      console.log(`[WS] ✓ ...${shortUrl} → "${(json.text || '').slice(0, 80)}"`);
    }

    await chrome.storage.local.set({ [txKey]: { blobUrl, text: json.text || null, owner, httpStatus: res.status } });
    return res.ok && !!json.text;
  } catch (e) {
    console.warn(`[WS] ✗ Exception ...${shortUrl}:`, e.message);
    await chrome.storage.local.set({ [txKey]: { blobUrl, text: null, owner, error: e.message } });
    return false;
  }
}

// ═══ Poll de blobs capturados en WhatsApp tabs ═════════════
// El background pregunta periódicamente al patch qué blobs tiene.
// Evita depender del timing de carga del content script.

// URLs que completamos con éxito (no reintentar)
const completedUrls = new Set();
// URLs actualmente en la cola o procesándose
const inFlightUrls  = new Set();
// Contador de intentos por URL (máximo 5 antes de darnos por vencidos)
const attemptCount  = new Map();

// Cola de transcripción con concurrencia máxima
const MAX_CONCURRENT = 2;
let   txInFlight     = 0;
const txQueue        = [];

function enqueueTranscribe(tabId, url, owner) {
  if (completedUrls.has(url) || inFlightUrls.has(url)) return;
  inFlightUrls.add(url);
  txQueue.push({ tabId, url, owner });
  drainTxQueue();
}

function drainTxQueue() {
  while (txInFlight < MAX_CONCURRENT && txQueue.length > 0) {
    const item = txQueue.shift();
    txInFlight++;
    const n = (attemptCount.get(item.url) || 0) + 1;
    attemptCount.set(item.url, n);

    transcribeAudio(item.tabId, item.url, item.owner)
      .then(success => {
        if (success) {
          completedUrls.add(item.url);
        } else if (n < 5) {
          // Reintentar con pequeño delay
          setTimeout(() => {
            inFlightUrls.delete(item.url);
            enqueueTranscribe(item.tabId, item.url, item.owner);
          }, 2000);
          return;
        } else {
          // Nos rendimos después de 5 intentos
          completedUrls.add(item.url);
        }
        inFlightUrls.delete(item.url);
      })
      .catch(() => {
        inFlightUrls.delete(item.url);
      })
      .finally(() => {
        txInFlight--;
        drainTxQueue();
      });
  }
}

async function pollCapturedBlobs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    for (const tab of tabs) {
      if (!tab.id) continue;
      let injection;
      try {
        [injection] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world:  'MAIN',
          func:   listCapturedBlobs,
        });
      } catch (_) { continue; }
      const list = injection?.result || [];
      for (const item of list) {
        const isAudio = (item.type || '').toLowerCase().startsWith('audio/');
        // SOLO procesamos audios desde el poll. Las imágenes se describen
        // únicamente cuando content.js envía DESCRIBE_IMAGE explícito —
        // así respeta el burst limit (max 3 por ráfaga). Sin esto,
        // pollCapturedBlobs descargaría TODAS las imágenes sin filtro.
        if (isAudio) {
          if (completedUrls.has(item.url) || inFlightUrls.has(item.url)) continue;
          console.log(`[WS] 🆕 audio descubierto ...${item.url.slice(-12)} owner="${item.owner}"`);
          enqueueTranscribe(tab.id, item.url, item.owner);
        }
      }
    }
  } catch (e) {
    console.warn('[WS] poll error:', e.message);
  }
}

// Poll cada 3 segundos
setInterval(pollCapturedBlobs, 3000);
// También poll inicial al cargar el SW
setTimeout(pollCapturedBlobs, 2000);

// ═══ Sincronización con Supabase (DELETE + INSERT) ══════════

// Cola de syncs por contacto — evita DELETE+INSERT simultáneos
// que dejan la fila temporalmente vacía y la rompe el visor al
// hacer poll entre las dos operaciones.
const syncQueue = new Map();   // contactKey → Promise en curso

async function syncToSupabase(entry) {
  const key = `${entry.contact}|${entry.date}`;
  // Esperar a que termine el sync anterior del mismo contacto
  const prev = syncQueue.get(key) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => doSyncToSupabase(entry));
  syncQueue.set(key, next);
  try { await next; }
  finally { if (syncQueue.get(key) === next) syncQueue.delete(key); }
}

async function doSyncToSupabase(entry) {
  const { supabaseKey } = await getSettings();
  const headers = {
    'Content-Type':  'application/json',
    'apikey':         supabaseKey,
    'Authorization':  `Bearer ${supabaseKey}`,
  };
  const filter = `contact=eq.${encodeURIComponent(entry.contact)}&date=eq.${encodeURIComponent(entry.date)}`;

  // Meta del contacto embebido en messages[0] — así guardamos info extra
  // sin tener que cambiar el schema de la tabla.
  const metaMsg = {
    role: '__meta__',
    text: '',
    time: '',
    type: 'meta',
    contactInfo: {
      profilePic: entry.profilePic,
      presence:   entry.presence,
      lastSeen:   entry.lastSeen,
      isGroup:    entry.isGroup || false,
    },
  };
  const messagesWithMeta = [metaMsg, ...entry.messages];

  await fetch(`${SUPABASE_URL}/rest/v1/wa_raw_captures?${filter}`, {
    method: 'DELETE',
    headers,
  });

  await fetch(`${SUPABASE_URL}/rest/v1/wa_raw_captures`, {
    method:  'POST',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body:    JSON.stringify({
      contact:     entry.contact,
      phone:       entry.phone,
      date:        entry.date,
      messages:    messagesWithMeta,
      captured_at: entry.capturedAt,
      updated_at:  entry.updatedAt,
      processed:   false,
    }),
  });
}

// ═══ DeepSeek — organizar capturas al CRM ══════════════════

async function organizeWithAI(captures) {
  const { deepseekKey } = await getSettings();
  const transcript = captures.map(c =>
    `== CLIENTE: ${c.contact}${c.phone ? ` (${c.phone})` : ''} | ${c.date} ==\n` +
    c.messages.map(m => `  [${m.time}] ${m.role}: ${m.text}`).join('\n')
  ).join('\n\n');

  const res = await fetch(DEEPSEEK_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deepseekKey}` },
    body:    JSON.stringify({
      model:       'deepseek-chat',
      temperature: 0.1,
      max_tokens:  3000,
      messages: [
        {
          role:    'system',
          content: `Eres un asistente CRM para Fábrica de Cortinas Girardot (Safra), Colombia. Moneda: COP.
Analiza conversaciones de WhatsApp y devuelve un JSON (array) con este esquema EXACTO:
[
  {
    "contacto": "nombre del cliente",
    "telefono": "número o null",
    "productos": ["lista de productos/sistemas mencionados"],
    "medidas": "medidas mencionadas o null",
    "precio_acordado": número o null,
    "estado": "nuevo_contacto | cotizacion | negociacion | cerrado | postventa | perdido",
    "resumen": "1-2 oraciones de qué se habló",
    "proxima_accion": "qué hacer con este cliente",
    "prioridad": "alta | media | baja"
  }
]
Solo JSON, sin markdown, sin explicaciones.`,
        },
        { role: 'user', content: transcript },
      ],
    }),
  });

  const json = await res.json();
  const raw  = json.choices?.[0]?.message?.content || '[]';
  try { return JSON.parse(raw); }
  catch {
    const m = raw.match(/\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : [];
  }
}

async function saveCrmRecords(records) {
  const { supabaseKey } = await getSettings();
  const rows = records.map(r => ({
    contacto:        r.contacto,
    telefono:        r.telefono,
    productos:       r.productos,
    medidas:         r.medidas,
    precio_acordado: r.precio_acordado,
    estado:          r.estado,
    resumen:         r.resumen,
    proxima_accion:  r.proxima_accion,
    prioridad:       r.prioridad,
    fecha:           new Date().toISOString().split('T')[0],
    fuente:          'whatsapp_web',
  }));

  const res = await fetch(`${SUPABASE_URL}/rest/v1/crm_interacciones`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':         supabaseKey,
      'Authorization':  `Bearer ${supabaseKey}`,
      'Prefer':         'return=minimal',
    },
    body: JSON.stringify(rows),
  });
  return res.ok;
}

// ═══ Descripción de imagen con OpenAI Vision (gpt-4o-mini) ═════════

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';

const VISION_PROMPT = `Describe brevemente en español lo que aparece en esta imagen.
Si hay TEXTO visible, transcríbelo literalmente (números, fechas, montos, referencias, nombres).
Si es un comprobante de pago: extrae monto, banco, cuenta destino, referencia, fecha.
Si es una persiana o cortina: describe el tipo (blackout, screen, panel japonés, sheer, enrollable), color, ubicación visible (sala, cuarto, ventana, puerta), estado o problema.
Si es una foto de medida o instalación: describe qué se mide o instala.
Si es una persona, mascota o escena cotidiana, describe brevemente.
Máximo 150 palabras. Sé directo, sin saludos ni rodeos.`;

async function describeImage(tabId, blobUrl, owner = null) {
  const txKey = `ws_imgtx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const shortUrl = blobUrl.slice(-12);
  console.log(`[WS-IMG] ▶ describe start ...${shortUrl} owner="${owner}" tab=${tabId}`);
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: readBlobInPage, args: [blobUrl],
    });
    const data = injection?.result;
    if (!data?.base64) {
      await chrome.storage.local.set({ [txKey]: { blobUrl, text: null, owner, error: data?.error || 'no base64', kind: 'image' } });
      console.warn(`[WS-IMG] ✗ sin base64 ...${shortUrl}`);
      return false;
    }
    const { openaiKey } = await getSettings();
    const dataUrl = `data:${data.mimeType || 'image/jpeg'};base64,${data.base64}`;
    console.log(`[WS-IMG]   → OpenAI Vision (size=${data.size}, type=${data.mimeType}) ...${shortUrl}`);
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: VISION_PROMPT },
            { type: 'image_url', image_url: { url: dataUrl, detail: 'low' } },
          ],
        }],
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      console.warn(`[WS-IMG] ✗ Vision rechazó ...${shortUrl}:`, JSON.stringify(json).slice(0, 300));
      await chrome.storage.local.set({ [txKey]: { blobUrl, text: null, owner, httpStatus: res.status, kind: 'image' } });
      return false;
    }
    const text = json.choices?.[0]?.message?.content?.trim() || null;
    console.log(`[WS-IMG] ✓ ...${shortUrl} → "${(text || '').slice(0, 80)}"`);
    await chrome.storage.local.set({ [txKey]: { blobUrl, text, owner, httpStatus: res.status, kind: 'image' } });
    return res.ok && !!text;
  } catch (e) {
    console.warn(`[WS-IMG] ✗ Exception ...${shortUrl}:`, e.message);
    await chrome.storage.local.set({ [txKey]: { blobUrl, text: null, owner, error: e.message, kind: 'image' } });
    return false;
  }
}

// Cola separada para imágenes — concurrencia más baja porque Vision es caro
const imgInFlightUrls = new Set();
const imgCompletedUrls = new Set();
const imgAttemptCount = new Map();
const imgQueue = [];
let imgTxInFlight = 0;
const IMG_MAX_CONCURRENT = 1;

function enqueueImageDescribe(tabId, url, owner) {
  if (imgCompletedUrls.has(url) || imgInFlightUrls.has(url)) return;
  imgInFlightUrls.add(url);
  imgQueue.push({ tabId, url, owner });
  drainImgQueue();
}

function drainImgQueue() {
  while (imgTxInFlight < IMG_MAX_CONCURRENT && imgQueue.length > 0) {
    const item = imgQueue.shift();
    imgTxInFlight++;
    const n = (imgAttemptCount.get(item.url) || 0) + 1;
    imgAttemptCount.set(item.url, n);
    describeImage(item.tabId, item.url, item.owner)
      .then(success => {
        if (success) imgCompletedUrls.add(item.url);
        else if (n < 3) setTimeout(() => {
          imgInFlightUrls.delete(item.url);
          enqueueImageDescribe(item.tabId, item.url, item.owner);
        }, 5000);
      })
      .finally(() => {
        imgTxInFlight--;
        imgInFlightUrls.delete(item.url);
        drainImgQueue();
      });
  }
}

// ═══ Resumen de PDF con OpenAI (primeras 2 páginas) ═════════════════

const PDF_PROMPT = `Resume el contenido de las PRIMERAS 2 páginas de este PDF en español.
Extrae los datos clave según el tipo de documento:
- Si es COTIZACIÓN: número, fecha, cliente, ítems con cantidades y precios, subtotal, IVA, total.
- Si es FACTURA: número, fecha, emisor, cliente, ítems, total, forma de pago.
- Si es COMPROBANTE DE PAGO: monto, fecha, banco, cuenta destino/origen, referencia.
- Si es CONTRATO o DOCUMENTO LEGAL: partes involucradas, monto, plazo, cláusulas críticas.
- Si es CATÁLOGO o FICHA TÉCNICA: producto, especificaciones, precios.
- Si es OTRO: hechos importantes (nombres, fechas, cantidades, montos).
Máximo 250 palabras. Sé directo, sin saludos. Si el PDF tiene más de 2 páginas, ignora las restantes.`;

// Variante para PDFs cuyo blob vive DENTRO del iframe del visor.
// chrome.scripting.executeScript con frameIds=[frameId] ejecuta dentro de
// ese iframe específico, donde el blob URL es resolvable.
async function summarizePdfInFrame(tabId, frameId, blobUrl, fileName = null) {
  const txKey = `ws_pdftx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const shortUrl = blobUrl.slice(-12);
  console.log(`[WS-PDF] ▶ summarize (iframe) start "${fileName}" ...${shortUrl} frame=${frameId}`);
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: readBlobInPage,
      args: [blobUrl],
    });
    const data = injection?.result;
    if (!data?.base64) {
      await chrome.storage.local.set({ [txKey]: { blobUrl, fileName, text: null, error: data?.error || 'no base64', kind: 'pdf' } });
      console.warn(`[WS-PDF] ✗ sin base64 (iframe) ...${shortUrl}`);
      return false;
    }
    const { openaiKey } = await getSettings();
    console.log(`[WS-PDF]   → OpenAI Files (iframe size=${data.size}) ...${shortUrl}`);
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PDF_PROMPT },
            { type: 'file', file: { file_data: `data:application/pdf;base64,${data.base64}`, filename: 'doc.pdf' } },
          ],
        }],
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      console.warn(`[WS-PDF] ✗ OpenAI rechazó (iframe) ...${shortUrl}:`, JSON.stringify(json).slice(0, 300));
      await chrome.storage.local.set({ [txKey]: { blobUrl, fileName, text: null, httpStatus: res.status, kind: 'pdf' } });
      return false;
    }
    const text = json.choices?.[0]?.message?.content?.trim() || null;
    console.log(`[WS-PDF] ✓ (iframe) "${fileName}" ...${shortUrl} → "${(text || '').slice(0, 80)}"`);
    await chrome.storage.local.set({ [txKey]: { blobUrl, fileName, text, httpStatus: res.status, kind: 'pdf' } });
    return res.ok && !!text;
  } catch (e) {
    console.warn(`[WS-PDF] ✗ Exception (iframe) ...${shortUrl}:`, e.message);
    await chrome.storage.local.set({ [txKey]: { blobUrl, fileName, text: null, error: e.message, kind: 'pdf' } });
    return false;
  }
}

function enqueuePdfSummarizeFrame(tabId, frameId, url, fileName) {
  if (pdfCompletedUrls.has(url) || pdfInFlightUrls.has(url)) return;
  pdfInFlightUrls.add(url);
  pdfQueue.push({ tabId, frameId, url, fileName, isFrame: true });
  drainPdfQueue();
}

// Procesa un PDF cuando ya recibimos el base64 desde el iframe — no
// necesita acceder al frame, evita "No frame with id X" si el viewer
// se cerró antes de que llegáramos a la cola.
async function summarizePdfFromBase64(base64, fileName, size) {
  const txKey = `ws_pdftx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  console.log(`[WS-PDF] ▶ summarize (base64) "${fileName}" size=${size}`);
  try {
    const { openaiKey } = await getSettings();
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PDF_PROMPT },
            { type: 'file', file: { file_data: `data:application/pdf;base64,${base64}`, filename: fileName || 'doc.pdf' } },
          ],
        }],
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      console.warn(`[WS-PDF] ✗ OpenAI rechazó "${fileName}":`, JSON.stringify(json).slice(0, 300));
      await chrome.storage.local.set({ [txKey]: { fileName, text: null, httpStatus: res.status, kind: 'pdf' } });
      return false;
    }
    const text = json.choices?.[0]?.message?.content?.trim() || null;
    console.log(`[WS-PDF] ✓ (base64) "${fileName}" → "${(text || '').slice(0, 80)}"`);
    await chrome.storage.local.set({ [txKey]: { fileName, text, httpStatus: res.status, kind: 'pdf' } });
    return !!text;
  } catch (e) {
    console.warn(`[WS-PDF] ✗ Exception (base64) "${fileName}":`, e.message);
    await chrome.storage.local.set({ [txKey]: { fileName, text: null, error: e.message, kind: 'pdf' } });
    return false;
  }
}

const pdfBase64ProcessedFiles = new Set();
function enqueuePdfSummarizeBase64(base64, fileName, size) {
  const dedupKey = `${fileName}|${size}`;
  if (pdfBase64ProcessedFiles.has(dedupKey)) return;
  pdfBase64ProcessedFiles.add(dedupKey);
  pdfQueue.push({ base64, fileName, size, isBase64: true });
  drainPdfQueue();
}

async function summarizePdf(tabId, blobUrl, owner = null) {
  const txKey = `ws_pdftx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const shortUrl = blobUrl.slice(-12);
  console.log(`[WS-PDF] ▶ summarize start ...${shortUrl} owner="${owner}" tab=${tabId}`);
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func: readBlobInPage, args: [blobUrl],
    });
    const data = injection?.result;
    if (!data?.base64) {
      await chrome.storage.local.set({ [txKey]: { blobUrl, text: null, owner, error: data?.error || 'no base64', kind: 'pdf' } });
      console.warn(`[WS-PDF] ✗ sin base64 ...${shortUrl}`);
      return false;
    }
    const { openaiKey } = await getSettings();
    console.log(`[WS-PDF]   → OpenAI Files (size=${data.size}) ...${shortUrl}`);
    // OpenAI Chat Completions con type:'file' acepta PDF como base64 inline.
    const res = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 600,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: PDF_PROMPT },
            { type: 'file', file: { file_data: `data:application/pdf;base64,${data.base64}`, filename: 'doc.pdf' } },
          ],
        }],
      }),
    });
    const json = await res.json();
    if (!res.ok) {
      console.warn(`[WS-PDF] ✗ OpenAI rechazó ...${shortUrl}:`, JSON.stringify(json).slice(0, 300));
      await chrome.storage.local.set({ [txKey]: { blobUrl, text: null, owner, httpStatus: res.status, kind: 'pdf' } });
      return false;
    }
    const text = json.choices?.[0]?.message?.content?.trim() || null;
    console.log(`[WS-PDF] ✓ ...${shortUrl} → "${(text || '').slice(0, 80)}"`);
    await chrome.storage.local.set({ [txKey]: { blobUrl, text, owner, httpStatus: res.status, kind: 'pdf' } });
    return res.ok && !!text;
  } catch (e) {
    console.warn(`[WS-PDF] ✗ Exception ...${shortUrl}:`, e.message);
    await chrome.storage.local.set({ [txKey]: { blobUrl, text: null, owner, error: e.message, kind: 'pdf' } });
    return false;
  }
}

const pdfInFlightUrls = new Set();
const pdfCompletedUrls = new Set();
const pdfQueue = [];
let pdfTxInFlight = 0;
const PDF_MAX_CONCURRENT = 1;

function enqueuePdfSummarize(tabId, url, owner) {
  if (pdfCompletedUrls.has(url) || pdfInFlightUrls.has(url)) return;
  pdfInFlightUrls.add(url);
  pdfQueue.push({ tabId, url, owner });
  drainPdfQueue();
}
function drainPdfQueue() {
  while (pdfTxInFlight < PDF_MAX_CONCURRENT && pdfQueue.length > 0) {
    const item = pdfQueue.shift();
    pdfTxInFlight++;
    const promise = item.isBase64
      ? summarizePdfFromBase64(item.base64, item.fileName, item.size)
      : item.isFrame
        ? summarizePdfInFrame(item.tabId, item.frameId, item.url, item.fileName)
        : summarizePdf(item.tabId, item.url, item.owner);
    promise
      .then(success => { if (success && item.url) pdfCompletedUrls.add(item.url); })
      .finally(() => {
        pdfTxInFlight--;
        if (item.url) pdfInFlightUrls.delete(item.url);
        drainPdfQueue();
      });
  }
}

// ═══ Router de mensajes ═════════════════════════════════════

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg?.type === 'SYNC_CAPTURE' && msg.entry) {
    syncToSupabase(msg.entry).catch(e => console.warn('[WS] Sync error:', e.message));
    return;
  }

  if (msg?.type === 'TRANSCRIBE_AUDIO' && msg.blobUrl) {
    const tabId = sender.tab?.id;
    if (tabId) transcribeAudio(tabId, msg.blobUrl);
    return;
  }

  if (msg?.type === 'DESCRIBE_IMAGE' && msg.blobUrl) {
    const tabId = sender.tab?.id;
    if (tabId) enqueueImageDescribe(tabId, msg.blobUrl, msg.owner || null);
    return;
  }

  if (msg?.type === 'SUMMARIZE_PDF' && msg.blobUrl) {
    const tabId = sender.tab?.id;
    if (tabId) enqueuePdfSummarize(tabId, msg.blobUrl, msg.owner || null);
    return;
  }

  // Mensaje desde el IFRAME del visor PDF (origen webtp.whatsapp.net).
  // El blob solo es accesible desde el frameId del iframe — usamos el
  // sender.frameId para targetear executeScript correctamente.
  if (msg?.type === 'SUMMARIZE_PDF_FROM_IFRAME' && msg.blobUrl) {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (tabId && frameId) {
      enqueuePdfSummarizeFrame(tabId, frameId, msg.blobUrl, msg.fileName || null);
    }
    return;
  }

  // Variante con base64 ya listo — el iframe lo leyó antes de cerrarse,
  // evita "No frame with id X" cuando el SW procesa tarde.
  if (msg?.type === 'SUMMARIZE_PDF_BASE64' && msg.base64) {
    enqueuePdfSummarizeBase64(msg.base64, msg.fileName || null, msg.size || 0);
    return;
  }

  if (msg?.type === 'PROCESS_AND_SEND' && Array.isArray(msg.captures)) {
    (async () => {
      try {
        const records = await organizeWithAI(msg.captures);
        const saved   = await saveCrmRecords(records);
        sendResponse({ ok: true, records, saved });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;  // async
  }
});
