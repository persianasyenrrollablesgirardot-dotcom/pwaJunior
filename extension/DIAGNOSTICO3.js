(async () => {
  const L = [];
  const before = window.__wsCaptura?.count || 0;
  L.push(`[A] Blobs ANTES del test: ${before}`);

  const audioRows = [...document.querySelectorAll('#main .message-in, #main .message-out')]
    .filter(r => r.querySelector('[data-icon="ptt-status"]'));
  L.push(`[B] Filas de audio encontradas: ${audioRows.length}`);

  if (audioRows.length === 0) {
    L.push('NO HAY AUDIOS EN EL CHAT, abre un chat con audios');
    const out = L.join('\n');
    console.log(out);
    document.title = 'DIAG: ver consola';
    return out;
  }

  const row = audioRows[0];
  const btn = row.querySelector('button[aria-label="Reproducir mensaje de voz"]')
           || row.querySelector('[role="button"][aria-label="Reproducir mensaje de voz"]');
  L.push(`[C] Botón de play encontrado: ${!!btn}`);
  if (!btn) {
    const all = row.querySelectorAll('button, [role="button"]');
    L.push(`    botones en la fila: ${all.length}`);
    all.forEach(b => L.push(`    aria-label="${b.getAttribute('aria-label') || '(sin)'}"`));
    const out = L.join('\n');
    console.log(out);
    return out;
  }

  // TEST 1: click simple
  L.push('[D] Disparando btn.click()...');
  try { btn.click(); } catch (e) { L.push(`    error: ${e.message}`); }
  await new Promise(r => setTimeout(r, 2500));
  const after1 = window.__wsCaptura?.count || 0;
  L.push(`    Blobs despues click simple: ${after1} (delta: ${after1 - before})`);

  // TEST 2: PointerEvent sintetico
  L.push('[E] Disparando PointerEvent...');
  const rect = btn.getBoundingClientRect();
  const opts = { bubbles: true, cancelable: true, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2, view: window, pointerType: 'mouse' };
  try {
    btn.dispatchEvent(new PointerEvent('pointerdown', opts));
    btn.dispatchEvent(new MouseEvent('mousedown',   opts));
    btn.dispatchEvent(new PointerEvent('pointerup',   opts));
    btn.dispatchEvent(new MouseEvent('mouseup',     opts));
    btn.dispatchEvent(new MouseEvent('click',       opts));
  } catch (e) { L.push(`    error: ${e.message}`); }
  await new Promise(r => setTimeout(r, 2500));
  const after2 = window.__wsCaptura?.count || 0;
  L.push(`    Blobs despues pointer events: ${after2} (delta: ${after2 - before})`);

  L.push(`[F] Blobs totales finales: ${after2}`);
  L.push(`[G] Map size: ${window.__wsCaptura?.blobs?.size || 0}`);

  if (window.__wsCaptura?.blobs) {
    const urls = [...window.__wsCaptura.blobs.keys()];
    L.push(`[H] URLs capturados: ${urls.length}`);
    urls.slice(0, 3).forEach(u => {
      const b = window.__wsCaptura.blobs.get(u);
      L.push(`    url=${u.slice(0, 50)}... type=${b?.type} size=${b?.size}`);
    });
  }

  const out = L.join('\n');
  console.log('═══════════════════════════');
  console.log(out);
  console.log('═══════════════════════════');
  try { copy(out); console.log('→ copiado al portapapeles'); } catch (_) {}
  document.title = 'DIAG LISTO — ver consola';
  return out;
})();
