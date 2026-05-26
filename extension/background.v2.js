/* ═══════════════════════════════════════════════════════════════════
 * WhatsApp Captura Safra — Background V2 (Service Worker)
 *
 * Responsabilidades:
 *   1. Recibir batches de CanonicalMessage desde content.v2.js
 *      (vía chrome.runtime.onMessage type='V2_BATCH')
 *   2. Persistir mensajes y media en IndexedDB de la extensión (origen
 *      independiente de WA Web — datos seguros aunque WA Web cierre).
 *   3. Descargar + descifrar media on-demand (HKDF + AES-256-CBC).
 *   4. Procesar media con IA: Whisper para audios, Vision para imágenes,
 *      Files API para PDFs. Cache de resultados por SHA-256 (dedup global).
 *   5. chrome.alarms keepalive para que el SW no se duerma con cola pendiente.
 *   6. Sync a Supabase (Bloque 3 — todavía no se conecta).
 *
 * IndexedDB de la extensión: `wa_capture_v2_db`
 *   Stores:
 *     - messages           keyPath='id'           CanonicalMessage[]
 *     - media_blobs        keyPath='sha256'       { sha256, bytes, mimetype, refCount, lastAccess }
 *     - media_processed    keyPath='sha256'       { sha256, kind, text, processedAt }
 *     - pending_queue      keyPath autoincrement  { taskType, messageId, attempts, nextAt }
 *     - processing_state   keyPath='id'           { messageId, state, attempts, lastError, updatedAt }
 *
 * Estados del CanonicalMessage:
 *   discovered → metadata_loaded → text_decrypted → media_downloaded → ai_processed → synced
 *
 * Configuración (constantes al tope):
 *   - WHISPER / VISION concurrency
 *   - chrome.alarms interval
 *   - Reintentos máximos
 *
 * ════════════════════════════════════════════════════════════════════ */

'use strict';

// Visor PG — schema nuevo. visor_pg_sync.js define funciones helper (canonicalToMensajeRow,
// canonicalToEventoRow, upsertChat, mapTipoMensaje) reusadas por extension_api.js.
// extension_api.js expone los handlers chrome.runtime.onMessageExternal para que el Visor
// pueda procesar / bloquear / listar chats con un click.
importScripts('visor_pg_sync.js');
importScripts('extension_api.js');

const DB_NAME    = 'wa_capture_v2_db';
const DB_VERSION = 2;   // bump por chat_metadata store

var SUPABASE_URL = 'https://olububjdvboiqgmihsmk.supabase.co';
const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const WHISPER_URL     = 'https://api.openai.com/v1/audio/transcriptions';

// Sync a Supabase: agrupar por chat_id y subir cada N segundos.
const SUPABASE_SYNC_INTERVAL_MS = 5000;
const SUPABASE_BATCH_MAX = 200;

// ─── Flags de control del pipeline IA ─────────────────────────────
// El SW lee estos flags de chrome.storage.local en cada drain. Por DEFAULT
// el pipeline IA está APAGADO — debe activarse explícitamente desde el
// Visor (toggle "Tiempo real ON") o invocando "Procesar este chat" para
// un chat específico. Esto evita que al arrancar la extensión empiece a
// procesar todo el histórico y queme saldo OpenAI.
//
// Flags persistentes:
//   ws_v2_ia_realtime_enabled  bool   — si true, los media nuevos se procesan automáticamente
//   ws_v2_ia_chats_whitelist   string[] — chat_ids autorizados a procesarse (manual o realtime)
//   ws_v2_ia_daily_cap_usd     number — tope diario de gasto en USD (default 10)
//
// Acumuladores:
//   ws_v2_ia_spend_daily       { date: 'YYYY-MM-DD', usd: number }
//   ws_v2_ia_spend_monthly     { month: 'YYYY-MM', usd: number }
//
// Reglas DURAS (no consultables, hardcoded):
//   - status@broadcast NUNCA se procesa
//   - stickers NUNCA se procesan con IA
//   - forwarded many times NUNCA se procesan
//   - burst limit imágenes: máx 3 por (chat, role, minuto)

const IA_FLAG_KEYS = [
  'ws_v2_ia_realtime_enabled',
  'ws_v2_ia_realtime_since',
  'ws_v2_ia_chats_whitelist',
  'ws_v2_ia_daily_cap_usd',
  'ws_v2_ia_spend_daily',
  'ws_v2_ia_spend_monthly',
];

async function getIAState() {
  const r = await chrome.storage.local.get(IA_FLAG_KEYS);
  return {
    realtimeEnabled: !!r.ws_v2_ia_realtime_enabled,
    // Momento (ms) en que se prendió tiempo real. Solo se procesan los mensajes
    // posteriores — el histórico viejo se sube con "Procesar", no se reprocesa solo.
    realtimeSince:   typeof r.ws_v2_ia_realtime_since === 'number' ? r.ws_v2_ia_realtime_since : 0,
    whitelist:       Array.isArray(r.ws_v2_ia_chats_whitelist) ? r.ws_v2_ia_chats_whitelist : [],
    dailyCapUsd:     typeof r.ws_v2_ia_daily_cap_usd === 'number' ? r.ws_v2_ia_daily_cap_usd : 10,
    spendDaily:      r.ws_v2_ia_spend_daily   || { date: '',  usd: 0 },
    spendMonthly:    r.ws_v2_ia_spend_monthly || { month: '', usd: 0 },
  };
}

async function setIAFlag(key, value) {
  if (!IA_FLAG_KEYS.includes(key)) throw new Error('flag desconocido: ' + key);
  await chrome.storage.local.set({ [key]: value });
}

function chatIsWhitelisted(chatId, whitelist) {
  if (!chatId || chatId.includes('status@broadcast')) return false;
  return whitelist.includes(chatId);
}

// ─── Sync de la whitelist a Supabase (chat_authorizations) ────────
// Cada vez que el usuario autoriza/desautoriza un chat, la extensión
// debe replicar el estado a la tabla chat_authorizations para que el
// worker server-side sepa qué chats puede analizar con DeepSeek.
async function syncChatAuthorizationToSupabase(chatId, authorized, alias = null) {
  try {
    const { supabaseKey } = await getSettings();
    if (!supabaseKey) {
      console.warn('[WS-BG-V2] sync chat_authorizations: supabaseKey vacío');
      return false;
    }
    const headers = {
      'Content-Type':  'application/json',
      'apikey':         supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer':        'resolution=merge-duplicates',
    };
    const row = {
      chat_id:       chatId,
      authorized:    !!authorized,
      authorized_at: new Date().toISOString(),
    };
    if (alias) row.alias = alias;
    const res = await fetch(`${SUPABASE_URL}/rest/v1/chat_authorizations`, {
      method: 'POST',
      headers,
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      const t = await res.text();
      console.warn(`[WS-BG-V2] sync chat_authorizations HTTP ${res.status}: ${t.slice(0,200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[WS-BG-V2] sync chat_authorizations error:', e.message);
    return false;
  }
}

const ALARM_NAME = 'ws_v2_keepalive';
const ALARM_PERIOD_MIN = 0.5;       // 30s — mantiene el SW vivo

// Antes 2/1 — un chat con 100 audios tomaba ~80 min con esto.
// Con 6 descargas paralelas y 3 IAs paralelas baja a ~20 min.
// Las descargas son GRATIS (CDN de WA, sin gasto API).
// 3 calls paralelos a OpenAI Whisper/Vision toleran sin rate limit.
const MAX_DOWNLOAD_CONCURRENCY = 6;
const MAX_AI_CONCURRENCY = 3;
const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS_BASE = 2000;   // exp backoff

// HKDF info por tipo (estándar WA — confirmado en POC)
const MEDIA_HKDF_INFO = {
  image:    'WhatsApp Image Keys',
  audio:    'WhatsApp Audio Keys',
  ptt:      'WhatsApp Audio Keys',
  video:    'WhatsApp Video Keys',
  document: 'WhatsApp Document Keys',
  sticker:  'WhatsApp Image Keys',
};

const VISION_PROMPT = `Eres asistente de un negocio de cortinas y persianas (Fábrica de Cortinas Girardot, Colombia).
Describe la imagen en español, máximo 150 palabras. Si hay TEXTO visible, transcríbelo literalmente (números, fechas, montos, referencias, nombres). Si es comprobante de pago: extrae monto, banco, cuenta destino, referencia, fecha. Si es persiana/cortina: tipo (blackout, screen, sheer, enrollable, panel japonés), color, ubicación. Sé directo, sin saludos.`;

const PDF_PROMPT = `Resume el PDF en español, máximo 250 palabras. Si es cotización/factura/comprobante/contrato/catálogo, extrae: cliente, monto, productos, medidas, fechas, referencias clave.`;

// ─── Settings (legacy share con v1) ────────────────────────────────
const SETTINGS_KEY = 'ws_settings';
async function getSettings() {
  const r = await chrome.storage.local.get([SETTINGS_KEY]);
  const s = r[SETTINGS_KEY] || {};
  return {
    deepseekKey: s.deepseekKey || '',
    supabaseKey: s.supabaseKey || '',
    openaiKey:   s.openaiKey   || '',
  };
}

// ─── IndexedDB de la extensión ────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('messages')) {
        const s = db.createObjectStore('messages', { keyPath: 'id' });
        s.createIndex('by_chat',     'chat_id',  { unique: false });
        s.createIndex('by_timestamp','timestamp',{ unique: false });
        s.createIndex('by_state',    'processing_state', { unique: false });
      }
      if (!db.objectStoreNames.contains('media_blobs')) {
        const s = db.createObjectStore('media_blobs', { keyPath: 'sha256' });
        s.createIndex('by_lastAccess', 'lastAccess', { unique: false });
      }
      if (!db.objectStoreNames.contains('media_processed')) {
        db.createObjectStore('media_processed', { keyPath: 'sha256' });
      }
      if (!db.objectStoreNames.contains('pending_queue')) {
        const s = db.createObjectStore('pending_queue', { keyPath: 'qid', autoIncrement: true });
        s.createIndex('by_nextAt', 'nextAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('processing_state')) {
        db.createObjectStore('processing_state', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chat_metadata')) {
        db.createObjectStore('chat_metadata', { keyPath: 'jid' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  try {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const result = await fn(store);
    await new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
    return result;
  } finally {
    db.close();
  }
}

function reqAsync(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

// ─── Persistir un batch de CanonicalMessages ──────────────────────

// ─── Reglas DURAS para excluir un mensaje del procesamiento IA ────
// Devuelve null si OK, o un string con la razón si NO debe procesarse.
function aiHardSkipReason(msg) {
  // Status broadcasts (historias) — NUNCA
  if (msg.chat_id?.includes('status@broadcast')) return 'status_broadcast';
  if (typeof msg.from === 'string' && msg.from.includes('status@broadcast')) return 'status_broadcast';
  // Stickers — NUNCA
  if (msg.type === 'sticker') return 'sticker';
  // Forwarded many times — NUNCA (cuando lo capturemos del IndexedDB)
  if (msg.is_forwarded_many_times === true) return 'forwarded_many_times';
  return null;
}

// Burst limit en imágenes: máx 3 por (chat_id, is_owner, minuto). El chequeo
// se hace al guardar; el burst_index se calcula contra los msgs ya guardados
// del mismo bucket.
async function shouldEnqueueMedia(msg, store) {
  // Reglas duras
  const hard = aiHardSkipReason(msg);
  if (hard) return { allow: false, reason: hard };
  // Sin media → no hay nada para descargar
  if (!msg.media || !msg.media.media_key || !msg.media.direct_path) {
    return { allow: false, reason: 'no_media' };
  }
  // Burst limit: contar imágenes en el mismo bucket (chat_id, role, minuto).
  // Subido de 3 → 10 para chats normales del negocio donde mandan
  // 6+ imágenes seguidas (cotizaciones con varios productos, fotos de
  // ventana, comprobantes, etc.). 10 sigue siendo defensa contra spam.
  if (msg.type === 'image' && typeof msg.timestamp === 'number') {
    const minute = Math.floor(msg.timestamp / 60);
    const role = msg.is_owner ? 'yo' : 'cl';
    let burstCount = 0;
    const idx = store.index('by_chat');
    const cursor = idx.openCursor(IDBKeyRange.only(msg.chat_id));
    await new Promise(res => {
      cursor.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { res(); return; }
        const v = cur.value;
        if (v.id !== msg.id && v.type === 'image' && typeof v.timestamp === 'number') {
          const vMinute = Math.floor(v.timestamp / 60);
          const vRole   = v.is_owner ? 'yo' : 'cl';
          if (vMinute === minute && vRole === role) burstCount++;
        }
        cur.continue();
      };
      cursor.onerror = () => res();
    });
    if (burstCount >= 10) {
      return { allow: false, reason: 'burst_limit_10' };
    }
  }
  return { allow: true, reason: null };
}

async function saveMessages(batch) {
  if (!batch?.length) return { saved: 0, mediaQueued: 0, mediaSkipped: 0 };
  let saved = 0, mediaQueued = 0, mediaSkipped = 0;

  const ia = await getIAState();
  const bloqueados = await getBloqueadosCache();

  const db = await openDB();
  try {
    const t = db.transaction(['messages', 'pending_queue', 'processing_state'], 'readwrite');
    const sMsg = t.objectStore('messages');
    const sQueue = t.objectStore('pending_queue');
    const sState = t.objectStore('processing_state');

    for (const msg of batch) {
      try {
        // Asignar processing_state inicial. Reglas:
        //   - media: 'media_pending' hasta que se autorice IA
        //   - texto/chat sin descifrar (decryption_status !== success): 'pending_decryption'
        //     (NO mandar a Supabase un mensaje vacío, esperar el plaintext)
        //   - texto descifrado o tipos sin texto (call/sticker/etc.): 'ready_to_sync'
        //
        // Si el mensaje YA estaba en BD con state 'pending_decryption' y ahora
        // llega update con texto descifrado (decryption_status='success'),
        // promovemos a 'ready_to_sync'.
        const requiresText = msg.type === 'chat' || msg.type === 'text' || msg.type === 'extendedText';
        const hasText      = !!msg.text;
        const decOk        = msg.decryption_status === 'success';

        const existing = await reqAsync(sMsg.get(msg.id));
        const prevState = existing?.processing_state;

        if (msg.media) {
          msg.processing_state = msg.processing_state || prevState || 'media_pending';
        } else if (msg.is_owner) {
          // OUTGOING (vos lo escribiste): no hay nada que esperar a descifrar
          // de la contraparte. Siempre ready_to_sync — el evento del mensaje
          // saliente llega a Supabase de inmediato y los agentes (Junior,
          // Checklist) saben que respondiste. Si el texto vino vacío porque
          // la cache no tenía el plaintext y row.body tampoco, llega como
          // evento sin texto — preferible perder el texto que perder el evento.
          msg.processing_state = 'ready_to_sync';
        } else if (requiresText && !decOk && !hasText) {
          msg.processing_state = 'pending_decryption';
        } else if (prevState === 'pending_decryption' && (decOk || hasText)) {
          // Promoción: estaba esperando descifrado, ahora llegó → ready
          msg.processing_state = 'ready_to_sync';
        } else {
          msg.processing_state = msg.processing_state || prevState || 'ready_to_sync';
        }
        await reqAsync(sMsg.put(msg));
        await reqAsync(sState.put({
          id:          msg.id,
          state:       msg.processing_state,
          attempts:    0,
          lastError:   null,
          updatedAt:   Date.now(),
        }));
        saved++;

        // Decidir si encolar para download/AI:
        //   - Reglas duras siempre aplican (status, sticker, forwarded, burst)
        //   - Además: chat debe estar en whitelist (procesamiento manual)
        //     o realtimeEnabled=true (procesamiento automático global)
        const enqueueDecision = await shouldEnqueueMedia(msg, sMsg);
        if (!enqueueDecision.allow) {
          // Anotar por qué saltamos (para debug y para mostrar en UI)
          msg.ai_skip_reason = enqueueDecision.reason;
          await reqAsync(sMsg.put(msg));
          mediaSkipped++;
          continue;
        }

        // Freno (Punto 3): chat bloqueado → nunca se procesa, ni con realtime ON.
        if (bloqueados.has(msg.chat_id)) continue;
        const isWhitelisted = chatIsWhitelisted(msg.chat_id, ia.whitelist);
        // Realtime procesa de ahora en adelante: los mensajes anteriores al
        // momento en que se prendió quedan para el "Procesar" manual.
        const margenTolerancia = 86400000; // 24 horas de margen para tolerar desincronización de reloj
        const isRealtimeMsg = ia.realtimeEnabled && (msg.timestamp_ms || 0) >= ((ia.realtimeSince || 0) - margenTolerancia);
        if (!isWhitelisted && !isRealtimeMsg) {
          // Chat no autorizado y realtime OFF (o mensaje viejo): NO encolar (el msg
          // queda media_pending, listo para cuando se clickee "Procesar" o se
          // prenda "Tiempo real").
          continue;
        }

        // OK: encolar download
        await reqAsync(sQueue.put({
          taskType: 'download_media',
          messageId: msg.id,
          attempts: 0,
          nextAt: Date.now(),
          createdAt: Date.now(),
        }));
        mediaQueued++;
      } catch (e) {
        console.warn('[WS-BG-V2] save msg falló:', msg.id, e.message);
      }
    }
    await new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  } finally {
    db.close();
  }
  return { saved, mediaQueued, mediaSkipped };
}

// ─── Descarga + descifrado de media ───────────────────────────────

function hkdf(keyBytes, info, length) {
  // chrome.crypto.subtle disponible en SW
  return crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HKDF' }, false, ['deriveBits']
  ).then(key => crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(32),    // 32 bytes de zeros
    info: new TextEncoder().encode(info),
  }, key, length * 8))
   .then(buf => new Uint8Array(buf));
}

async function pkcs7Unpad(u8) {
  if (u8.length === 0) throw new Error('pkcs7: vacío');
  const padLen = u8[u8.length - 1];
  if (padLen < 1 || padLen > 16) throw new Error(`pkcs7: pad ${padLen}`);
  return u8.slice(0, u8.length - padLen);
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function sha256B64(u8) {
  const h = await crypto.subtle.digest('SHA-256', u8);
  const arr = new Uint8Array(h);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

async function downloadAndDecryptMedia(msg) {
  const m = msg.media;
  if (!m?.media_key || !m?.direct_path) throw new Error('media sin key o path');
  const url = m.mms_url || `https://mmg.whatsapp.net${m.direct_path}&mms3=true`;

  // Verificar si la URL probablemente expiró (param oe=hex)
  const oeMatch = url.match(/[?&]oe=([0-9A-Fa-f]+)/);
  if (oeMatch) {
    const oe = parseInt(oeMatch[1], 16);
    const now = Math.floor(Date.now() / 1000);
    if (oe < now) {
      throw new Error('URL expirada (oe=' + new Date(oe * 1000).toISOString() + ')');
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const fileBytes = new Uint8Array(await res.arrayBuffer());
  if (fileBytes.length < 11) throw new Error('archivo muy corto');

  // Derivar keys
  const mediaKey = b64ToBytes(m.media_key);
  if (mediaKey.length !== 32) throw new Error('mediaKey size ' + mediaKey.length);
  const info = MEDIA_HKDF_INFO[msg.type] || MEDIA_HKDF_INFO.image;
  const expanded = await hkdf(mediaKey, info, 112);
  const iv = expanded.slice(0, 16);
  const cipherKey = expanded.slice(16, 48);
  const macKey = expanded.slice(48, 80);

  const ciphertext = fileBytes.slice(0, -10);
  const mac = fileBytes.slice(-10);

  // Verificar HMAC
  const macKeyImported = await crypto.subtle.importKey('raw', macKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const macInput = new Uint8Array(iv.length + ciphertext.length);
  macInput.set(iv, 0);
  macInput.set(ciphertext, iv.length);
  const expectedMacFull = new Uint8Array(await crypto.subtle.sign('HMAC', macKeyImported, macInput));
  const expectedMac = expectedMacFull.slice(0, 10);
  for (let i = 0; i < 10; i++) {
    if (expectedMac[i] !== mac[i]) throw new Error('HMAC no coincide');
  }

  // Descifrar AES-256-CBC.
  // IMPORTANTE: Web Crypto AES-CBC ya quita PKCS7 padding automáticamente
  // (a diferencia de Node con setAutoPadding(false) donde hay que quitarlo
  // manualmente). El POC paso 5 corrió en Node con autoPadding=false. Aquí
  // en el SW, NO debemos llamar pkcs7Unpad o tirará "pad inválido".
  const cipherKeyImported = await crypto.subtle.importKey('raw', cipherKey, { name: 'AES-CBC', length: 256 }, false, ['decrypt']);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cipherKeyImported, ciphertext));

  // Verificar filehash si existe
  if (m.file_hash) {
    const hash = await sha256B64(plaintext);
    if (hash !== m.file_hash) {
      console.warn(`[WS-BG-V2] filehash mismatch para ${msg.id}: esperado=${m.file_hash} obtenido=${hash}`);
    }
  }

  // Calcular SHA-256 hex (clave de cache)
  const hashHexBuf = await crypto.subtle.digest('SHA-256', plaintext);
  const hashHex = Array.from(new Uint8Array(hashHexBuf)).map(b => b.toString(16).padStart(2, '0')).join('');

  return { bytes: plaintext, sha256: hashHex, mimetype: m.mimetype };
}

// ─── Persistir blob descargado ────────────────────────────────────

async function saveMediaBlob(sha256, bytes, mimetype) {
  return tx('media_blobs', 'readwrite', async store => {
    const existing = await reqAsync(store.get(sha256));
    if (existing) {
      existing.refCount = (existing.refCount || 1) + 1;
      existing.lastAccess = Date.now();
      return reqAsync(store.put(existing));
    }
    return reqAsync(store.put({
      sha256,
      bytes,                     // Uint8Array — IndexedDB lo acepta como BLOB-like
      mimetype,
      refCount: 1,
      createdAt: Date.now(),
      lastAccess: Date.now(),
    }));
  });
}

async function loadMediaBlob(sha256) {
  return tx('media_blobs', 'readonly', async store => reqAsync(store.get(sha256)));
}

// ─── Pipeline IA: descripción/transcripción ───────────────────────

async function whisperTranscribe(bytes, mimetype) {
  const { openaiKey } = await getSettings();
  if (!openaiKey) throw new Error('openaiKey vacío');
  const blob = new Blob([bytes], { type: mimetype || 'audio/ogg' });
  const form = new FormData();
  form.append('file', blob, 'audio.ogg');
  form.append('model', 'whisper-1');
  form.append('language', 'es');
  const res = await fetch(WHISPER_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  const json = await res.json();
  if (!res.ok) throw new Error('Whisper HTTP ' + res.status + ': ' + JSON.stringify(json).slice(0, 200));
  return json.text || '';
}

async function visionDescribe(bytes, mimetype) {
  const { openaiKey } = await getSettings();
  if (!openaiKey) throw new Error('openaiKey vacío');
  // bytes a base64
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin);
  const dataUrl = `data:${mimetype || 'image/jpeg'};base64,${b64}`;
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
  if (!res.ok) throw new Error('Vision HTTP ' + res.status + ': ' + JSON.stringify(json).slice(0, 200));
  return json.choices?.[0]?.message?.content?.trim() || '';
}

function extractTextFromPdf(bytes) {
  try {
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const rawStr = decoder.decode(bytes);
    
    // Limitar la extracción de texto a las primeras 2 páginas del PDF.
    // Buscamos el marcador de la 3ra página ("/Type /Page" o "/Type/Page") y recortamos allí.
    const pageMarkerRegex = /\/Type\s*\/Page\b/gi;
    let pageCount = 0;
    let limitIndex = -1;
    let match;
    while ((match = pageMarkerRegex.exec(rawStr)) !== null) {
      pageCount++;
      if (pageCount === 3) {
        limitIndex = match.index;
        break;
      }
    }
    
    const strToParse = limitIndex !== -1 ? rawStr.slice(0, limitIndex) : rawStr;
    if (limitIndex !== -1) {
      console.log('[VPG-BG-V2] PDF tiene >= 3 páginas. Recortando extracción al inicio de la página 3.');
    }
    
    // Buscar todas las cadenas de texto dentro de paréntesis en el PDF recortado
    const matches = strToParse.match(/\(([^)]+)\)/g) || [];
    const strings = matches
      .map(m => m.slice(1, -1).replace(/\\([()])/g, '$1')) // Quitar paréntesis externos y escapar caracteres
      .filter(s => s.length >= 2 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(s)); // Quedarse con texto legible/imprimible
      
    if (strings.length > 5) {
      return strings.join(' ').slice(0, 10000);
    }
    
    // Fallback: buscar palabras ASCII legibles en el binario (útil para PDFs no comprimidos)
    const words = strToParse.match(/[a-zA-Z0-9áéíóúÁÉÍÓÚñÑüÜ\s\-\.\,\:\$\%]{4,}/g) || [];
    const cleanedWords = words
      .map(w => w.trim())
      .filter(w => w.length >= 4 && !/^[a-zA-Z0-9]{15,}$/.test(w)); // Ignorar cadenas largas tipo hash/hexadecimal
      
    if (cleanedWords.length > 10) {
      return cleanedWords.join(' ').slice(0, 10000);
    }
  } catch (err) {
    console.warn('[VPG-BG-V2] extractTextFromPdf error:', err);
  }
  return '';
}

async function pdfSummarize(bytes, fileName) {
  const { openaiKey } = await getSettings();
  if (!openaiKey) throw new Error('openaiKey vacío');

  // Extraer texto plano nativamente para evitar type: 'file' no soportado por OpenAI Chat
  const extractedText = extractTextFromPdf(bytes);
  let promptContent = PDF_PROMPT;
  if (fileName) promptContent += `\nArchivo: ${fileName}`;

  if (extractedText.trim().length > 10) {
    promptContent += `\n\n[TEXTO EXTRAÍDO DEL DOCUMENTO PDF]:\n${extractedText}`;
  } else {
    promptContent += `\n\n[NOTA]: No se pudo extraer el texto directo del PDF (podría ser un PDF escaneado como imagen o comprimido). Si el nombre del archivo sugiere qué tipo de cotización o documento es, descríbelo según eso o indícalo amablemente.`;
  }

  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: promptContent,
      }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('PDF HTTP ' + res.status + ': ' + JSON.stringify(json).slice(0, 200));
  return json.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Procesador IA con cache por SHA-256 ──────────────────────────

async function processMediaWithAI(msg) {
  const m = msg.media;
  if (!m?.sha256) throw new Error('media sin sha256 (descarga primero)');

  // Cache check
  const cached = await tx('media_processed', 'readonly', s => reqAsync(s.get(m.sha256)));
  if (cached?.text) {
    console.log(`[WS-BG-V2] IA cache HIT ${m.sha256.slice(0, 8)} (${cached.kind})`);
    return cached;
  }

  // Cargar bytes
  const blob = await loadMediaBlob(m.sha256);
  if (!blob?.bytes) throw new Error('blob no en BD');
  const bytes = blob.bytes instanceof Uint8Array ? blob.bytes : new Uint8Array(blob.bytes);

  let kind, text;
  if (msg.type === 'audio' || msg.type === 'ptt') {
    kind = 'whisper';
    text = await whisperTranscribe(bytes, m.mimetype);
  } else if (msg.type === 'image' || msg.type === 'sticker') {
    kind = 'vision';
    text = await visionDescribe(bytes, m.mimetype);
  } else if (msg.type === 'document' && (m.mimetype || '').includes('pdf')) {
    kind = 'pdf';
    text = await pdfSummarize(bytes, m.file_name);
  } else {
    return { sha256: m.sha256, kind: 'unsupported', text: null };
  }

  const entry = { sha256: m.sha256, kind, text, processedAt: Date.now() };
  await tx('media_processed', 'readwrite', s => reqAsync(s.put(entry)));
  console.log(`[WS-BG-V2] IA ${kind} ✓ ${m.sha256.slice(0, 8)} → "${(text || '').slice(0, 60)}"`);
  return entry;
}

// ─── Cola de tareas: drain con concurrencia controlada ────────────

let downloadInFlight = 0;
let aiInFlight = 0;
let drainScheduled = false;

async function drainQueue() {
  if (drainScheduled) return;
  drainScheduled = true;
  try {
    const tasks = await tx('pending_queue', 'readonly', async s => {
      const idx = s.index('by_nextAt');
      const range = IDBKeyRange.upperBound(Date.now());
      const out = [];
      const cursor = idx.openCursor(range);
      await new Promise(res => {
        cursor.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur || out.length >= 20) { res(); return; }
          out.push(cur.value);
          cur.continue();
        };
        cursor.onerror = () => res();
      });
      return out;
    });

    const leasedTasks = [];
    if (tasks.length > 0) {
      await tx('pending_queue', 'readwrite', async s => {
        for (const task of tasks) {
          const downloadsCurrentlyActive = downloadInFlight + leasedTasks.filter(t => t.taskType === 'download_media').length;
          const aiCurrentlyActive = aiInFlight + leasedTasks.filter(t => t.taskType === 'ai_process').length;
          
          const canDownload = task.taskType === 'download_media' && downloadsCurrentlyActive < MAX_DOWNLOAD_CONCURRENCY;
          const canAI = task.taskType === 'ai_process' && aiCurrentlyActive < MAX_AI_CONCURRENCY;
          
          if (canDownload || canAI) {
            // Lease de la tarea por 2 minutos para evitar ejecuciones duplicadas en paralelo (race condition)
            task.nextAt = Date.now() + 120000;
            await reqAsync(s.put(task));
            leasedTasks.push(task);
          }
        }
      });
    }

    for (const task of leasedTasks) {
      if (task.taskType === 'download_media') {
        downloadInFlight++;
        runDownloadTask(task).finally(() => { downloadInFlight--; setTimeout(drainQueue, 50); });
      } else if (task.taskType === 'ai_process') {
        aiInFlight++;
        runAITask(task).finally(() => { aiInFlight--; setTimeout(drainQueue, 50); });
      }
    }
  } finally {
    drainScheduled = false;
  }
}

async function removeTask(qid) {
  return tx('pending_queue', 'readwrite', s => reqAsync(s.delete(qid)));
}

async function rescheduleTask(task, errorMsg) {
  task.attempts = (task.attempts || 0) + 1;
  task.lastError = errorMsg.slice(0, 200);
  if (task.attempts >= MAX_ATTEMPTS) {
    console.warn(`[WS-BG-V2] task ${task.taskType} ${task.messageId} dado por vencido tras ${task.attempts} intentos`);
    return removeTask(task.qid);
  }
  task.nextAt = Date.now() + RETRY_DELAY_MS_BASE * Math.pow(2, task.attempts);
  await tx('pending_queue', 'readwrite', s => reqAsync(s.put(task)));
}

async function runDownloadTask(task) {
  let msg;
  try {
    msg = await tx('messages', 'readonly', s => reqAsync(s.get(task.messageId)));
    if (!msg) throw new Error('msg no en BD');
    let result;
    try {
      result = await downloadAndDecryptMedia(msg);
    } catch (downloadErr) {
      // URL caducada o HTTP error → intentar refresh via API interna de WA Web
      const isExpiredOrHttp = /expirada|HTTP \d|HMAC/i.test(downloadErr.message);
      if (!isExpiredOrHttp) throw downloadErr;
      console.log(`[WS-BG-V2] download falló ${task.messageId} (${downloadErr.message}) — intentando refresh via WA Web…`);
      result = await refreshMediaViaContent(msg);
    }
    msg.media.sha256 = result.sha256;
    msg.media.download_status = 'downloaded';
    await saveMediaBlob(result.sha256, result.bytes, result.mimetype);
    await tx('messages', 'readwrite', s => reqAsync(s.put(msg)));

    // Encolar tarea de IA
    await tx('pending_queue', 'readwrite', s => reqAsync(s.put({
      taskType: 'ai_process',
      messageId: msg.id,
      attempts: 0,
      nextAt: Date.now(),
      createdAt: Date.now(),
    })));
    await removeTask(task.qid);
    console.log(`[WS-BG-V2] download ✓ ${msg.id} sha256=${result.sha256.slice(0, 8)} size=${result.bytes.length}`);
  } catch (e) {
    console.warn(`[WS-BG-V2] download falló ${task.messageId}: ${e.message}`);
    if (msg && msg.media) {
      const isUnrecoverable = e.message.includes('UNRECOVERABLE');
      msg.media.download_status = isUnrecoverable ? 'lost'
        : e.message.startsWith('URL expirada') ? 'expired' : 'failed';
      // Para UNRECOVERABLE: NO reintentar, marcar ai_skip_reason y promover a
      // ready_to_sync para que el Visor lo reciba con su placeholder
      // "no recuperable" en vez de quedar en media_pending eternamente.
      if (isUnrecoverable) {
        msg.ai_skip_reason = 'media_lost';
        msg.processing_state = 'ready_to_sync';
        await tx('messages', 'readwrite', s => reqAsync(s.put(msg)));
        await tx('processing_state', 'readwrite', s => reqAsync(s.put({
          id: msg.id, state: 'ready_to_sync', attempts: 0, lastError: null, updatedAt: Date.now(),
        })));
        await removeTask(task.qid);
        if (typeof syncToVisorPG === 'function') syncToVisorPG();
        return;
      }
      await tx('messages', 'readwrite', s => reqAsync(s.put(msg)));
    }
    await rescheduleTask(task, e.message);
  }
}

// Pide a content.v2 (que pasa a patch.v2 en MAIN) que use Store.Msg.downloadMedia()
// para obtener bytes en claro. Útil cuando la URL del CDN expiró (~17d).
// Devuelve el mismo shape que downloadAndDecryptMedia: { bytes, sha256, mimetype }.
async function refreshMediaViaContent(msg) {
  const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (!tabs.length) throw new Error('no hay tab WA Web abierta para refresh');
  const reply = await chrome.tabs.sendMessage(tabs[0].id, {
    type: 'V2_REFRESH_MEDIA',
    messageId: msg.id,
  });
  if (!reply?.ok) throw new Error('refresh failed: ' + (reply?.error || 'sin respuesta'));
  const bytes = reply.bytes instanceof Uint8Array ? reply.bytes : new Uint8Array(reply.bytes);
  const hashHexBuf = await crypto.subtle.digest('SHA-256', bytes);
  const hashHex = Array.from(new Uint8Array(hashHexBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { bytes, sha256: hashHex, mimetype: reply.mimetype || msg.media?.mimetype || null };
}

async function runAITask(task) {
  let msg;
  try {
    msg = await tx('messages', 'readonly', s => reqAsync(s.get(task.messageId)));
    if (!msg) throw new Error('msg no en BD');
    const entry = await processMediaWithAI(msg);
    if (entry?.text) {
      // Inyectar el texto IA al CanonicalMessage como `media.ai_text`
      msg.media.ai_text = entry.text;
      msg.media.ai_kind = entry.kind;
      msg.media.ai_status = 'processed';
      msg.processing_state = 'ready_to_sync';
      await tx('messages', 'readwrite', s => reqAsync(s.put(msg)));
      if (typeof syncToVisorPG === 'function') syncToVisorPG();
    } else {
      msg.media.ai_status = 'skipped';
      await tx('messages', 'readwrite', s => reqAsync(s.put(msg)));
    }
    await removeTask(task.qid);
  } catch (e) {
    console.warn(`[WS-BG-V2] AI falló ${task.messageId}: ${e.message}`);
    if (msg?.media) {
      msg.media.ai_status = 'failed';
      msg.media.ai_error = e.message.slice(0, 200);
      await tx('messages', 'readwrite', s => reqAsync(s.put(msg)));
    }
    await rescheduleTask(task, e.message);
  }
}

// ─── Mensajería con content.v2.js ──────────────────────────────────

// Handler unificado: mismo código maneja mensajes internos (content.v2.js)
// y externos (Visor en localhost vía externally_connectable).
function handleMessage(msg, sender, sendResponse) {
  if (msg?.type === 'V2_BATCH' && Array.isArray(msg.messages)) {
    saveMessages(msg.messages)
      .then(({ saved, mediaQueued, mediaSkipped }) => {
        if (saved > 0) {
          console.log(`[WS-BG-V2] batch saved=${saved} mediaQueued=${mediaQueued} mediaSkipped=${mediaSkipped}`);
          if (typeof syncToVisorPG === 'function') syncToVisorPG();
        }
        if (mediaQueued > 0) drainQueue();
        sendResponse({ ok: true, saved, mediaQueued, mediaSkipped });
      })
      .catch(e => {
        console.warn('[WS-BG-V2] batch error:', e.message);
        sendResponse({ ok: false, error: e.message });
      });
    return true;
  }

  if (msg?.type === 'V2_STATUS') {
    statusSnapshot().then(s => sendResponse(s));
    return true;
  }

  if (msg?.type === 'V2_DRAIN') {
    drainQueue();
    sendResponse({ ok: true });
    return false;
  }

  // ─── Controles desde el Visor ───────────────────────────────────

  if (msg?.type === 'V2_GET_IA_STATE') {
    getIAState().then(s => sendResponse(s));
    return true;
  }

  if (msg?.type === 'V2_TOGGLE_REALTIME') {
    setIAFlag('ws_v2_ia_realtime_enabled', !!msg.enabled)
      .then(() => sendResponse({ ok: true, enabled: !!msg.enabled }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_SET_DAILY_CAP') {
    const cap = Number(msg.usd) || 10;
    setIAFlag('ws_v2_ia_daily_cap_usd', cap)
      .then(() => sendResponse({ ok: true, cap }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_AUTHORIZE_CHAT' && msg.chatId) {
    getIAState().then(async (ia) => {
      if (!ia.whitelist.includes(msg.chatId)) {
        await setIAFlag('ws_v2_ia_chats_whitelist', [...ia.whitelist, msg.chatId]);
      }
      // Sync a Supabase para que el worker corra el Analista sobre este chat
      await syncChatAuthorizationToSupabase(msg.chatId, true);
      sendResponse({ ok: true, chatId: msg.chatId });
    }).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_PROCESS_CHAT' && msg.chatId) {
    processChatManually(msg.chatId)
      .then(async (r) => {
        await syncChatAuthorizationToSupabase(msg.chatId, true);
        sendResponse(r);
      })
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_REMOVE_CHAT_FROM_WHITELIST' && msg.chatId) {
    getIAState().then(async (ia) => {
      const next = ia.whitelist.filter(c => c !== msg.chatId);
      await setIAFlag('ws_v2_ia_chats_whitelist', next);
      await syncChatAuthorizationToSupabase(msg.chatId, false);
      sendResponse({ ok: true, whitelist: next });
    });
    return true;
  }

  if (msg?.type === 'V2_ESTIMATE_CHAT_COST' && msg.chatId) {
    estimateChatCost(msg.chatId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_LIST_CHATS') {
    listChatsWithStats()
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_CHATS_METADATA' && Array.isArray(msg.metadata)) {
    saveChatMetadata(msg.metadata)
      .then(saved => sendResponse({ ok: true, saved }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_FACTORY_RESET') {
    factoryReset()
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_DEBUG_CHAT' && msg.chatId) {
    debugChat(msg.chatId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_LIST_CHAT_MESSAGE_IDS' && msg.chatId) {
    listChatMessageIds(msg.chatId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_FORCE_SYNC') {
    syncBatchToSupabase()
      .then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  // F12 (2026-05-07): dump COMPLETO de mensajes de un chat para subirlos
  // directo a Supabase desde Node, sin pasar por el flujo viejo de IA.
  // Devuelve los mensajes raw del IndexedDB de la extensión, sin tocar estado.
  if (msg?.type === 'V2_DUMP_CHAT_MESSAGES' && msg.chatId) {
    (async () => {
      try {
        const db = await openDB();
        try {
          const t = db.transaction('messages', 'readonly');
          const idx = t.objectStore('messages').index('by_chat');
          const out = [];
          await new Promise(res => {
            idx.openCursor(IDBKeyRange.only(msg.chatId)).onsuccess = (e) => {
              const c = e.target.result; if (!c) { res(); return; }
              const m = c.value;
              // Solo lo necesario para alimentar agentes v3 (cero bytes binarios)
              out.push({
                id:                  m.id,
                chat_id:             m.chat_id,
                key:                 m.key || m.id,
                role:                m.is_from_me ? 'yo' : 'cliente',
                is_owner:            !!m.is_from_me,
                msg_type:            m.type || 'text',
                text_content:        m.text || m.ai_text || '',
                occurred_at:         m.t ? new Date(m.t * 1000).toISOString() : (m.captured_at ? new Date(m.captured_at).toISOString() : null),
                has_media:           !!m.media,
                processing_state:    m.processing_state || 'captured',
                decryption_status:   m.decryption_status || null,
              });
              c.continue();
            };
          });
          sendResponse({ ok: true, chatId: msg.chatId, messages: out });
        } finally { db.close(); }
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();
    return true;
  }

  if (msg?.type === 'V2_RETRY_FAILED_MEDIA' && msg.chatId) {
    retryFailedMedia(msg.chatId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_FORCE_BACKFILL') {
    const bursts = Math.max(1, Math.min(20, msg.bursts || 5));
    forceBackfill(bursts)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_DEBUG_STATE') {
    chrome.storage.local.get(null, (data) => {
      const v2 = {};
      for (const k of Object.keys(data)) if (k.startsWith('ws_v2')) v2[k] = data[k];
      sendResponse({ ok: true, v2 });
    });
    return true;
  }

  if (msg?.type === 'V2_RESET_BACKFILL_STATE') {
    chrome.storage.local.set({ ws_v2_state: { lastProcessedRowId: 0, lastBackfillRowId: 0, backfillExhausted: false, firstSweepDone: false } }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  // ─── Diagnóstico (SOLO LECTURA, CERO gasto API) ─────────────────
  if (msg?.type === 'V2_DIAGNOSE_CHAT' && msg.chatId) {
    diagnoseChat(msg.chatId)
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg?.type === 'V2_DIAGNOSE_GLOBAL') {
    diagnoseGlobal()
      .then(r => sendResponse(r))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
}

// ─── Diagnóstico — lee SW IDB y reporta el estado real de cada media ─
//
// Devuelve por cada msg: en qué etapa del pipeline está y por qué.
// CERO gasto API: solo lee storage local.

const PIPELINE_STAGES = {
  CAPTURED:        'captured',          // recién hidratado, sin acción
  TEXT_OK:         'text_ok',           // tipo texto, descifrado y sincronizado
  MEDIA_PENDING:   'media_pending_dl',  // media esperando descarga
  MEDIA_QUEUED:    'media_queued_dl',   // en pending_queue para descarga
  DOWNLOADED:      'media_downloaded',  // bytes en cache, esperando IA
  AI_QUEUED:       'media_queued_ai',   // en pending_queue para IA
  AI_PROCESSED:    'media_ai_done',     // ai_text presente, listo
  SYNCED:          'synced',            // sincronizado a Supabase con todo
  // Errores
  DL_FAILED:       'dl_failed',         // 5 intentos fallidos descarga
  DL_LOST:         'dl_lost_unrecov',   // mediaStage=ERROR_MISSING (CDN purgó)
  DL_EXPIRED:      'dl_expired',        // URL expirada, esperando refresh
  AI_SKIPPED:      'ai_skipped',        // regla dura: status/sticker/forwarded/burst
  // Misc
  NO_TEXT:         'no_text',           // call_log/protocol/system sin contenido
};

function classifyMessage(m, queuedMessageIds) {
  // Primero: tipos sin texto y sin media
  if (m.type === 'call_log' || m.type === 'protocol' || m.type === 'notification_template') {
    return PIPELINE_STAGES.NO_TEXT;
  }
  // Texto puro
  if (!m.media) {
    if (m.processing_state === 'synced') return PIPELINE_STAGES.SYNCED;
    return PIPELINE_STAGES.TEXT_OK;
  }
  // Media con skip rule
  if (m.ai_skip_reason && m.ai_skip_reason !== 'media_lost') {
    return PIPELINE_STAGES.AI_SKIPPED;
  }
  // Media: por download_status
  const dl = m.media.download_status;
  if (dl === 'lost') return PIPELINE_STAGES.DL_LOST;
  if (dl === 'failed') return PIPELINE_STAGES.DL_FAILED;
  if (dl === 'expired') return PIPELINE_STAGES.DL_EXPIRED;
  if (dl === 'downloaded') {
    // Por ai_status
    const ai = m.media.ai_status;
    if (ai === 'processed') return PIPELINE_STAGES.AI_PROCESSED;
    if (queuedMessageIds.has(m.id)) return PIPELINE_STAGES.AI_QUEUED;
    return PIPELINE_STAGES.DOWNLOADED;
  }
  // dl='pending' o sin status
  if (queuedMessageIds.has(m.id)) return PIPELINE_STAGES.MEDIA_QUEUED;
  return PIPELINE_STAGES.MEDIA_PENDING;
}

async function getQueuedMessageIds() {
  return tx('pending_queue', 'readonly', async store => {
    const out = new Set();
    const cursor = store.openCursor();
    await new Promise(res => {
      cursor.onsuccess = (e) => {
        const c = e.target.result; if (!c) { res(); return; }
        if (c.value.messageId) out.add(c.value.messageId);
        c.continue();
      };
      cursor.onerror = () => res();
    });
    return out;
  });
}

async function diagnoseChat(chatId) {
  const queued = await getQueuedMessageIds();
  const db = await openDB();
  try {
    const t = db.transaction('messages', 'readonly');
    const idx = t.objectStore('messages').index('by_chat');
    const stages = {};
    const byTypeStage = {};
    const errors = [];   // muestras de errores con razón
    let total = 0;
    await new Promise(res => {
      idx.openCursor(IDBKeyRange.only(chatId)).onsuccess = (e) => {
        const c = e.target.result; if (!c) { res(); return; }
        const m = c.value; total++;
        const stage = classifyMessage(m, queued);
        stages[stage] = (stages[stage] || 0) + 1;
        const k = (m.type || 'unknown') + '|' + stage;
        byTypeStage[k] = (byTypeStage[k] || 0) + 1;
        // Capturar muestras de errores
        if ((stage === PIPELINE_STAGES.DL_FAILED || stage === PIPELINE_STAGES.DL_LOST || stage === PIPELINE_STAGES.DL_EXPIRED) && errors.length < 8) {
          const ageD = m.media?.media_key_timestamp ? Math.floor((Date.now()/1000 - m.media.media_key_timestamp)/86400) : null;
          errors.push({ id: m.id?.slice(-20), type: m.type, stage, age_days: ageD, mimetype: m.media?.mimetype });
        }
        c.continue();
      };
    });
    return { ok: true, chatId, total, stages, byTypeStage, errorSamples: errors };
  } finally { db.close(); }
}

async function diagnoseGlobal() {
  const queued = await getQueuedMessageIds();
  const db = await openDB();
  try {
    const t = db.transaction('messages', 'readonly');
    const stages = {};
    const byChatTotals = new Map();
    let total = 0;
    await new Promise(res => {
      t.objectStore('messages').openCursor().onsuccess = (e) => {
        const c = e.target.result; if (!c) { res(); return; }
        const m = c.value; total++;
        const stage = classifyMessage(m, queued);
        stages[stage] = (stages[stage] || 0) + 1;
        if (m.chat_id) {
          let entry = byChatTotals.get(m.chat_id);
          if (!entry) { entry = { total: 0, stages: {} }; byChatTotals.set(m.chat_id, entry); }
          entry.total++;
          entry.stages[stage] = (entry.stages[stage] || 0) + 1;
        }
        c.continue();
      };
    });
    return { ok: true, total, stages, queuedTasksCount: queued.size, chatCount: byChatTotals.size };
  } finally { db.close(); }
}

async function forceBackfill(bursts) {
  let total = 0;
  for (let i = 0; i < bursts; i++) {
    await fireBackfillTicks();   // 8 ticks por burst = ~1600 msgs cada uno
    total += 8;
    await new Promise(r => setTimeout(r, 500));
  }
  return { ok: true, ticks_fired: total };
}

async function retryFailedMedia(chatId) {
  const db = await openDB();
  let queued = 0, promoted_lost = 0;
  try {
    const t = db.transaction(['messages', 'pending_queue', 'processing_state'], 'readwrite');
    const sMsg = t.objectStore('messages');
    const sQueue = t.objectStore('pending_queue');
    const sState = t.objectStore('processing_state');
    const idx = sMsg.index('by_chat');
    await new Promise(res => {
      idx.openCursor(IDBKeyRange.only(chatId)).onsuccess = async (e) => {
        const c = e.target.result; if (!c) { res(); return; }
        const m = c.value;
        if (!m.media) { c.continue(); return; }
        if (m.media.download_status === 'lost' && !m.ai_skip_reason) {
          // Promover lost a ready_to_sync con marca para que el Visor muestre placeholder
          m.ai_skip_reason = 'media_lost';
          m.processing_state = 'ready_to_sync';
          await reqAsync(sMsg.put(m));
          await reqAsync(sState.put({ id: m.id, state: 'ready_to_sync', attempts: 0, lastError: null, updatedAt: Date.now() }));
          promoted_lost++;
        } else if ((m.media.download_status === 'expired' || m.media.download_status === 'failed') && !m.ai_skip_reason) {
          m.media.download_status = 'pending';
          await reqAsync(sMsg.put(m));
          await reqAsync(sQueue.put({
            taskType: 'download_media',
            messageId: m.id,
            attempts: 0,
            nextAt: Date.now(),
            createdAt: Date.now(),
          }));
          queued++;
        }
        c.continue();
      };
    });
    await new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  } finally { db.close(); }
  drainQueue();
  return { ok: true, chatId, queued, promoted_lost };
}

async function listChatMessageIds(chatId) {
  const db = await openDB();
  try {
    const t = db.transaction('messages', 'readonly');
    const idx = t.objectStore('messages').index('by_chat');
    const ids = [];
    await new Promise(res => {
      idx.openCursor(IDBKeyRange.only(chatId)).onsuccess = (e) => {
        const c = e.target.result; if (!c) { res(); return; }
        const v = c.value;
        ids.push({
          id: v.id, type: v.type, state: v.processing_state,
          dec: v.decryption_status,
          dl_status: v.media?.download_status,
          ai_status: v.media?.ai_status,
          ai_skip: v.ai_skip_reason,
          has_mk: !!v.media?.media_key,
          has_dp: !!v.media?.direct_path,
          mks_age_d: v.media?.media_key_timestamp ? Math.floor((Date.now()/1000 - v.media.media_key_timestamp)/86400) : null,
        });
        c.continue();
      };
    });
    return { ok: true, chatId, count: ids.length, ids };
  } finally { db.close(); }
}

async function debugChat(chatId) {
  const db = await openDB();
  try {
    const t = db.transaction('messages', 'readonly');
    const idx = t.objectStore('messages').index('by_chat');
    const stats = { total: 0, byState: {}, byType: {}, decrypt: {}, samples: [] };
    await new Promise(res => {
      idx.openCursor(IDBKeyRange.only(chatId)).onsuccess = (e) => {
        const c = e.target.result; if (!c) { res(); return; }
        const m = c.value;
        stats.total++;
        stats.byState[m.processing_state || 'null'] = (stats.byState[m.processing_state || 'null'] || 0) + 1;
        stats.byType[m.type || 'null'] = (stats.byType[m.type || 'null'] || 0) + 1;
        stats.decrypt[m.decryption_status || 'null'] = (stats.decrypt[m.decryption_status || 'null'] || 0) + 1;
        if (stats.samples.length < 6 && m.text) {
          stats.samples.push({ id: m.id?.slice(-20), state: m.processing_state, type: m.type, text: m.text.slice(0, 80) });
        }
        c.continue();
      };
    });
    return { ok: true, chatId, ...stats };
  } finally { db.close(); }
}

// Factory reset: borra TODA la BD local de la extensión y limpia chrome.storage.
// Tras esto, content.v2.js (al recargar WA Web) empieza a capturar desde cero.
async function factoryReset() {
  // 1. Borrar IndexedDB de la extensión
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
    req.onblocked = () => {
      // Si está bloqueada, esperar un poco y forzar
      setTimeout(() => resolve(), 2000);
    };
  });

  // 2. Limpiar chrome.storage.local de keys V2 (preserva ws_settings con OpenAI/Supabase keys)
  const allKeys = await chrome.storage.local.get(null);
  const v2Keys = Object.keys(allKeys).filter(k => k.startsWith('ws_v2_'));
  if (v2Keys.length > 0) {
    await chrome.storage.local.remove(v2Keys);
  }

  console.log(`[WS-BG-V2] FACTORY RESET completado: BD borrada, ${v2Keys.length} keys removidas`);
  return { ok: true, removedKeys: v2Keys.length };
}

async function saveChatMetadata(metadataList) {
  if (!metadataList?.length) return 0;
  // CLEAR + PUT: cada sync de content.v2 trae el snapshot completo de los
  // chats VÁLIDOS (post-filtrado de huérfanos / archivados / duplicados).
  // Para que las entries borradas/filtradas no queden persistidas como
  // "fantasmas", limpiamos toda la store y guardamos solo lo nuevo.
  let saved = 0;
  const db = await openDB();
  try {
    const t = db.transaction('chat_metadata', 'readwrite');
    const s = t.objectStore('chat_metadata');
    await reqAsync(s.clear());
    for (const md of metadataList) {
      if (!md.jid) continue;
      try {
        await reqAsync(s.put({ ...md, updatedAt: Date.now() }));
        saved++;
      } catch (e) { /* silent */ }
    }
    await new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  } finally {
    db.close();
  }

  // Corrector universal de contactos: en cada refresh de metadata reconcilia
  // chats.titulo + personas.nombre + personas.telefono_e164 para cualquier
  // tipo de JID (@c.us / @lid). Definido en visor_pg_sync.js. Si falla, no
  // interrumpe el guardado de metadata.
  try {
    const { supabaseKey } = await getSettings();
    if (supabaseKey && typeof self.reconciliarContactos === 'function') {
      const r = await self.reconciliarContactos(metadataList, supabaseKey);
      const total = (r?.nombres || 0) + (r?.telefonos || 0);
      if (total > 0) console.log(`[WS-BG-V2] corrector contactos: ${r.nombres} nombre(s) + ${r.telefonos} teléfono(s)`);
    }
  } catch (e) {
    console.warn('[WS-BG-V2] corrector contactos falló:', e.message);
  }

  return saved;
}

chrome.runtime.onMessage.addListener(handleMessage);

// ─── Funciones de control para el Visor ───────────────────────────

async function processChatManually(chatId) {
  // 1. Agregar a whitelist
  const ia = await getIAState();
  if (!ia.whitelist.includes(chatId)) {
    await setIAFlag('ws_v2_ia_chats_whitelist', [...ia.whitelist, chatId]);
  }

  // 2. Encolar download para todos los mensajes media_pending de ese chat
  let queued = 0;
  const db = await openDB();
  try {
    const t = db.transaction(['messages', 'pending_queue'], 'readwrite');
    const sMsg = t.objectStore('messages');
    const sQueue = t.objectStore('pending_queue');
    const idx = sMsg.index('by_chat');
    const cursor = idx.openCursor(IDBKeyRange.only(chatId));
    await new Promise(res => {
      cursor.onsuccess = async (e) => {
        const cur = e.target.result;
        if (!cur) { res(); return; }
        const m = cur.value;
        if (m.processing_state === 'media_pending' && m.media?.media_key && !m.ai_skip_reason) {
          await reqAsync(sQueue.put({
            taskType: 'download_media',
            messageId: m.id,
            attempts: 0,
            nextAt: Date.now(),
            createdAt: Date.now(),
          }));
          queued++;
        }
        cur.continue();
      };
      cursor.onerror = () => res();
    });
    await new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); });
  } finally {
    db.close();
  }

  drainQueue();

  // 3. Pedir a content.v2 dos cosas:
  //    a) RE-HIDRATAR todos los msgs del chat con Camino A (descifra textos
  //       que quedaron como pending_decryption en capturas previas).
  //    b) Abrir el chat en WA Web (legacy / útil para descargar media).
  try {
    const md = await tx('chat_metadata', 'readonly', s => reqAsync(s.get(chatId)));
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (tabs.length) {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'V2_REHYDRATE_CHAT',
        jid:  chatId,
      }).catch(() => {});
      chrome.tabs.sendMessage(tabs[0].id, {
        type: 'V2_OPEN_AND_SCROLL_CHAT',
        jid:         chatId,
        name:        md?.name || null,
        phoneNumber: md?.phoneNumber || null,
      }).catch(() => {});
    }
  } catch (_) {}

  return { ok: true, chatId, queued };
}

async function estimateChatCost(chatId) {
  const counts = { image: 0, audio: 0, video: 0, document: 0, sticker: 0, text: 0, totalMessages: 0, skipped: 0 };
  let totalAudioSeconds = 0;
  const db = await openDB();
  try {
    const t = db.transaction('messages', 'readonly');
    const idx = t.objectStore('messages').index('by_chat');
    const cursor = idx.openCursor(IDBKeyRange.only(chatId));
    await new Promise(res => {
      cursor.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { res(); return; }
        const m = cur.value;
        counts.totalMessages++;
        // Contar para IA solo media no procesada y no excluida
        if (m.media && !m.ai_skip_reason && m.processing_state !== 'synced') {
          if (m.type === 'image')         counts.image++;
          else if (m.type === 'audio'   ||
                   m.type === 'ptt')      {
            counts.audio++;
            // WA guarda duration como string ("59"); coercionar a number
            // antes de sumar — sin esto JS concatena ("0"+"59"+"64"="05964").
            const d = Number(m.media.duration);
            totalAudioSeconds += Number.isFinite(d) && d > 0 ? d : 30;
          }
          else if (m.type === 'video')    counts.video++;
          else if (m.type === 'document') counts.document++;
          else if (m.type === 'sticker')  counts.sticker++;
        } else if (m.ai_skip_reason) {
          counts.skipped++;
        }
        // Contar textos para estimación DeepSeek
        if ((m.type === 'chat' || m.type === 'text') && !m.ai_skip_reason) {
          counts.text++;
        }
        cur.continue();
      };
      cursor.onerror = () => res();
    });
  } finally {
    db.close();
  }

  // Estimación USD:
  //   Vision gpt-4o-mini detail:'low' ≈ $0.0008/img
  //   Whisper                          ≈ $0.006/min
  //   Files PDF (con recorte 2 páginas)≈ $0.005/pdf
  //   DeepSeek Junior/Analista        ≈ $0.0003/análisis × N
  //     (N ≈ 1 análisis cada 15 mensajes nuevos, como mide la memoria del proyecto)
  const audioMinutes = totalAudioSeconds / 60;
  const deepseekAnalyses = Math.max(1, Math.ceil(counts.totalMessages / 15));
  const cost = {
    images:    counts.image    * 0.0008,
    audios:    audioMinutes * 0.006,
    videos:    counts.video    * 0.001,
    documents: counts.document * 0.005,
    deepseek:  deepseekAnalyses * 0.0003,
  };
  cost.total = cost.images + cost.audios + cost.videos + cost.documents + cost.deepseek;
  return {
    ok: true, chatId, counts,
    audioMinutes: Math.round(audioMinutes * 10) / 10,
    deepseekAnalyses,
    cost,
  };
}

async function listChatsWithStats() {
  // Estrategia V2: PARTIMOS DESDE chat_metadata (todos los chats que existen
  // en WA Web), no desde los mensajes capturados. Eso garantiza que cada
  // chat de WA Web aparece en el panel — aunque no tengamos mensajes
  // capturados aún. El orden lo dicta `chatT` (el timestamp que WA Web usa
  // internamente para ordenar la lista del sidebar).

  const stats = new Map();
  const db = await openDB();
  try {
    // 1. Crear una entry por cada chat conocido por WA Web
    const tMd = db.transaction('chat_metadata', 'readonly');
    const cursorMd = tMd.objectStore('chat_metadata').openCursor();
    await new Promise(res => {
      cursorMd.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { res(); return; }
        const md = cur.value;
        if (!md.jid || md.jid.includes('status@broadcast')) { cur.continue(); return; }
        stats.set(md.jid, {
          chat_id:        md.jid,
          name:           md.name || null,
          phoneNumber:    md.phoneNumber || null,
          profilePicUrl:  md.profilePicUrl || null,
          isAddressBook:  !!md.isAddressBook,
          isBusiness:     !!md.isBusiness,
          verifiedName:   md.verifiedName || null,
          isGroup:        !!md.isGroup,
          unreadCount:    md.unreadCount || 0,
          // chatTs: timestamp en MS que WA Web usa para ordenar.
          // chatT viene en segundos Unix.
          chatTs:         (md.chatT || 0) * 1000,
          total: 0, mediaPending: 0, mediaSkipped: 0, mediaProcessed: 0, lastTs: 0,
          byType: {
            text: 0, audio: 0, image: 0, video: 0, document: 0,
            sticker: 0, location: 0, call: 0, other: 0,
          },
        });
        cur.continue();
      };
      cursorMd.onerror = () => res();
    });

    // 2. Iterar mensajes capturados y enriquecer stats. Si el mensaje pertenece
    //    a un chat que NO está en metadata (filtrado como fantasma o aún no
    //    sincronizado), lo IGNORAMOS — solo mostramos chats que sobrevivieron
    //    al filtro de content.v2 (chats reales del sidebar de WA Web).
    const t = db.transaction('messages', 'readonly');
    const cursor = t.objectStore('messages').openCursor();
    await new Promise(res => {
      cursor.onsuccess = (e) => {
        const cur = e.target.result;
        if (!cur) { res(); return; }
        const m = cur.value;
        if (!m.chat_id || m.chat_id.includes('status@broadcast')) { cur.continue(); return; }
        let s = stats.get(m.chat_id);
        if (!s) {
          // Chat NO está en metadata → es un fantasma o un chat filtrado.
          // Lo ignoramos (no lo agregamos a stats).
          cur.continue();
          return;
        }
        s.total++;
        if (m.timestamp_ms && m.timestamp_ms > s.lastTs) s.lastTs = m.timestamp_ms;

        const tp = (m.type || 'other').toLowerCase();
        if (tp === 'chat' || tp === 'text')               s.byType.text++;
        else if (tp === 'audio' || tp === 'ptt')          s.byType.audio++;
        else if (tp === 'image')                          s.byType.image++;
        else if (tp === 'sticker')                        s.byType.sticker++;
        else if (tp === 'video')                          s.byType.video++;
        else if (tp === 'document')                       s.byType.document++;
        else if (tp === 'location')                       s.byType.location++;
        else if (tp === 'call_log' || tp === 'call')      s.byType.call++;
        else                                               s.byType.other++;

        if (m.media) {
          if (m.ai_skip_reason)                            s.mediaSkipped++;
          else if (m.media.ai_status === 'processed')      s.mediaProcessed++;
          else if (m.processing_state === 'media_pending') s.mediaPending++;
        }
        cur.continue();
      };
      cursor.onerror = () => res();
    });
  } finally {
    db.close();
  }

  const ia = await getIAState();
  const list = [...stats.values()].map(s => ({
    ...s,
    inWhitelist: ia.whitelist.includes(s.chat_id),
    // sortTs: usar chatTs (de WA) si existe, sino lastTs (de mensajes
    // capturados). Garantiza que TODO chat tenga un ts de orden.
    sortTs: s.chatTs || s.lastTs || 0,
  })).sort((a, b) => b.sortTs - a.sortTs);   // descendente: más reciente primero
  return { ok: true, chats: list, ia };
}

async function statusSnapshot() {
  const db = await openDB();
  try {
    const counts = {};
    for (const name of ['messages', 'media_blobs', 'media_processed', 'pending_queue']) {
      const t = db.transaction(name, 'readonly');
      counts[name] = await reqAsync(t.objectStore(name).count());
    }
    return counts;
  } finally {
    db.close();
  }
}

// ─── Sync a Supabase ──────────────────────────────────────────────
//
// Estrategia:
//   - Cada N segundos consultamos `messages` con processing_state = 'ready_to_sync'
//     (mensajes de texto puros, los de media esperan al pipeline IA primero).
//   - Agrupamos por chat_id, hacemos UPSERT a wa_raw_captures con shape v2.
//   - Tras éxito, actualizamos processing_state a 'synced'.
//
// Schema v2 de wa_raw_captures (existente con cols extra opcionales):
//   id (uuid), chat_id (text), contact (text), phone (text), is_group (bool),
//   date (text), messages (jsonb array de CanonicalMessage), captured_at, updated_at, processed.
//
// Como un chat puede tener miles de mensajes acumulados, escribimos UN ROW
// por chat (key contact+date) acumulando los messages array. Para preservar
// la idempotencia y evitar duplicados, usamos UPSERT por (chat_id+date).

let supabaseSyncing = false;

async function syncBatchToSupabase() {
  if (supabaseSyncing) return;
  supabaseSyncing = true;
  try {
    const { supabaseKey } = await getSettings();
    if (!supabaseKey) {
      console.warn('[WS-BG-V2] supabaseKey vacío, sync skip');
      return;
    }

    // 1. Tomar mensajes con state='ready_to_sync' DE CHATS AUTORIZADOS.
    // Sin autorización → captura local solamente, no viaja a Supabase.
    const ia = await getIAState();
    const whitelist = new Set(ia.whitelist || []);
    if (whitelist.size === 0) return;   // nada autorizado → sync skip

    const ready = await tx('messages', 'readonly', async store => {
      const idx = store.index('by_state');
      const out = [];
      const cursor = idx.openCursor(IDBKeyRange.only('ready_to_sync'));
      await new Promise(res => {
        cursor.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur || out.length >= SUPABASE_BATCH_MAX) { res(); return; }
          if (whitelist.has(cur.value.chat_id)) out.push(cur.value);
          cur.continue();
        };
        cursor.onerror = () => res();
      });
      return out;
    });

    if (!ready.length) return;

    // 1.5 Cargar chat_metadata para enriquecer contact con nombres humanos
    const metadataByJid = new Map();
    try {
      const meta = await tx('chat_metadata', 'readonly', async store => {
        const out = [];
        const cursor = store.openCursor();
        await new Promise(res => {
          cursor.onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur) { res(); return; }
            out.push(cur.value);
            cur.continue();
          };
          cursor.onerror = () => res();
        });
        return out;
      });
      for (const md of meta) metadataByJid.set(md.jid, md);
    } catch (_) {}

    // 2. Agrupar por chat_id solamente (UNA captura por chat, no por día).
    // El "date" lo derivamos del mensaje más reciente del chat para el campo date
    // de wa_raw_captures, pero la captura contiene TODOS los mensajes del chat.
    const groups = new Map();
    for (const m of ready) {
      const key = m.chat_id;
      let g = groups.get(key);
      if (!g) { g = { chat_id: m.chat_id, messages: [], maxTs: 0 }; groups.set(key, g); }
      g.messages.push(m);
      if ((m.timestamp_ms || 0) > g.maxTs) g.maxTs = m.timestamp_ms;
    }
    // Asignar date como el día del último mensaje del chat
    for (const g of groups.values()) {
      g.date = g.maxTs
        ? new Date(g.maxTs).toLocaleDateString('es-CO')
        : new Date().toLocaleDateString('es-CO');
    }

    // 3. Para cada grupo: leer mensajes existentes en BD local (para acumular),
    //    hacer DELETE+INSERT en Supabase, marcar como synced.
    let synced = 0, failed = 0;
    for (const g of groups.values()) {
      try {
        // Acumular: tomamos TODOS los mensajes del chat (independiente del día)
        // para que cada chat tenga UNA SOLA captura con todo su contenido.
        const allOfChat = await tx('messages', 'readonly', async store => {
          const idx = store.index('by_chat');
          const out = [];
          const cursor = idx.openCursor(IDBKeyRange.only(g.chat_id));
          await new Promise(res => {
            cursor.onsuccess = (e) => {
              const cur = e.target.result;
              if (!cur) { res(); return; }
              out.push(cur.value);
              cur.continue();
            };
            cursor.onerror = () => res();
          });
          return out;
        });

        // Sort cronológico ascendente
        allOfChat.sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0));

        // Derivar contact name: priorizar nombre humano de chat_metadata.
        // Si no hay, derivar del JID (legacy fallback).
        const md = metadataByJid.get(g.chat_id);
        const contact = md?.name
                     || md?.verifiedName
                     || md?.phoneNumber
                     || (g.chat_id || '').replace(/@.*$/, '')
                     || 'desconocido';
        const phone = md?.phoneNumber
                   || (g.chat_id?.endsWith('@c.us') ? '+' + g.chat_id.replace(/@c\.us$/, '') : null);
        const isGroup = !!md?.isGroup || g.chat_id?.endsWith('@g.us');

        const headers = {
          'Content-Type':  'application/json',
          'apikey':        supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
        };

        // DELETE existente SOLO por chat_id (una row por chat,
        // independiente de la fecha — el "date" del row varía entre syncs
        // según el último mensaje, y un filtro por (chat_id+date) deja
        // huérfanos cuando date cambia → duplicación).
        const filter = `chat_id=eq.${encodeURIComponent(g.chat_id)}`;
        await fetch(`${SUPABASE_URL}/rest/v1/wa_raw_captures?${filter}`, {
          method: 'DELETE',
          headers,
        });

        // INSERT con shape v2
        const nowIso = new Date().toISOString();
        const oldestTs = allOfChat[0]?.timestamp_ms || Date.now();
        const row = {
          chat_id:     g.chat_id,
          contact:     contact,
          phone:       phone,
          is_group:    !!isGroup,
          date:        g.date,
          messages:    allOfChat,           // CanonicalMessage[]
          captured_at: new Date(oldestTs).toISOString(),
          updated_at:  nowIso,
          processed:   false,
        };

        const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/wa_raw_captures`, {
          method:  'POST',
          headers: { ...headers, 'Prefer': 'return=minimal' },
          body:    JSON.stringify(row),
        });

        if (!insertRes.ok) {
          const errText = await insertRes.text();
          throw new Error(`Supabase HTTP ${insertRes.status}: ${errText.slice(0, 200)}`);
        }

        // Marcar como synced
        await tx('messages', 'readwrite', async store => {
          for (const m of g.messages) {
            m.processing_state = 'synced';
            await reqAsync(store.put(m));
          }
        });
        synced += g.messages.length;
      } catch (e) {
        failed += g.messages.length;
        console.warn(`[WS-BG-V2] sync chat=${g.chat_id} fallo: ${e.message}`);
      }
    }
    if (synced > 0 || failed > 0) {
      console.log(`[WS-BG-V2] Supabase sync: ${synced} OK, ${failed} fail (${groups.size} chats)`);
    }
  } finally {
    supabaseSyncing = false;
  }
}

// Marcar ready_to_sync para mensajes de texto y mensajes media tras AI processing.
// (Los ya están así por saveMessages para text-only; media los marca runAITask.)

// Visor PG v5.0+: sync AUTOMÁTICO ELIMINADO.
// Los chats se quedan en IndexedDB local. El Visor (módulo Captura) decide qué chat procesar
// con un click. Ese click llama V3_PROCESS_CHAT vía chrome.runtime.sendMessage externo.
//
// Solo queda la sincronización en TIEMPO REAL para chats YA procesados (cuando llega un mensaje
// nuevo a un chat que ya está en Supabase). Eso lo dispara el listener Realtime + chats.ia_autorizado.
// (Ese flujo se implementa en F1.11.5+, por ahora todo es manual via Visor → V3_PROCESS_CHAT.)

// ─── chrome.alarms keepalive ──────────────────────────────────────
// El SW se duerme tras ~30s sin actividad. chrome.alarms lo despierta.
// Aprovechamos cada wake-up para:
//   1. Drenar la cola de procesamiento (downloads + IA)
//   2. Sincronizar a Supabase los chats autorizados
//   3. Disparar tickets de backfill al content script de WA Web
//      → bypasea el throttling de setInterval cuando la pestaña está en background.
chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MIN });

const BACKFILL_TICK_NAME = 'ws_v2_backfill_ticks';
chrome.alarms.create(BACKFILL_TICK_NAME, { periodInMinutes: 0.5 });   // cada 30s

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    drainQueue();
    // Tiempo real (Punto 2): syncToVisorPG se auto-regula — con realtime ON
    // sube a Supabase los mensajes nuevos de todos los chats no bloqueados;
    // con realtime OFF es no-op (el procesamiento manual lo hace procesarChat).
    if (typeof syncToVisorPG === 'function') syncToVisorPG();
  }
  if (alarm.name === BACKFILL_TICK_NAME) {
    await fireBackfillTicks();
  }
});

// Envía RAFAGA de tickets al content script de WA Web. Cada tick dispara
// inmediatamente backfillCycle() en content.v2 — y como onMessage NO se
// throttla (a diferencia de setInterval), el backfill sigue avanzando
// incluso cuando WA Web está en background.
async function fireBackfillTicks() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    if (!tabs.length) return;
    const tabId = tabs[0].id;
    // 8 ticks con 200ms entre cada uno → ~8 lotes de backfill = 1600 mensajes/wake
    for (let i = 0; i < 8; i++) {
      try {
        await chrome.tabs.sendMessage(tabId, { type: 'V2_TICK_BACKFILL' });
      } catch (e) {
        // tab cerrada o content.v2 no respondió: cortar burst
        return;
      }
      await new Promise(r => setTimeout(r, 200));
    }
  } catch (e) {
    console.warn('[WS-BG-V2] fireBackfillTicks error:', e.message);
  }
}

// ─── Init ─────────────────────────────────────────────────────────
console.log('[WS-BG-V2] background.v2.js cargado · sync tiempo real vía alarm cada ' + ALARM_PERIOD_MIN + ' min');
drainQueue();
syncToVisorPG();
