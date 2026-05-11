/* ═══════════════════════════════════════════════════════════
 * WhatsApp Captura Safra — Patch en world MAIN
 *
 * Corre en document_start, en el contexto real de la página.
 * Parchea URL.createObjectURL para capturar los blobs de audio
 * que WhatsApp crea cuando el usuario (o un click programático)
 * reproduce un mensaje de voz.
 *
 * Los blobs capturados se exponen en window.__wsCaptura.blobs y
 * cada uno dispara un postMessage que el content script escucha.
 * ════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // Namespace compartido con el resto de la extensión
  window.__wsCaptura = {
    blobs:   new Map(),   // url → Blob
    owners:  new Map(),   // url → nombre del contacto al momento de captura
    count:   0,
  };

  // Lee el nombre del contacto del chat actualmente abierto
  function currentContactName() {
    try {
      const h = document.querySelector('#main header');
      if (!h) return null;
      for (const s of h.querySelectorAll('span')) {
        const txt = (s.innerText || '').trim();
        if (txt && txt.length > 1 && txt.length < 80 && !txt.includes('\n')) return txt;
      }
    } catch (_) {}
    return null;
  }

  const origCreateURL = URL.createObjectURL.bind(URL);

  URL.createObjectURL = function patchedCreateObjectURL(obj) {
    const url = origCreateURL(obj);
    try {
      if (obj instanceof Blob) {
        const type = (obj.type || '').toLowerCase();
        const isAudio = type.startsWith('audio/');
        // Imágenes: > 5KB descarta avatares (típicamente 1-3KB) y emojis.
        const isImage = type.startsWith('image/') && obj.size > 5000;
        // PDFs: > 1KB (PDFs reales son siempre más). Capturamos blob para
        // que background.js los procese con OpenAI (resumen primeras 2 págs).
        const isPdf = type === 'application/pdf' && obj.size > 1000;
        if (isAudio && obj.size > 500) {
          const owner = currentContactName();
          window.__wsCaptura.blobs.set(url, obj);
          window.__wsCaptura.owners.set(url, owner);
          window.__wsCaptura.count++;
          window.postMessage({
            __wsCapturaEvent: 'audio_blob',
            url, size: obj.size, type: obj.type, contactName: owner,
          }, '*');
        } else if (isImage) {
          const owner = currentContactName();
          window.__wsCaptura.blobs.set(url, obj);
          window.__wsCaptura.owners.set(url, owner);
          window.__wsCaptura.count++;
          window.postMessage({
            __wsCapturaEvent: 'image_blob',
            url, size: obj.size, type: obj.type, contactName: owner,
          }, '*');
        } else if (isPdf) {
          const owner = currentContactName();
          window.__wsCaptura.blobs.set(url, obj);
          window.__wsCaptura.owners.set(url, owner);
          window.__wsCaptura.count++;
          window.postMessage({
            __wsCapturaEvent: 'pdf_blob',
            url, size: obj.size, type: obj.type, contactName: owner,
          }, '*');
        }
      }
    } catch (_) { /* no bloquear createObjectURL jamás */ }
    return url;
  };

  // También parchear revokeObjectURL para no perder blobs
  const origRevokeURL = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = function patchedRevokeObjectURL(url) {
    // Mantenemos el blob capturado unos segundos por si la
    // transcripción llega después del revoke
    if (window.__wsCaptura.blobs.has(url)) {
      setTimeout(() => {
        try { origRevokeURL(url); } catch (_) {}
        window.__wsCaptura.blobs.delete(url);
      }, 8000);
      return;
    }
    return origRevokeURL(url);
  };

  // ─── Hook de postMessage para capturar PDFs cross-frame ────
  // WA Web NO usa URL.createObjectURL para los PDFs del visor —
  // los pasa al iframe del visor (webtp.whatsapp.net) vía
  // postMessage. Este hook intercepta TODOS los postMessage
  // hacia/desde windows y detecta cuando el payload contiene un
  // ArrayBuffer/Uint8Array grande (>1KB) con header PDF.
  //
  // Solo captura en iframe context (location !== web.whatsapp.com).
  // En parent, los postMessages del Object URL ya se manejan via
  // el hook de URL.createObjectURL.

  // Capturar PDFs cross-frame. WA Web usa postMessage con formato:
  //   { type: 'RENDER_PDF_PREVIEW', payload: { file: <Blob pdf>, fileName: '...' } }
  // Solo se ejecuta en el iframe del visor (no en el parent).
  if (location.host !== 'web.whatsapp.com') {
    window.addEventListener('message', (event) => {
      if (event.data?.__wsCapturaEvent || event.data?.__wsCapturaCmd) return;
      const d = event.data;
      if (d?.type !== 'RENDER_PDF_PREVIEW') return;
      const file = d?.payload?.file;
      const fileName = d?.payload?.fileName || 'documento.pdf';
      if (!(file instanceof Blob) || file.size < 1000) return;
      try {
        const url = origCreateURL(file);
        window.__wsCaptura.blobs.set(url, file);
        window.__wsCaptura.owners.set(url, fileName);
        window.__wsCaptura.count++;
        console.log(`[WS-PATCH-PDF] 📎 PDF capturado: ${fileName} (${file.size}b)`);
        window.postMessage({
          __wsCapturaEvent: 'pdf_blob',
          url, size: file.size, type: 'application/pdf',
          fileName,
        }, '*');
      } catch (e) {
        console.warn('[WS-PATCH-PDF] error creando blob URL:', e.message);
      }
    }, true);  // capture phase — antes que el handler de WA
  }

  // Replay: content.js puede pedir todos los blobs ya capturados
  // (útil porque el patch corre antes que el content y puede
  //  capturar blobs cuyos postMessage se pierden).
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.__wsCapturaCmd !== 'replay_blobs') return;
    for (const [url, blob] of window.__wsCaptura.blobs) {
      const t = (blob.type || '').toLowerCase();
      const eventName = t.startsWith('audio/') ? 'audio_blob'
                      : t.startsWith('image/') ? 'image_blob'
                      : t === 'application/pdf' ? 'pdf_blob'
                      : null;
      if (!eventName) continue;
      window.postMessage({
        __wsCapturaEvent: eventName,
        url, size: blob.size, type: blob.type,
        contactName: window.__wsCaptura.owners.get(url) || null,
        replay: true,
      }, '*');
    }
  });
})();
