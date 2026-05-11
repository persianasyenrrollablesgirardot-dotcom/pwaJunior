/* ═══════════════════════════════════════════════════════════════════
 * WhatsApp Captura Safra — Content V2
 *
 * ISOLATED world. Corre en cada pestaña web.whatsapp.com.
 *
 * Responsabilidades:
 *   1. TRIGGER — detectar mensajes nuevos:
 *      - MutationObserver sobre #main (instant, cuando DOM cambia)
 *      - Polling cada 1s a model-storage.message via rowId index (red de seguridad)
 *
 *   2. HYDRATION — para cada row nueva, construir CanonicalMessage:
 *      - Lee metadata estructurada del IndexedDB de WA Web
 *      - Si type requiere texto (chat / extendedText / caption):
 *          a) Hash SHA-256 del ciphertext de msgRowOpaqueData._data
 *          b) Busca en window.__wsCaptureV2.decryptCache (poblado por patch.v2.js)
 *          c) Parsea el plaintext con window.__wsProtobuf.parseMsgRowOpaqueData
 *      - Si type es media: no descarga aquí — solo guarda mediaKey + directPath
 *      - Construye CanonicalMessage con shape estándar (ver ARQUITECTURA_V2.md)
 *
 *   3. BACKFILL — al abrir un chat, scrollea programáticamente al inicio
 *      para forzar a WA Web a renderizar mensajes viejos → trigger decrypt
 *      → cache hit. Solo se ejecuta una vez por chat por sesión.
 *
 *   4. DISPATCH — manda batches de CanonicalMessage al background.v2.js
 *      vía chrome.runtime.sendMessage. Background los persiste en su IndexedDB
 *      y orquesta sync a Supabase + pipeline IA de media.
 *
 * Convención de identificadores:
 *   - chat_id ≡ jid del peer (en 1:1) o jid del grupo (en grupos)
 *   - message_id ≡ row.id nativo de WA Web (estable cross-sesión)
 *
 * No toca DOM para extraer datos. El DOM se usa solo como timbre (trigger).
 *
 * ════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';
  if (window.__wsContentV2Installed) return;
  window.__wsContentV2Installed = true;

  // ─── Configuración ────────────────────────────────────────────────
  const POLL_INTERVAL_MS  = 1000;
  const BATCH_MAX         = 50;       // máx mensajes por dispatch al background
  const BACKFILL_MAX_SCROLLS = 30;    // tope de scrolls programáticos al abrir chat
  const STATE_KEY         = 'ws_v2_state';   // chrome.storage.local key

  // Detección "nuestro número" — usado para distinguir is_owner.
  // Se refresca al iniciar leyendo de WA Web's IndexedDB (campo `me` o similar).
  let OUR_JID_USER = null;             // ej: '573202381865'

  // Estado en memoria de la sesión
  let lastProcessedRowId = 0;          // último rowId que procesamos (persistente)
  const seenMsgIds = new Set();        // dedup intra-sesión por id nativo
  const backfilledChats = new Set();   // chat_ids ya backfilleados en esta sesión

  // Pendientes de descifrado — mensajes que vimos en IndexedDB pero cuya
  // ciphertext aún no está en cache. Se reintentan cada RETRY_PENDING_INTERVAL_MS
  // hasta que el plaintext aparece (porque el usuario abrió ese chat o llegó
  // un mensaje que disparó el render).
  const pendingDecryption = new Map();  // rowId → row crudo de IndexedDB
  const RETRY_PENDING_INTERVAL_MS = 5000;
  const MAX_PENDING_AGE_MS = 24 * 60 * 60 * 1000;   // 24h máx en pending

  // ─── Apertura del IndexedDB de WA Web ─────────────────────────────
  // Cada operación abre y cierra su propia conexión. Manejamos onblocked
  // (cuando hay otra conexión bloqueando) y un timeout duro defensivo —
  // si el browser no resuelve en N ms, asumimos error y reintentamos.
  function openWaModelStorage(timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (v, isErr) => {
        if (settled) return;
        settled = true;
        if (isErr) reject(v); else resolve(v);
      };
      const req = indexedDB.open('model-storage');
      req.onsuccess  = () => settle(req.result, false);
      req.onerror    = () => settle(req.error || new Error('open error'), true);
      req.onblocked  = () => settle(new Error('blocked'), true);
      setTimeout(() => settle(new Error('open timeout ' + timeoutMs + 'ms'), true), timeoutMs);
    });
  }

  async function openWaModelStorageReady(retries = 8, delayMs = 1500) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
      try {
        const db = await openWaModelStorage();
        if (db.objectStoreNames.contains('message')) return db;
        db.close();
        lastErr = new Error('store "message" no encontrada');
      } catch (e) {
        lastErr = e;
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error('model-storage no disponible: ' + (lastErr?.message || 'unknown'));
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  function jidOf(field) {
    if (!field) return null;
    if (typeof field === 'string') return field;
    if (typeof field === 'object' && field._serialized) return field._serialized;
    return null;
  }

  function jidUser(jid) {
    if (!jid) return null;
    const m = String(jid).match(/^([^@]+)@/);
    return m ? m[1] : null;
  }

  // Determina si un mensaje fue enviado por NOSOTROS (el dueño del WA).
  // ★ Source of truth: el prefijo del `id` que pone WA — `true_` outgoing,
  // `false_` incoming. WA lo escribe directo en IndexedDB, es 100% confiable
  // y NO depende de detectar OUR_JID_USER (que con Multi-Device puede ser
  // múltiples jids: @c.us legacy + @lid).
  function isOwnerMessage(row) {
    if (typeof row.id === 'string') {
      if (row.id.startsWith('true_'))  return true;
      if (row.id.startsWith('false_')) return false;
    }
    // Fallback heurística por OUR_JID_USER (legacy)
    if (!OUR_JID_USER) return false;
    const fromUser = jidUser(jidOf(row.from));
    return fromUser === OUR_JID_USER;
  }

  // El chat_id es el jid del PEER (en 1:1) o del grupo.
  // ★ Source of truth: el segundo segmento del `id` — `<true|false>_<peer>_<key>`.
  // WA garantiza que el peer (jid del chat) está siempre ahí, sea outgoing o
  // incoming. Sin esto, los outgoing se guardaban con chat_id = nuestro propio
  // @lid (Multi-Device) y desaparecían del chat real.
  function chatIdOf(row) {
    if (typeof row.id === 'string') {
      const parts = row.id.split('_');
      if (parts.length >= 3) {
        const peer = parts[1];
        if (peer && !peer.includes(':')) return peer;
      }
    }
    // Fallback histórico (rows con id no estándar)
    const fromJid = jidOf(row.from);
    const toJid   = jidOf(row.to);
    if (!fromJid) return null;
    if (fromJid.startsWith('status@broadcast')) {
      const author = jidOf(row.author);
      return author || 'status@broadcast';
    }
    if (fromJid.endsWith('@g.us')) return fromJid;
    if (OUR_JID_USER) {
      const fromUser = jidUser(fromJid);
      if (fromUser === OUR_JID_USER) return toJid || fromJid;
      return fromJid;
    }
    return toJid || fromJid;
  }

  // ─── Bridge isolated → main world: descifrado directo opaqueData ──
  // Pide al patch.v2 (main world) que descifre un ciphertext usando la
  // key AES-CBC ya derivada por WA Web. Esto bypassa la dependencia del
  // scroll/render — descifra cualquier mensaje del IndexedDB siempre que
  // la pestaña WA Web esté abierta (porque ahí vive la key derivada).
  let _decryptReqId = 0;
  const _decryptPending = new Map();   // requestId → { resolve, reject, timer }

  window.addEventListener('wsv2:decrypt-opaque-reply', (event) => {
    const { requestId, ok, parsed, plaintext, error } = event.detail || {};
    const p = _decryptPending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    _decryptPending.delete(requestId);
    if (ok) p.resolve({ parsed, plaintext });
    else p.reject(new Error(error || 'decrypt failed'));
  });

  function decryptOpaqueDirect(ct, iv, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const requestId = ++_decryptReqId;
      const timer = setTimeout(() => {
        _decryptPending.delete(requestId);
        reject(new Error('decrypt timeout'));
      }, timeoutMs);
      _decryptPending.set(requestId, { resolve, reject, timer });
      window.dispatchEvent(new CustomEvent('wsv2:decrypt-opaque-request', {
        detail: { ct, iv, requestId },
      }));
    });
  }

  // ─── Bridge page → SW (testing only, sin auth porque corremos local) ─
  window.addEventListener('wsv2:bg-request', (e) => {
    const { requestId, payload } = e.detail || {};
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime.lastError?.message;
      window.dispatchEvent(new CustomEvent('wsv2:bg-reply', {
        detail: { requestId, ok: !err, response, error: err },
      }));
    });
  });

  // ─── SHA-256 hex ──────────────────────────────────────────────────
  async function sha256Hex(buf) {
    const data = buf instanceof ArrayBuffer
      ? buf
      : (buf?.buffer ? buf.buffer.slice(buf.byteOffset || 0, (buf.byteOffset || 0) + buf.byteLength) : buf);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const arr = new Uint8Array(hash);
    let s = '';
    for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
    return s;
  }

  // ─── Hydration: row de IndexedDB → CanonicalMessage ───────────────
  async function hydrate(row) {
    if (!row || !row.id) return null;

    const chatId = chatIdOf(row);
    if (!chatId) return null;

    const fromJid = jidOf(row.from);
    const toJid   = jidOf(row.to);
    const authorJid = jidOf(row.author);

    const msg = {
      id:           row.id,                    // identidad estable
      chat_id:      chatId,
      internal_id:  row.internalId || null,
      row_id:       row.rowId || null,
      timestamp:    typeof row.t === 'number' ? row.t : null,    // Unix segundos
      timestamp_ms: typeof row.t === 'number' ? row.t * 1000 : null,
      captured_at:  new Date().toISOString(),

      from:         fromJid,
      to:           toJid,
      author:       authorJid,
      is_owner:     isOwnerMessage(row),

      type:         String(row.type || 'unknown'),
      text:         null,
      caption:      null,
      file_name:    null,

      media:        null,
      quoted_message_id: null,
      quoted_sender_jid: null,
      mentions:          [],

      ack:          typeof row.ack === 'number' ? row.ack : null,
      edited_at:    null,
      deleted_at:   null,

      decryption_status: 'pending',  // 'pending' | 'success' | 'no_cache' | 'parse_failed' | 'no_text'
    };

    // ─ Texto: descifrar msgRowOpaqueData si tiene contenido cifrado ─
    // Camino A: descifrado + parseo en MAIN world (patch.v2 + parser_protobuf
    // viven juntos ahí). content.v2 corre en ISOLATED y NO ve __wsProtobuf,
    // así que el bridge devuelve el resultado YA parseado.
    const opaque = row.msgRowOpaqueData;
    if (opaque && opaque._data && opaque.iv) {
      const ct = opaque._data;
      try {
        const ctU8 = ct instanceof ArrayBuffer
          ? new Uint8Array(ct)
          : (ct instanceof Uint8Array ? ct : null);
        if (ctU8 && ctU8.byteLength > 0) {
          let bridgeResult = null;
          try { bridgeResult = await decryptOpaqueDirect(ctU8, opaque.iv, 2500); }
          catch (_) { /* descifrado falló — sin texto */ }

          if (bridgeResult?.parsed?.ok) {
            const parsed = bridgeResult.parsed;
            msg.decryption_status = 'success';
            if (parsed.text)            msg.text = parsed.text;
            if (parsed.caption)         msg.caption = parsed.caption;
            if (parsed.fileName)        msg.file_name = parsed.fileName;
            if (parsed.quotedMessageId) msg.quoted_message_id = parsed.quotedMessageId;
            if (parsed.quotedSenderJid) msg.quoted_sender_jid = parsed.quotedSenderJid;
            if (parsed.mentions?.length) msg.mentions = parsed.mentions;
            if (parsed.type && parsed.type !== msg.type && msg.type === 'chat') {
              msg.type = parsed.type;
            }
          } else if (bridgeResult?.parsed) {
            msg.decryption_status = 'parse_failed';
          } else if (bridgeResult) {
            msg.decryption_status = 'no_parser';   // descifró pero no había parser
          } else {
            msg.decryption_status = 'no_cache';
          }
        }
      } catch (e) {
        msg.decryption_status = 'error: ' + e.message.slice(0, 80);
      }
    } else {
      msg.decryption_status = 'no_text';
    }

    // ─ Media: si tiene mediaKey + directPath, guardamos metadata ────
    if (row.mediaKey && row.directPath) {
      // WA guarda duration como string ("59"). Forzamos a number — sin esto,
      // estimateChatCost concatena strings (5964 + "114" = "5964114") y
      // produce minutos infladísimos en el panel de costo.
      const dur = row.duration ?? row.seconds ?? null;
      const durNum = dur != null ? Number(dur) : null;
      msg.media = {
        sha256:      null,                                 // se llena post-descarga
        mimetype:    row.mimetype || null,
        size:        Number(row.size) || null,
        width:       Number(row.width) || null,
        height:      Number(row.height) || null,
        duration:    Number.isFinite(durNum) ? durNum : null,
        media_key:   row.mediaKey,                         // base64
        direct_path: row.directPath,
        mms_url:     row.deprecatedMms3Url || null,
        media_key_timestamp: row.mediaKeyTimestamp || null,
        file_hash:   row.filehash || null,
        enc_filehash: row.encFilehash || null,
        is_view_once: !!row.isViewOnce,
        // Estado de procesamiento IA
        download_status: 'pending',   // 'pending' | 'downloaded' | 'expired' | 'failed'
        ai_status:       'pending',   // 'pending' | 'processed' | 'skipped' | 'failed'
      };
    }

    return msg;
  }

  // ─── Detectar nuestro JID al iniciar ──────────────────────────────
  async function detectOurJid() {
    try {
      const db = await openWaModelStorageReady();
      // El campo `me` puede estar en distintas stores según versión.
      // Heurística: leer un user-prefs o sync-keys que tenga nuestro número.
      // Si no, leemos el primer chat 1:1 reciente y vemos cuál JID se repite como sender.
      const tx = db.transaction('message', 'readonly');
      const store = tx.objectStore('message');
      const cursor = store.openCursor(null, 'prev');
      const fromUserCount = new Map();
      await new Promise(res => {
        let n = 0;
        cursor.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur || n++ >= 200) { res(); return; }
          const v = cur.value;
          if (v.type === 'chat' && !String(jidOf(v.from) || '').startsWith('status@')) {
            const u = jidUser(jidOf(v.from));
            if (u) fromUserCount.set(u, (fromUserCount.get(u) || 0) + 1);
          }
          cur.continue();
        };
        cursor.onerror = () => res();
      });
      db.close();
      // El JID que más se repite como `from` en los últimos 200 msgs es probablemente nuestro
      let bestUser = null, bestCount = 0;
      for (const [u, c] of fromUserCount) {
        if (c > bestCount) { bestUser = u; bestCount = c; }
      }
      OUR_JID_USER = bestUser;
      console.log(`[WS-CONTENT-V2] our JID user detectado: ${bestUser} (${bestCount} msgs)`);
    } catch (e) {
      console.warn('[WS-CONTENT-V2] detectOurJid falló:', e.message);
    }
  }

  // ─── Restaurar estado persistente ─────────────────────────────────
  async function restoreState() {
    try {
      const r = await chrome.storage.local.get([STATE_KEY]);
      const s = r[STATE_KEY] || {};
      lastProcessedRowId = s.lastProcessedRowId || 0;
      lastBackfillRowId  = s.lastBackfillRowId  || 0;
      backfillExhausted  = !!s.backfillExhausted;
      // Si ya teníamos progreso anterior, saltamos la "primera pasada"
      // (que sería redundante) y arrancamos directo en modo forward + backfill.
      if (lastProcessedRowId > 0) {
        firstSweepDone = true;
        // Si no había lastBackfillRowId persistido, lo seteamos al rowId
        // procesado (= empezamos a hacer backfill hacia atrás desde ahí).
        if (lastBackfillRowId === 0) lastBackfillRowId = lastProcessedRowId;
      }
      console.log(`[WS-CONTENT-V2] restored lastProcessedRowId=${lastProcessedRowId} lastBackfillRowId=${lastBackfillRowId} firstSweepDone=${firstSweepDone} exhausted=${backfillExhausted}`);
    } catch (e) {
      console.warn('[WS-CONTENT-V2] restoreState falló:', e.message);
    }
  }

  async function persistState() {
    try {
      await chrome.storage.local.set({
        [STATE_KEY]: {
          lastProcessedRowId,
          lastBackfillRowId,
          backfillExhausted,
        },
      });
    } catch (e) { /* SW dormido o error transitorio — reintenta próximo ciclo */ }
  }

  // ─── Polling de IndexedDB: encontrar rows nuevas por rowId ────────
  // Estrategia:
  //   - Primera ejecución (lastProcessedRowId=0): traemos los 1000 MÁS RECIENTES
  //     desde el rowId max hacia atrás. Eso cubre la mayoría de chats activos.
  //   - Ciclos siguientes (forward): rowIds > lastProcessedRowId — mensajes nuevos.
  //   - BACKFILL progresivo (backward): paralelo al forward, vamos hacia atrás
  //     procesando 100 mensajes por ciclo a partir de lastBackfillRowId hasta
  //     consumir todo el histórico. Esto carga progresivamente los chats viejos.
  let firstSweepDone = false;
  let lastBackfillRowId = 0;
  let backfillExhausted = false;
  // Antes 1000 — pero WA IDB típicamente tiene 15-20k msgs distribuidos en
  // cientos de chats. Cortar en 1000 deja cientos de chats con 0 msgs aunque
  // WA Web SÍ los tenga localmente (los más viejos quedaban fuera del
  // FIRST_SWEEP). 100k cubre cualquier instalación real.
  const FIRST_SWEEP_SIZE = 100000;
  const BACKFILL_BATCH_SIZE = 500;

  async function findNewRows() {
    const db = await openWaModelStorageReady();
    try {
      const tx = db.transaction('message', 'readonly');
      const store = tx.objectStore('message');
      const idx = store.indexNames.contains('rowId') ? store.index('rowId') : null;

      const out = [];
      if (!firstSweepDone && lastProcessedRowId === 0) {
        // Primera pasada: 1000 más recientes (descendente)
        const cursor = idx ? idx.openCursor(null, 'prev') : store.openCursor(null, 'prev');
        await new Promise(res => {
          cursor.onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur || out.length >= FIRST_SWEEP_SIZE) { res(); return; }
            out.push(cur.value);
            cur.continue();
          };
          cursor.onerror = () => res();
        });
        // El rowId más alto = lastProcessedRowId (forward); el más bajo = lastBackfillRowId
        const maxRow = out.reduce((mx, r) => Math.max(mx, r.rowId || 0), 0);
        const minRow = out.reduce((mn, r) => Math.min(mn, r.rowId || Infinity), Infinity);
        if (maxRow > 0) lastProcessedRowId = maxRow;
        if (minRow > 0 && minRow !== Infinity) lastBackfillRowId = minRow;
        firstSweepDone = true;
        console.log(`[WS-CONTENT-V2] primera pasada: ${out.length} msgs (rowId ${minRow}..${maxRow})`);
      } else if (idx) {
        // Forward: rowId > lastProcessedRowId (mensajes nuevos)
        const lower = IDBKeyRange.lowerBound(lastProcessedRowId, true);
        const cursor = idx.openCursor(lower, 'next');
        await new Promise(res => {
          cursor.onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur || out.length >= BATCH_MAX) { res(); return; }
            out.push(cur.value);
            cur.continue();
          };
          cursor.onerror = () => res();
        });
      } else {
        // Fallback sin index: cursor desc filtrando lastProcessed
        const cursor = store.openCursor(null, 'prev');
        await new Promise(res => {
          cursor.onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur || out.length >= BATCH_MAX) { res(); return; }
            if ((cur.value.rowId || 0) > lastProcessedRowId) out.push(cur.value);
            cur.continue();
          };
          cursor.onerror = () => res();
        });
      }
      return out;
    } finally {
      db.close();
    }
  }

  // ─── Dispatch al background ───────────────────────────────────────
  function dispatchBatch(msgs) {
    if (!msgs.length) return;
    try {
      chrome.runtime.sendMessage({ type: 'V2_BATCH', messages: msgs }, () => {
        // Ignorar respuesta — el background los persiste async.
        // chrome.runtime.lastError puede aparecer si SW está dormido — ok.
      });
    } catch (e) {
      console.warn('[WS-CONTENT-V2] dispatchBatch falló:', e.message);
    }
  }

  // ─── Ciclo principal ──────────────────────────────────────────────
  let processing = false;

  async function processCycle() {
    if (processing) return;
    processing = true;
    try {
      const rows = await findNewRows();
      if (rows.length === 0) return;
      const canonicals = [];
      for (const row of rows) {
        if (seenMsgIds.has(row.id)) continue;
        seenMsgIds.add(row.id);
        const c = await hydrate(row);
        if (c) {
          canonicals.push(c);
          // Si quedó sin descifrar pero tiene ciphertext, lo encolamos para reintento.
          if (c.decryption_status === 'no_cache' && row.msgRowOpaqueData?._data) {
            pendingDecryption.set(row.rowId || row.id, { row, addedAt: Date.now() });
          }
        }
        if (typeof row.rowId === 'number' && row.rowId > lastProcessedRowId) {
          lastProcessedRowId = row.rowId;
        }
      }
      if (canonicals.length) {
        for (let i = 0; i < canonicals.length; i += BATCH_MAX) {
          dispatchBatch(canonicals.slice(i, i + BATCH_MAX));
        }
        await persistState();
        console.log(`[WS-CONTENT-V2] ${canonicals.length} mensajes procesados (último rowId=${lastProcessedRowId}, pending decryption=${pendingDecryption.size})`);
      }
    } catch (e) {
      console.warn('[WS-CONTENT-V2] processCycle error:', e.message);
    } finally {
      processing = false;
    }
  }

  // ─── Retry de mensajes pendientes de descifrado ───────────────────
  // Cada N segundos revisamos los msgs en pendingDecryption. Si el plaintext
  // ahora está en cache (porque WA Web lo descifró al rendear), re-hidratamos
  // y dispatchamos un UPDATE al background. Después de MAX_PENDING_AGE_MS
  // los descartamos.
  let retryProcessing = false;
  async function retryPendingCycle() {
    if (retryProcessing) return;
    if (pendingDecryption.size === 0) return;
    retryProcessing = true;
    try {
      const now = Date.now();
      const resolved = [];
      const expired = [];
      for (const [key, entry] of pendingDecryption) {
        if (now - entry.addedAt > MAX_PENDING_AGE_MS) {
          expired.push(key);
          continue;
        }
        const c = await hydrate(entry.row);
        if (c && c.decryption_status === 'success') {
          resolved.push(c);
          pendingDecryption.delete(key);
        }
      }
      for (const k of expired) pendingDecryption.delete(k);
      if (resolved.length) {
        for (let i = 0; i < resolved.length; i += BATCH_MAX) {
          dispatchBatch(resolved.slice(i, i + BATCH_MAX));
        }
        console.log(`[WS-CONTENT-V2] retry: ${resolved.length} mensajes descifrados (pending=${pendingDecryption.size})`);
      }
    } catch (e) {
      console.warn('[WS-CONTENT-V2] retryPendingCycle error:', e.message);
    } finally {
      retryProcessing = false;
    }
  }

  // ─── Recolección de metadata de chats (nombre, teléfono, foto) ────
  // El IndexedDB de WA Web tiene 3 stores que combinamos para enriquecer
  // cada chat con datos humanos:
  //   - `chat`: metadata del chat (unread, t, etc.)
  //   - `contact`: nombre, pushName, phoneNumber, isAddressBookContact
  //   - `profile-pic-thumb`: thumbnail de foto de perfil (URL o eurl)
  //
  // Llamamos esta función periódicamente y mandamos el mapa al SW.
  // Flag para hacer dump de diagnóstico SOLO la primera vez
  let metadataDebugDumped = false;

  async function gatherChatMetadata() {
    try {
      const db = await openWaModelStorageReady(3, 1500);
      try {
        const stores = ['chat', 'contact', 'profile-pic-thumb'];
        for (const s of stores) {
          if (!db.objectStoreNames.contains(s)) return;
        }
        const tx = db.transaction(stores, 'readonly');
        const sChat    = tx.objectStore('chat');
        const sContact = tx.objectStore('contact');
        const sPic     = tx.objectStore('profile-pic-thumb');

        const chats = await new Promise(res => {
          const r = sChat.getAll();
          r.onsuccess = () => res(r.result || []);
          r.onerror   = () => res([]);
        });

        // ─── Pre-pase: detectar duplicados de migración Multi-Device ────
        // WhatsApp Multi-Device crea pares: chat_lid (nuevo) + chat_cus (viejo).
        // El chat_lid tiene historyChatId apuntando al chat_cus.
        // WA Web muestra solo el chat_lid (el "actual") y oculta el viejo.
        // Replicamos esa lógica: si un chat es referenciado como historyChatId
        // de otro, lo descartamos (es el viejo reemplazado).
        const replacedJids = new Set();
        const lidToHistoryMap = new Map();   // lid_jid → cus_jid (para fallback de nombre)
        for (const c of chats) {
          const cId = typeof c.id === 'string' ? c.id : c.id?._serialized;
          if (!cId) continue;
          const hc = c.historyChatId;
          const hcId = typeof hc === 'string' ? hc : hc?._serialized;
          if (hcId && hcId !== cId) {
            replacedJids.add(hcId);
            lidToHistoryMap.set(cId, hcId);
          }
        }

        const metadata = [];
        let firstSampleLogged = false;

        for (const c of chats) {
          if (!c.id) continue;
          const jid = typeof c.id === 'string' ? c.id : c.id?._serialized;
          if (!jid || jid.includes('status@broadcast')) continue;

          // Filtros de chats fantasma:

          // 1. Chat reemplazado por su versión @lid (es el viejo)
          if (replacedJids.has(jid)) continue;

          // 2. Chat archivado — no lo muestra WA Web en sidebar principal
          if (c.archive === true) continue;

          // 3. Newsletters / canales — lidOriginType distinto de 'general' o 'pn'
          //    indica chat especial (newsletter, broadcast official, etc.)
          if (c.lidOriginType && c.lidOriginType !== 'general' && c.lidOriginType !== 'pn') {
            continue;
          }

          // 4. Chats sin actividad reciente: t == 0 indica chat creado pero
          //    nunca usado (común en huérfanos de migración).
          if (!c.t || c.t === 0) continue;

          let contact = null;
          try {
            contact = await new Promise(res => {
              const r = sContact.get(jid);
              r.onsuccess = () => res(r.result || null);
              r.onerror   = () => res(null);
            });
          } catch (_) {}

          // Si el contact del @lid no tiene name pero el chat tiene
          // historyChatId apuntando al @c.us viejo, buscamos el contact
          // del @c.us — ahí suele estar el nombre real guardado.
          const historyJid = lidToHistoryMap.get(jid);
          let historyContact = null;
          if (historyJid && (!contact?.name && !contact?.pushname)) {
            try {
              historyContact = await new Promise(res => {
                const r = sContact.get(historyJid);
                r.onsuccess = () => res(r.result || null);
                r.onerror   = () => res(null);
              });
            } catch (_) {}
          }

          // Foto: probar primero @lid, después @c.us (viejo) si no hay
          let pic = null;
          try {
            pic = await new Promise(res => {
              const r = sPic.get(jid);
              r.onsuccess = () => res(r.result || null);
              r.onerror   = () => res(null);
            });
          } catch (_) {}
          if (!pic?.eurl && historyJid) {
            try {
              pic = await new Promise(res => {
                const r = sPic.get(historyJid);
                r.onsuccess = () => res(r.result || null);
                r.onerror   = () => res(null);
              });
            } catch (_) {}
          }

          // DEBUG: la primera vez, dumpear el shape EXACTO de un contact y un chat real
          // para identificar los campos correctos (camelCase vs lowercase, etc).
          if (!metadataDebugDumped && !firstSampleLogged && contact) {
            firstSampleLogged = true;
            console.log('[WS-CONTENT-V2] 🔍 SAMPLE chat raw:', JSON.stringify(c, (k, v) => v instanceof ArrayBuffer ? '[ArrayBuffer]' : v).slice(0, 800));
            console.log('[WS-CONTENT-V2] 🔍 SAMPLE contact raw:', JSON.stringify(contact, (k, v) => v instanceof ArrayBuffer ? '[ArrayBuffer]' : v).slice(0, 800));
            console.log('[WS-CONTENT-V2] 🔍 SAMPLE profile-pic-thumb raw:', JSON.stringify(pic, (k, v) => v instanceof ArrayBuffer ? '[ArrayBuffer]' : v).slice(0, 400));
          }

          // Probar TODAS las variantes (WA Web cambió nombres entre versiones).
          // Primero el contact del @lid actual, después el del @c.us viejo
          // como fallback (el name suele estar en el viejo).
          const name = contact?.name
                    || contact?.formattedName
                    || contact?.verifiedName
                    || contact?.pushname
                    || contact?.pushName
                    || contact?.notify
                    || contact?.notifyName
                    || historyContact?.name
                    || historyContact?.formattedName
                    || historyContact?.pushname
                    || historyContact?.pushName
                    || c?.name
                    || null;

          // Bug clave detectado: WA Web guarda contact.phoneNumber como
          // OTRO jid '573...@c.us', no como teléfono. Hay que extraer el
          // número del jid si tiene esa forma.
          const rawPhone = contact?.phoneNumber || contact?.phone;
          let phoneNumber = null;
          if (typeof rawPhone === 'string') {
            if (rawPhone.endsWith('@c.us')) {
              phoneNumber = '+' + rawPhone.replace(/@c\.us$/, '');
            } else if (/^\+?\d{8,}$/.test(rawPhone)) {
              phoneNumber = rawPhone.startsWith('+') ? rawPhone : '+' + rawPhone;
            }
          }
          // Fallback: si jid del chat es @c.us, ese es el teléfono
          if (!phoneNumber && jid.endsWith('@c.us')) {
            phoneNumber = '+' + jid.replace(/@c\.us$/, '');
          }
          // Para chats con jid @lid pero contact con phoneNumber resuelto, ya
          // se llenó arriba. Para grupos no aplica teléfono.

          const profilePicUrl = pic?.eurl
                            || pic?.previewEurl
                            || pic?.img
                            || null;

          const isAddressBook = !!(contact?.isAddressBookContact || contact?.isMyContact);
          const isBusiness    = !!(contact?.isBusiness || contact?.verifiedName || contact?.businessProfile);
          const verifiedName  = contact?.verifiedName || null;

          metadata.push({
            jid,
            name,
            phoneNumber,
            profilePicUrl,
            isAddressBook,
            isBusiness,
            verifiedName,
            isGroup: jid.endsWith('@g.us'),
            unreadCount: c.unreadCount || 0,
            // Timestamp del CHAT según WA Web — usado para ordenar como WA.
            // Es Unix segundos (campo `t` del chat). Esto se actualiza cuando
            // WA recibe/envía un mensaje, así queda alineado al orden visual de WA Web.
            chatT: typeof c.t === 'number' ? c.t : 0,
            // Datos crudos para debug si hace falta más adelante
            _rawContactKeys: contact ? Object.keys(contact).slice(0, 30) : [],
          });
        }
        if (!metadataDebugDumped) {
          metadataDebugDumped = true;
          // Reportar campos que más se vieron — útil para futuros ajustes
          const fieldFreq = {};
          for (const m of metadata) {
            for (const k of (m._rawContactKeys || [])) fieldFreq[k] = (fieldFreq[k] || 0) + 1;
            delete m._rawContactKeys;
          }
          console.log('[WS-CONTENT-V2] 📊 Campos más comunes en contact store:', JSON.stringify(
            Object.entries(fieldFreq).sort((a, b) => b[1] - a[1]).slice(0, 25)
          ));
        } else {
          // En llamadas siguientes ya no necesitamos los rawKeys
          for (const m of metadata) delete m._rawContactKeys;
        }

        db.close();
        return metadata;
      } catch (e) {
        try { db.close(); } catch (_) {}
        throw e;
      }
    } catch (e) {
      console.warn('[WS-CONTENT-V2] gatherChatMetadata:', e.message);
      return null;
    }
  }

  async function syncChatMetadataToBackground() {
    const metadata = await gatherChatMetadata();
    if (!metadata || metadata.length === 0) return;
    try {
      chrome.runtime.sendMessage({ type: 'V2_CHATS_METADATA', metadata }, () => {});
    } catch (_) {}
  }

  // ─── Backfill progresivo del histórico ────────────────────────────
  // Va hacia atrás (rowId menor que lastBackfillRowId) capturando lotes
  // de BACKFILL_BATCH_SIZE mensajes hasta cubrir todo el histórico.
  // Ejecuta en paralelo al ciclo principal (forward).
  let backfilling = false;
  async function backfillCycle() {
    if (backfilling || backfillExhausted) return;
    if (!firstSweepDone || lastBackfillRowId <= 1) return;
    backfilling = true;
    try {
      const db = await openWaModelStorageReady(3, 1500);
      try {
        const tx = db.transaction('message', 'readonly');
        const store = tx.objectStore('message');
        const idx = store.indexNames.contains('rowId') ? store.index('rowId') : null;
        if (!idx) { backfillExhausted = true; return; }

        const out = [];
        const upper = IDBKeyRange.upperBound(lastBackfillRowId, true);
        const cursor = idx.openCursor(upper, 'prev');
        await new Promise(res => {
          cursor.onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur || out.length >= BACKFILL_BATCH_SIZE) { res(); return; }
            out.push(cur.value);
            cur.continue();
          };
          cursor.onerror = () => res();
        });

        if (out.length === 0) {
          backfillExhausted = true;
          console.log('[WS-CONTENT-V2] backfill completado — todo el histórico procesado');
          db.close();
          return;
        }

        const minRow = out.reduce((mn, r) => Math.min(mn, r.rowId || Infinity), Infinity);
        if (minRow !== Infinity) lastBackfillRowId = minRow;

        // Procesar igual que findNewRows: hidratar y dispatchar
        const canonicals = [];
        for (const row of out) {
          if (seenMsgIds.has(row.id)) continue;
          seenMsgIds.add(row.id);
          const c = await hydrate(row);
          if (c) canonicals.push(c);
        }
        db.close();

        if (canonicals.length) {
          for (let i = 0; i < canonicals.length; i += BATCH_MAX) {
            dispatchBatch(canonicals.slice(i, i + BATCH_MAX));
          }
          await persistState();
          console.log(`[WS-CONTENT-V2] backfill: ${canonicals.length} mensajes históricos (rowId hasta ${lastBackfillRowId})`);
        }
      } catch (e) {
        try { db.close(); } catch (_) {}
        throw e;
      }
    } catch (e) {
      console.warn('[WS-CONTENT-V2] backfillCycle error:', e.message);
    } finally {
      backfilling = false;
    }
  }

  // ─── Backfill: al abrir un chat, scrollear arriba para forzar render ─
  // Cuando el usuario abre un chat, WA Web solo descifra los mensajes que
  // están en viewport. Para tener TODOS los textos en cache, scrolleamos
  // programáticamente hasta el inicio del chat. Una sola vez por chat por
  // sesión (registramos en backfilledChats).
  let lastDetectedChatHeader = null;

  function detectChatChange() {
    try {
      const main = document.querySelector('#main');
      if (!main) return null;
      // Usamos el textContent del header como identificador "fuzzy" del chat actual.
      // No es perfecto pero alcanza para no re-backfillear el mismo chat.
      const h = main.querySelector('header');
      const sig = (h?.textContent || '').slice(0, 80);
      return sig || null;
    } catch (_) { return null; }
  }

  async function backfillCurrentChat() {
    const sig = detectChatChange();
    if (!sig || backfilledChats.has(sig)) return;
    backfilledChats.add(sig);
    console.log(`[WS-CONTENT-V2] backfill scroll para "${sig.slice(0, 40)}..."`);

    // Buscar el panel scrollable del chat
    const scrollable = (() => {
      const candidates = [
        document.querySelector('#main [role="application"]'),
        document.querySelector('#main .copyable-area'),
        ...document.querySelectorAll('#main div'),
      ].filter(Boolean);
      for (const el of candidates) {
        if (el.scrollHeight > el.clientHeight + 100) return el;
      }
      return null;
    })();
    if (!scrollable) return;

    // Scrollear arriba hasta que ya no se cargue nada nuevo o llegamos al top
    let lastTop = -1;
    for (let i = 0; i < BACKFILL_MAX_SCROLLS; i++) {
      scrollable.scrollBy(0, -1500);
      await new Promise(r => setTimeout(r, 600));
      if (scrollable.scrollTop === 0 && lastTop === 0) break;
      lastTop = scrollable.scrollTop;
    }
    console.log(`[WS-CONTENT-V2] backfill scroll completado para "${sig.slice(0, 40)}..."`);
  }

  // ─── Abrir y scrollear un chat para forzar descifrado del histórico ─
  // Cuando el usuario autoriza un chat desde el Visor, el SW dispara este
  // método. El content.v2 busca el chat en el sidebar por su jid (data-id),
  // hace click para abrirlo, espera, y scrollea arriba progresivamente
  // hasta el inicio del chat. WA Web descifra cada mensaje al renderizarlo
  // → nuestra cache (window.__wsCaptureV2.decryptCache) se llena → el
  // retryPendingCycle promueve los mensajes a ready_to_sync.
  async function openAndScrollChat(jid, name, phoneNumber) {
    // Estrategia: usar el input de búsqueda de WA Web para filtrar el chat.
    // Eso evita el problema de scroll virtual del sidebar. Tipiamos nombre o
    // teléfono, esperamos que WA filtre, click en el primer match.
    const phoneNorm = phoneNumber ? phoneNumber.replace(/[^0-9]/g, '') : null;
    const queries = [];
    if (name) queries.push(name);
    if (phoneNumber) queries.push(phoneNumber);
    if (phoneNorm) queries.push(phoneNorm);
    if (!queries.length) return { ok: false, error: 'sin name ni phoneNumber' };

    // El search es un <input type="text"> con role="textbox" y aria-label específico
    const searchInput = document.querySelector('input[role="textbox"]')
                     || document.querySelector('input[aria-label*="Buscar"]')
                     || document.querySelector('input[type="text"][placeholder*="Buscar"]');
    if (!searchInput) {
      console.warn('[WS-CONTENT-V2] openAndScrollChat: input de búsqueda no encontrado');
      return { ok: false, error: 'search input not found' };
    }

    // Helpers para tipear en un input nativo de React (necesita disparar
    // los eventos input/change correctamente para que React detecte el cambio)
    const setInputValue = (input, value) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    let foundRow = null;
    for (const query of queries) {
      searchInput.focus();
      setInputValue(searchInput, '');
      await new Promise(r => setTimeout(r, 200));
      setInputValue(searchInput, query);
      await new Promise(r => setTimeout(r, 1500));

      const rows = document.querySelectorAll('#pane-side [role="row"]');
      for (const r of rows) {
        const txt = (r.innerText || '').toLowerCase();
        if (name && txt.includes(name.toLowerCase())) { foundRow = r; break; }
        if (phoneNumber && txt.includes(phoneNumber)) { foundRow = r; break; }
        if (phoneNorm) {
          const txtDigits = txt.replace(/[^0-9]/g, '');
          if (txtDigits.includes(phoneNorm)) { foundRow = r; break; }
        }
      }
      if (foundRow) break;
    }
    if (!foundRow) {
      console.warn(`[WS-CONTENT-V2] openAndScrollChat: no se encontró ${jid} con queries [${queries.join(', ')}]`);
      try { setInputValue(searchInput, ''); } catch (_) {}
      return { ok: false, error: 'chat no encontrado vía búsqueda' };
    }
    const found = { ok: true, row: foundRow };

    // 2. Abrir el chat. El click sintético no es trusted en WA Business Web →
    // alternativa: ENTER en el search input abre el primer resultado filtrado.
    const cell = found.row.querySelector('[role="gridcell"]') || found.row;
    cell.scrollIntoView({ block: 'center' });

    // Intento A: ENTER en el search input (lo más confiable en WA Business)
    if (searchInput && document.activeElement === searchInput) {
      searchInput.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
      searchInput.dispatchEvent(new KeyboardEvent('keypress', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
      searchInput.dispatchEvent(new KeyboardEvent('keyup', {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
        bubbles: true, cancelable: true,
      }));
      console.log(`[WS-CONTENT-V2] openAndScrollChat: Enter enviado al search para ${jid}`);
    } else {
      // Intento B: click sintético en la fila (fallback)
      const rect = cell.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2, view: window };
      cell.dispatchEvent(new PointerEvent('pointerdown', opts));
      cell.dispatchEvent(new MouseEvent('mousedown', opts));
      cell.dispatchEvent(new PointerEvent('pointerup', opts));
      cell.dispatchEvent(new MouseEvent('mouseup', opts));
      cell.dispatchEvent(new MouseEvent('click', opts));
      console.log(`[WS-CONTENT-V2] openAndScrollChat: click sintético enviado para ${jid}`);
    }

    // 3. Esperar que #main monte el chat
    let mainReady = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const main = document.querySelector('#main');
      if (main && main.querySelectorAll('.message-in, .message-out').length > 0) {
        mainReady = true; break;
      }
    }
    if (!mainReady) return { ok: false, error: 'chat abrió pero no rendeó mensajes' };

    // 4. Marcar como backfilleado para que NO se vuelva a abrir automático
    backfilledChats.add(detectChatChange());

    // 5. Scrollear hacia arriba progresivamente para forzar render+descifrado
    // de todos los mensajes del chat. ~30 scrolls cubren chats grandes.
    const scrollable = (() => {
      const cands = [
        document.querySelector('#main [role="application"]'),
        document.querySelector('#main .copyable-area'),
        ...document.querySelectorAll('#main div'),
      ].filter(Boolean);
      for (const el of cands) if (el.scrollHeight > el.clientHeight + 100) return el;
      return null;
    })();
    if (!scrollable) return { ok: true, scrolled: 0, warning: 'no scrollable element' };

    // Scrollear arriba — más agresivo. Esperamos que scrollTop NO cambie
    // por 3 iteraciones consecutivas para considerar "llegamos al inicio".
    let scrolls = 0;
    let stableCount = 0;
    let lastTop = -1;
    for (let i = 0; i < 80; i++) {
      const beforeTop = scrollable.scrollTop;
      scrollable.scrollBy(0, -3000);
      await new Promise(r => setTimeout(r, 700));
      scrolls++;
      const afterTop = scrollable.scrollTop;
      if (afterTop === lastTop && afterTop === beforeTop) {
        stableCount++;
        if (stableCount >= 3) break;   // 3 iters sin cambio → llegamos al top
      } else {
        stableCount = 0;
      }
      lastTop = afterTop;
    }
    console.log(`[WS-CONTENT-V2] openAndScrollChat: ${scrolls} scrolls completados para ${jid}`);

    // 6. Esperar 4s extra para que la cache de descifrado se llene de los
    // mensajes recién renderizados (WA Web descifra async).
    await new Promise(r => setTimeout(r, 4000));

    // 7. Re-hidratar TODOS los mensajes de ese chat desde IndexedDB de WA.
    // Ahora la cache tiene texto descifrado → hydrate produce CanonicalMessage
    // CON texto. Los dispatch cambian el processing_state de pending_decryption
    // a ready_to_sync en saveMessages del SW.
    let rehydrated = 0;
    try {
      const db = await openWaModelStorageReady();
      try {
        const tx = db.transaction('message', 'readonly');
        const store = tx.objectStore('message');
        // Filtramos los mensajes del jid: el campo `to` o `from` apunta al chat
        const cursor = store.openCursor();
        const ofChat = [];
        await new Promise(res => {
          cursor.onsuccess = (e) => {
            const cur = e.target.result;
            if (!cur) { res(); return; }
            const v = cur.value;
            const fromJid = jidOf(v.from);
            const toJid   = jidOf(v.to);
            if (fromJid === jid || toJid === jid) ofChat.push(v);
            cur.continue();
          };
          cursor.onerror = () => res();
        });
        db.close();
        // Hidratar y dispatchar en batches.
        // Para los que NO descifren todavía, los agregamos al pendingDecryption
        // para que retryPendingCycle los siga intentando cuando WA Web descifre
        // más en background.
        const canonicals = [];
        for (const row of ofChat) {
          const c = await hydrate(row);
          if (!c) continue;
          canonicals.push(c);
          if (c.decryption_status === 'no_cache' && row.msgRowOpaqueData?._data) {
            pendingDecryption.set(row.rowId || row.id, { row, addedAt: Date.now() });
          }
        }
        for (let i = 0; i < canonicals.length; i += BATCH_MAX) {
          dispatchBatch(canonicals.slice(i, i + BATCH_MAX));
        }
        rehydrated = canonicals.length;
        console.log(`[WS-CONTENT-V2] openAndScrollChat: ${rehydrated} mensajes re-hidratados para ${jid}`);
      } catch (e) {
        try { db.close(); } catch (_) {}
        throw e;
      }
    } catch (e) {
      console.warn('[WS-CONTENT-V2] re-hidratación falló:', e.message);
    }

    // Limpiar el input de búsqueda para que el sidebar vuelva a la lista normal
    try {
      const si = document.querySelector('input[role="textbox"]') || document.querySelector('input[aria-label*="Buscar"]');
      if (si) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(si, '');
        si.dispatchEvent(new Event('input', { bubbles: true }));
      }
    } catch (_) {}

    return { ok: true, scrolls, rehydrated };
  }

  // ─── Init ─────────────────────────────────────────────────────────
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  console.log('[WS-CONTENT-V2] script cargado, esperando DOMContentLoaded...');
  ready(async () => {
    console.log('[WS-CONTENT-V2] DOM ready, iniciando detectOurJid...');
    try {
      await detectOurJid();
    } catch (e) {
      console.warn('[WS-CONTENT-V2] detectOurJid:', e.message);
    }
    console.log('[WS-CONTENT-V2] post detectOurJid, restoreState...');
    try {
      await restoreState();
    } catch (e) {
      console.warn('[WS-CONTENT-V2] restoreState:', e.message);
    }
    console.log('[WS-CONTENT-V2] post restoreState, configurando observers...');

    // MutationObserver: cuando #main cambia, dispara processCycle.
    // Esperamos a que document.body exista (DOMContentLoaded ya pasó si llegamos aquí).
    if (document.body) {
      const obs = new MutationObserver(() => {
        processCycle();
        backfillCurrentChat();
      });
      obs.observe(document.body, { childList: true, subtree: true });
    } else {
      console.warn('[WS-CONTENT-V2] document.body ausente, sin MutationObserver');
    }

    // Polling de seguridad (forward — mensajes nuevos)
    setInterval(processCycle, POLL_INTERVAL_MS);

    // Retry de mensajes pendientes de descifrado
    setInterval(retryPendingCycle, RETRY_PENDING_INTERVAL_MS);

    // Backfill progresivo del histórico (backward — mensajes viejos).
    setInterval(backfillCycle, 3000);

    // Sincronización periódica de metadata de chats.
    setTimeout(syncChatMetadataToBackground, 5000);
    setInterval(syncChatMetadataToBackground, 20000);

    // Listener para ticks del SW. Cuando WA Web está en background, los
    // setInterval se throttlan agresivamente (Chrome los corre cada minuto).
    // Pero los onMessage handlers NO se throttlan — el SW puede dispararlos
    // siempre que quiera vía chrome.alarms (que tampoco se throttla).
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'V2_TICK_BACKFILL') {
        backfillCycle();
        processCycle();
        sendResponse({ ok: true });
        return false;
      }
      if (msg?.type === 'V2_OPEN_AND_SCROLL_CHAT' && msg.jid) {
        openAndScrollChat(msg.jid, msg.name || null, msg.phoneNumber || null)
          .then(r => sendResponse(r))
          .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      if (msg?.type === 'V2_REHYDRATE_CHAT' && msg.jid) {
        rehydrateChat(msg.jid)
          .then(r => sendResponse(r))
          .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
      }
      if (msg?.type === 'V2_REFRESH_MEDIA' && msg.messageId) {
        refreshMediaBridge(msg.messageId)
          .then(r => sendResponse(r))
          .catch(e => sendResponse({ ok: false, error: e.message }));
        return true;
      }
    });

    // Bridge MAIN ↔ ISOLATED para refresh de media expirada.
    // El SW pide a content.v2 que invoque a patch.v2 (que vive en MAIN y
    // tiene acceso a Store.Msg) para regenerar la URL del media usando la
    // API interna de WA Web. patch.v2 devuelve los bytes EN CLARO ya
    // descifrados — saltamos HKDF/AES en el SW.
    let _refreshReqId = 0;
    const _refreshPending = new Map();
    window.addEventListener('wsv2:refresh-media-reply', (e) => {
      const { requestId, ok, bytes, mimetype, error, len } = e.detail || {};
      const p = _refreshPending.get(requestId);
      if (!p) return;
      clearTimeout(p.timer);
      _refreshPending.delete(requestId);
      if (ok) p.resolve({ bytes, mimetype, len });
      else p.reject(new Error(error || 'refresh failed'));
    });
    function refreshMediaBridge(messageId, timeoutMs = 30000) {
      return new Promise((resolve, reject) => {
        const requestId = ++_refreshReqId;
        const timer = setTimeout(() => {
          _refreshPending.delete(requestId);
          reject(new Error('refresh timeout'));
        }, timeoutMs);
        _refreshPending.set(requestId, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); }, timer });
        window.dispatchEvent(new CustomEvent('wsv2:refresh-media-request', {
          detail: { messageId, requestId },
        }));
      }).then(({ bytes, mimetype, len }) => {
        // Convertir a array regular para que sobreviva chrome.runtime.sendMessage
        // (chrome.runtime serializa con structured clone que SI soporta Uint8Array
        // pero usamos array por seguridad cross-version).
        return { ok: true, bytes: Array.from(bytes), mimetype, len };
      });
    }

    // Re-hidratar TODOS los msgs de un chat usando Camino A. Usado cuando
    // el usuario procesa manualmente un chat cuyas msgs quedaron como
    // pending_decryption (capturadas antes de que la key derivada estuviera
    // disponible o antes de que el bridge Camino A existiera).
    async function rehydrateChat(jid) {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('model-storage');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      try {
        const tx = db.transaction('message', 'readonly');
        const all = await new Promise(r => {
          const req = tx.objectStore('message').getAll();
          req.onsuccess = () => r(req.result);
        });
        const target = all.filter(m =>
          typeof m.id === 'string' && m.id.split('_')[1] === jid);
        let dispatched = 0, success = 0, failed = 0;
        const batch = [];
        for (const row of target) {
          try {
            const msg = await hydrate(row);
            if (!msg) continue;
            if (msg.decryption_status === 'success') success++;
            else if (msg.decryption_status?.startsWith('error')) failed++;
            batch.push(msg);
            if (batch.length >= BATCH_MAX) {
              dispatchBatch(batch.splice(0, batch.length));
              dispatched += BATCH_MAX;
            }
          } catch (_) { failed++; }
        }
        if (batch.length) { dispatchBatch(batch); dispatched += batch.length; }
        return { ok: true, jid, total: target.length, dispatched, success, failed };
      } finally { db.close(); }
    }

    // Primera pasada inmediata (después de un pequeño delay para que
    // WA Web termine de cargar su IndexedDB)
    setTimeout(processCycle, 2000);

    console.log('[WS-CONTENT-V2] inicializado · poll cada ' + POLL_INTERVAL_MS + 'ms · retry pending cada ' + RETRY_PENDING_INTERVAL_MS + 'ms');
  });
})();
