/* ═══════════════════════════════════════════════════════════════════
 * Visor PG · Extension API
 *
 * Cargado vía importScripts en background.v2.js.
 * Expone API hacia el Visor (localhost:5173) vía chrome.runtime.onMessageExternal.
 *
 * Endpoints:
 *   V3_PING                  → { pong, version, ts }
 *   V3_LIST_CHATS            → [{ jid, name, isGroup, stats, lastMsg, ... }]  (lee chat_metadata + agrega counts)
 *   V3_GET_MESSAGES { jid, limit? } → [CanonicalMessage[]]
 *   V3_PROCESS_CHAT { jid }  → { ok, chat_id_db, mensajes_subidos, eventos_creados } (sube + crea evento_pg NUEVO)
 *   V3_BLOCK_CHAT { jid, motivo, titulo } → { ok }  (escribe en Supabase chats_bloqueados)
 *   V3_UNBLOCK_CHAT { jid, motivo } → { ok }
 *   V3_LIST_BLOQUEADOS       → [string[]]  (jids bloqueados, leídos de Supabase)
 *   V3_ESTIMATE_CHAT_MEDIA { jid } → { procesables, omitidos, costo_estimado_usd, duracion_audio_seg }
 *   V3_TRANSCRIBE_CHAT_MEDIA { jid } → { ok, stats }  (descarga + Whisper/Vision/PDF + UPDATE Supabase)
 *   V3_SET_KEYS { supabaseKey, openaiKey, deepseekKey } → { ok }  (sync de credenciales desde el Visor a chrome.storage)
 *
 * Reusa funciones globales del background.v2.js:
 *   tx, reqAsync, getSettings, SUPABASE_URL, mapTipoMensaje, canonicalToMensajeRow, canonicalToEventoRow, upsertChat
 * ═══════════════════════════════════════════════════════════════════ */

'use strict';

var SUPABASE_URL = 'https://olububjdvboiqgmihsmk.supabase.co';


const VISOR_API_VERSION = '5.0.0';

// Expresiones regex para detectar candidatos a no-cliente
const PATRONES_NO_CLIENTE = [
  { tag: 'restaurante', regex: /(carta|men[uú]|domicilio|plato|chef|cocina|reserva (de )?mesa|orden|delivery|pedido)/i, peso: 1 },
  { tag: 'transporte',  regex: /(viaje|conductor|tarifa|recoger|uber|didi|cabify|recogida)/i, peso: 1 },
  { tag: 'spam_finan',  regex: /(tasas? bajas?|pr[eé]stamo aprobado|oferta especial|cupo de cr[eé]dito|tarjeta aprobada)/i, peso: 2 },
  { tag: 'encuesta',    regex: /(encuesta|calificar|su opini[oó]n|escala del 1 al)/i, peso: 1 },
  { tag: 'broadcast',   regex: /(promo(?:ci[oó]n)? especial|descuento exclusivo|oferta del d[ií]a)/i, peso: 1 },
];

// Bypass: si el chat menciona productos/servicios del catálogo Safra,
// JAMÁS se marca como sospechoso aunque haya match de patrones no-cliente.
// (decisión 2026-05-08, opción C — evita falsos positivos de palabras genéricas
// como "carta" o "viaje" que aparecen en cualquier conversación normal)
const PATRON_SAFRA = /(cortina|persiana|blackout|black\s*out|screen\s*solar|sheer|elegance|panel\s*japon[eé]s|enrollable|persiana(s)?\s*vertical|pel[ií]cula\s*solar|toldo|domotic|domótica|riel|tela|cenefa|cadenilla|tapaluz|motorizad|motor\b|sistema\s*guaya|instalaci[oó]n|medici[oó]n|cotizaci[oó]n|cotizar)/i;

function detectarNoCliente(textosConcatenados) {
  // Bypass: si menciona productos del negocio, no es sospechoso (R-detector-001)
  if (PATRON_SAFRA.test(textosConcatenados)) {
    return { tags: [], score: 0, bypass_safra: true };
  }
  const tags = [];
  for (const p of PATRONES_NO_CLIENTE) {
    if (p.regex.test(textosConcatenados)) tags.push({ tag: p.tag, peso: p.peso });
  }
  const score = tags.reduce((s, t) => s + t.peso, 0);
  return { tags: tags.map(t => t.tag), score, bypass_safra: false };
}

function mapTipoStat(canonicalType) {
  if (['text','chat','extendedText','list_response','buttons_response','template_button_reply'].includes(canonicalType)) return 'texto';
  if (canonicalType === 'image' || canonicalType === 'album') return 'imagen';
  if (canonicalType === 'video') return 'video';
  if (canonicalType === 'audio' || canonicalType === 'ptt') return 'audio';
  if (canonicalType === 'document') return 'documento';
  if (canonicalType === 'location' || canonicalType === 'live_location') return 'ubicacion';
  if (canonicalType === 'vcard') return 'contacto';
  if (canonicalType === 'sticker') return 'sticker';
  return 'sistema';
}

// ─── Handler principal ─────────────────────────────────────────────

chrome.runtime.onMessageExternal.addListener((request, sender, sendResponse) => {
  const t = request?.type;
  if (!t) { sendResponse({ error: 'sin type' }); return; }

  (async () => {
    try {
      switch (t) {
        case 'V3_PING':
          sendResponse({ pong: true, version: VISOR_API_VERSION, ts: Date.now(), origin: sender.origin });
          return;

        case 'V3_LIST_CHATS':
          sendResponse({ ok: true, data: await listarChats() });
          return;

        case 'V3_GET_MESSAGES':
          sendResponse({ ok: true, data: await obtenerMensajes(request.jid, request.limit ?? 200) });
          return;

        case 'V3_PROCESS_CHAT':
          sendResponse(await procesarChat(request.jid));
          return;

        case 'V3_BLOCK_CHAT':
          sendResponse(await bloquearChat(request.jid, request.motivo, request.titulo));
          return;

        case 'V3_UNBLOCK_CHAT':
          sendResponse(await desbloquearChat(request.jid, request.motivo));
          return;

        case 'V3_LIST_BLOQUEADOS':
          sendResponse({ ok: true, data: await listarBloqueados() });
          return;

        case 'V3_ESTIMATE_CHAT_MEDIA':
          sendResponse(await estimarMediaChat(request.jid));
          return;

        case 'V3_TRANSCRIBE_CHAT_MEDIA':
          sendResponse(await transcribirMediaChat(request.jid));
          return;

        case 'V3_SET_KEYS':
          sendResponse(await setKeysFromVisor(request));
          return;

        case 'V3_SET_REALTIME':
          sendResponse(await setRealtimeFlag(request.enabled));
          return;

        case 'V3_WA_STATUS':
          sendResponse(await getWaStatus());
          return;

        default:
          sendResponse({ error: 'tipo desconocido: ' + t });
      }
    } catch (e) {
      console.error('[VPG-API]', t, e);
      sendResponse({ error: e.message });
    }
  })();

  return true;  // async response
});

// ─── Implementaciones ──────────────────────────────────────────────

async function listarChats() {
  // 1. Lee chat_metadata (todos los chats que la extensión sniffeó)
  const meta = await tx('chat_metadata', 'readonly', async store => {
    const out = [];
    const cur = store.openCursor();
    await new Promise(res => {
      cur.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { res(); return; }
        out.push(c.value);
        c.continue();
      };
      cur.onerror = () => res();
    });
    return out;
  });

  // 2. Agrega stats por chat desde 'messages'
  const stats = new Map();  // jid -> { totales por tipo + texto + sample }
  await tx('messages', 'readonly', async store => {
    const cur = store.openCursor();
    await new Promise(res => {
      cur.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { res(); return; }
        const m = c.value;
        let s = stats.get(m.chat_id);
        if (!s) {
          s = { total: 0, texto: 0, imagen: 0, video: 0, audio: 0, documento: 0, ubicacion: 0, contacto: 0, sticker: 0, sistema: 0,
                entrantes: 0, salientes: 0, lastTs: 0, firstTs: Infinity, textoConcatenado: '' };
          stats.set(m.chat_id, s);
        }
        s.total++;
        const tp = mapTipoStat(m.type || '');
        s[tp] = (s[tp] || 0) + 1;
        if (m.is_owner) s.salientes++; else s.entrantes++;
        const ts = m.timestamp_ms || 0;
        if (ts > s.lastTs) s.lastTs = ts;
        if (ts && ts < s.firstTs) s.firstTs = ts;
        if (s.textoConcatenado.length < 5000 && m.text) s.textoConcatenado += ' ' + m.text;
        c.continue();
      };
      cur.onerror = () => res();
    });
  });

  // 3. Lista bloqueados (snapshot reciente, se cachea 60s)
  const bloqueadosSet = await getBloqueadosCache();

  // 4. Combinar metadata + stats + detección no-cliente
  const out = [];
  for (const md of meta) {
    const s = stats.get(md.jid) || null;
    const isGroup = !!md.isGroup || md.jid.endsWith('@g.us');
    const isStatus = md.jid === 'status@broadcast';
    const titulo = tituloContacto(md.jid, md.name, md.verifiedName, md.phoneNumber);
    const noCliente = s ? detectarNoCliente(s.textoConcatenado) : { tags: [], score: 0 };

    out.push({
      jid: md.jid,
      titulo,
      phoneNumber: md.phoneNumber || null,
      profilePicUrl: md.profilePicUrl || null,        // foto de perfil del contacto
      isAddressBook: !!md.isAddressBook,
      isBusiness: !!md.isBusiness,
      verifiedName: md.verifiedName || null,
      isGroup,
      isStatus,
      bloqueado: bloqueadosSet.has(md.jid),
      stats: s ? {
        total: s.total,
        texto: s.texto, imagen: s.imagen, video: s.video, audio: s.audio,
        documento: s.documento, ubicacion: s.ubicacion, contacto: s.contacto,
        sticker: s.sticker, sistema: s.sistema,
        entrantes: s.entrantes, salientes: s.salientes,
        pct_entrante: s.total ? Math.round((s.entrantes / s.total) * 100) : 0,
        // last_ts FIX (F1.19): preferir md.chatT (timestamp del chat según WA Web,
        // siempre actualizado al último mensaje) sobre s.lastTs (max de mensajes
        // CAPTURADOS, que sin backfill completo da hora de captura).
        // chatT viene en Unix segundos → convertir a ms.
        last_ts: (typeof md.chatT === 'number' && md.chatT > 0)
          ? md.chatT * 1000
          : (s.lastTs || null),
        first_ts: s.firstTs === Infinity ? null : s.firstTs,
      } : {
        total: 0, texto:0, imagen:0, video:0, audio:0, documento:0, ubicacion:0, contacto:0,
        sticker:0, sistema:0, entrantes:0, salientes:0, pct_entrante:0,
        // Aún sin mensajes capturados, ya tenemos chatT del store de WA → mostrar fecha real
        last_ts: (typeof md.chatT === 'number' && md.chatT > 0) ? md.chatT * 1000 : null,
        first_ts: null,
      },
      no_cliente_tags: noCliente.tags,
      no_cliente_score: noCliente.score,
    });
  }

  out.sort((a, b) => (b.stats.last_ts || 0) - (a.stats.last_ts || 0));
  return out;
}

async function obtenerMensajes(jid, limit = 200) {
  if (!jid) throw new Error('jid requerido');
  const all = await tx('messages', 'readonly', async store => {
    const idx = store.index('by_chat');
    const out = [];
    const cur = idx.openCursor(IDBKeyRange.only(jid));
    await new Promise(res => {
      cur.onsuccess = (e) => {
        const c = e.target.result;
        if (!c) { res(); return; }
        out.push(c.value);
        c.continue();
      };
      cur.onerror = () => res();
    });
    return out;
  });
  all.sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0));
  // Devolver los últimos `limit`
  return all.slice(-limit);
}

// PROCESAR un chat = sube TODO a Supabase + dispara identidad/agentes (vía evento_pg NUEVO)
async function procesarChat(jid) {
  if (!jid) return { error: 'jid requerido' };
  const { supabaseKey } = await getSettings();
  if (!supabaseKey) return { error: 'supabaseKey no configurada en la extensión' };

  // 1. Bloqueado? aborta
  const bloqueados = await getBloqueadosCache();
  if (bloqueados.has(jid)) return { error: 'chat bloqueado, desbloquéalo primero' };

  // Chequeo del chat en BD — incluye soft-deleted para soportar "Eliminar y re-procesar".
  //   - Vivo + ia_historico_procesado=true → ya procesado, hay que eliminar primero.
  //   - Soft-deleted (post Eliminar) → resucitar antes de seguir: si no, los UPSERTs
  //     e INSERTs con ignore-duplicates no des-eliminan nada y el chat nunca reaparece.
  //   - No existe → caso normal, el flujo lo crea.
  let chatPrevio = null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/chats?canal=eq.whatsapp&canal_chat_id=eq.${encodeURIComponent(jid)}&select=id,deleted_at,ia_historico_procesado,proyecto_id`,
      { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } },
    );
    if (r.ok) chatPrevio = (await r.json())[0] ?? null;
  } catch (_) {}
  if (chatPrevio && !chatPrevio.deleted_at && chatPrevio.ia_historico_procesado === true) {
    return { error: 'chat ya procesado anteriormente. Andá al módulo Captura y usá "🗑 Eliminar y re-procesar" si querés volver a subirlo.' };
  }
  if (chatPrevio?.deleted_at && typeof self.resucitarChatSoftDeleted === 'function') {
    try {
      await self.resucitarChatSoftDeleted(supabaseKey, chatPrevio.id, chatPrevio.proyecto_id);
      console.log(`[VPG-API] chat ${chatPrevio.id} (${jid}) resucitado tras eliminación previa`);
    } catch (e) {
      console.warn('[VPG-API] resucitar chat soft-deleted falló:', e?.message);
    }
  }

  // 2. Cargar metadata + mensajes locales
  const meta = await tx('chat_metadata', 'readonly', async store => {
    return await reqAsync(store.get(jid));
  });
  if (!meta) return { error: 'chat no encontrado en IndexedDB local' };

  const mensajesLocal = await obtenerMensajes(jid, 100000);
  if (mensajesLocal.length === 0) return { error: 'chat sin mensajes capturados todavía' };

  const titulo = tituloContacto(jid, meta.name, meta.verifiedName, meta.phoneNumber);
  const isGroup = !!meta.isGroup || jid.endsWith('@g.us');

  // 3. Upsert chat → obtiene chat_id_db (función ya definida en visor_pg_sync.js)
  const chatIdDb = await upsertChat({ supabaseKey, jid, titulo, isGroup });

  // 4. Insertar mensajes (idempotente por UNIQUE chat_id+canal_msg_id)
  const mensajesRows = mensajesLocal.map(m => canonicalToMensajeRow(m, chatIdDb));
  const headers = {
    'Content-Type':  'application/json',
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Prefer':        'resolution=ignore-duplicates,return=minimal',
  };
  // Subir en chunks de 500 para evitar timeouts en chats grandes
  const CHUNK = 500;
  for (let i = 0; i < mensajesRows.length; i += CHUNK) {
    const chunk = mensajesRows.slice(i, i + CHUNK);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/mensajes`, { method: 'POST', headers, body: JSON.stringify(chunk) });
    if (!r.ok && r.status !== 409) {
      const err = await r.text();
      throw new Error(`insert mensajes ${r.status}: ${err.slice(0, 200)}`);
    }
  }

  // 5. Insertar evento_pg para CADA mensaje (estado=NUEVO → worker pipeline lo identificará)
  const eventosRows = mensajesLocal.map(m => canonicalToEventoRow(m, chatIdDb));
  for (let i = 0; i < eventosRows.length; i += CHUNK) {
    const chunk = eventosRows.slice(i, i + CHUNK);
    const r = await fetch(`${SUPABASE_URL}/rest/v1/evento_pg`, { method: 'POST', headers, body: JSON.stringify(chunk) });
    if (!r.ok && r.status !== 409) {
      const err = await r.text();
      throw new Error(`insert evento_pg ${r.status}: ${err.slice(0, 200)}`);
    }
  }

  // 6. Marcar el chat como autorizado + histórico procesado (capa 3 ARQUITECTURA.md)
  const upd = await fetch(`${SUPABASE_URL}/rest/v1/chats?canal=eq.whatsapp&canal_chat_id=eq.${encodeURIComponent(jid)}`, {
    method: 'PATCH',
    headers: { ...headers, 'Prefer': 'return=minimal' },
    body: JSON.stringify({ ia_autorizado: true, ia_historico_procesado: true }),
  });
  if (!upd.ok) console.warn('[VPG-API] update chats flags falló', upd.status);

  // 7. Marcar mensajes locales como synced
  await tx('messages', 'readwrite', async store => {
    for (const m of mensajesLocal) {
      m.processing_state = 'synced';
      await reqAsync(store.put(m));
    }
  });

  return {
    ok: true,
    chat_id_db: chatIdDb,
    mensajes_subidos: mensajesLocal.length,
    eventos_creados: eventosRows.length,
  };
}

// ─── Bloqueo persistente en Supabase ──────────────────────────────

let bloqueadosCache = { ts: 0, set: new Set() };
const BLOQUEADOS_CACHE_TTL_MS = 60_000;

async function getBloqueadosCache() {
  const ahora = Date.now();
  if (ahora - bloqueadosCache.ts < BLOQUEADOS_CACHE_TTL_MS) return bloqueadosCache.set;
  bloqueadosCache.set = new Set(await listarBloqueados());
  bloqueadosCache.ts = ahora;
  return bloqueadosCache.set;
}

async function listarBloqueados() {
  const { supabaseKey } = await getSettings();
  if (!supabaseKey) return [];
  const r = await fetch(`${SUPABASE_URL}/rest/v1/chats_bloqueados?canal=eq.whatsapp&desbloqueado_at=is.null&select=canal_chat_id`, {
    headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` },
  });
  if (!r.ok) return [];
  const data = await r.json();
  return (data || []).map(x => x.canal_chat_id);
}

async function bloquearChat(jid, motivo, titulo) {
  if (!jid || !motivo) return { error: 'jid y motivo requeridos' };
  const { supabaseKey } = await getSettings();
  if (!supabaseKey) return { error: 'supabaseKey no configurada' };

  const r = await fetch(`${SUPABASE_URL}/rest/v1/chats_bloqueados?on_conflict=canal,canal_chat_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey,
      'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify({
      canal: 'whatsapp', canal_chat_id: jid, titulo_snapshot: titulo || null,
      motivo, bloqueado_por: 1, desbloqueado_at: null, desbloqueado_por: null, desbloqueado_motivo: null,
    }),
  });
  if (!r.ok) {
    const err = await r.text();
    return { error: `block ${r.status}: ${err.slice(0,200)}` };
  }
  bloqueadosCache.ts = 0;  // invalidar
  return { ok: true };
}

async function desbloquearChat(jid, motivo) {
  if (!jid) return { error: 'jid requerido' };
  const { supabaseKey } = await getSettings();
  if (!supabaseKey) return { error: 'supabaseKey no configurada' };
  const r = await fetch(`${SUPABASE_URL}/rest/v1/chats_bloqueados?canal=eq.whatsapp&canal_chat_id=eq.${encodeURIComponent(jid)}&desbloqueado_at=is.null`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}`,
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify({ desbloqueado_at: new Date().toISOString(), desbloqueado_motivo: motivo || null, desbloqueado_por: 1 }),
  });
  if (!r.ok) {
    const err = await r.text();
    return { error: `unblock ${r.status}: ${err.slice(0,200)}` };
  }
  bloqueadosCache.ts = 0;
  return { ok: true };
}

// ─── Transcripción de media de un chat ────────────────────────────
//
// Reglas duras (heredadas del Visor viejo, hardcoded — NO consultables):
//   - status@broadcast nunca se procesa
//   - stickers nunca
//   - forwarded_many_times nunca
//   - video nunca (Whisper no acepta MP4 nativo, Vision no resume video)
//   - imágenes: máx 10 por (chat, rol, minuto) — burst limit
//
// Reusa de background.v2.js: aiHardSkipReason, downloadAndDecryptMedia,
// refreshMediaViaContent, saveMediaBlob, processMediaWithAI, getSettings.

// Costos OpenAI (referencia mayo 2026):
const COSTO_WHISPER_USD_POR_MIN = 0.006;
const COSTO_VISION_USD_POR_IMG  = 0.0008;   // gpt-4o-mini detail:'low'
const COSTO_PDF_USD_POR_DOC     = 0.005;    // gpt-4o-mini con recorte 2 págs
const DURACION_AUDIO_DEFAULT_S  = 30;       // si no hay duración en metadata

// Clasifica los mensajes de un chat aplicando reglas duras.
// Retorna { procesables: [{msg, kind}], omitidos: {...} } sin llamar IA.
function clasificarMediaChat(mensajes) {
  const procesables = [];
  const omitidos = {
    sticker: 0, status_broadcast: 0, forwarded_many: 0,
    video: 0, burst_limit: 0, ya_procesado: 0,
  };

  const sorted = [...mensajes].sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0));
  const bucketCount = new Map();   // (chat|role|minuto) → conteo de imágenes

  for (const m of sorted) {
    const t = m.type;
    const esAudio   = (t === 'audio' || t === 'ptt');
    const esImagen  = (t === 'image');
    const esPdf     = (t === 'document' && (m.media?.mimetype || '').includes('pdf'));
    const esVideo   = (t === 'video');
    const esSticker = (t === 'sticker');

    if (!esAudio && !esImagen && !esPdf && !esVideo && !esSticker) continue;

    // Reglas duras (orden importa para contadores correctos)
    if (typeof m.chat_id === 'string' && m.chat_id.includes('status@broadcast')) { omitidos.status_broadcast++; continue; }
    if (m.is_forwarded_many_times === true) { omitidos.forwarded_many++; continue; }
    if (esSticker) { omitidos.sticker++; continue; }
    if (esVideo)   { omitidos.video++;   continue; }

    // Cache: ya procesado anteriormente (otra corrida)
    if (m.media?.ai_text && m.media?.ai_status === 'processed') { omitidos.ya_procesado++; continue; }

    // Burst limit en imágenes
    if (esImagen) {
      const minute = Math.floor((m.timestamp_ms || 0) / 60000);
      const role = m.is_owner ? 'yo' : 'cl';
      const key = `${m.chat_id}|${role}|${minute}`;
      const c = (bucketCount.get(key) || 0) + 1;
      bucketCount.set(key, c);
      if (c > 10) { omitidos.burst_limit++; continue; }
    }

    let kind;
    if (esAudio) kind = 'whisper';
    else if (esImagen) kind = 'vision';
    else if (esPdf) kind = 'pdf';

    procesables.push({ msg: m, kind });
  }

  return { procesables, omitidos };
}

// Estima costo de transcribir todo el media procesable de un chat.
async function estimarMediaChat(jid) {
  if (!jid) return { error: 'jid requerido' };
  const all = await obtenerMensajes(jid, 100000);
  const { procesables, omitidos } = clasificarMediaChat(all);

  let segundosAudio = 0;
  let imagenes = 0, pdfs = 0;
  for (const p of procesables) {
    if (p.kind === 'whisper') {
      const d = Number(p.msg.media?.seconds) || Number(p.msg.duration) || DURACION_AUDIO_DEFAULT_S;
      segundosAudio += d;
    } else if (p.kind === 'vision') imagenes++;
    else if (p.kind === 'pdf')      pdfs++;
  }

  const costo_audios   = (segundosAudio / 60) * COSTO_WHISPER_USD_POR_MIN;
  const costo_imagenes = imagenes * COSTO_VISION_USD_POR_IMG;
  const costo_pdfs     = pdfs * COSTO_PDF_USD_POR_DOC;

  return {
    procesables: {
      audios:   procesables.filter(p => p.kind === 'whisper').length,
      imagenes,
      pdfs,
    },
    omitidos,
    duracion_audio_seg: Math.round(segundosAudio),
    costo_estimado_usd: Math.round((costo_audios + costo_imagenes + costo_pdfs) * 10000) / 10000,
    desglose_costos: {
      audios:   Math.round(costo_audios * 10000) / 10000,
      imagenes: Math.round(costo_imagenes * 10000) / 10000,
      pdfs:     Math.round(costo_pdfs * 10000) / 10000,
    },
  };
}

// Transcribe todo el media procesable de un chat.
// Pool 3 paralelo (igual que MAX_AI_CONCURRENCY del background).
// Para cada media: descarga (si falta) → Whisper/Vision/PDF → UPDATE Supabase.
async function transcribirMediaChat(jid) {
  if (!jid) return { error: 'jid requerido' };

  const { supabaseKey, openaiKey } = await getSettings();
  if (!supabaseKey) return { error: 'supabaseKey no llegó del Visor (reiniciar npm run dev del Visor)' };
  if (!openaiKey)   return { error: 'openaiKey no llegó del Visor — chequear .env tiene VITE_OPENAI_API_KEY y reiniciar npm run dev' };

  // Resolver chat_id_db (cache o upsert)
  const meta = await tx('chat_metadata', 'readonly', s => reqAsync(s.get(jid)));
  const titulo = tituloContacto(jid, meta?.name, meta?.verifiedName, meta?.phoneNumber);
  const isGroup = !!meta?.isGroup || jid.endsWith('@g.us');
  const chat_id_db = await upsertChat({ supabaseKey, jid, titulo, isGroup });

  const all = await obtenerMensajes(jid, 100000);
  const { procesables, omitidos } = clasificarMediaChat(all);

  const stats = {
    audios: 0, imagenes: 0, pdfs: 0,
    errores: 0, cache_hits: 0, no_existentes_en_supabase: 0,
    irrecuperables_cdn: 0,            // CDN de WA borró el archivo (>17d sin actividad)
    errores_temporales: 0,            // network, rate limit OpenAI, etc — reintentables
    errores_inesperados_detalle: [],  // {msg_id, kind, error} — bugs reales
    omitidos_total: Object.values(omitidos).reduce((a, b) => a + b, 0),
    detalle_omitidos: omitidos,
    chat_id_db,
  };

  if (procesables.length === 0) {
    return { ok: true, stats };
  }

  // Worker pool: 3 paralelos
  let idx = 0;
  async function worker() {
    while (idx < procesables.length) {
      const my = idx++;
      const { msg, kind } = procesables[my];
      try {
        // 1. Descargar bytes si no están en blobs
        if (!msg.media?.sha256) {
          let result;
          try {
            result = await downloadAndDecryptMedia(msg);
          } catch (e) {
            // URL del CDN expirada o HMAC inválido → intentar refresh via WA Web
            const expirable = /expirada|HTTP \d|HMAC/i.test(e.message);
            if (!expirable) throw e;
            try {
              result = await refreshMediaViaContent(msg);
            } catch (refreshErr) {
              // Refresh también falló → archivo IRRECUPERABLE (CDN borró >17d)
              throw new Error('IRRECUPERABLE_CDN: ' + (refreshErr?.message || e.message));
            }
          }
          msg.media.sha256 = result.sha256;
          msg.media.download_status = 'downloaded';
          msg.media.mimetype = msg.media.mimetype || result.mimetype;
          await saveMediaBlob(result.sha256, result.bytes, result.mimetype);
          await tx('messages', 'readwrite', s => reqAsync(s.put(msg)));
        }

        // 2. IA con cache SHA-256 (processMediaWithAI hace check)
        const cachedAntes = await tx('media_processed', 'readonly', s => reqAsync(s.get(msg.media.sha256)));
        const entry = await processMediaWithAI(msg);
        if (cachedAntes?.text) stats.cache_hits++;

        if (!entry?.text) continue;   // unsupported / vacío

        msg.media.ai_text = entry.text;
        msg.media.ai_kind = entry.kind;
        msg.media.ai_status = 'processed';
        await tx('messages', 'readwrite', s => reqAsync(s.put(msg)));

        // 3. UPDATE Supabase (texto formateado + metadata.ai_*)
        const ok = await actualizarMensajeEnSupabase(supabaseKey, chat_id_db, msg);
        if (!ok) stats.no_existentes_en_supabase++;

        if (kind === 'whisper') stats.audios++;
        else if (kind === 'vision') stats.imagenes++;
        else if (kind === 'pdf') stats.pdfs++;
      } catch (e) {
        const msgErr = e?.message || String(e);
        console.warn(`[VPG-API] transcribir media ${msg.id}: ${msgErr}`);

        // Clasificar el error para reportar y marcar el mensaje
        const esIrrecuperable = /IRRECUPERABLE_CDN|UNRECOVERABLE/i.test(msgErr);
        const esTemporal = /timeout|rate.?limit|429|503|ECONNRESET|fetch failed/i.test(msgErr);

        if (esIrrecuperable) {
          stats.irrecuperables_cdn++;
          await marcarMensajeIrrecuperable(supabaseKey, chat_id_db, msg, kind, msgErr).catch(() => {});
        } else if (esTemporal) {
          stats.errores_temporales++;
          await marcarMensajeError(supabaseKey, chat_id_db, msg, 'temporal', msgErr).catch(() => {});
        } else {
          stats.errores++;
          stats.errores_inesperados_detalle.push({ msg_id: msg.id, kind, error: msgErr.slice(0, 200) });
          await marcarMensajeError(supabaseKey, chat_id_db, msg, 'inesperado', msgErr).catch(() => {});
        }
      }
    }
  }

  await Promise.all([worker(), worker(), worker()]);

  return { ok: true, stats };
}

// Marca un mensaje como IRRECUPERABLE (CDN de WA ya borró el archivo, >17d sin actividad).
// El mensaje queda con texto placeholder y `metadata.download_status='lost'` para distinguirlo
// de "pendiente de transcribir" en la UI.
async function marcarMensajeIrrecuperable(supabaseKey, chat_id_db, msg, kind, detalle) {
  const placeholder =
    kind === 'whisper' ? '🎤 [Audio no recuperable de WhatsApp · CDN expiró tras >17d]'
  : kind === 'vision'  ? '🖼 [Imagen no recuperable de WhatsApp · CDN expiró tras >17d]'
  : kind === 'pdf'     ? '📎 [Documento no recuperable de WhatsApp · CDN expiró tras >17d]'
  :                      '[Media no recuperable]';
  return await actualizarMetadataYTexto(supabaseKey, chat_id_db, msg, placeholder, {
    download_status: 'lost',
    download_motivo: 'cdn_expirado',
    download_detalle: detalle.slice(0, 200),
    ai_status: 'skipped_cdn_lost',
    intentado_at: new Date().toISOString(),
  });
}

// Marca un mensaje con error (temporal o inesperado). NO modifica el texto (preserva el original).
// El campo metadata.ai_status sirve para que la UI lo distinga de "pendiente".
async function marcarMensajeError(supabaseKey, chat_id_db, msg, tipo, detalle) {
  return await actualizarMetadataYTexto(supabaseKey, chat_id_db, msg, null, {
    ai_status: tipo === 'temporal' ? 'error_temporal' : 'error_inesperado',
    ai_error: detalle.slice(0, 200),
    intentado_at: new Date().toISOString(),
  });
}

// Helper común: read-modify-write del metadata jsonb + opcional UPDATE de texto.
async function actualizarMetadataYTexto(supabaseKey, chat_id_db, msg, textoNuevo, metaPatch) {
  const headers = { 'Content-Type': 'application/json', 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };
  const url = `${SUPABASE_URL}/rest/v1/mensajes?chat_id=eq.${chat_id_db}&canal_msg_id=eq.${encodeURIComponent(msg.id)}&select=metadata`;
  const getRes = await fetch(url, { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } });
  if (!getRes.ok) throw new Error(`get mensaje ${getRes.status}`);
  const rows = await getRes.json();
  if (!rows.length) return false;
  const meta = { ...(rows[0].metadata || {}), ...metaPatch };
  const body = textoNuevo !== null ? { texto: textoNuevo, metadata: meta } : { metadata: meta };
  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/mensajes?chat_id=eq.${chat_id_db}&canal_msg_id=eq.${encodeURIComponent(msg.id)}`,
    { method: 'PATCH', headers: { ...headers, 'Prefer': 'return=minimal' }, body: JSON.stringify(body) },
  );
  if (!patchRes.ok) throw new Error(`patch mensaje ${patchRes.status}: ${(await patchRes.text()).slice(0, 150)}`);
  return true;
}

// UPDATE de un mensaje en Supabase: rellena texto formateado + metadata.ai_*.
// Preserva campos previos del JSONB metadata (extractor_done, internal_id, etc).
// Retorna true si se actualizó, false si el mensaje no existe en Supabase.
async function actualizarMensajeEnSupabase(supabaseKey, chat_id_db, msg) {
  const ai_text = msg.media?.ai_text;
  const ai_kind = msg.media?.ai_kind;
  if (!ai_text || !ai_kind) return false;

  let textoNuevo;
  if (ai_kind === 'whisper')      textoNuevo = `🎤 ${ai_text}`;
  else if (ai_kind === 'vision')  textoNuevo = `🖼 [Imagen] ${ai_text}`;
  else if (ai_kind === 'pdf')     textoNuevo = `📎 ${msg.media?.file_name || ''} — RESUMEN: ${ai_text}`;
  else                            textoNuevo = ai_text;

  const headers = {
    'Content-Type':  'application/json',
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
  };

  // Read-modify-write para preservar otras keys del metadata jsonb.
  // PostgREST no soporta jsonb_set vía API, así que hacemos GET + PATCH.
  const url = `${SUPABASE_URL}/rest/v1/mensajes?chat_id=eq.${chat_id_db}&canal_msg_id=eq.${encodeURIComponent(msg.id)}&select=metadata`;
  const getRes = await fetch(url, { headers: { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` } });
  if (!getRes.ok) throw new Error(`get mensaje ${getRes.status}`);
  const rows = await getRes.json();
  if (!rows.length) return false;       // mensaje no existe en Supabase (chat sin procesar todavía)

  const meta = rows[0].metadata || {};
  meta.ai_text = ai_text;
  meta.ai_kind = ai_kind;
  meta.ai_status = 'processed';
  meta.ai_processed_at = new Date().toISOString();
  meta.ai_sha256 = msg.media?.sha256 || null;
  // Forzar re-extracción en próximo ciclo (ahora que hay texto real, no thumbnail base64)
  if (meta.extractor_done) delete meta.extractor_done;

  const patchRes = await fetch(
    `${SUPABASE_URL}/rest/v1/mensajes?chat_id=eq.${chat_id_db}&canal_msg_id=eq.${encodeURIComponent(msg.id)}`,
    {
      method: 'PATCH',
      headers: { ...headers, 'Prefer': 'return=minimal' },
      body: JSON.stringify({ texto: textoNuevo, metadata: meta }),
    },
  );
  if (!patchRes.ok) {
    const err = await patchRes.text();
    throw new Error(`patch mensaje ${patchRes.status}: ${err.slice(0, 150)}`);
  }
  return true;
}

// ─── V3_SET_KEYS — el Visor empuja credenciales (no más popup manual) ──
//
// El Visor lee `import.meta.env.VITE_*` (que viene del .env del proyecto) y
// llama a este endpoint en cada arranque. La extensión guarda las keys en
// chrome.storage.local (key 'ws_settings') donde getSettings() ya las lee.
//
// Decisión 2026-05-08 F2.3.B: elimina el flujo viejo del popup manual donde
// Jhon tenía que pegar las API keys a mano. El proyecto nuevo tiene una
// fuente única de verdad: el .env del Visor. La extensión es consumidora.
async function setKeysFromVisor({ supabaseKey, openaiKey, deepseekKey }) {
  if (!supabaseKey && !openaiKey && !deepseekKey) {
    return { error: 'al menos una key requerida' };
  }

  // Merge con lo que ya esté guardado (no sobrescribir keys ausentes con vacío)
  const SETTINGS_KEY = 'ws_settings';
  const r = await chrome.storage.local.get([SETTINGS_KEY]);
  const actual = r[SETTINGS_KEY] || {};
  const next = {
    deepseekKey: deepseekKey || actual.deepseekKey || '',
    supabaseKey: supabaseKey || actual.supabaseKey || '',
    openaiKey:   openaiKey   || actual.openaiKey   || '',
  };
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  console.log('[VPG-API] V3_SET_KEYS: keys actualizadas',
    `supabase=${!!next.supabaseKey} openai=${!!next.openaiKey} deepseek=${!!next.deepseekKey}`);
  return {
    ok: true,
    tiene_supabase: !!next.supabaseKey,
    tiene_openai:   !!next.openaiKey,
    tiene_deepseek: !!next.deepseekKey,
  };
}

// ─── V3_SET_REALTIME — el Visor prende/apaga el modo IA tiempo real ───
//
// Cuando ON: la extensión procesa y sincroniza TODOS los chats no bloqueados
// automáticamente, sin esperar el "Procesar" manual. El flag vive en
// chrome.storage.local (key 'ws_v2_ia_realtime_enabled'), donde getIAState()
// del background.v2.js ya lo lee. Persiste entre reinicios de Chrome.
async function setRealtimeFlag(enabled) {
  const on = !!enabled;
  const patch = { ws_v2_ia_realtime_enabled: on };
  // Al prender, marcar el momento: solo se procesan los mensajes de ahora en
  // adelante. El histórico viejo de un chat se sube con "Procesar".
  if (on) patch.ws_v2_ia_realtime_since = Date.now();
  await chrome.storage.local.set(patch);
  console.log('[VPG-API] V3_SET_REALTIME:', on ? 'ON' : 'OFF');
  return { ok: true, realtime: on };
}

// ─── V3_WA_STATUS — semáforo de conexión de WhatsApp Web ──────────────
//
// El Visor lo consulta cada ~10s para mostrar 🟢 Capturando / 🔴 Desconectado.
// Estrategia: ¿hay pestaña de web.whatsapp.com? -> preguntarle al content
// script si está vivo y logueado (#pane-side presente). Sin pestaña o sin
// respuesta => desconectado (no captura en tiempo real).
async function getWaStatus() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  } catch (e) {
    return { ok: true, conectado: false, motivo: 'error_tabs', detalle: 'No se pudo consultar pestañas: ' + e.message };
  }
  if (!tabs.length) {
    return { ok: true, conectado: false, motivo: 'sin_pestana', detalle: 'WhatsApp Web no está abierto' };
  }
  for (const tab of tabs) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { type: 'WA_PING' });
      if (r?.alive) {
        if (r.loggedIn) {
          return { ok: true, conectado: true, motivo: 'ok', detalle: 'Capturando en tiempo real', estado: r.estado };
        }
        return {
          ok: true, conectado: false,
          motivo: r.estado === 'qr' ? 'qr' : 'cargando',
          detalle: r.estado === 'qr' ? 'WhatsApp Web abierto: escaneá el QR' : 'WhatsApp Web cargando…',
          estado: r.estado,
        };
      }
    } catch (_) { /* content script no responde en esta pestaña: probar la siguiente */ }
  }
  return { ok: true, conectado: false, motivo: 'sin_respuesta', detalle: 'WhatsApp Web abierto pero no responde (recargá la pestaña)' };
}

console.log('[VPG-API] cargado v' + VISOR_API_VERSION);
