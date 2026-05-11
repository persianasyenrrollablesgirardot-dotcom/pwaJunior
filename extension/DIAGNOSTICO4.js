(() => {
  const L = [];
  L.push('══ DIAGNÓSTICO 4 — Estado del content.js ══');

  // 1. ¿Hay blobs capturados por el patch?
  const bc = window.__wsCaptura?.count || 0;
  const bm = window.__wsCaptura?.blobs?.size || 0;
  const om = window.__wsCaptura?.owners?.size || 0;
  L.push(`[A] Patch: ${bc} blobs capturados, ${bm} en map, ${om} owners registrados`);

  // 2. Listar blobs y sus owners
  if (window.__wsCaptura?.owners) {
    const entries = [...window.__wsCaptura.owners.entries()];
    L.push(`[B] Owners de cada blob:`);
    entries.forEach(([url, owner]) => {
      L.push(`    url=...${url.slice(-12)} owner="${owner || '(null)'}"`);
    });
  }

  // 3. Chat actual según el DOM
  const h = document.querySelector('#main header');
  let currentName = null;
  if (h) {
    for (const s of h.querySelectorAll('span')) {
      const txt = (s.innerText || '').trim();
      if (txt && txt.length > 1 && txt.length < 80 && !txt.includes('\n')) {
        currentName = txt;
        break;
      }
    }
  }
  L.push(`[C] Contacto actual según el DOM: "${currentName}"`);

  // 4. Cantidad de filas audio
  const audioRows = [...document.querySelectorAll('#main .message-in, #main .message-out')]
    .filter(r => r.querySelector('[data-icon="ptt-status"]'));
  L.push(`[D] Filas de audio en el chat actual: ${audioRows.length}`);

  return L.join('\n');
})();
