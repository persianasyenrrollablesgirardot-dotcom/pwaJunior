// Pega esto en la CONSOLA de WhatsApp Web (F12 → Console) sobre un chat
// que tenga mensajes largos colapsados con "Mostrar más" / "Read more".
//
// Compara los métodos de extracción para ver dónde está el texto completo:
//   1. innerText del primer span en [data-pre-plain-text] (método ANTIGUO)
//   2. textContent del primer span en [data-pre-plain-text]
//   3. innerText de span.selectable-text
//   4. textContent de span.selectable-text  ← lo que ahora usa la extensión
//
// Con esto confirmas si "Mostrar más" está cortando lo capturado.

(() => {
  const rows = [...document.querySelectorAll('#main .message-in, #main .message-out')];
  console.log(`%c[DIAG-TRUNCADO] ${rows.length} mensajes en el chat`, 'color:#a78bfa;font-weight:bold');

  // Buscar botones "Mostrar más" / "Read more" en el chat
  const expandBtns = document.querySelectorAll(
    '#main div[role="button"][aria-label*="ostrar más" i], ' +
    '#main div[role="button"][aria-label*="ead more" i], ' +
    '#main button[aria-label*="ostrar más" i], ' +
    '#main button[aria-label*="ead more" i]'
  );
  console.log(`Botones "Mostrar más" / "Read more" detectados: ${expandBtns.length}`);
  expandBtns.forEach((b, i) => {
    if (i < 3) console.log(`  [${i}] aria-label="${b.getAttribute('aria-label')}"`);
  });

  // Tomar los 5 mensajes más largos (probablemente los truncados)
  const stats = rows.map((row, idx) => {
    const meta = row.querySelector('[data-pre-plain-text]');
    const sel  = row.querySelector('span.selectable-text');
    const m1 = (meta?.querySelector('span')?.innerText || '').trim();
    const m2 = (meta?.querySelector('span')?.textContent || '').trim();
    const m3 = (sel?.innerText || '').trim();
    const m4 = (sel?.textContent || '').trim();
    return { idx, m1, m2, m3, m4, maxLen: Math.max(m1.length, m2.length, m3.length, m4.length) };
  })
  .filter(s => s.maxLen > 200)   // solo mensajes "largos"
  .sort((a, b) => b.maxLen - a.maxLen)
  .slice(0, 5);

  console.log(`\nTop ${stats.length} mensajes largos:\n`);
  stats.forEach(s => {
    console.log(`%c━━━ Mensaje #${s.idx} (max ${s.maxLen} chars) ━━━`, 'color:#fbbf24;font-weight:bold');
    console.log(`  1) meta>span.innerText      : ${s.m1.length} chars  ${s.m1.endsWith('…') ? '⚠ termina con …' : ''}`);
    console.log(`  2) meta>span.textContent    : ${s.m2.length} chars  ${s.m2.endsWith('…') ? '⚠ termina con …' : ''}`);
    console.log(`  3) selectable.innerText     : ${s.m3.length} chars  ${s.m3.endsWith('…') ? '⚠ termina con …' : ''}`);
    console.log(`  4) selectable.textContent   : ${s.m4.length} chars  ${s.m4.endsWith('…') ? '⚠ termina con …' : ''}  ← lo que ahora usa la extensión`);
    const ganador = [
      ['1', s.m1.length], ['2', s.m2.length], ['3', s.m3.length], ['4', s.m4.length]
    ].sort((a, b) => b[1] - a[1])[0];
    console.log(`  → más largo: opción ${ganador[0]} con ${ganador[1]} chars`);
  });

  // Conclusión
  const losers = stats.filter(s => s.m1 !== s.m4 && s.m4.length > s.m1.length).length;
  console.log(`\n%cResumen: ${losers}/${stats.length} mensajes pierden chars con innerText (método antiguo) vs textContent (método nuevo).`,
    losers > 0 ? 'color:#f87171;font-weight:bold' : 'color:#4ade80;font-weight:bold');
  if (expandBtns.length > 0) {
    console.log('%c⚠ Hay botones "Mostrar más" en el chat. La extensión los clickea automáticamente antes del scan.',
      'color:#fbbf24');
  }
})();
