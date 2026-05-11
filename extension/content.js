/* ═══════════════════════════════════════════════════════════
 * WhatsApp Captura Safra — Content Script (mundo aislado)
 *
 * Arquitectura real (confirmada por diagnóstico):
 *   - WhatsApp NO usa <audio> tags. Usa Web Audio API.
 *   - Los blobs de audio se crean al presionar "Reproducir
 *     mensaje de voz" via URL.createObjectURL.
 *   - patch.js (world MAIN) intercepta createObjectURL y avisa
 *     aquí por postMessage cuando hay un blob nuevo.
 *   - Este script hace click programático en los botones de
 *     play de cada fila con data-icon="ptt-status" para forzar
 *     que WhatsApp cree los blobs de audios no reproducidos.
 * ════════════════════════════════════════════════════════ */

'use strict';

console.log('[WS-CONTENT] content.js cargado', new Date().toISOString());

// v2: bumpeado tras cambios de schema (_domIdx, blobUrl en audios). El cache
// viejo bajo 'ws_captures_local' queda huérfano y se ignora — evita que los
// mensajes capturados con código antiguo se mezclen con los nuevos.
const LOCAL_KEY = 'ws_captures_local_v2';

// ─── Estado ──────────────────────────────────────────────────

let lastSnapshotHash = '';
let lastSyncAt       = 0;
let mainObserver     = null;
let sideObserver     = null;
let scanTimer        = null;

const transcriptions      = new Map();   // blobUrl audio → transcripción
const imageDescriptions   = new Map();   // blobUrl imagen → descripción Vision
const pdfSummariesByFile  = new Map();   // fileName.toLowerCase() → resumen GPT
const pendingTx           = new Set();   // blobUrls audio en proceso
const pendingImg          = new Set();   // blobUrls imagen en proceso
const pendingPdfKeys      = new Set();   // stableKeys pdf en proceso
// WeakMap<row, timestampMs> en vez de WeakSet — permite reintentar audios
// cuyo click previo no produjo un blob (típico cuando la decriptación de WA
// falla por timing o virtualización). Cooldown de 15s por fila evita spam.
const clickedAt           = new WeakMap();
// Mismo patrón para PDFs — auto-click en thumbnail abre el visor;
// cerramos clickeando el botón "X" del [data-testid="media-viewer-modal"].
// Cooldown por FILENAME (no DOM ref): WA virtualiza/rebuild rows constante-
// mente; un WeakMap<row> pierde el cooldown al rebuild → loop. Map<key,ts>
// con key=`filename|role|date|time` sobrevive cualquier rebuild del DOM.
const pdfClickedKey       = new Map();   // key estable → timestamp ms
let   pdfClickInFlight    = false;
const capturedAudioUrls   = [];          // URLs audio en orden de captura
const capturedImageUrls   = [];          // URLs imagen en orden de captura
const urlContact          = new Map();   // url → contactName o null
let currentContactName    = null;        // nombre del chat abierto ahora

// Resolución de teléfonos para contactos agendados (WhatsApp esconde
// el número del header cuando el contacto está en agenda). Abrimos
// brevemente el panel de info una vez por contacto, leemos el número,
// cerramos con Escape y cacheamos en chrome.storage.local para siempre.
const PHONE_CACHE_KEY   = 'ws_phone_cache';
let   phoneCache        = {};             // contactName → "+573001234567"
const phoneResolveTried = new Set();      // contactNames intentados en esta sesión
let   resolvingPhone    = false;          // lock: una resolución a la vez

chrome.storage.local.get([PHONE_CACHE_KEY]).then(v => {
  phoneCache = v[PHONE_CACHE_KEY] || {};
  console.log('[WS-CONTENT] 📞 phone cache:', Object.keys(phoneCache).length, 'entradas');
}).catch(() => {});

// ─── Utilidades ──────────────────────────────────────────────

function isAlive() {
  try { return !!chrome.runtime?.id; } catch (_) { return false; }
}

// Banner de actualización — si la extensión pierde conexión con Chrome
// (pasa cuando cambiamos código y Chrome la recarga), mostramos un aviso
// con un botón para recargar WhatsApp Web sin que el usuario tenga que
// adivinar qué hacer.
let __wsReloadBanner = null;
function showReloadBanner() {
  if (__wsReloadBanner || !document.body) return;
  const el = document.createElement('div');
  el.id = '__ws_reload_banner';
  el.setAttribute('style', [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:2147483647',
    'background:linear-gradient(90deg,#7c3aed,#a78bfa)', 'color:#fff',
    'padding:10px 16px', 'text-align:center',
    'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
    'font-size:13px', 'font-weight:600',
    'box-shadow:0 2px 14px rgba(0,0,0,.35)',
    'display:flex', 'align-items:center', 'justify-content:center', 'gap:14px',
  ].join(';'));
  el.innerHTML = `
    <span>🔄 WhatsApp Captura Safra se actualizó — recarga para seguir capturando</span>
    <button id="__ws_reload_btn" style="
      padding:6px 14px;background:#fff;color:#7c3aed;
      border:none;border-radius:6px;cursor:pointer;
      font-weight:700;font-size:12px;
    ">Recargar ahora</button>
    <button id="__ws_dismiss_btn" style="
      padding:6px 10px;background:transparent;color:#fff;
      border:1px solid rgba(255,255,255,.5);border-radius:6px;cursor:pointer;
      font-size:11px;
    ">Ignorar</button>
  `;
  document.body.appendChild(el);
  __wsReloadBanner = el;
  document.getElementById('__ws_reload_btn')?.addEventListener('click', () => location.reload());
  document.getElementById('__ws_dismiss_btn')?.addEventListener('click', () => {
    el.remove(); __wsReloadBanner = null;
  });
}

// Chequeo periódico — si perdimos el contexto, mostramos el banner
setInterval(() => {
  if (!isAlive()) showReloadBanner();
}, 3000);

function t(el) { return (el?.innerText || '').trim(); }

// Patrones que WhatsApp Web usa para el botón de expandir mensajes largos.
// Cubrimos español, inglés y portugués. Algunos botones solo dicen "más"
// (sin "leer/mostrar/ver"), por eso lo aceptamos como bandera independiente
// si está aislado en un span clickeable corto.
const EXPAND_LABEL_REGEX = /(leer\s+m[áa]s|mostrar\s+m[áa]s|ver\s+m[áa]s|read\s+more|show\s+more|see\s+more|ler\s+mais|exibir\s+mais|continuar\s+lendo|read all)/i;
// "más" / "more" sólo (texto único en botón corto)
const EXPAND_SHORT_REGEX = /^(m[áa]s|more|mais)\s*\.{0,3}\s*$/i;

// Encuentra el botón "Leer más / Mostrar más / Read more" dentro del row.
// Busca de forma amplia: por aria-label, por texto visible, por role=button
// o por element <button>. Devuelve null si no hay tal botón.
function findExpandButton(row) {
  // 1) Por aria-label (label largo)
  const candidates = row.querySelectorAll(
    '[role="button"][aria-label], button[aria-label], [aria-label]'
  );
  for (const el of candidates) {
    const label = (el.getAttribute('aria-label') || '').toLowerCase();
    if (EXPAND_LABEL_REGEX.test(label) || EXPAND_SHORT_REGEX.test(label)) return el;
  }
  // 2) Por texto visible en elementos típicamente clickeables
  const clickables = row.querySelectorAll('[role="button"], button, span[role="button"], div[role="button"]');
  for (const el of clickables) {
    const txt = (el.textContent || '').trim();
    if (txt.length > 0 && txt.length < 30 && (EXPAND_LABEL_REGEX.test(txt) || EXPAND_SHORT_REGEX.test(txt))) return el;
  }
  // 3) Cualquier nodo hoja con texto que coincida (span/div con onClick implícito)
  const all = row.querySelectorAll('span, div');
  for (const el of all) {
    if (el.children.length > 0) continue;
    const txt = (el.textContent || '').trim();
    if (txt.length > 0 && txt.length < 30 && (EXPAND_LABEL_REGEX.test(txt) || EXPAND_SHORT_REGEX.test(txt))) {
      const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
      if (cs?.cursor === 'pointer' || el.hasAttribute('tabindex') || el.onclick) return el;
    }
  }
  // 4) HEURÍSTICA POR ELLIPSIS: si el row contiene "…" al final del texto
  //    visible, hay un "Leer más" oculto. Buscamos el elemento más cercano
  //    al ellipsis que sea clickeable y lo devolvemos.
  const txtRow = (row.textContent || '');
  if (/[…]\s*$/.test(txtRow.trim()) || /\.{3}\s*[Mm][áa]s/.test(txtRow)) {
    // Buscar cualquier elemento con cursor:pointer dentro del row
    const allEls = row.querySelectorAll('*');
    for (const el of allEls) {
      const cs = el.ownerDocument.defaultView?.getComputedStyle(el);
      if (cs?.cursor === 'pointer' && el.children.length < 3) {
        const t = (el.textContent || '').trim();
        if (t.length > 0 && t.length < 50) return el;
      }
    }
  }
  return null;
}

// Click realista — WhatsApp puede ignorar `.click()` si detecta que no es
// trusted. Disparamos pointerdown + pointerup + click + mousedown + mouseup
// para emular interacción humana lo mejor posible.
function realisticClick(el) {
  if (!el) return;
  const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
  try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('mousedown',     opts)); } catch (_) {}
  try { el.dispatchEvent(new PointerEvent('pointerup',   opts)); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('mouseup',       opts)); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('click',         opts)); } catch (_) {}
  try { el.click(); } catch (_) {}
}

// Cache para evitar re-clickear el MISMO botón cada scan (después del click,
// el botón ya no debería estar; pero por seguridad).
const expandedButtons = new WeakSet();

// Expande TODOS los mensajes con "Leer más" en el chat actual antes del scan.
// Se llama una vez por scan global, no por mensaje, para minimizar el costo.
function expandAllLongMessages() {
  const main = document.querySelector('#main');
  if (!main) return 0;
  const rows = main.querySelectorAll('.message-in, .message-out');
  let clicked = 0;
  for (const row of rows) {
    const btn = findExpandButton(row);
    if (btn && !expandedButtons.has(btn)) {
      expandedButtons.add(btn);
      realisticClick(btn);
      clicked++;
    }
  }
  return clicked;
}

// Extrae el texto COMPLETO del cuerpo de un mensaje. Usa textContent (no
// innerText) para que WhatsApp no nos recorte por CSS de ellipsis/overflow.
// Asume que ya se llamó expandAllLongMessages() previamente para que los
// "Leer más" estén expandidos.
function extractMsgText(row) {
  // Doble seguridad: si llegamos a este row con un "Leer más" todavía sin
  // clickear (por ejemplo recién renderizado), lo expandimos ahora.
  const btn = findExpandButton(row);
  if (btn && !expandedButtons.has(btn)) {
    expandedButtons.add(btn);
    realisticClick(btn);
  }

  // Buscar el contenedor del cuerpo. Preferimos `selectable-text` que es
  // donde WhatsApp pone el texto rico, incluso si visualmente está truncado
  // por CSS. textContent recoge el texto del DOM aunque esté oculto.
  const bodyEl = row.querySelector('span.selectable-text')
              || row.querySelector('div.copyable-text [data-pre-plain-text] + div span')
              || row.querySelector('span[dir="ltr"]')
              || row.querySelector('span[dir]');
  if (bodyEl) {
    const txt = (bodyEl.textContent || '').trim();
    // Si el texto termina en ellipsis "…" o "..." es señal de que quedó
    // colapsado a pesar del click — lo logueamos para diagnosticar.
    if (txt.length > 0) {
      if (/[…]$|\.\.\.\s*$/.test(txt) && txt.length < 200) {
        console.warn('[WS-CONTENT] mensaje sigue truncado tras expandir:', txt.slice(-40));
      }
      return txt;
    }
  }
  // Fallback al método antiguo para no romper casos atípicos.
  const meta = row.querySelector('[data-pre-plain-text]');
  return t(meta?.querySelector('span')) || t(row.querySelector('span[dir]')) || '';
}

function send(msg) {
  if (!isAlive()) return;
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// ─── Contacto ────────────────────────────────────────────────

function extractContact() {
  const header = document.querySelector('#main header');
  if (!header) return null;

  const spans = Array.from(header.querySelectorAll('span'));
  let name = null;
  for (const s of spans) {
    const x = t(s);
    if (x && x.length > 1 && x.length < 80 && !x.includes('\n')) { name = x; break; }
  }
  if (!name) return null;

  let phone = null;
  for (const s of spans) {
    const x = t(s);
    if (x && /^\+?\d[\d\s\-]{7,}$/.test(x)) { phone = x.replace(/\s/g, ''); break; }
  }

  let profilePic = null;
  const img = header.querySelector('img');
  if (img?.src && img.src.startsWith('http')) profilePic = img.src;

  let presence = null, lastSeen = null;
  for (const s of spans) {
    const x = t(s); const low = x.toLowerCase();
    if (!low) continue;
    if (low === 'en línea' || low === 'online' || low.startsWith('escribiendo') || low.startsWith('typing')) {
      presence = x; break;
    }
    if (low.includes('última vez') || low.includes('last seen') || low.startsWith('visto') || low.startsWith('hace ')) {
      lastSeen = x;
    }
  }

  const isGroup = /\d+\s+(participantes|members)/i.test(header.innerText || '');

  // Fallback 1: algunos data-id (en ciertas versiones de WA) contienen
  // el JID con "@c.us". Si está, lo usamos.
  if (!phone && !isGroup) {
    const els = document.querySelectorAll('#main [data-id]');
    for (const el of els) {
      const id = el.getAttribute('data-id') || '';
      const m = id.match(/(\d{7,15})@c\.us/);
      if (m) { phone = '+' + m[1]; break; }
    }
  }

  // Fallback 2: cache poblada por resolvePhoneViaPanel (panel de info).
  if (!phone && !isGroup && name && phoneCache[name]) {
    phone = phoneCache[name];
  }

  return { name, phone, profilePic, presence, lastSeen, isGroup };
}

// ─── Resolución de teléfono via panel de info ────────────────

function collectPhonesOutsideChatAndList() {
  const phones = new Set();
  const main = document.querySelector('#main');
  const side = document.querySelector('#pane-side');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (main && main.contains(node)) continue;
    if (side && side.contains(node)) continue;
    const txt = node.nodeValue.trim();
    if (/^\+?\d[\d\s\-]{7,}$/.test(txt)) phones.add(txt.replace(/\s/g, ''));
  }
  return phones;
}

async function closeInfoDrawer() {
  // Escape dos veces (a veces el drawer tiene sub-vistas)
  for (let i = 0; i < 2; i++) {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
    }));
    await new Promise(r => setTimeout(r, 120));
  }
  // Fallback: botón Cerrar/Back fuera de main y sidebar
  const main = document.querySelector('#main');
  const side = document.querySelector('#pane-side');
  const btns = document.querySelectorAll(
    '[aria-label="Cerrar"], [aria-label="Close"], [aria-label="Atrás"], [aria-label="Back"]'
  );
  for (const b of btns) {
    if (main?.contains(b) || side?.contains(b)) continue;
    try { b.click(); } catch (_) {}
    break;
  }
}

async function resolvePhoneViaPanel(name, isGroup) {
  if (!name || isGroup) return;
  if (phoneCache[name]) return;
  if (phoneResolveTried.has(name)) return;
  if (resolvingPhone) return;
  phoneResolveTried.add(name);
  resolvingPhone = true;

  try {
    const header = document.querySelector('#main header');
    if (!header) return;

    // Validar que seguimos en el mismo chat
    const stillSame = extractContact();
    if (!stillSame || stillSame.name !== name) return;

    // Snapshot de teléfonos visibles fuera del chat y sidebar
    const before = collectPhonesOutsideChatAndList();

    // Click al header → abre panel de info
    const target = header.querySelector('[role="button"]')
                || header.querySelector('div[tabindex]')
                || header;
    try { target.click(); } catch (_) {}

    // Esperar hasta 2s a que aparezca un teléfono nuevo
    let phone = null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      const now = collectPhonesOutsideChatAndList();
      const diff = [...now].filter(p => !before.has(p));
      if (diff.length > 0) { phone = diff[0]; break; }
    }

    await closeInfoDrawer();

    if (phone) {
      phoneCache[name] = phone;
      chrome.storage.local.set({ [PHONE_CACHE_KEY]: phoneCache }).catch(() => {});
      lastSnapshotHash = '';
      lastSyncAt = 0;
      scheduleScan(300);
      console.log('[WS-CONTENT] 📞 resuelto', name, '→', phone);
    } else {
      console.log('[WS-CONTENT] 📞 no encontrado para', name);
    }
  } catch (e) {
    if (!isAlive() || /Extension context invalidated/i.test(e?.message || '')) {
      showReloadBanner();
    } else {
      console.warn('[WS-CONTENT] resolvePhone error:', e);
    }
  } finally {
    resolvingPhone = false;
  }
}

// ─── Mensajes ────────────────────────────────────────────────

// Detección STRICTA de audio. Solo `ptt-status` (push-to-talk = mensaje de voz)
// es señal inequívoca. `audio-play`/`audio-pause` también aparecen en catálogos
// y otras cards multimedia → SOLO los aceptamos si además hay aria-label
// explícito de "mensaje de voz".
function isAudioRow(row) {
  if (row.querySelector('[data-icon="ptt-status"]')) return true;
  const hasVoiceLabel = [...row.querySelectorAll('[aria-label]')].some(el =>
    /(mensaje de voz|voice message|voice note|reproduzir mensagem de voz)/i
      .test((el.getAttribute('aria-label') || '').toLowerCase()));
  if (hasVoiceLabel) return true;
  return false;
}

// Catálogo de WA Business — se envía como card con productos. No debe
// confundirse con audio ni con imagen (aunque tenga thumbnails).
function isCatalogRow(row) {
  if (row.querySelector('[data-icon="catalog"], [data-icon="shopping-bag"], [data-icon="business-catalog"]')) return true;
  for (const el of row.querySelectorAll('[aria-label]')) {
    const l = (el.getAttribute('aria-label') || '').toLowerCase().trim();
    if (/^(catálogo|catalog|productos|products|ver catálogo|view catalog|abrir catálogo|open catalog)$/i.test(l)) return true;
  }
  // Heurística: card con múltiples thumbnails de producto + texto con precios
  const blobImgs = [...row.querySelectorAll('img')].filter(img => (img.src || '').startsWith('blob:'));
  const txt = (row.textContent || '');
  // 2+ imágenes y texto con marcas de precio → muy probable catálogo
  if (blobImgs.length >= 2 && /\$\s?\d[\d.,]+/.test(txt)) return true;
  return false;
}

// Imagen — detección amplia. WhatsApp Web cambia el data-icon entre versiones,
// así que combinamos múltiples señales.
function isImageRow(row) {
  // data-icons conocidos de imagen
  if (row.querySelector('[data-icon="image"], [data-icon="media-image"], [data-icon="status-image"], [data-icon="picture-broken"]')) return true;
  // <img> con blob: o src de la CDN de WA — suelen ser thumbnails de imagen
  const imgs = row.querySelectorAll('img');
  for (const img of imgs) {
    const src = img.src || img.getAttribute('src') || '';
    // blob: o web.whatsapp.com — descartar avatares (en otros contenedores)
    if ((src.startsWith('blob:') || /web\.whatsapp\.com/.test(src)) &&
        (img.naturalWidth > 80 || img.width > 80 || img.naturalHeight > 80 || img.height > 80)) {
      return true;
    }
  }
  // aria-label de imagen
  for (const el of row.querySelectorAll('[aria-label]')) {
    const l = (el.getAttribute('aria-label') || '').toLowerCase().trim();
    if (/^(foto|photo|imagen|image|abrir foto|open photo|abrir imagen|open image|descargar foto|descargar imagen|download photo|download image)$/i.test(l)) return true;
  }
  return false;
}

// Video — <video> tag, data-icon, o aria-label
function isVideoRow(row) {
  if (row.querySelector('video')) return true;
  if (row.querySelector('[data-icon="media-video"], [data-icon="video"], [data-icon="media-play"]')) return true;
  for (const el of row.querySelectorAll('[aria-label]')) {
    const l = (el.getAttribute('aria-label') || '').toLowerCase();
    if (/^(video|reproducir video|reproduzir video)$/i.test(l)) return true;
  }
  return false;
}

// Sticker — figura sin texto, data-icon "sticker"
function isStickerRow(row) {
  if (row.querySelector('[data-icon="sticker"], [data-icon="sticker-refreshed"]')) return true;
  return false;
}

// Llamada (perdida, contestada, videollamada). Estructura distinta a mensajes
// normales — las burbujas de llamada tienen iconos específicos.
function isCallRow(row) {
  if (row.querySelector('[data-icon="call"], [data-icon="call-outgoing"], [data-icon="call-incoming"], [data-icon="missed-voice-call"], [data-icon="missed-video-call"], [data-icon="video-call"], [data-icon="video"]')) {
    // Confirmar que NO es solo un botón de llamar dentro de otro contenido —
    // los rows de registro de llamada son cortos y no tienen mensaje real.
    const txt = (row.textContent || '').trim();
    if (txt.length < 200) return true;
  }
  for (const el of row.querySelectorAll('[aria-label]')) {
    const l = (el.getAttribute('aria-label') || '').toLowerCase().trim();
    if (/(llamada perdida|missed call|videollamada|video call|llamada de voz|voice call|llamada saliente|outgoing call|llamada entrante|incoming call)/i.test(l)) return true;
  }
  // Texto típico de registro de llamada
  const txt = (row.textContent || '').trim().toLowerCase();
  if (/^(llamada perdida|missed call|sin contestar|videollamada perdida|llamada de voz|llamada de video|video llamada)/i.test(txt)) return true;
  // Duración tipo "0:32" o "1:05" como única información del row + corto
  if (txt.length < 80 && /\b\d{1,2}:\d{2}\b/.test(txt) && /(llamada|call)/.test(txt)) return true;
  return false;
}

// Ubicación
function isLocationRow(row) {
  if (row.querySelector('[data-icon="location-refreshed"], [data-icon="location"]')) return true;
  for (const el of row.querySelectorAll('[aria-label]')) {
    const l = (el.getAttribute('aria-label') || '').toLowerCase();
    if (/^(ubicación|location|localização)$/i.test(l)) return true;
  }
  return false;
}

// Documentos PDF/Excel/Word/imagen como adjunto. WhatsApp Web los renderiza
// con un icono específico + nombre de archivo. Sin esta detección la
// extensión los captura como text='Cotizacion_COT-1720.pdf' sin metadata.
function isDocumentRow(row) {
  // Guard contra falsos positivos: si el row YA es claramente un audio
  // (botón "Reproducir mensaje de voz" o data-icon=ptt-status), NO lo
  // clasifiques como document aunque tenga ic-download. WA Web pone un
  // icono de descarga incluso en bubbles de audio cuando se hace hover.
  // Bug visto: audio sin transcribir → text="10:08 a. m." (la hora del
  // bubble) → isDocumentRow lo agarraba por ic-download + tamaño visible.
  if (isAudioRow(row)) return false;
  // Igual para imagen genuina (con <img blob > 80x80 visible) — el viewer
  // PDF inline también muestra ic-download pero el row real es image.
  if (row.querySelector('[data-icon="image"], [data-icon="media-image"]')) return false;
  // Cualquier data-icon que empiece con "document" — cubre "document",
  // "document-refreshed", "document-PDF-icon", "document-pdf", etc.
  if (row.querySelector('[data-icon^="document"]')) return true;
  if (row.querySelector('[data-icon="pdf"], [data-icon^="pdf"]')) return true;
  // data-testid="document-thumb" — botón para abrir/ver el archivo
  if (row.querySelector('[data-testid="document-thumb"]')) return true;
  if (row.querySelector('a[href$=".pdf" i]'))        return true;
  // ic-download / download — archivo genérico con tamaño en kB/MB/GB.
  // WA Web pone el icono como <title>ic-download</title> dentro de un SVG,
  // no como atributo data-icon. Buscamos en los <title> elementos del row.
  if (row.querySelector('[data-icon="ic-download"], [data-icon="download"], [data-icon^="ic-download"]')) {
    const txt = (row.textContent || '');
    if (/\d+(?:[.,]\d+)?\s*(kB|MB|GB|KB|Mb|Gb)/.test(txt)) return true;
  }
  // Fallback: buscar "ic-download" en cualquier <title> SVG dentro del row
  // + tamaño en el textContent. Ejemplo: foto enviada como archivo, PDF
  // sin thumbnail visible, archivo descargable genérico.
  const svgTitles = [...row.querySelectorAll('title')].map(t => (t.textContent || '').toLowerCase());
  if (svgTitles.some(t => /^(ic-download|download|file|file-attachment)$/.test(t))) {
    const txt = (row.textContent || '');
    if (/\d+(?:[.,]\d+)?\s*(kB|MB|GB|KB|Mb|Gb)/.test(txt)) return true;
  }
  // Heurística por aria-label
  const labelEls = row.querySelectorAll('[aria-label]');
  for (const el of labelEls) {
    const l = (el.getAttribute('aria-label') || '').toLowerCase();
    if (/(documento|document|descargar|download)/i.test(l)) {
      const txt = (row.textContent || '').toLowerCase();
      if (/\.(pdf|docx?|xlsx?|pptx?|zip|rar|csv|txt|jpg|jpeg|png|gif|mp4)\b/.test(txt)) return true;
      if (/\d+(?:[.,]\d+)?\s*(kb|mb|gb)/i.test(txt)) return true;
    }
  }
  // Heurística por contenido: extensión de archivo + páginas/tamaño
  const visible = (row.textContent || '').trim();
  if (visible.length < 300 && /\b\S+\.(pdf|docx?|xlsx?|pptx?|zip|csv|txt)\b/i.test(visible)) return true;
  return false;
}

// El texto extraído ES sólo una hora ("1:36 p. m." / "10:47 a.m." / "10:47").
// Esto pasa cuando es un audio sin captura de blob: WhatsApp muestra la hora
// del audio en el bubble y la extensión la lee como texto.
function isOnlyTimeText(t) {
  return /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?)?\s*$/i.test((t || '').trim());
}

async function extractMessages() {
  // ── Expandir mensajes largos ANTES de leer ──
  const expandidos = expandAllLongMessages();
  if (expandidos > 0) {
    console.log(`[WS-CONTENT] 📖 expandidos ${expandidos} "Leer más" — esperando inyección DOM`);
    // WhatsApp inyecta el texto expandido asíncronamente. Sin este delay,
    // el textContent puede leer la versión todavía truncada. 250ms cubre
    // la mayoría de los casos; si en algún chat necesita más, el siguiente
    // scan (3s después) lo capturará completo y mergeMessages lo upgrade.
    await new Promise(r => setTimeout(r, 250));
  }

  const list = [];
  const rows = [...document.querySelectorAll('#main .message-in, #main .message-out')];
  const audioRows = rows.filter(r => isAudioRow(r));
  const imageRows = rows.filter(r => isImageRow(r));

  // Mapeo posicional de blobs a rows: las últimas N URLs capturadas
  // corresponden a las N rows visibles del tipo (asume orden cronológico
  // estable entre creación de blob y orden DOM).
  const filterByContact = (urls) => urls.filter(u => {
    const o = urlContact.get(u);
    return !o || o === currentContactName;
  });
  // Mapeo posicional solo para audio + imagen (sus blobs viven en parent).
  // Los PDFs se asocian por stableKey directo en la rama isDocumentRow.
  const audioCandidates = filterByContact(capturedAudioUrls).slice(-audioRows.length);
  const imageCandidates = filterByContact(capturedImageUrls).slice(-imageRows.length);
  const rowUrl      = new Map();
  const imageRowUrl = new Map();
  audioRows.forEach((r, i) => { if (audioCandidates[i]) rowUrl.set(r, audioCandidates[i]); });
  imageRows.forEach((r, i) => { if (imageCandidates[i]) imageRowUrl.set(r, imageCandidates[i]); });

  // Estado de herencia: WhatsApp solo pone data-pre-plain-text en algunas
  // filas (típicamente la primera de cada grupo del mismo remitente). Las
  // siguientes filas heredan msgDate (y, dentro del mismo grupo, también time
  // si no lo tienen propio). Sin esto, audios consecutivos quedaban con
  // msgDate='' y se sorteaban al inicio del listado.
  let lastMsgDate = '';
  let lastTime    = '';
  let lastRole    = null;

  // Contador de ráfagas de imágenes — limita Vision API a las primeras 3 por
  // (role, msgDate, time). Cuando se envían 5+ imágenes al mismo minuto del
  // mismo remitente (típico catálogo o ráfaga comercial), solo describimos
  // las primeras 3 — el resto se guarda como `🖼 [Imagen]` sin descripción.
  // Ahorra ~70% de costo Vision en chats con ráfagas frecuentes.
  const imgBucketCount = new Map();
  const IMG_BURST_LIMIT = 3;

  rows.forEach((row, _domIdx) => {
    const isOut   = row.classList.contains('message-out');
    const role    = isOut ? 'yo' : 'cliente';
    const meta    = row.querySelector('[data-pre-plain-text]');
    const timeRaw = meta?.getAttribute('data-pre-plain-text') || '';
    // data-pre-plain-text trae "[hora, fecha]". Variantes vistas:
    //   "[1:18 p. m., 25/4/2026]"  → ES con año 4 dígitos
    //   "[1:18 p. m., 25/4/26]"    → año 2 dígitos
    //   "[1:18 PM, 4/25/2026]"     → EN
    //   "[10:00 a. m.]"            → algunos audios solo traen hora
    // Regex permisiva: 1-4 dígitos en el año.
    const tdM = timeRaw.match(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\.?)?),\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\]/i);
    let time    = tdM ? tdM[1] : (timeRaw.match(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\.?)?)/i)?.[1] || '');
    let msgDate = tdM ? tdM[2] : '';

    // Normalizar año de 2 dígitos → 4 dígitos asumiendo 2000+. Sin esto,
    // "20/4/26" sortearía antes que "20/4/2026" en el orden lex.
    if (msgDate && /^\d{1,2}\/\d{1,2}\/\d{2}$/.test(msgDate)) {
      const parts = msgDate.split('/');
      msgDate = `${parts[0]}/${parts[1]}/20${parts[2]}`;
    }

    // Snapshot ANTES de aplicar herencia, para saber si el timestamp salió
    // del propio data-pre-plain-text de la fila o vino prestado del bloque
    // previo. Esa distinción se propaga al backend como timestamp_quality
    // y permite que el Visor marque visualmente los rows de orden incierto.
    const hadOwnTime = !!time;
    const hadOwnDate = !!msgDate;

    // Herencia de msgDate: WA NO repite el atributo en grupos consecutivos.
    if (!msgDate && lastMsgDate) msgDate = lastMsgDate;
    // Herencia de time: SOLO dentro del mismo grupo del mismo rol y solo
    // si la fila tampoco tiene su propio time. Audios sin time bajo un texto
    // del mismo remitente heredan la hora aproximada del bloque.
    if (!time && lastTime && role === lastRole) time = lastTime;

    // Calidad del timestamp:
    //   exact     = la fila tenía data-pre-plain-text propio con hora Y fecha
    //   inherited = la fila NO tenía atributo (o era parcial) pero
    //               completamos hora+fecha desde el bloque previo del rol
    //   inferred  = ni propio ni heredable; el processor caerá a captured_at
    //               y el Visor debe avisar que el orden es dudoso
    let timestamp_quality;
    if (hadOwnTime && hadOwnDate)        timestamp_quality = 'exact';
    else if (time && msgDate)            timestamp_quality = 'inherited';
    else                                 timestamp_quality = 'inferred';

    if (msgDate) lastMsgDate = msgDate;
    if (time)    { lastTime = time; lastRole = role; }

    // ORDEN DE DETECCIÓN: del más específico/inequívoco al más genérico.
    // Audio va ÚLTIMO entre los multimedia para que catálogos/llamadas/imágenes
    // no terminen como audio aunque tengan algún signal ambiguo.

    // Llamada — registros de llamada perdida/contestada. Estructura distinta
    // a los mensajes; debe detectarse antes que audio (la llamada puede tener
    // botón "Reproducir" o icono ambiguo).
    if (isCallRow(row)) {
      const detalle = (row.textContent || '').trim().slice(0, 120) || '(llamada)';
      list.push({ role, text: `📞 ${detalle}`, time, msgDate, type: 'call', _domIdx, timestamp_quality });
      return;
    }

    // Catálogo — card con productos. Múltiples thumbnails + precios.
    if (isCatalogRow(row)) {
      const detalle = (extractMsgText(row) || '(sin descripción)').slice(0, 200);
      list.push({ role, text: `🛒 [Catálogo] ${detalle}`, time, msgDate, type: 'catalog', _domIdx, timestamp_quality });
      return;
    }

    // Documento adjunto. Puede ser PDF (path principal: auto-click + Vision)
    // o IMAGEN enviada como archivo (route a Vision API gpt-4o-mini igual
    // que las imágenes normales). Otros tipos (docx/xlsx/zip) caen al path
    // genérico sin procesamiento por ahora.
    if (isDocumentRow(row)) {
      const fileNameAndSize = extractMsgText(row) || '(documento)';
      // Extraer filename — primero PDF/DOC/XLS, luego imagen-como-archivo.
      const pdfMatch = fileNameAndSize.match(/(\S+\.(?:pdf|docx?|xlsx?|pptx?))/i);
      const imgFileMatch = fileNameAndSize.match(/(\S+\.(?:jpe?g|png|gif|webp|heic|heif))/i);
      const isImageFile = !pdfMatch && !!imgFileMatch;

      if (isImageFile) {
        // Imagen enviada como archivo. Buscar blob en imageRowUrl o
        // capturedImageUrls. Disparar DESCRIBE_IMAGE igual que image normal.
        const blobUrl = imageRowUrl.get(row) || null;
        const desc = blobUrl ? imageDescriptions.get(blobUrl) : null;
        const burstKey = `${role}|${msgDate}|${time}`;
        const burstIdx = (imgBucketCount.get(burstKey) || 0) + 1;
        imgBucketCount.set(burstKey, burstIdx);
        const inBurstRange = burstIdx <= IMG_BURST_LIMIT;
        if (blobUrl && !desc && !pendingImg.has(blobUrl) && inBurstRange) {
          pendingImg.add(blobUrl);
          console.log(`[WS-CONTENT] 🖼 DESCRIBE_IMAGE (file) → ...${blobUrl.slice(-12)} ${imgFileMatch[1]}`);
          send({ type: 'DESCRIBE_IMAGE', blobUrl, owner: currentContactName });
        }
        let text;
        if (desc) text = `🖼 [Imagen-archivo ${imgFileMatch[1]}] ${desc}`;
        else if (blobUrl && pendingImg.has(blobUrl)) text = `🖼 [Imagen-archivo ${imgFileMatch[1]} describiendo...]`;
        else text = `🖼 [Imagen-archivo ${imgFileMatch[1]}]`;
        list.push({ role, text, time, msgDate, type: 'image', blobUrl, _domIdx, timestamp_quality, burst_index: burstIdx });
        return;
      }

      // PDF/DOC/XLS path tradicional. El resumen lo asociamos por filename:
      // patch.js en iframe captura el blob + filename, background lo manda a
      // OpenAI, el resumen llega con el filename y matchea acá.
      const fileName = pdfMatch ? pdfMatch[1].toLowerCase() : null;
      const summary = fileName ? pdfSummariesByFile.get(fileName) : null;
      const docKey = pdfStableKey(row, role, msgDate, time);
      const isPending = pendingPdfKeys.has(docKey);

      let text;
      if (summary) {
        text = `📎 ${fileNameAndSize} — RESUMEN: ${summary}`;
      } else if (isPending) {
        text = `📎 ${fileNameAndSize} (resumiendo...)`;
      } else {
        text = `📎 ${fileNameAndSize}`;
      }
      list.push({ role, text, time, msgDate, type: 'document', _domIdx, timestamp_quality });
      return;
    }

    // Ubicación
    if (isLocationRow(row)) {
      const detalle = extractMsgText(row) || '(ubicación)';
      list.push({ role, text: `📍 ${detalle}`, time, msgDate, type: 'location', _domIdx, timestamp_quality });
      return;
    }

    // Sticker
    if (isStickerRow(row)) {
      list.push({ role, text: '🖼 [Sticker]', time, msgDate, type: 'sticker', _domIdx, timestamp_quality });
      return;
    }

    // Video con caption opcional
    if (isVideoRow(row)) {
      let caption = extractMsgText(row) || '';
      if (isOnlyTimeText(caption)) caption = '';
      const text = caption ? `📹 [Video] ${caption}` : '📹 [Video]';
      list.push({ role, text, time, msgDate, type: 'video', _domIdx, timestamp_quality });
      return;
    }

    // Imagen con caption opcional. Si extractMsgText devuelve solo la hora
    // visible del bubble, la descartamos. Si tenemos blobUrl, pedimos a la
    // Vision API una descripción y la insertamos como prefijo del caption.
    if (isImageRow(row)) {
      let caption = extractMsgText(row) || '';
      if (isOnlyTimeText(caption)) caption = '';
      const blobUrl = imageRowUrl.get(row) || null;
      const desc = blobUrl ? imageDescriptions.get(blobUrl) : null;

      // Contar la posición dentro de la ráfaga (mismo role+date+time).
      // Solo describimos las primeras IMG_BURST_LIMIT (3) imágenes del bucket.
      const burstKey = `${role}|${msgDate}|${time}`;
      const burstIdx = (imgBucketCount.get(burstKey) || 0) + 1;
      imgBucketCount.set(burstKey, burstIdx);
      const inBurstRange = burstIdx <= IMG_BURST_LIMIT;

      // Disparar descripción si: hay blob, no la tenemos aún, no está pendiente,
      // y estamos dentro del límite de ráfaga.
      if (blobUrl && !desc && !pendingImg.has(blobUrl) && inBurstRange) {
        pendingImg.add(blobUrl);
        console.log(`[WS-CONTENT] 🖼 DESCRIBE_IMAGE → ...${blobUrl.slice(-12)} (ráfaga ${burstIdx}/${IMG_BURST_LIMIT}, key=${burstKey})`);
        send({ type: 'DESCRIBE_IMAGE', blobUrl, owner: currentContactName });
      } else if (!inBurstRange && blobUrl) {
        // Loguear el límite alcanzado para que sea visible en debugging.
        console.log(`[WS-CONTENT] 🚫 burst skip — imagen ${burstIdx} de la ráfaga ${burstKey}`);
      }

      let text;
      if (desc) {
        text = caption ? `🖼 [Imagen] ${desc} · Caption: ${caption}` : `🖼 [Imagen] ${desc}`;
      } else if (!inBurstRange) {
        // Imagen #4+ en ráfaga — no describir. Marcar para que la Analista
        // sepa que hubo más imágenes pero no se procesaron individualmente.
        text = caption ? `🖼 [Imagen ráfaga #${burstIdx}] ${caption}` : `🖼 [Imagen ráfaga #${burstIdx} sin describir]`;
      } else if (blobUrl && pendingImg.has(blobUrl)) {
        text = caption ? `🖼 [Imagen describiendo...] ${caption}` : '🖼 [Imagen describiendo...]';
      } else {
        text = caption ? `🖼 [Imagen] ${caption}` : '🖼 [Imagen]';
      }
      // burst_index propaga la posición dentro del bucket (role|date|time)
      // para que el processor lo incluya en message_key. Sin esto, N imágenes
      // pendientes de describir comparten text='🖼 [Imagen describiendo...]'
      // → mismo hash de texto → upsert con dedup colapsa N rows en 1 y
      // perdemos info silenciosamente.
      list.push({ role, text, time, msgDate, type: 'image', blobUrl, _domIdx, timestamp_quality, burst_index: burstIdx });
      return;
    }

    // Audio — ÚLTIMO entre multimedia. Si llegamos aquí, ya descartamos call/
    // catalog/document/location/sticker/video/image. isAudioRow es estricto
    // (solo ptt-status o aria-label "mensaje de voz").
    if (isAudioRow(row)) {
      const blobUrl = rowUrl.get(row) || null;
      const tx      = blobUrl ? transcriptions.get(blobUrl) : null;
      if (tx) {
        list.push({ role, text: `🎤 ${tx}`, time, msgDate, type: 'audio', blobUrl, _domIdx, timestamp_quality });
      } else if (blobUrl && pendingTx.has(blobUrl)) {
        list.push({ role, text: '🎤 (transcribiendo...)', time, msgDate, type: 'audio_pending', blobUrl, _domIdx, timestamp_quality });
      } else {
        list.push({ role, text: '🎤 (audio sin transcribir)', time, msgDate, type: 'audio_pending', blobUrl, _domIdx, timestamp_quality });
      }
      return;
    }

    const text = extractMsgText(row);
    if (!text || text.length < 2) return;

    // Última defensa: si el texto extraído es SOLO una hora, casi seguro es un
    // audio que no pudimos detectar como tal (WhatsApp cambió iconos).
    // Lo marcamos como audio_pending para no contaminar el chat con "1:36 p. m."
    // como si fuera un mensaje real del cliente.
    if (isOnlyTimeText(text)) {
      const horaText = text.trim();
      list.push({
        role,
        text: '🎤 (audio sin transcribir)',
        time: time || horaText,   // si no había time del meta, usar la hora visible
        msgDate, type: 'audio_pending', _domIdx, timestamp_quality,
      });
      return;
    }

    list.push({ role, text, time, msgDate, type: 'text', _domIdx, timestamp_quality });
  });

  return list;
}

// ─── Forzar carga de blobs — click silencioso en play ────────

// Mute global del tab (WhatsApp usa Web Audio). Intentamos
// bajar el volumen de todos los audios que sean HTMLAudioElement
// y escondemos el sonido de los nuevos que se creen.
function muteAllAudio() {
  document.querySelectorAll('audio, video').forEach(a => {
    try { a.muted = true; a.volume = 0; } catch (_) {}
  });
}

// In-flight tracking: si un row ya tiene un click activo (esperando que WA
// decripte y emita el blob), NO relanzamos. Esto cubre el caso de audios
// largos donde la decriptación tarda > 15s — antes el cooldown se vencía
// mientras seguía el flight, y el siguiente scan re-clickeaba interrumpiendo
// la decriptación en curso → blob nunca llegaba.
const audioInFlight = new WeakMap();  // row → { startedAt, cleanup }

function clickPlay(row) {
  // Si hay flight activo, no relanzar. Su finalize() limpia el slot.
  if (audioInFlight.has(row)) return;
  // Cooldown 30s después del último intento FINALIZADO. Aplica solo cuando
  // ya no hay flight (la condición de arriba). Sin esto, un audio que falló
  // (timeout duro a 25s) se reintentaría inmediatamente en el próximo scan.
  const last = clickedAt.get(row) || 0;
  if (last && Date.now() - last < 30000) return;

  const btn = row.querySelector('button[aria-label="Reproducir mensaje de voz"]')
           || row.querySelector('[role="button"][aria-label="Reproducir mensaje de voz"]');
  if (!btn) return;

  muteAllAudio();

  try {
    // Click real (WhatsApp a veces requiere pointer events)
    const rect = btn.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5, view: window };
    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
    btn.dispatchEvent(new MouseEvent('mousedown',   opts));
    btn.dispatchEvent(new PointerEvent('pointerup',   opts));
    btn.dispatchEvent(new MouseEvent('mouseup',     opts));
    btn.dispatchEvent(new MouseEvent('click',       opts));
  } catch (_) {
    try { btn.click(); } catch (__) {}
  }

  // Sensor activo: pausar cuando el <audio> esté listo (emite loadedmetadata
  // o canplay), no a 8s ciegos. Esos eventos disparan DESPUÉS de que WA llamó
  // URL.createObjectURL — lo que significa que patch.js ya interceptó el blob
  // y postMessage para transcribirlo está en cola. Pausar antes (8s ciego)
  // detenía la decriptación a mitad de camino y perdíamos ~10% de audios
  // largos.
  let paused = false;
  let attached = null;
  let attachInt = null;
  let timeoutId = null;

  const finalize = () => {
    if (attachInt) clearInterval(attachInt);
    if (timeoutId) clearTimeout(timeoutId);
    if (attached) {
      try { attached.removeEventListener('loadedmetadata', onReady); } catch (_) {}
      try { attached.removeEventListener('canplay',        onReady); } catch (_) {}
      try { attached.removeEventListener('loadeddata',     onReady); } catch (_) {}
    }
    audioInFlight.delete(row);
    clickedAt.set(row, Date.now());
  };

  const onReady = () => {
    if (paused) return;
    paused = true;
    muteAllAudio();
    // Pequeño delay para asegurar que el postMessage del patch ya se procesó
    // y el blob está en capturedAudioUrls antes de pausar.
    setTimeout(() => clickPauseBtn(row), 200);
    finalize();
  };

  const tryAttach = () => {
    if (attached) return true;
    const a = row.querySelector('audio');
    if (!a) return false;
    attached = a;
    a.addEventListener('loadedmetadata', onReady, { once: true });
    a.addEventListener('canplay',        onReady, { once: true });
    a.addEventListener('loadeddata',     onReady, { once: true });
    return true;
  };

  // Polling: el <audio> element no existe aún cuando hacemos click; aparece
  // cuando WA llama URL.createObjectURL y asigna .src. Probamos cada 200ms.
  let attachAttempts = 0;
  if (!tryAttach()) {
    attachInt = setInterval(() => {
      if (tryAttach() || ++attachAttempts > 125) {  // 125 * 200ms = 25s
        clearInterval(attachInt);
        attachInt = null;
      }
    }, 200);
  }

  // Mute agresivo durante toda la ventana de espera (hasta 25s).
  [0, 50, 100, 200, 500, 1000, 2000, 3000, 5000, 7000, 10000, 13000, 17000, 22000].forEach(ms =>
    setTimeout(muteAllAudio, ms));

  // Timeout duro a 25s: si el <audio> nunca emite loadedmetadata (decrypt
  // falló o WA no creó el elemento), pausamos igual y dejamos cooldown
  // operar. El próximo scan a >30s permitirá reintento.
  audioInFlight.set(row, { startedAt: Date.now() });
  timeoutId = setTimeout(() => {
    if (paused) return;
    paused = true;
    clickPauseBtn(row);
    finalize();
  }, 25000);
}

function clickPauseBtn(row) {
  const pauseBtn = row.querySelector('button[aria-label="Pausar mensaje de voz"]')
                || row.querySelector('[role="button"][aria-label="Pausar mensaje de voz"]');
  if (pauseBtn) try { pauseBtn.click(); } catch (_) {}
}

function scanAudioRows() {
  if (!isAlive() || !currentContactName) return;
  const rows     = document.querySelectorAll('#main .message-in, #main .message-out');
  const audios   = [...rows].filter(isAudioRow);
  const candidates = capturedAudioUrls.filter(u => {
    const o = urlContact.get(u);
    return !o || o === currentContactName;
  });
  if (audios.length <= candidates.length) return;
  audios.forEach(row => clickPlay(row));
}

// ─── PDF auto-click + close viewer (modo activo silencioso) ──
// El visor de PDF es [data-testid="media-viewer-modal"]. Lo cerramos
// SOLO con su botón X específico (`button[aria-label="Cerrar"]` dentro
// del modal) — verificado vía CDP que cierra sin navegar atrás.
// NUNCA usar Escape: WA lo interpreta como "back" y crea loop.

function pdfViewerIsOpen() {
  return !!document.querySelector('[data-testid="media-viewer-modal"]');
}

function closePdfViewer() {
  const viewer = document.querySelector('[data-testid="media-viewer-modal"]');
  if (!viewer) return false;
  const closeBtn = viewer.querySelector('button[aria-label="Cerrar"]')
                || viewer.querySelector('button[aria-label="Close"]');
  if (!closeBtn) return false;
  try {
    closeBtn.click();
    return true;
  } catch (_) {
    return false;
  }
}

// Identificador estable de un row de PDF que sobrevive rebuild del DOM.
function pdfStableKey(row, role, msgDate, time) {
  const text = (row.textContent || '');
  const fileMatch = text.match(/(\S+\.(?:pdf|docx?|xlsx?|pptx?))/i);
  const filename = fileMatch ? fileMatch[1].toLowerCase() : (text.slice(0, 40).replace(/\s+/g, ''));
  return `${filename}|${role}|${msgDate || ''}|${time || ''}`;
}

function clickPdfThumb(row, stableKey) {
  // Cooldown 5min por (filename, role, date, time) — sobrevive rebuild DOM
  const last = pdfClickedKey.get(stableKey) || 0;
  if (Date.now() - last < 5 * 60 * 1000) return;
  // Si ya tenemos resumen para este filename, skip
  const filenameInKey = stableKey.split('|')[0];
  if (pdfSummariesByFile.has(filenameInKey)) return;
  if (pdfViewerIsOpen()) return;
  if (pdfClickInFlight) return;

  pdfClickInFlight = true;
  pdfClickedKey.set(stableKey, Date.now());
  pendingPdfKeys.add(stableKey);

  const btn = row.querySelector('[data-testid="document-thumb"]')
           || row.querySelector('div[role="button"][title*=".pdf" i]')
           || row.querySelector('div[role="button"]');
  if (!btn) { pdfClickInFlight = false; return; }

  console.log(`[WS-PDF] 📎 auto-click ${stableKey.slice(0, 60)}`);

  try {
    btn.click();
  } catch (_) {}

  // Esperar 2.5s para que abra y se capture el blob, luego cerrar UNA VEZ.
  // Si fallar el cierre, reintentar UN par de veces más con backoff.
  let attempts = 0;
  const tryClose = () => {
    attempts++;
    if (!pdfViewerIsOpen()) {
      // ya cerrado (raro, pero ok)
      pdfClickInFlight = false;
      return;
    }
    if (closePdfViewer()) {
      console.log('[WS-PDF] ✓ visor cerrado');
      pdfClickInFlight = false;
      return;
    }
    if (attempts < 3) {
      setTimeout(tryClose, 1000);
    } else {
      console.warn('[WS-PDF] ⚠ no se cerró el visor — el usuario debe cerrar manualmente');
      pdfClickInFlight = false;
    }
  };
  setTimeout(tryClose, 2500);
}

function scanPdfRows() {
  if (!isAlive() || !currentContactName) return;
  if (pdfClickInFlight) return;
  if (pdfViewerIsOpen()) return;
  const rows = [...document.querySelectorAll('#main .message-in, #main .message-out')];
  const docs = rows.filter(r => isDocumentRow(r));
  if (docs.length === 0) return;
  // Encontrar el primer doc que NO tenga ya resumen y cuyo cooldown esté
  // vencido. Sin resumen = no procesado todavía.
  for (const r of docs) {
    const isOut = r.classList.contains('message-out');
    const role = isOut ? 'yo' : 'cliente';
    const meta = r.querySelector('[data-pre-plain-text]');
    const timeRaw = meta?.getAttribute('data-pre-plain-text') || '';
    const tdM = timeRaw.match(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?\s?m\.?)?),\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\]/i);
    const time = tdM ? tdM[1] : '';
    const msgDate = tdM ? tdM[2] : '';
    const k = pdfStableKey(r, role, msgDate, time);
    const filenameInKey = k.split('|')[0];
    if (pdfSummariesByFile.has(filenameInKey)) continue;  // ya tiene resumen
    if (pendingPdfKeys.has(k))                  continue;  // en proceso
    const last = pdfClickedKey.get(k) || 0;
    if (Date.now() - last < 5 * 60 * 1000) continue;
    clickPdfThumb(r, k);
    break;
  }
}

// ─── Recibir blobs desde el patch (world MAIN) ───────────────

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d) return;

  if (d.__wsCapturaEvent === 'audio_blob') {
    const url = d.url;
    const owner = d.contactName || null;
    if (!url || transcriptions.has(url)) return;
    if (!urlContact.has(url)) {
      urlContact.set(url, owner);
      capturedAudioUrls.push(url);
      if (capturedAudioUrls.length > 200) capturedAudioUrls.splice(0, capturedAudioUrls.length - 200);
    }
    if (!pendingTx.has(url)) {
      pendingTx.add(url);
      send({ type: 'TRANSCRIBE_AUDIO', blobUrl: url });
    }
    if (!owner || owner === currentContactName) scheduleScan(200);
    return;
  }

  if (d.__wsCapturaEvent === 'image_blob') {
    const url = d.url;
    const owner = d.contactName || null;
    if (!url || imageDescriptions.has(url)) return;
    if (!urlContact.has(url)) {
      urlContact.set(url, owner);
      capturedImageUrls.push(url);
      if (capturedImageUrls.length > 300) capturedImageUrls.splice(0, capturedImageUrls.length - 300);
    }
    // No pedimos describe acá — lo dispara extractMessages cuando la fila
    // aparece en DOM y se mapea al blobUrl. Así evitamos describir blobs
    // que no llegaron a ser parte de un mensaje visible.
    if (!owner || owner === currentContactName) scheduleScan(200);
    return;
  }

  // pdf_blob solo llega si el patch está corriendo en el iframe del visor;
  // ese caso lo maneja pdf_iframe.js directamente con SUMMARIZE_PDF_FROM_IFRAME.
  // Si por algún motivo el blob aparece en parent, lo ignoramos —
  // background lo procesará via el message del iframe.
});

// Pedir al patch todos los blobs que ya capturó (por si llegaron
// antes de que este script estuviera escuchando).
function requestReplay() {
  window.postMessage({ __wsCapturaCmd: 'replay_blobs' }, '*');
}

// Pedir replay al arrancar y periódicamente para recoger blobs
// que aparezcan mientras el usuario navega entre chats.
setTimeout(requestReplay, 500);
setInterval(requestReplay, 3000);

// Recibe la transcripción desde background via storage
// (background descubre los blobs directamente del patch, así que
// aquí solo consumimos los resultados y registramos el owner)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of Object.keys(changes)) {
    const v = changes[key].newValue;
    if (!v?.blobUrl) continue;
    const url = v.blobUrl;

    if (key.startsWith('ws_tx_')) {
      // Transcripción de audio
      console.log(`[WS-CONTENT] 📥 audio tx recibida ...${url.slice(-12)} text="${(v.text||'').slice(0,40)}"`);
      pendingTx.delete(url);
      if (!urlContact.has(url)) {
        urlContact.set(url, v.owner || null);
        capturedAudioUrls.push(url);
        if (capturedAudioUrls.length > 200) capturedAudioUrls.splice(0, capturedAudioUrls.length - 200);
      }
      if (v.text) {
        transcriptions.set(url, v.text);
        lastSnapshotHash = '';
        lastSyncAt = 0;
        scheduleScan(150);
      }
      chrome.storage.local.remove(key).catch(() => {});
      continue;
    }

    if (key.startsWith('ws_imgtx_')) {
      // Descripción de imagen
      console.log(`[WS-CONTENT] 📥 img desc recibida ...${url.slice(-12)} text="${(v.text||'').slice(0,40)}"`);
      pendingImg.delete(url);
      if (v.text) {
        imageDescriptions.set(url, v.text);
        lastSnapshotHash = '';
        lastSyncAt = 0;
        scheduleScan(150);
      }
      chrome.storage.local.remove(key).catch(() => {});
      continue;
    }

    if (key.startsWith('ws_pdftx_')) {
      // Resumen de PDF — asociar al row por fileName (que viene desde el iframe).
      // Buscamos cualquier stableKey existente que empiece con este filename.
      console.log(`[WS-CONTENT] 📥 pdf summary fileName="${v.fileName}" text="${(v.text||'').slice(0,60)}"`);
      const fname = (v.fileName || '').toLowerCase();
      if (v.text && fname) {
        // Marcar resumen por filename (matching ocurrirá en extractMessages
        // cuando el row se procese: pdfStableKey usa filename como prefijo).
        pdfSummariesByFile.set(fname, v.text);
        // Limpiar pendientes que matchean
        for (const k of [...pendingPdfKeys]) {
          if (k.toLowerCase().startsWith(fname)) pendingPdfKeys.delete(k);
        }
        lastSnapshotHash = '';
        lastSyncAt = 0;
        scheduleScan(150);
      }
      chrome.storage.local.remove(key).catch(() => {});
      continue;
    }
  }
});

// ─── Snapshot ────────────────────────────────────────────────

// Fingerprint estable de un mensaje. Mismo fingerprint en dos scans → es el
// mismo mensaje. Permite mergear mensajes que aparecieron y desaparecieron
// del DOM (WhatsApp Web virtualiza el scroll y desmonta los que no están
// en el viewport).
// Para audios usamos un fingerprint que NO incluye text — el placeholder
// "🎤 (transcribiendo...)" cambia a la transcripción real, y queremos que
// se reconozca como el MISMO mensaje y se haga upgrade. Para audios sin
// blobUrl conocido, msgDate+time+role basta como identidad. Para audios con
// blobUrl, ese URL es la identidad más estable (un blob por audio).
function msgFingerprint(m) {
  const stableType = (m.type === 'audio_pending') ? 'audio' : (m.type || 'text');
  // Tipos media (audio, image, video, document, sticker, call, location,
  // catalog): identidad por (type, msgDate, time, role). NO incluir text
  // porque varía: la transcripción reemplaza al placeholder, los captions
  // pueden venir vacíos y luego con la hora visible del bubble, etc.
  if (['audio','image','video','document','sticker','call','location','catalog'].includes(stableType)) {
    return `${stableType}|${m.msgDate || ''}|${m.time || ''}|${m.role}`;
  }
  // Texto: fp incluye contenido — dos mensajes distintos al mismo minuto SÍ
  // deben distinguirse por su texto.
  const text = String(m.text || '').slice(0, 120);
  return ['text', m.msgDate || '', m.time || '', m.role, text].join('|');
}

// Para ordenar cronológicamente convertimos (msgDate, time) a un timestamp
// numérico. Soporta msgDate "DD/MM/YYYY" y time con formatos "1:18 p. m.",
// "10:00 a. m.", "13:45", etc. Si no se puede parsear, devuelve null y el
// caller usa _domIdx como fallback.
function msgSortKey(m) {
  const md = (m.msgDate || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!md) return null;
  const tm = (m.time || '').toLowerCase().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?|am|pm)?/);
  let h = 0, mn = 0, s = 0;
  if (tm) {
    h  = parseInt(tm[1], 10);
    mn = parseInt(tm[2], 10);
    s  = tm[3] ? parseInt(tm[3], 10) : 0;
    const period = (tm[4] || '').replace(/[\s.]/g, '');
    if (period === 'pm' && h < 12) h += 12;
    if (period === 'am' && h === 12) h = 0;
  }
  return new Date(+md[3], +md[2] - 1, +md[1], h, mn, s).getTime();
}

// Mergea mensajes nuevos sobre los acumulados conservando el orden cronológico.
// Reglas:
//   1. Mismo fingerprint que ya teníamos → conserva el acumulado.
//   2. EXCEPCIÓN audio: pending→audio reemplaza (upgrade de transcripción).
//   3. EXCEPCIÓN texto: si llega texto >30 chars más largo (caso "Leer más"
//      expandido), reemplaza.
//   4. Sort final por timestamp parseado (msgDate+time) con tiebreaker _domIdx
//      del scan más reciente. Mensajes sin msgDate parseable van al final
//      ordenados por _domIdx.
function mergeMessages(prev, fresh) {
  const map = new Map();
  for (const m of (prev || [])) map.set(msgFingerprint(m), m);
  for (const m of (fresh || [])) {
    const fp = msgFingerprint(m);
    const prior = map.get(fp);
    if (!prior) {
      map.set(fp, m);
      continue;
    }
    // Upgrades posibles para el mismo fingerprint:
    //   1. audio_pending → audio (llegó la transcripción)
    //   2. audio sin blobUrl → audio CON blobUrl (patch.js capturó el blob)
    //   3. texto truncado → texto expandido (Leer más)
    const isAudioUpgrade   = prior.type === 'audio_pending' && m.type === 'audio';
    const isBlobUpgrade    = ['audio','audio_pending','image','document'].includes(m.type) && !prior.blobUrl && m.blobUrl;
    const isTextExpansion  = (m.text?.length || 0) > (prior.text?.length || 0) + 30;
    if (isAudioUpgrade || isBlobUpgrade || isTextExpansion) {
      map.set(fp, {
        ...m,
        // Conservar campos del prior si el nuevo viene vacío
        msgDate: m.msgDate || prior.msgDate,
        time:    m.time    || prior.time,
        blobUrl: m.blobUrl || prior.blobUrl,
        _domIdx: (m._domIdx ?? prior._domIdx),
      });
    }
  }
  return [...map.values()].sort((a, b) => {
    const ka = msgSortKey(a);
    const kb = msgSortKey(b);
    // Si ambos tienen timestamp parseable y son distintos → orden cronológico
    if (ka != null && kb != null && ka !== kb) return ka - kb;
    // Cualquier otro caso (uno o ambos sin parsear, o mismo timestamp):
    // tiebreaker por orden DOM. WA Web renderiza top-to-bottom en orden
    // cronológico, así que _domIdx preserva la posición visual original.
    return (a._domIdx ?? 0) - (b._domIdx ?? 0);
  });
}

async function saveSnapshot(contact, messages) {
  if (!isAlive() || !contact?.name || messages.length === 0) return;

  const date = new Date().toLocaleDateString('es-CO');

  const nowIso   = new Date().toISOString();
  const stored   = await chrome.storage.local.get([LOCAL_KEY]);
  const captures = stored[LOCAL_KEY] || [];
  const idx      = captures.findIndex(c => c.contact === contact.name && c.date === date);

  // ── ACUMULADO: mergear con los mensajes previos del mismo (contact, date)
  // para no perder mensajes cuando WhatsApp Web desmonta del DOM los que no
  // están en el viewport. La virtualización del scroll era la causa raíz de
  // que al subir aparecían iniciales y al bajar volvían a aparecer finales,
  // pero la captura sobrescribía siempre con lo del momento.
  const prevMessages = idx >= 0 ? (captures[idx].messages || []) : [];
  const mergedMessages = mergeMessages(prevMessages, messages);

  // Hash sobre el ACUMULADO (no sobre el batch del DOM). Si después del
  // merge no hay cambios reales (mismo total, mismos últimos), no resync.
  const audioSig = mergedMessages.filter(m => m.type === 'audio' || m.type === 'audio_pending').map(m => m.text).join('|');
  const hash = JSON.stringify({
    c: contact.name, d: date, n: mergedMessages.length,
    tail: mergedMessages.slice(-3).map(m => m.text),
    head: mergedMessages.slice(0, 3).map(m => m.text),
    audio: audioSig,
    pres: contact.presence,
  });
  if (hash === lastSnapshotHash) return;

  // Throttle: no sincronizar con Supabase más rápido que cada 2s.
  const nowMs = Date.now();
  if (nowMs - lastSyncAt < 2000) {
    scheduleScan(2200 - (nowMs - lastSyncAt));
    return;
  }
  lastSnapshotHash = hash;
  lastSyncAt = nowMs;

  const entry = {
    id:         idx >= 0 ? captures[idx].id : crypto.randomUUID(),
    contact:    contact.name,
    phone:      contact.phone      || captures[idx]?.phone      || null,
    profilePic: contact.profilePic || captures[idx]?.profilePic || null,
    presence:   contact.presence   || null,
    lastSeen:   contact.lastSeen   || captures[idx]?.lastSeen   || null,
    isGroup:    contact.isGroup    || false,
    date, messages: mergedMessages,
    capturedAt: idx >= 0 ? captures[idx].capturedAt : nowIso,
    updatedAt:  nowIso,
    sent:       false,
  };

  if (idx >= 0) captures[idx] = entry;
  else captures.unshift(entry);

  await chrome.storage.local.set({ [LOCAL_KEY]: captures.slice(0, 100) });
  send({ type: 'SYNC_CAPTURE', entry });
}

// ─── Auto-scroll para capturar histórico completo ─────────────
//
// WhatsApp Web virtualiza el scroll: solo renderiza los mensajes en el
// viewport. Para capturar TODO el chat sin que Jhon tenga que scrollear
// manualmente, la extensión recorre el chat automáticamente al abrirlo:
// sube hasta el tope (forzando lazy-load), captura a medida que aparecen
// mensajes, y al terminar vuelve al final.
//
// Se hace UNA vez por chat por sesión del navegador (scrolledChats cache).
// Si el usuario quiere reescanear, puede usar el botón "Scan now" del popup
// o cerrar y reabrir Chrome.

const scrolledChats = new Set();   // contactos ya recorridos esta sesión
let   autoScrollInProgress = false;

// Localiza el contenedor scrollable de mensajes dentro de #main.
// WA Web cambia su DOM seguido — buscamos por la propiedad de overflow.
function findMessagesScrollContainer() {
  const main = document.querySelector('#main');
  if (!main) return null;
  // El primer message-in/message-out: subimos por su árbol hasta encontrar
  // el ancestro que sea scrollable verticalmente.
  const probe = main.querySelector('.message-in, .message-out');
  let el = probe;
  while (el && el !== main) {
    const cs = getComputedStyle(el);
    const ovY = cs.overflowY;
    if ((ovY === 'auto' || ovY === 'scroll') && el.scrollHeight > el.clientHeight + 50) {
      return el;
    }
    el = el.parentElement;
  }
  // Fallback: buscar por atributo común que WA usa
  return main.querySelector('div[role="application"] [data-tab]') || null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function autoScrollAndCapture(contactName) {
  if (autoScrollInProgress) return;
  if (scrolledChats.has(contactName)) return;
  scrolledChats.add(contactName);
  autoScrollInProgress = true;

  try {
    const container = findMessagesScrollContainer();
    if (!container) return;

    console.log(`[WS-CONTENT] 🌀 auto-scroll iniciando "${contactName}"…`);
    const MAX_ITER = 30;
    let prevHeight = container.scrollHeight;
    let stableCount = 0;

    for (let i = 0; i < MAX_ITER; i++) {
      // Si el usuario cambió de chat mientras scrolleábamos, abortar
      if (currentContactName && currentContactName !== contactName) {
        console.log(`[WS-CONTENT] 🌀 abortado: usuario cambió de chat`);
        break;
      }
      // Subir al tope para disparar lazy-load del histórico
      container.scrollTop = 0;
      await sleep(700);

      // Capturar lo que se renderizó
      try { scanChatNow(); } catch (_) {}

      const newHeight = container.scrollHeight;
      if (newHeight <= prevHeight + 5) {
        // Sin crecimiento — llegamos al tope o no hay más histórico
        stableCount++;
        if (stableCount >= 2) break;   // 2 iteraciones estables → fin
      } else {
        stableCount = 0;
      }
      prevHeight = newHeight;
    }

    // Volver al fondo (donde el usuario espera ver los mensajes recientes)
    container.scrollTop = container.scrollHeight;
    await sleep(500);
    try { scanChatNow(); } catch (_) {}

    console.log(`[WS-CONTENT] 🌀 auto-scroll terminado "${contactName}" (altura final ${prevHeight}px)`);
  } finally {
    autoScrollInProgress = false;
  }
}

// ─── Scan ────────────────────────────────────────────────────

// Versión sin protección de re-entrada — usada por autoScrollAndCapture.
async function scanChatNow() {
  if (!document.querySelector('#main')) return;
  const contact = extractContact();
  if (!contact) return;
  currentContactName = contact.name;
  if (!contact.phone && !contact.isGroup && contact.name) {
    resolvePhoneViaPanel(contact.name, contact.isGroup).catch(() => {});
  }
  scanAudioRows();
  scanPdfRows();
  const messages = await extractMessages();
  if (messages.length === 0) return;
  saveSnapshot(contact, messages).catch(() => {});
}

async function scanChat() {
  if (!document.querySelector('#main')) return;
  const contact = extractContact();
  if (!contact) return;
  const isNewChat = currentContactName !== contact.name;
  currentContactName = contact.name;

  if (!contact.phone && !contact.isGroup && contact.name) {
    resolvePhoneViaPanel(contact.name, contact.isGroup).catch(() => {});
  }

  scanAudioRows();
  scanPdfRows();
  const messages = await extractMessages();
  if (messages.length === 0) return;
  saveSnapshot(contact, messages).catch(() => {});

  // Disparar auto-scroll la PRIMERA vez que vemos este chat en la sesión
  // (después del primer scan para tener el contacto resuelto).
  if (isNewChat && !scrolledChats.has(contact.name) && !autoScrollInProgress) {
    setTimeout(() => autoScrollAndCapture(contact.name), 800);
  }
}

function scheduleScan(delay = 400) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(scanChat, delay);
}

// ─── Observers ───────────────────────────────────────────────

function onMainChange() { scheduleScan(400); }
function onSideChange() { lastSnapshotHash = ''; scheduleScan(700); }

function startObservers() {
  if (mainObserver) mainObserver.disconnect();
  if (sideObserver) sideObserver.disconnect();

  const main = document.querySelector('#main');
  const side = document.querySelector('#pane-side');
  if (!main || !side) return;

  mainObserver = new MutationObserver(onMainChange);
  mainObserver.observe(main, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'aria-label', 'data-icon'] });

  sideObserver = new MutationObserver(onSideChange);
  sideObserver.observe(side, { childList: true, subtree: true });

  scanChat();
}

function boot() {
  const ticker = setInterval(() => {
    if (document.querySelector('#main') && document.querySelector('#pane-side')) {
      clearInterval(ticker);
      startObservers();
    }
  }, 1000);
}

boot();

// Scan periódico
setInterval(() => {
  if (isAlive() && document.querySelector('#main')) scanChat();
}, 3000);

// Mensajes desde popup
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'SCAN_NOW') {
    lastSnapshotHash = '';
    // Forzar re-scroll completo: limpiar cache para que vuelva a recorrer
    // el chat actual de tope a fondo.
    scrolledChats.delete(currentContactName);
    scanChat();
    sendResponse({ ok: true });
  }
  return true;
});

// Responder a pedidos de estado (desde la página, vía postMessage)
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.__wsCapturaCmd !== 'get_content_state') return;
  window.postMessage({
    __wsCapturaEvent: 'content_state',
    currentContactName,
    capturedAudioUrls: [...capturedAudioUrls],
    urlContact:        [...urlContact.entries()],
    pendingTx:         [...pendingTx],
    transcriptions:    [...transcriptions.entries()],
  }, '*');
});
