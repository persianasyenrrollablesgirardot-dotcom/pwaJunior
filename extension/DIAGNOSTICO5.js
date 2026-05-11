(async () => {
  const L = [];
  L.push('══ DIAGNÓSTICO 5 — Estado del content.js ══');

  const state = await new Promise((resolve) => {
    const to = setTimeout(() => resolve(null), 2000);
    function handler(e) {
      if (e.source !== window) return;
      if (e.data?.__wsCapturaEvent !== 'content_state') return;
      clearTimeout(to);
      window.removeEventListener('message', handler);
      resolve(e.data);
    }
    window.addEventListener('message', handler);
    window.postMessage({ __wsCapturaCmd: 'get_content_state' }, '*');
  });

  if (!state) {
    L.push('content.js no respondió en 2s.');
    L.push('Asegúrate: chrome://extensions → recarga la extensión; F5 en WhatsApp; espera 5s; re-ejecuta.');
    console.log(L.join('\n'));
    return L.join('\n');
  }

  L.push(`[A] currentContactName: "${state.currentContactName}"`);
  L.push(`[B] capturedAudioUrls: ${state.capturedAudioUrls.length}`);
  L.push(`[C] urlContact: ${state.urlContact.length}`);
  L.push(`[D] pendingTx: ${state.pendingTx.length}`);
  L.push(`[E] transcriptions: ${state.transcriptions.length}`);

  L.push(`\n--- Detalle por URL ---`);
  const contactMap = new Map(state.urlContact);
  const txMap      = new Map(state.transcriptions);
  const pendSet    = new Set(state.pendingTx);

  state.capturedAudioUrls.forEach(u => {
    const owner   = contactMap.get(u);
    const pending = pendSet.has(u);
    const tx      = txMap.get(u);
    L.push(`  ...${u.slice(-12)} owner="${owner || 'null'}" pending=${pending} text="${(tx || '').slice(0, 40)}"`);
  });

  L.push(`\n--- Patch side ---`);
  L.push(`  __wsCaptura.count: ${window.__wsCaptura?.count}`);
  L.push(`  __wsCaptura.blobs.size: ${window.__wsCaptura?.blobs?.size}`);

  const out = L.join('\n');
  console.log('═══════════════════════════');
  console.log(out);
  console.log('═══════════════════════════');
  try { copy(out); console.log('→ copiado al portapapeles'); } catch (_) {}
  return out;
})();
