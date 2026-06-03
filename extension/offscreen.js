/* ═══════════════════════════════════════════════════════════
 * Documento OFFSCREEN — rasteriza PDF → imágenes JPEG.
 *
 * El service worker (background.v2.js) no tiene DOM ni <canvas>, así que no
 * puede renderizar un PDF. Este documento offscreen sí: recibe los bytes del
 * PDF (base64), renderiza las primeras N páginas con pdf.js a un canvas y
 * devuelve cada página como dataURL JPEG. El SW luego las manda a Vision
 * (gpt-4o-mini) — el mismo camino que ya funciona para las imágenes.
 *
 * Por qué: el extractor de texto viejo (extractTextFromPdf) fallaba con PDFs
 * comprimidos (FlateDecode) y escaneados. Vision lee píxeles → funciona igual.
 * ════════════════════════════════════════════════════════ */
'use strict';

// pdf.js corre su parser en un worker propio; lo servimos desde la extensión.
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function rasterize({ b64, maxPages = 2, targetWidth = 1654, jpegQuality = 0.85 }) {
  const data = b64ToBytes(b64);
  // isEvalSupported:false → respeta la CSP estricta de las páginas de extensión.
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
  const numPages = pdf.numPages;
  const n = Math.min(maxPages, numPages);
  const images = [];
  for (let p = 1; p <= n; p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    // Escalar para que el ancho quede legible (~A4 a 200dpi), tope 3x.
    const scale = Math.min(3, Math.max(1, targetWidth / base.width));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    // Fondo blanco: los PDFs con transparencia salen negros sin esto.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    images.push(canvas.toDataURL('image/jpeg', jpegQuality));
    page.cleanup();
  }
  await pdf.destroy();
  return { images, numPages };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'WS_RASTERIZE_PDF') return;
  rasterize(msg)
    .then(r => sendResponse({ ok: true, ...r }))
    .catch(e => sendResponse({ ok: false, error: String(e?.message || e) }));
  return true; // respuesta asíncrona
});
