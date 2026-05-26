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

var SUPABASE_URL = 'https://olububjdvboiqgmihsmk.supabase.co';


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

// ─── Título de respaldo y corrector de nombres @lid (FASE 9 fix) ──────
// Placeholder visible para un chat @lid cuyo nombre humano aún no llegó.
const TITULO_PENDIENTE = '⏳ Identificando…';

// Título de respaldo cuando la metadata todavía no trae el nombre humano.
// Para @c.us el número ES el teléfono real y sí identifica al cliente.
// Para @lid el número es un identificador opaco e inútil como nombre →
// usamos un placeholder; reconciliarContactos lo reemplaza al llegar el
// nombre, así el cliente nunca aparece como un número largo sin sentido.
function tituloFallback(jid) {
  if (!jid) return 'desconocido';
  if (jid.endsWith('@lid'))  return TITULO_PENDIENTE;
  if (jid.endsWith('@g.us')) return 'Grupo sin nombre';
  return jid.replace(/@.*$/, '') || 'desconocido';
}
self.tituloFallback = tituloFallback;

// ¿El valor es un nombre PROVISIONAL (identificador crudo / placeholder) y
// no un nombre humano real? Garantiza que el corrector nunca pise un nombre
// bueno: un nombre real ("Nancy Bermúdez") o un teléfono ("+57…") no matchea.
function esTituloProvisional(valor, jid) {
  if (!valor) return true;
  const crudo = String(jid || '').replace(/@.*$/, '');
  return valor === crudo
      || valor === jid
      || valor === TITULO_PENDIENTE
      || valor === 'desconocido'
      || /^\d{6,}$/.test(valor);
}

// Corrector universal de contactos (reemplaza al corrector @lid parcial).
//
// Repasa cada 20 s (desde saveChatMetadata) lo que la extensión SÍ sabe de
// WhatsApp Web vs lo que quedó guardado en Supabase, y reconcilia:
//   - chats.titulo          cuando es provisional (número crudo, jid, placeholder…)
//   - personas.nombre       cuando es provisional
//   - personas.telefono_e164 cuando está null y la metadata tiene phoneNumber
//
// Cubre AMBOS tipos de JID (@c.us y @lid) sin discriminar — el filtro es por
// VALOR del campo, no por forma del JID. Marca personas.sintesis_pendiente
// para que el worker re-analice al toque.
//
// Garantías "sin romper nada":
//   - esTituloProvisional() solo reconoce valores provisionales conocidos.
//     Un nombre real ("Maritza Jhon", "Casa 64 Claudia", teléfono "+57…")
//     NUNCA matchea → no se toca.
//   - PATCH con filtro doble &col=eq.<valorExactoLeído>: si entre el GET y
//     el PATCH el valor cambió (corrección manual paralela), no afecta filas.
//   - Teléfono: filtro &telefono_e164=is.null → jamás pisa un teléfono manual.
async function reconciliarContactos(metadataList, supabaseKey) {
  if (!supabaseKey) return { nombres: 0, telefonos: 0 };

  // Mapa jid → { name?, phoneNumber? } con valores VÁLIDOS solamente.
  const mapa = new Map();
  for (const md of metadataList || []) {
    if (!md?.jid) continue;
    const entry = {};
    const nombre = String(md.name || md.verifiedName || '').trim();
    if (nombre && !esTituloProvisional(nombre, md.jid)) entry.name = nombre;
    const raw = typeof md.phoneNumber === 'string' ? md.phoneNumber.trim() : '';
    if (/^[+]?\d{8,}$/.test(raw)) {
      entry.phoneNumber = raw.startsWith('+') ? raw : '+' + raw;
    }
    if (entry.name || entry.phoneNumber) mapa.set(md.jid, entry);
  }
  if (mapa.size === 0) return { nombres: 0, telefonos: 0 };

  const headers = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };
  const patchHeaders = { ...headers, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' };

  // PATCH idempotente: filtra por el valor EXACTO leído. Si cambió, no afecta.
  async function patchExacto(tabla, idCol, idVal, valCol, valActual, valNuevo) {
    const url = `${SUPABASE_URL}/rest/v1/${tabla}`
      + `?${idCol}=eq.${encodeURIComponent(idVal)}`
      + `&${valCol}=eq.${encodeURIComponent(valActual)}`;
    const res = await fetch(url, {
      method: 'PATCH', headers: patchHeaders,
      body: JSON.stringify({ [valCol]: valNuevo }),
    });
    return res.ok;
  }
  // Teléfono: solo escribe si el actual es null (doble garantía en el server).
  async function patchTelefono(jid, telefono) {
    const url = `${SUPABASE_URL}/rest/v1/personas`
      + `?jid=eq.${encodeURIComponent(jid)}&telefono_e164=is.null`;
    const res = await fetch(url, {
      method: 'PATCH', headers: patchHeaders,
      body: JSON.stringify({ telefono_e164: telefono }),
    });
    return res.ok;
  }

  let nombresOK = 0, telefonosOK = 0;
  const personasAfectadas = new Set();

  // 1. chats.titulo — para CUALQUIER tipo de JID (sin discriminar @c.us/@lid).
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/chats?select=canal_chat_id,titulo&canal=eq.whatsapp`,
      { headers });
    if (res.ok) {
      for (const c of await res.json()) {
        const ent = mapa.get(c.canal_chat_id);
        if (!ent?.name || ent.name === c.titulo) continue;
        if (!esTituloProvisional(c.titulo, c.canal_chat_id)) continue;
        if (await patchExacto('chats', 'canal_chat_id', c.canal_chat_id, 'titulo', c.titulo, ent.name)) {
          nombresOK++;
        }
      }
    }
  } catch (e) { console.warn('[VPG-SYNC] reconciliar chats.titulo:', e.message); }

  // 2. personas — nombre Y teléfono en una sola pasada.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/personas?select=id,jid,nombre,telefono_e164`,
      { headers });
    if (res.ok) {
      for (const p of await res.json()) {
        const ent = mapa.get(p.jid);
        if (!ent) continue;
        let cambio = false;
        // 2.a Nombre — solo si el actual es provisional.
        if (ent.name && ent.name !== p.nombre && esTituloProvisional(p.nombre, p.jid)) {
          if (await patchExacto('personas', 'jid', p.jid, 'nombre', p.nombre, ent.name)) {
            nombresOK++;
            cambio = true;
          }
        }
        // 2.b Teléfono — solo si el actual es null.
        if (ent.phoneNumber && p.telefono_e164 == null) {
          if (await patchTelefono(p.jid, ent.phoneNumber)) {
            telefonosOK++;
            cambio = true;
          }
        }
        if (cambio) personasAfectadas.add(p.id);
      }
    }
  } catch (e) { console.warn('[VPG-SYNC] reconciliar personas:', e.message); }

  // 3. Marcar sintesis_pendiente para que el worker re-sintetice al toque.
  if (personasAfectadas.size > 0) {
    try {
      const ids = [...personasAfectadas].join(',');
      await fetch(
        `${SUPABASE_URL}/rest/v1/personas?id=in.(${ids})`,
        { method: 'PATCH', headers: patchHeaders, body: JSON.stringify({ sintesis_pendiente: true }) },
      );
    } catch (e) { console.warn('[VPG-SYNC] marcar sintesis_pendiente:', e.message); }
  }

  return { nombres: nombresOK, telefonos: telefonosOK };
}
self.reconciliarContactos = reconciliarContactos;

// Resucita un chat "eliminado" (soft-delete de eliminarChatProcesado): chat +
// mensajes + evento_pg + proyecto + persona + inmueble. Los eventos vuelven a
// estado='NUEVO' para que el worker los re-procese por el pipeline desde cero.
// Idempotente: si ya están vivos, los PATCH son inocuos.
async function resucitarChatSoftDeleted(supabaseKey, chatId, proyectoId) {
  const h = {
    'Content-Type':  'application/json',
    'apikey':        supabaseKey,
    'Authorization': `Bearer ${supabaseKey}`,
    'Prefer':        'return=minimal',
  };
  const hGet = { 'apikey': supabaseKey, 'Authorization': `Bearer ${supabaseKey}` };

  // 1. Chat: resucitar + resetear ia_historico_procesado (el flujo lo marca true al final).
  await fetch(`${SUPABASE_URL}/rest/v1/chats?id=eq.${chatId}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ deleted_at: null, ia_historico_procesado: false }),
  });
  // 2. Mensajes del chat.
  await fetch(`${SUPABASE_URL}/rest/v1/mensajes?chat_id=eq.${chatId}`, {
    method: 'PATCH', headers: h, body: JSON.stringify({ deleted_at: null }),
  });
  // 3. Eventos: revivir + resetear estado a NUEVO para re-procesar por el pipeline.
  await fetch(`${SUPABASE_URL}/rest/v1/evento_pg?chat_id=eq.${chatId}`, {
    method: 'PATCH', headers: h,
    body: JSON.stringify({ deleted_at: null, estado: 'NUEVO', procesando_por: null, procesando_hasta: null }),
  });

  // 4. Proyecto/persona/inmueble que arrastró el soft-delete en cascada.
  if (proyectoId) {
    let personaId = null, inmuebleId = null;
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/proyectos?id=eq.${proyectoId}&select=persona_id,inmueble_id`,
        { headers: hGet });
      if (r.ok) {
        const [p] = await r.json();
        personaId  = p?.persona_id  ?? null;
        inmuebleId = p?.inmueble_id ?? null;
      }
    } catch (_) {}
    await fetch(`${SUPABASE_URL}/rest/v1/proyectos?id=eq.${proyectoId}`, {
      method: 'PATCH', headers: h, body: JSON.stringify({ deleted_at: null }),
    });
    if (personaId != null) {
      await fetch(`${SUPABASE_URL}/rest/v1/personas?id=eq.${personaId}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ deleted_at: null }),
      });
    }
    if (inmuebleId != null) {
      await fetch(`${SUPABASE_URL}/rest/v1/inmuebles?id=eq.${inmuebleId}`, {
        method: 'PATCH', headers: h, body: JSON.stringify({ deleted_at: null }),
      });
    }
  }
}
self.resucitarChatSoftDeleted = resucitarChatSoftDeleted;

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
      ai_text:            m.media?.ai_text || m.ai_text || null,
      ai_status:          m.media?.ai_status || null,
      ai_error:           m.media?.ai_error || null,
      ai_kind:            m.media?.ai_kind || null,
      quoted_message_id:  m.quoted_message_id || null,
      quoted_sender_jid:  m.quoted_sender_jid || null,
      type_original:      m.type,
      subtype:            m.subtype || null,
      sys_raw:            m.sys_raw || null,
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
      subtype:        m.subtype || null,
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

    // syncToVisorPG es el MOTOR DE TIEMPO REAL: solo corre con realtime ON.
    // El procesamiento manual de un chat lo hace procesarChat() (extension_api.js).
    const ia = await getIAState();
    if (!ia.realtimeEnabled) return;
    const realtimeSince = ia.realtimeSince || 0;
    const bloqueados = (typeof getBloqueadosCache === 'function')
      ? await getBloqueadosCache()
      : new Set();
    const chatPermitido = (chatId) =>
      !!chatId && !chatId.includes('status@broadcast') && !bloqueados.has(chatId);

    // 1. Tomar mensajes ready_to_sync — TODOS los chats no bloqueados (Punto 2),
    //    pero solo los posteriores al momento en que se prendió tiempo real.
    //    Un chat bloqueado deja de subir sus mensajes al instante (Punto 3).
    const ready = await tx('messages', 'readonly', async store => {
      const idx = store.index('by_state');
      const out = [];
      const cursor = idx.openCursor(IDBKeyRange.only('ready_to_sync'));
      await new Promise(res => {
        cursor.onsuccess = (e) => {
          const cur = e.target.result;
          if (!cur || out.length >= 500) { res(); return; }
          const m = cur.value;
          const margenTolerancia = 86400000; // 24 horas de margen para tolerar desincronización de reloj y offline
          if (chatPermitido(m.chat_id) && (m.timestamp_ms || 0) >= (realtimeSince - margenTolerancia)) {
            out.push(m);
          }
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
                    || tituloFallback(g.jid);
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
