/* ═══════════════════════════════════════════════════════════════════
 * Parser Protobuf MÍNIMO para WAMessage (WhatsApp).
 *
 * El plaintext que sale de crypto.subtle.decrypt es un protobuf
 * serializado. Este parser NO trae toda la librería de Baileys —
 * implementa solo el subset necesario para extraer el contenido útil
 * de mensajes de WhatsApp Web.
 *
 * EXPORT: window.__wsProtobuf.parseMsgRowOpaqueData(uint8) → resultado
 *
 * Resultado:
 *   { ok: true, type, text?, caption?, fileName?, quotedMessageId?, ... }
 *   { ok: false, reason, attempts: [...] }
 *
 * Estrategia:
 *   1. WA Web ENVUELVE el Message en wrappers internos (vimos hasta 3 niveles
 *      en POC). El parser intenta cada nivel y se queda con el PRIMERO que
 *      produzca un resultado VÁLIDO (texto UTF-8 limpio, type reconocido).
 *   2. Validación estricta: el texto extraído no se acepta como "el mensaje"
 *      si contiene basura binaria (caracteres de control no esperados,
 *      bytes UTF-8 inválidos). Si se rechaza, se intenta el siguiente nivel.
 *
 * Schema relevante (campos de WAMessage simplificado):
 *   Message {
 *     1:  string conversation
 *     2:  SenderKeyDistributionMessage senderKeyDistributionMessage
 *     3:  ImageMessage imageMessage     { 5/7: string caption }
 *     4:  ContactMessage contactMessage
 *     5:  LocationMessage locationMessage
 *     14: ExtendedTextMessage extendedTextMessage  { 1: text, 35/37: ContextInfo }
 *     19: DocumentMessage documentMessage   { 5: caption, 7/8: fileName }
 *     21/22: AudioMessage audioMessage      { 4: bool ptt }
 *     23: StickerMessage stickerMessage
 *     26/28: VideoMessage videoMessage      { 5/7: caption }
 *   }
 *
 *   ContextInfo {
 *     1: string stanzaId       (id del mensaje quoted)
 *     2: string participant    (jid del autor original)
 *     3: Message quotedMessage
 *     15: repeated string mentionedJid
 *   }
 *
 * ════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';
  if (window.__wsProtobuf?.installed) return;

  // ─── Decodificación protobuf base ─────────────────────────────────

  // Wire types: 0=VARINT, 1=FIXED64, 2=LENGTH_DELIMITED, 5=FIXED32
  // Tag = (field_number << 3) | wire_type

  function readVarint(buf, off) {
    let v = 0n, shift = 0n, i = off;
    while (i < buf.length) {
      const b = buf[i++];
      v |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return [v, i];
      shift += 7n;
      if (shift > 63n) throw new Error('varint > 64 bits');
    }
    throw new Error('varint truncado');
  }

  function readField(buf, off) {
    const [tag, after] = readVarint(buf, off);
    const tagN = Number(tag);
    const fieldNumber = tagN >>> 3;
    const wireType = tagN & 7;
    let value, end;
    switch (wireType) {
      case 0: { const [v, e] = readVarint(buf, after); value = v; end = e; break; }
      case 1: value = buf.slice(after, after + 8); end = after + 8; break;
      case 2: {
        const [len, e] = readVarint(buf, after);
        const lenN = Number(len);
        if (lenN < 0 || e + lenN > buf.length) throw new Error('length-delimited fuera de rango');
        value = buf.slice(e, e + lenN); end = e + lenN; break;
      }
      case 5: value = buf.slice(after, after + 4); end = after + 4; break;
      default: throw new Error(`wire type desconocido ${wireType}`);
    }
    return { fieldNumber, wireType, value, end };
  }

  function decodeMessage(buf) {
    const fields = new Map();
    let off = 0;
    while (off < buf.length) {
      const f = readField(buf, off);
      const arr = fields.get(f.fieldNumber) || [];
      arr.push({ wireType: f.wireType, value: f.value });
      fields.set(f.fieldNumber, arr);
      off = f.end;
    }
    return fields;
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  function utf8DecodeStrict(u8) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(u8); }
    catch { return null; }
  }

  // Texto razonable: ≥1 char, sin caracteres de control no típicos.
  // Permitimos: tab, LF, CR, espacios, todo lo > 0x1f.
  // Rechazamos: la mayoría de bytes <0x20 (control chars que NO aparecen en mensajes humanos).
  // Aceptamos hasta 1% de "ruido" para tolerar emojis ZWJ y zero-width selectors.
  function isReasonableText(str) {
    if (typeof str !== 'string' || str.length === 0) return false;
    let bad = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      // Permitir 0x09 (tab), 0x0A (LF), 0x0D (CR). Rechazar otros control chars.
      if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) bad++;
      // Rechazar bytes en zona reservada de UTF-16 sin pareja (replacement chars)
      else if (c === 0xfffd) bad++;
    }
    // Tolerancia: máximo 2% de chars sospechosos (cubre uso de invisible chars
    // legítimos en algunos mensajes, sin permitir basura binaria).
    return (bad / str.length) <= 0.02;
  }

  function getStringStrict(fields, fieldNumber) {
    const arr = fields.get(fieldNumber);
    if (!arr || !arr.length || arr[0].wireType !== 2) return null;
    const decoded = utf8DecodeStrict(arr[0].value);
    if (decoded === null) return null;
    return isReasonableText(decoded) ? decoded : null;
  }

  function getStringLoose(fields, fieldNumber) {
    // Versión sin validación UTF-8 estricta — para identificadores que
    // pueden contener bytes no-UTF-8 (raro, pero no descartar).
    const arr = fields.get(fieldNumber);
    if (!arr || !arr.length || arr[0].wireType !== 2) return null;
    try { return new TextDecoder('utf-8', { fatal: false }).decode(arr[0].value); }
    catch { return null; }
  }

  function getNested(fields, fieldNumber) {
    const arr = fields.get(fieldNumber);
    if (!arr || !arr.length || arr[0].wireType !== 2) return null;
    try { return decodeMessage(arr[0].value); }
    catch { return null; }
  }

  function getRepeatedStringStrict(fields, fieldNumber) {
    const arr = fields.get(fieldNumber);
    if (!arr) return [];
    return arr
      .filter(f => f.wireType === 2)
      .map(f => utf8DecodeStrict(f.value))
      .filter(s => s !== null && isReasonableText(s));
  }

  function getBool(fields, fieldNumber) {
    const arr = fields.get(fieldNumber);
    if (!arr || !arr.length || arr[0].wireType !== 0) return null;
    return arr[0].value !== 0n;
  }

  // ─── Extractor de Message ─────────────────────────────────────────
  // Detecta el sub-mensaje presente y retorna info útil.
  // Retorna null si NO se reconoce ningún tipo (no es un Message válido).
  function extractFromMessage(msg) {
    if (!msg || msg.size === 0) return null;

    // 1: conversation (string puro). Texto plano de un mensaje type=chat.
    const conversation = getStringStrict(msg, 1);
    if (conversation) {
      return { type: 'text', text: conversation };
    }

    // 14: extendedTextMessage { 1: text, 35/37: ContextInfo }
    const ext = getNested(msg, 14);
    if (ext) {
      const text = getStringStrict(ext, 1);
      if (text) {
        const ctx = getNested(ext, 35) || getNested(ext, 37);
        const out = { type: 'text', text };
        if (ctx) {
          const quotedId = getStringLoose(ctx, 1);
          const quotedSender = getStringLoose(ctx, 2);
          if (quotedId) out.quotedMessageId = quotedId;
          if (quotedSender) out.quotedSenderJid = quotedSender;
          const mentions = getRepeatedStringStrict(ctx, 15);
          if (mentions.length) out.mentions = mentions;
        }
        return out;
      }
    }

    // 3: imageMessage
    const img = getNested(msg, 3);
    if (img) {
      const caption = getStringStrict(img, 5) || getStringStrict(img, 7) || '';
      return { type: 'image', caption };
    }

    // 26 ó 28: videoMessage
    const vid = getNested(msg, 26) || getNested(msg, 28);
    if (vid) {
      const caption = getStringStrict(vid, 5) || getStringStrict(vid, 7) || '';
      return { type: 'video', caption };
    }

    // 21 ó 22: audioMessage
    const aud = getNested(msg, 21) || getNested(msg, 22);
    if (aud) {
      const isPtt = getBool(aud, 4) || false;
      return { type: isPtt ? 'ptt' : 'audio' };
    }

    // 19: documentMessage
    const doc = getNested(msg, 19);
    if (doc) {
      const fileName = getStringStrict(doc, 7) || getStringStrict(doc, 8) || '';
      const caption = getStringStrict(doc, 5) || '';
      return { type: 'document', fileName, caption };
    }

    // 23: stickerMessage
    if (getNested(msg, 23)) return { type: 'sticker' };

    // 5: locationMessage
    if (getNested(msg, 5)) return { type: 'location' };

    // 4: contactMessage
    if (getNested(msg, 4)) return { type: 'contact' };

    // No reconocido
    return null;
  }

  // ─── Parser tolerante: prueba múltiples niveles de wrap ───────────
  // El plaintext puede venir como:
  //   level 0: Message directo
  //   level 1: { 1: Message }
  //   level 2: { 1: { 1: Message } }
  //   level 3: { 1: { 2: Message } }   (WebMessageInfo wrapping)
  //
  // Probamos cada uno y nos quedamos con el primero que produzca un Message
  // RECONOCIDO con texto sano. Si todos fallan: ok:false.
  function parseMsgRowOpaqueData(uint8) {
    if (!(uint8 instanceof Uint8Array)) {
      try { uint8 = new Uint8Array(uint8); }
      catch { return { ok: false, reason: 'no es Uint8Array ni convertible' }; }
    }
    if (uint8.length === 0) return { ok: false, reason: 'plaintext vacío' };

    const attempts = [];

    // ─ Level 0: el plaintext ES un Message
    try {
      const m = decodeMessage(uint8);
      const r = extractFromMessage(m);
      if (r) return { ok: true, level: 0, ...r };
      attempts.push({ level: 0, decoded: true, recognized: false });
    } catch (e) {
      attempts.push({ level: 0, error: e.message });
    }

    // ─ Level 1: el plaintext es { 1: Message }
    try {
      const wrap = decodeMessage(uint8);
      const inner = getNested(wrap, 1);
      if (inner) {
        const r = extractFromMessage(inner);
        if (r) return { ok: true, level: 1, ...r };
      }
      attempts.push({ level: 1, hasField1: !!inner });
    } catch (e) {
      attempts.push({ level: 1, error: e.message });
    }

    // ─ Level 2: el plaintext es { 1: { 1: Message } } (visto en POC)
    try {
      const wrap1 = decodeMessage(uint8);
      const wrap2 = getNested(wrap1, 1);
      if (wrap2) {
        const inner = getNested(wrap2, 1);
        if (inner) {
          const r = extractFromMessage(inner);
          if (r) return { ok: true, level: 2, ...r };
        }
      }
      attempts.push({ level: 2 });
    } catch (e) {
      attempts.push({ level: 2, error: e.message });
    }

    // ─ Level 3: el plaintext es { 1: WebMessageInfo } donde WebMessageInfo {2: Message}
    try {
      const wrap = decodeMessage(uint8);
      const wmi = getNested(wrap, 1);
      if (wmi) {
        const innerMsg = getNested(wmi, 2);
        if (innerMsg) {
          const r = extractFromMessage(innerMsg);
          if (r) return { ok: true, level: 3, ...r };
        }
      }
    } catch (e) {
      attempts.push({ level: 3, error: e.message });
    }

    // ─ Level 4 (defensivo): { 2: Message } directo en la raíz
    try {
      const wrap = decodeMessage(uint8);
      const inner = getNested(wrap, 2);
      if (inner) {
        const r = extractFromMessage(inner);
        if (r) return { ok: true, level: 4, ...r };
      }
    } catch (e) {
      attempts.push({ level: 4, error: e.message });
    }

    return { ok: false, reason: 'ningún nivel reconocido', attempts, hex: bufToHex(uint8.slice(0, 32)) };
  }

  function bufToHex(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i++) s += u8[i].toString(16).padStart(2, '0');
    return s;
  }

  // ─── Exponer al window ────────────────────────────────────────────
  window.__wsProtobuf = {
    installed: true,
    parseMsgRowOpaqueData,
    decodeMessage,
    bufToHex,
    isReasonableText,   // expuesto para tests
  };

  console.log('[WS-PROTOBUF-V2] parser instalado (con validación UTF-8 estricta)');
})();
