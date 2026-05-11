(() => {
  const L = [];
  const main = document.querySelector('#main');
  L.push(`[1] #main existe: ${!!main}`);
  if (!main) return L.join('\n');

  const audios = main.querySelectorAll('audio');
  L.push(`[2] <audio> elements en #main: ${audios.length}`);
  audios.forEach((a, i) => L.push(`    Audio#${i}: src="${(a.src||'').slice(0,80)}" paused=${a.paused} ready=${a.readyState}`));

  const rows = main.querySelectorAll('.message-in, .message-out');
  L.push(`[3] Filas message-in/out total: ${rows.length}`);

  const rowsAudio = [...rows].filter(r =>
    r.querySelector('audio') ||
    r.querySelector('[data-icon*="audio" i]') ||
    r.querySelector('[data-icon*="play" i]') ||
    r.querySelector('[aria-label*="voz" i]') ||
    r.querySelector('[aria-label*="audio" i]')
  );
  L.push(`[4] Filas que parecen tener audio: ${rowsAudio.length}`);

  rowsAudio.slice(0, 3).forEach((r, i) => {
    L.push(`\n--- Mensaje-audio #${i} ---`);
    L.push(`   Clases: ${r.className.slice(0,150)}`);
    const hasAudio = !!r.querySelector('audio');
    L.push(`   Tiene <audio>: ${hasAudio}`);
    const icons = r.querySelectorAll('[data-icon]');
    icons.forEach(ic => L.push(`   data-icon="${ic.getAttribute('data-icon')}"`));
    const btns = r.querySelectorAll('[role="button"], button');
    L.push(`   Botones/roles: ${btns.length}`);
    btns.forEach(b => {
      const al = b.getAttribute('aria-label') || '(sin)';
      L.push(`     aria-label="${al.slice(0,80)}"`);
    });
  });

  L.push(`\n[5] URL.createObjectURL tipo: ${typeof URL.createObjectURL}`);
  L.push(`[6] window.Audio tipo: ${typeof window.Audio}`);

  return L.join('\n');
})();






resultado 


'[1] #main existe: true\n[2] <audio> elements en #main: 0\n[3] Filas message-in/out total: 22\n[4] Filas que parecen tener audio: 4\n\n--- Mensaje-audio #0 ---\n   Clases: message-in focusable-list-item _amjy _amjz _amjw x1klvx2g xahtqtb\n   Tiene <audio>: false\n   data-icon="tail-in"\n   data-icon="ptt-status"\n   Botones/roles: 2\n     aria-label="Reproducir mensaje de voz"\n     aria-label="(sin)"\n\n--- Mensaje-audio #1 ---\n   Clases: message-out focusable-list-item _amjy _amjz _amjw x1klvx2g xahtqtb\n   Tiene <audio>: false\n   data-icon="ptt-status"\n   data-icon="msg-dblcheck"\n   Botones/roles: 3\n     aria-label="Reproducir mensaje de voz"\n     aria-label="(sin)"\n     aria-label="(sin)"\n\n--- Mensaje-audio #2 ---\n   Clases: message-in focusable-list-item _amjy _amjz _amjw x1klvx2g xahtqtb\n   Tiene <audio>: false\n   data-icon="tail-in"\n   data-icon="ptt-status"\n   Botones/roles: 2\n     aria-label="Reproducir mensaje de voz"\n     aria-label="(sin)"\n\n[5] URL.createObjectURL tipo: function\n[6] window.Audio tipo: function'