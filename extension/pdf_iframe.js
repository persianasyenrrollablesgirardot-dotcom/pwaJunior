/* ═══════════════════════════════════════════════════════════
 * Content script DENTRO del iframe del visor PDF de WA Web
 * (https://webtp.whatsapp.net/pdf-viewer/?locale=...)
 *
 * patch.js (en MAIN world del iframe) captura los blobs de PDF
 * que WA carga al renderizar. Este script (ISOLATED world) los
 * reenvía al background mediante chrome.runtime.sendMessage —
 * desde el iframe el sender incluye frameId, que el background
 * usa para targetear `chrome.scripting.executeScript` y leer el
 * blob correctamente.
 * ════════════════════════════════════════════════════════ */

'use strict';

console.log('[WS-PDF-IFRAME] cargado en', location.href);

// Recibe los blobs del patch (mismo tab, mismo window — patch corre en
// MAIN world de ESTE iframe).
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (!d) return;

  // El patch emite `pdf_blob` y `image_blob` y `audio_blob`. Acá solo nos
  // interesa `pdf_blob` — los otros los maneja el content.js del top frame.
  if (d.__wsCapturaEvent === 'pdf_blob') {
    console.log(`[WS-PDF-IFRAME] 📎 PDF detectado: ${d.fileName} (${d.size}b)`);
    // Leer el blob a base64 INMEDIATAMENTE (mientras el iframe existe) y
    // mandarlo al SW. Evita el error "No frame with id X" cuando el SW
    // procesa después de que el viewer se cerró y el iframe se destruyó.
    (async () => {
      try {
        const res = await fetch(d.url);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 8192) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        }
        const base64 = btoa(bin);
        chrome.runtime.sendMessage({
          type: 'SUMMARIZE_PDF_BASE64',
          base64,
          size: d.size,
          fileName: d.fileName,
        }).catch(() => {});
        console.log(`[WS-PDF-IFRAME] ✓ base64 enviado al SW (${base64.length} chars)`);
      } catch (e) {
        console.warn('[WS-PDF-IFRAME] error leyendo blob:', e.message);
      }
    })();
  }
});
