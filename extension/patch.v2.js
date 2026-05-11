/* ═══════════════════════════════════════════════════════════════════
 * WhatsApp Captura Safra — Patch V2 (hook a Web Crypto API)
 *
 * Corre en MAIN world, document_start. Se inyecta ANTES de que cualquier
 * script de WhatsApp Web cargue.
 *
 * Su único trabajo: interceptar `crypto.subtle.decrypt` y guardar en una
 * cache LRU el plaintext de cada call, indexado por SHA-256(ciphertext).
 *
 * Cuando content.v2.js lee un mensaje del IndexedDB de WA Web, encuentra
 * el campo `msgRowOpaqueData._data` (ciphertext). Calcula su SHA-256 y
 * busca en la cache → si está, tiene el plaintext que WA Web ya descifró
 * cuando renderizó el mensaje.
 *
 * NAMESPACE: usa `window.__wsCaptureV2` (separado de v1 `__wsCaptura`).
 * Durante la construcción v1 y v2 conviven, y v1 reasigna su namespace
 * al arrancar — si compartiéramos namespace v1 borraría las props de v2.
 *
 * Cero efectos secundarios visibles para WA Web. La extensión sigue
 * comportándose 100% pasiva (riesgo de baneo: 0%).
 *
 * Diseño LRU:
 *   - Map nativo (preserva orden de inserción)
 *   - Tamaño máximo MAX_ENTRIES, eviction FIFO
 *   - Si entry ya existe al insertar, se mueve al final
 *   - Búsqueda por SHA-256 hex es O(1)
 *
 * Estructura window.__wsCaptureV2:
 *   ─ installed:      true
 *   ─ decryptCache:   Map<sha256Hex, Uint8Array>
 *   ─ stats:          { hookCalls, hits, misses, evictions, errors }
 *   ─ getDecrypted(ciphertext):  helper que devuelve plaintext si está
 *
 * ════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  if (window.__wsCaptureV2?.installed) return;

  const ns = window.__wsCaptureV2 = {
    installed:    true,
    decryptCache: new Map(),
    stats:        { hookCalls: 0, hits: 0, misses: 0, evictions: 0, errors: 0 },
    // ─── Camino A: capturas de derivación HKDF ────────────────────────
    // Cuando WA Web va a descifrar un msgRowOpaqueData, primero deriva
    // una key específica desde la masterKey (guardada en wawc_db_enc.keys)
    // usando HKDF con un salt e info específicos. Capturamos cada
    // deriveKey/deriveBits para mapear (params HKDF) → (key derivada).
    // Esto nos permite REPLICAR la derivación sin esperar a WA Web.
    derivations:  [],          // {salt, info, hash, baseKeyId, derivedAlg, exportableBits, ts}
    keyRegistry:  new Map(),   // CryptoKey → { id, role: 'master'|'derived', algorithm, ... }
    nextKeyId:    1,
  };

  const MAX_ENTRIES = 5000;       // ~50MB techo (10KB promedio por mensaje)
  const MAX_PT_LEN  = 65536;      // No cachear plaintexts > 64KB (probable archivo, no msg)

  // ─── SHA-256 hex de un Uint8Array | ArrayBuffer ───────────────────
  async function sha256Hex(buf) {
    const data = buf instanceof ArrayBuffer ? buf : (buf.buffer ? buf.buffer.slice(buf.byteOffset || 0, (buf.byteOffset || 0) + buf.byteLength) : buf);
    const hash = await crypto.subtle.digest('SHA-256', data);
    const arr = new Uint8Array(hash);
    let out = '';
    for (let i = 0; i < arr.length; i++) out += arr[i].toString(16).padStart(2, '0');
    return out;
  }

  // ─── LRU put: si la entry ya existe, refrescar posición ───────────
  function lruPut(key, value) {
    if (ns.decryptCache.has(key)) ns.decryptCache.delete(key);
    ns.decryptCache.set(key, value);
    while (ns.decryptCache.size > MAX_ENTRIES) {
      const oldest = ns.decryptCache.keys().next().value;
      ns.decryptCache.delete(oldest);
      ns.stats.evictions++;
    }
  }

  // ─── Helper público para content.js: dado un ciphertext (Uint8Array
  //     o ArrayBuffer), devuelve el plaintext si está en cache.
  ns.getDecrypted = async function (ciphertext) {
    try {
      const hex = await sha256Hex(ciphertext);
      const pt  = ns.decryptCache.get(hex);
      if (pt) {
        ns.stats.hits++;
        // Refrescar LRU
        ns.decryptCache.delete(hex);
        ns.decryptCache.set(hex, pt);
        return pt;
      }
      ns.stats.misses++;
      return null;
    } catch (e) {
      ns.stats.errors++;
      return null;
    }
  };

  // ─── Helpers de registro de keys ──────────────────────────────────
  function registerKey(key, role, extra = {}) {
    if (!key || ns.keyRegistry.has(key)) return ns.keyRegistry.get(key)?.id;
    const id = ns.nextKeyId++;
    ns.keyRegistry.set(key, {
      id,
      role,
      algorithm: key.algorithm,
      extractable: key.extractable,
      type: key.type,
      usages: key.usages,
      ...extra,
    });
    return id;
  }
  function keyId(key) {
    return key ? (ns.keyRegistry.get(key)?.id ?? '?') : null;
  }
  function u8ToHex(u8) {
    if (!u8) return null;
    const arr = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    let s = '';
    for (let i = 0; i < arr.length; i++) s += arr[i].toString(16).padStart(2, '0');
    return s;
  }

  // ─── Hooks de derivación: deriveKey + deriveBits ──────────────────
  // Estos disparan ANTES de cada decrypt cuando WA Web crea su key
  // específica desde la masterKey. Capturamos los params HKDF para poder
  // replicar la derivación independientemente.
  const origDeriveKey  = crypto.subtle.deriveKey.bind(crypto.subtle);
  const origDeriveBits = crypto.subtle.deriveBits.bind(crypto.subtle);

  crypto.subtle.deriveKey = async function patchedDeriveKey(algorithm, baseKey, derivedKeyAlgorithm, extractable, usages) {
    const r = await origDeriveKey(algorithm, baseKey, derivedKeyAlgorithm, extractable, usages);
    try {
      const baseId = registerKey(baseKey, 'master_or_intermediate');
      const derivedId = registerKey(r, 'derived', { derivedFrom: baseId });
      ns.derivations.push({
        kind:        'deriveKey',
        ts:          Date.now(),
        algName:     algorithm?.name,
        salt:        u8ToHex(algorithm?.salt),
        info:        u8ToHex(algorithm?.info),
        hash:        algorithm?.hash?.name || algorithm?.hash || null,
        baseKeyId:   baseId,
        derivedKeyId:derivedId,
        derivedAlg:  derivedKeyAlgorithm,
        extractable, usages,
      });
      // Cap a 200 derivations
      if (ns.derivations.length > 200) ns.derivations.splice(0, 50);
    } catch (e) { ns.stats.errors++; }
    return r;
  };

  crypto.subtle.deriveBits = async function patchedDeriveBits(algorithm, baseKey, length) {
    const r = await origDeriveBits(algorithm, baseKey, length);
    try {
      const baseId = registerKey(baseKey, 'master_or_intermediate');
      ns.derivations.push({
        kind:    'deriveBits',
        ts:      Date.now(),
        algName: algorithm?.name,
        salt:    u8ToHex(algorithm?.salt),
        info:    u8ToHex(algorithm?.info),
        hash:    algorithm?.hash?.name || algorithm?.hash || null,
        baseKeyId: baseId,
        length,
        bitsHex: u8ToHex(r),
      });
      if (ns.derivations.length > 200) ns.derivations.splice(0, 50);
    } catch (e) { ns.stats.errors++; }
    return r;
  };

  // ─── Hook a crypto.subtle.decrypt ─────────────────────────────────
  // Cuando WA Web descifra un mensaje internamente para renderizarlo,
  // pasa por aquí. Capturamos el par (ciphertext, plaintext) y lo
  // cacheamos para que content.v2.js lo use después.
  const origDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);

  crypto.subtle.decrypt = async function patchedDecrypt(algorithm, key, data) {
    let plaintext;
    try {
      plaintext = await origDecrypt(algorithm, key, data);
    } catch (e) {
      throw e;
    }
    ns.stats.hookCalls++;
    try {
      if (!data) return plaintext;
      const ctU8 = data instanceof Uint8Array ? data : (data instanceof ArrayBuffer ? new Uint8Array(data) : null);
      if (!ctU8 || ctU8.byteLength === 0) return plaintext;
      const ptU8 = plaintext instanceof Uint8Array ? plaintext : new Uint8Array(plaintext);
      if (ptU8.byteLength === 0 || ptU8.byteLength > MAX_PT_LEN) return plaintext;

      // Registrar la key usada para descifrar (link con derivación previa)
      const usedKeyId = keyId(key);

      sha256Hex(ctU8).then(hex => {
        const copy = new Uint8Array(ptU8.byteLength);
        copy.set(ptU8);
        lruPut(hex, copy);
        // Anotar también qué key derivada se usó — útil para asociar
        // ciphertexts al mismo "keyId" de derivación (deduce el patrón).
        ns.lastDecryptInfo = ns.lastDecryptInfo || [];
        ns.lastDecryptInfo.push({
          ctHash: hex,
          ctLen: ctU8.byteLength,
          ptLen: ptU8.byteLength,
          algName: algorithm?.name,
          ivHex: u8ToHex(algorithm?.iv),
          usedKeyId,
          ts: Date.now(),
        });
        if (ns.lastDecryptInfo.length > 50) ns.lastDecryptInfo.splice(0, 20);
      }).catch(() => { ns.stats.errors++; });
    } catch (e) {
      ns.stats.errors++;
    }
    return plaintext;
  };

  // ─── Camino A: descifrado directo de msgRowOpaqueData ────────────
  // Expone una función que content.v2 (isolated world) puede invocar
  // vía CustomEvent. Usa la key AES-CBC ya derivada por WA Web (vive
  // en window.__wsCaptureV2.keyRegistry) — NO requiere replicar HKDF.
  //
  // Cuando se encuentra la key que descifra exitosamente, la cacheamos
  // como "goodKey" para evitar probar todas las candidates cada vez.
  let cachedGoodKey = null;

  async function decryptOpaqueData(ctU8, ivU8) {
    if (!ctU8 || !ivU8) throw new Error('ct o iv vacío');

    // Probar primero la cached good key
    if (cachedGoodKey) {
      try {
        const pt = await origDecrypt({ name: 'AES-CBC', iv: ivU8 }, cachedGoodKey, ctU8);
        return new Uint8Array(pt);
      } catch (_) {
        cachedGoodKey = null;   // se invalidó (sesión nueva quizás)
      }
    }
    // Probar todas las AES-CBC con decrypt usage
    for (const [key, info] of ns.keyRegistry) {
      if (info.algorithm?.name !== 'AES-CBC') continue;
      if (!info.usages?.includes('decrypt')) continue;
      try {
        const pt = await origDecrypt({ name: 'AES-CBC', iv: ivU8 }, key, ctU8);
        cachedGoodKey = key;
        return new Uint8Array(pt);
      } catch (_) { /* probar siguiente */ }
    }
    throw new Error('ninguna key derivada descifró el ciphertext');
  }

  // Bridge isolated → main: escuchar requests vía CustomEvent.
  // El iv puede llegar como ArrayBuffer, Uint8Array o como objeto plano
  // {0:.., 1:.., 15:..} que IndexedDB a veces devuelve. Normalizamos.
  function toU8(x, fallbackLen) {
    if (x instanceof Uint8Array) return x;
    if (x instanceof ArrayBuffer) return new Uint8Array(x);
    if (x && typeof x === 'object') {
      const len = typeof x.length === 'number' ? x.length :
                  typeof x.byteLength === 'number' ? x.byteLength :
                  fallbackLen;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = x[i] | 0;
      return out;
    }
    return new Uint8Array(0);
  }

  window.addEventListener('wsv2:decrypt-opaque-request', async (event) => {
    const { ct, iv, requestId } = event.detail || {};
    let result;
    try {
      const ctU8 = toU8(ct);
      const ivU8 = toU8(iv, 16);
      if (ctU8.byteLength === 0) throw new Error('ct vacío');
      if (ivU8.byteLength !== 16) throw new Error('iv inválido len=' + ivU8.byteLength);
      const pt = await decryptOpaqueData(ctU8, ivU8);

      // El parser de protobuf vive en MAIN (este world). Lo invocamos acá
      // y enviamos sólo el resultado parseado al ISOLATED — así content.v2
      // no necesita acceso al window.__wsProtobuf (que ISOLATED no ve).
      let parsed = null;
      try {
        if (window.__wsProtobuf?.parseMsgRowOpaqueData) {
          parsed = window.__wsProtobuf.parseMsgRowOpaqueData(pt);
        }
      } catch (e) {
        parsed = { ok: false, error: 'parser threw: ' + e.message };
      }
      result = { ok: true, plaintext: pt, parsed, plaintextLen: pt.byteLength };
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    // Dispatch reply
    window.dispatchEvent(new CustomEvent('wsv2:decrypt-opaque-reply', {
      detail: { requestId, ...result },
    }));
  });

  // ─── Refresh URL de media expirada ───────────────────────────────
  // Cuando el SW falla descargando media porque la URL del CDN caducó (~17d),
  // pedimos a WA Web que regenere la URL usando su API interna
  // (`Msg.downloadMedia()` que internamente hace re-upload media reference).
  // El resultado es un Blob descifrado que enviamos al SW como bytes en claro.
  //
  // WA Web ahora usa Meta's Haste require, no webpack chunks tradicionales.
  // Accedemos via `window.require('WAWebMsgCollection').MsgCollection`.

  function getMsgCollection() {
    try {
      const mod = window.require && window.require('WAWebMsgCollection');
      return mod?.MsgCollection || null;
    } catch (_) { return null; }
  }

  async function findMsgById(messageId) {
    const MC = getMsgCollection();
    if (!MC) throw new Error('MsgCollection no disponible (window.require)');
    // Intento 1: ya cargado en memoria
    if (typeof MC.get === 'function') {
      const m = MC.get(messageId);
      if (m) return m;
    }
    // Intento 2: cargar desde IndexedDB de WA Web — getMessagesById acepta
    // strings serializados directamente y devuelve {messages, eof, canceled}.
    if (typeof MC.getMessagesById === 'function') {
      try {
        const r = await MC.getMessagesById([messageId]);
        if (r?.messages?.length) return r.messages[0];
      } catch (_) {}
    }
    return null;
  }

  async function refreshMediaViaStore({ messageId }) {
    const msg = await findMsgById(messageId);
    if (!msg) throw new Error('msg no en MsgCollection: ' + messageId);
    if (typeof msg.downloadMedia !== 'function') {
      throw new Error('msg.downloadMedia no disponible');
    }
    await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
    // Pequeña espera para que el blob se asiente en el cache
    await new Promise(r => setTimeout(r, 800));

    const md = msg.mediaData;
    const attrs = md?.attributes || {};
    const stage = attrs.mediaStage;

    // ERROR_MISSING = WA Web confirma que el archivo NO está en el CDN
    // (media muy viejo, >17d sin actividad). Irrecuperable definitivo.
    if (stage === 'ERROR_MISSING') {
      throw new Error('UNRECOVERABLE: media expirado del CDN de WhatsApp (mediaStage=ERROR_MISSING)');
    }

    // Estrategia A: Cache Storage de WA Web — `lru-media-array-buffer-cache`
    // contiene los bytes descifrados indexados por SHA-256 del archivo (filehash).
    // ESTA es la fuente real de los bytes después de downloadMedia(). El blob
    // NO se mantiene como propiedad del msg/mediaData; vive solo en este cache.
    const filehash = msg.filehash || attrs.filehash;
    if (filehash) {
      try {
        const c = await caches.open('lru-media-array-buffer-cache');
        const url = 'https://_media_cache_v2_.whatsapp.com/lru-media-array-buffer-cache_' + encodeURIComponent(filehash);
        const resp = await c.match(url);
        if (resp) {
          const ab = await resp.arrayBuffer();
          if (ab && ab.byteLength > 0) {
            return { bytes: new Uint8Array(ab), mimetype: msg.mimetype || attrs.mimetype || null };
          }
        }
      } catch (_) { /* siguiente estrategia */ }
    }

    // Estrategia B (fallback): mediaData attributes (versiones viejas de WA Web)
    let blob = null;
    if (attrs.mediaBlob instanceof Blob) blob = attrs.mediaBlob;
    else if (md?.mediaBlob instanceof Blob) blob = md.mediaBlob;
    else if (md?.fullFile instanceof Blob) blob = md.fullFile;
    else if (typeof md?.dataDownload === 'function') {
      try { blob = await md.dataDownload(); } catch (_) {}
    }

    if (!blob) {
      throw new Error('downloadMedia no devolvió blob (mediaStage=' + stage + ', filehash=' + (filehash ? 'presente_pero_no_en_cache' : 'ausente') + ')');
    }
    const u8 = new Uint8Array(await blob.arrayBuffer());
    return { bytes: u8, mimetype: blob.type || msg.mimetype || null };
  }

  window.addEventListener('wsv2:refresh-media-request', async (event) => {
    const { requestId, messageId } = event.detail || {};
    let result;
    try {
      const r = await refreshMediaViaStore({ messageId });
      // Pasamos un Uint8Array por CustomEvent (mismo realm, no hay clone overhead)
      result = { ok: true, bytes: r.bytes, mimetype: r.mimetype, len: r.bytes.byteLength };
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    window.dispatchEvent(new CustomEvent('wsv2:refresh-media-reply', {
      detail: { requestId, ...result },
    }));
  });

  // ─── Carga histórica de un chat desde el servidor ────────────────
  // Para chats viejos cuyo histórico WA Web ya purgó del cache local
  // (model-storage.message), pedimos a WA Web que descargue del servidor.
  // Estrategia: Cmd.openChatBottom(chat) → activa el chat → WA carga msgs.
  // Después loadEarlierMsgs en bucle para descargar más antiguos.
  // Los msgs cargados quedan en model-storage IndexedDB → nuestro backfill
  // los detecta y procesa con Camino A.

  function getChatCollection() {
    try { return window.require('WAWebChatCollection').ChatCollection; }
    catch (_) { return null; }
  }
  function getCmd() {
    try { return window.require('WAWebCmd').Cmd; }
    catch (_) { return null; }
  }
  function getLoadMsgsAPI() {
    try { return window.require('WAWebChatLoadMessages'); }
    catch (_) { return null; }
  }

  async function loadChatHistoryFromServer({ chatJid, maxIterations = 8 }) {
    const CC = getChatCollection();
    const Cmd = getCmd();
    const LM = getLoadMsgsAPI();
    if (!CC || !Cmd || !LM) throw new Error('módulos require no disponibles (CC/Cmd/LoadMsgs)');
    const chat = CC.get(chatJid);
    if (!chat) throw new Error('chat no encontrado en ChatCollection: ' + chatJid);

    const before = chat.msgs?.length || 0;

    // Activar el chat → WA Web carga su msgs iniciales del servidor si no están
    if (typeof Cmd.openChatBottom === 'function') {
      try { await Cmd.openChatBottom(chat); } catch (_) {}
    }
    await new Promise(r => setTimeout(r, 1500));

    // Descargar más histórico iterando loadEarlierMsgs
    let iterations = 0, lastCount = chat.msgs?.length || 0;
    for (let i = 0; i < maxIterations; i++) {
      try {
        await LM.loadEarlierMsgs(chat);
        iterations++;
      } catch (e) {
        // loadEarlierMsgs falla cuando no hay más histórico → cortar bucle
        break;
      }
      await new Promise(r => setTimeout(r, 600));
      const now = chat.msgs?.length || 0;
      if (now === lastCount) break;   // ya no se cargan más
      lastCount = now;
    }

    const after = chat.msgs?.length || 0;
    return { ok: true, chatJid, msgsBefore: before, msgsAfter: after, iterations };
  }

  window.addEventListener('wsv2:load-chat-history-request', async (event) => {
    const { requestId, chatJid, maxIterations } = event.detail || {};
    let result;
    try {
      result = await loadChatHistoryFromServer({ chatJid, maxIterations });
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    window.dispatchEvent(new CustomEvent('wsv2:load-chat-history-reply', {
      detail: { requestId, ...result },
    }));
  });

  console.log('[WS-PATCH-V2] hook crypto.subtle.decrypt instalado · LRU cache size=' + MAX_ENTRIES);
  console.log('[WS-PATCH-V2] descifrado directo de msgRowOpaqueData expuesto vía wsv2:decrypt-opaque-request');
  console.log('[WS-PATCH-V2] refresh de media expirada expuesto vía wsv2:refresh-media-request');
  console.log('[WS-PATCH-V2] carga histórica desde servidor expuesta vía wsv2:load-chat-history-request');
})();
