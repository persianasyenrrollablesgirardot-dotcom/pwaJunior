/* ═══════════════════════════════════════════════════════════════════
 * Visor PG — Sync módulo (reemplaza syncBatchToSupabase del Visor viejo)
 *
 * Escribe directo al schema nuevo del Visor PG:
 *   - chats           (UPSERT por canal+canal_chat_id=jid)
 *   - mensajes        (INSERT idempotente por chat_id+canal_msg_id)
 *   - evento_pg       (INSERT idempotente por canal+canal_msg_id+agente_origen=NULL)
 *
 * Cargado vía importScripts() en background.v2.js.
 * Reusa funciones globales: tx, reqAsync, getSettings, getIAState, SUPABASE_URL.
 *
 * NO toca: captura IndexedDB, descifrado HKDF, descarga de media, IA.
 * ═══════════════════════════════════════════════════════════════════ */

'use strict';

// Cache en memoria del SW: jid → chat_id_db (sobrevive hasta que el SW se duerme).
const chatIdCache = new Map();

// Cache de uniones únicas: msg_canal_id → boolean (ya sincronizado este wakeup).
const recentlySynced = new Set();
const RECENT_SYNCED_MAX = 5000;

// Mapeo de tipos del CanonicalMessage → tipo del schema mensajes.
// Tipos reales observados en IndexedDB de WhatsApp Web (extensión v4.0):
//   text, image, ptt, audio, video, document, location, vcard, sticker, album,
//   revoked, protocol, e2e_notification, call_log, notification_template, gp2,
//   unknown, event_creation, biz_content_placeholder, ciphertext, interactive,
//   list, buttons_response, list_response, template_button_reply, product
function mapTipoMensaje(canonicalType) {
  const map = {
    // Texto humano (incluye legacy chat/extendedText por compatibilidad)
    'text':         'texto',
    'chat':         'texto',
    'extendedText': 'texto',
    // Media
    'image':        'imagen',
    'album':        'imagen',
    'video':        'video',
    'audio':        'audio',
    'ptt':          'audio',           // push-to-talk = nota de voz
    'document':     'documento',
    'location':     'ubicacion',
    'live_location':'ubicacion',
    'vcard':        'contacto',
    'sticker':      'sticker',
    // Listas/botones interactivos = el cliente respondió o eligió. Texto-equivalente.
    'list_response':         'texto',
    'buttons_response':      'texto',
    'template_button_reply': 'texto',
    // El resto (revoked, protocol, e2e_notification, call_log, notification_template,
    // gp2, unknown, event_creation, biz_content_placeholder, ciphertext, interactive,
    // list, product) son ruido del sistema, no mensajes humanos
  };
  return map[canonicalType] || 'sistema';
}

// E.164 normalize: jid '573225458821@c.us' → '+573225458821'
function jidToTelefono(jid) {
  if (!jid) return null;
  if (jid.endsWith('@c.us')) {
    const num = jid.replace(/@c\.us$/, '').replace(/[^\d]/g, '');
    return num ? '+' + num : null;
  }
  return null;
}

// UPSERT chat. Retorna chat_id_db.
async function upsertChat({ supabaseKey, jid, titulo, isGroup }) {
  if (chatIdCache.has(jid)) return chatIdCache.get(jid);

  const headers = {
    'Content-Type':  'application/json',
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Prefer':        'resolution=merge-duplicates,return=representation',
  };

  const row = {
    canal:             'whatsapp',
    canal_chat_id:     jid,
    tipo:              isGroup ? 'grupo' : 'individual',
    titulo:            titulo || jid,
    ambito:            'comercial',          // MVP default; Jhon cambia desde el Visor
    ambito_confirmado: false,                // marca: el clasificador propuso, falta confirmación humana
  };

  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/chats?on_conflict=canal,canal_chat_id`,
    { method: 'POST', headers, body: JSON.stringify(row) },
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`upsert chats falló ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const chatIdDb = data?.[0]?.id;
  if (!chatIdDb) throw new Error('upsert chats: respuesta sin id');

  chatIdCache.set(jid, chatIdDb);
  return chatIdDb;
}

// Convierte CanonicalMessage → row de mensajes
function canonicalToMensajeRow(m, chatIdDb) {
  const texto = m.text ?? m.caption ?? null;
  const tsCanal = m.timestamp_ms ? new Date(m.timestamp_ms).toISOString() : new Date().toISOString();

  return {
    chat_id:        chatIdDb,
    canal_msg_id:   m.id,
    autor_jid:      m.is_owner ? null : (m.sender_jid || m.chat_id || null),
    persona_autor_id: null,
    direccion:      m.is_owner ? 'saliente' : 'entrante',
    tipo:           mapTipoMensaje(m.type),
    texto:          texto,
    media_url:      null,
    media_mime:     m.mimetype || null,
    metadata:       {
      internal_id:        m.internal_id,
      row_id:             m.row_id,
      ai_text:            m.ai_text || null,
      quoted_message_id:  m.quoted_message_id || null,
      quoted_sender_jid:  m.quoted_sender_jid || null,
      type_original:      m.type,
    },
    ts_canal:       tsCanal,
  };
}

// Convierte CanonicalMessage → row de evento_pg
function canonicalToEventoRow(m, chatIdDb) {
  const tsCanal = m.timestamp_ms ? new Date(m.timestamp_ms).toISOString() : new Date().toISOString();
  const texto = m.text ?? m.caption ?? '';
  const previewLen = 120;
  const preview = texto.length > previewLen ? texto.slice(0, previewLen) + '…' : texto;

  return {
    canal:            'whatsapp',
    canal_msg_id:     m.id,
    chat_id:          chatIdDb,
    persona_id:       null,                  // resuelve L1 (Identidad)
    proyecto_id:      null,
    inmueble_id:      null,
    ambito:           'comercial',           // MVP default; reescribe L1 si cambia
    tipo_evento:      m.is_owner ? 'mensaje_saliente' : 'mensaje_entrante',
    prioridad:        5,
    estado:           'NUEVO',
    payload:          {
      preview,
      tipo_canonical: m.type,
      tiene_media:    !!m.mimetype,
      autor_jid:      m.is_owner ? null : (m.sender_jid || m.chat_id || null),
    },
    // F1.21: vincular evento → mensaje origen para que el trigger
    // sync_evento_preview_from_mensaje pueda actualizar el preview cuando se transcriba
    evidencia_ids:    { msg_ids: [m.id] },
    agente_origen:    null,
    confianza:        null,
    shadow:           false,
    costo_usd:        0,
    ts_canal:         tsCanal,
  };
}

// Sync principal — reemplaza a syncBatchToSupabase del Visor viejo
async function syncToVisorPG() {
  if (typeof tx !== 'function') {
    console.warn('[VPG-SYNC] background helpers aún no listos, skip');
    return;
  }

  try {
    const { supabaseKey } = await getSettings();
    if (!supabaseKey) {
      console.warn('[VPG-SYNC] supabaseKey vacío, sync skip');
      return;
    }

    const ia = await getIAState();
    const whitelist = new Set(ia.whitelist || []);
    if (whitelist.size === 0) return;   // nada autorizado → sync skip

    // 1. Tomar mensajes ready_to_sync de chats autorizados
    const ready = await tx('messages', 'readonly', async store => {
      const idx = store.index('by_state');
      const out = [];
      const cursor = idx.openCursor(IDBKeyRange.only('ready_to_sync'));
      await new Promise(res => {
        cursor.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur || out.length >= 500) { res(); return; }
          if (whitelist.has(cur.value.chat_id)) out.push(cur.value);
          cur.continue();
        };
        cursor.onerror = () => res();
      });
      return out;
    });

    if (!ready.length) return;

    // 2. Cargar metadata de chats (nombres humanos)
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

    // 3. Agrupar por chat_id
    const grupos = new Map();
    for (const m of ready) {
      let g = grupos.get(m.chat_id);
      if (!g) { g = { jid: m.chat_id, mensajes: [] }; grupos.set(m.chat_id, g); }
      g.mensajes.push(m);
    }

    // 4. Por cada chat: upsert chat → batch insert mensajes → batch insert evento_pg
    let syncedMsgs = 0;
    let syncedEvts = 0;
    let failedMsgs = 0;

    for (const g of grupos.values()) {
      try {
        const md = metadataByJid.get(g.jid);
        const titulo = md?.name
                    || md?.verifiedName
                    || md?.phoneNumber
                    || (g.jid || '').replace(/@.*$/, '')
                    || 'desconocido';
        const isGroup = !!md?.isGroup || g.jid?.endsWith('@g.us');

        const chatIdDb = await upsertChat({ supabaseKey, jid: g.jid, titulo, isGroup });

        const headers = {
          'Content-Type':  'application/json',
          'apikey':        supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Prefer':        'resolution=ignore-duplicates,return=minimal',
        };

        // 4a. INSERT mensajes (idempotente por UNIQUE chat_id+canal_msg_id)
        const mensajesRows = g.mensajes.map(m => canonicalToMensajeRow(m, chatIdDb));
        const resMsg = await fetch(`${SUPABASE_URL}/rest/v1/mensajes`, {
          method:  'POST',
          headers,
          body:    JSON.stringify(mensajesRows),
        });
        if (!resMsg.ok && resMsg.status !== 409) {
          const errText = await resMsg.text();
          throw new Error(`insert mensajes ${resMsg.status}: ${errText.slice(0, 200)}`);
        }

        // 4b. INSERT evento_pg (idempotente por UNIQUE canal+canal_msg_id+agente_origen)
        // Solo eventos NUEVOS (no los ya sincronizados en este wakeup)
        const eventosRows = g.mensajes
          .filter(m => !recentlySynced.has(m.id))
          .map(m => canonicalToEventoRow(m, chatIdDb));

        if (eventosRows.length > 0) {
          const resEvt = await fetch(`${SUPABASE_URL}/rest/v1/evento_pg`, {
            method:  'POST',
            headers,
            body:    JSON.stringify(eventosRows),
          });
          if (!resEvt.ok && resEvt.status !== 409) {
            const errText = await resEvt.text();
            throw new Error(`insert evento_pg ${resEvt.status}: ${errText.slice(0, 200)}`);
          }

          // marcar en cache que estos ya se publicaron
          for (const m of g.mensajes) {
            recentlySynced.add(m.id);
            if (recentlySynced.size > RECENT_SYNCED_MAX) {
              const first = recentlySynced.values().next().value;
              recentlySynced.delete(first);
            }
          }
          syncedEvts += eventosRows.length;
        }

        // 4c. Marcar mensajes locales como synced
        await tx('messages', 'readwrite', async store => {
          for (const m of g.mensajes) {
            m.processing_state = 'synced';
            await reqAsync(store.put(m));
          }
        });

        syncedMsgs += g.mensajes.length;
      } catch (e) {
        failedMsgs += g.mensajes.length;
        console.warn(`[VPG-SYNC] chat=${g.jid} fallo: ${e.message}`);
      }
    }

    if (syncedMsgs > 0 || failedMsgs > 0) {
      console.log(`[VPG-SYNC] mensajes=${syncedMsgs}OK/${failedMsgs}fail eventos=${syncedEvts} chats=${grupos.size}`);
    }
  } catch (e) {
    console.error('[VPG-SYNC] fatal:', e.message);
  }
}

// Helper para que background.v2.js lo invoque
self.syncToVisorPG = syncToVisorPG;
