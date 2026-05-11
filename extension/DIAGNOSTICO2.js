(() => {
  const L = [];
  L.push('══ DIAGNÓSTICO 2 ══');
  L.push(`[A] #main existe: ${!!document.querySelector('#main')}`);
  L.push(`[B] patch.js corrió (window.__wsCaptura existe): ${typeof window.__wsCaptura}`);
  if (typeof window.__wsCaptura === 'object') {
    L.push(`    blobs capturados hasta ahora: ${window.__wsCaptura.count || 0}`);
    L.push(`    Map size: ${window.__wsCaptura.blobs?.size || 0}`);
  }
  L.push(`[C] URL.createObjectURL parcheado: ${URL.createObjectURL.name || '(anon)'}`);
  L.push(`    ¿Es nuestro patch?: ${URL.createObjectURL.name === 'patchedCreateObjectURL'}`);

  // Mensajes de texto
  const rows = document.querySelectorAll('#main .message-in, #main .message-out');
  L.push(`[D] Filas totales: ${rows.length}`);

  const textMsgs = [...rows].filter(r => !r.querySelector('[data-icon="ptt-status"]'));
  L.push(`[E] Filas que NO son audio: ${textMsgs.length}`);

  // Mostrar 2 ejemplos de filas de texto
  textMsgs.slice(0, 2).forEach((r, i) => {
    L.push(`  texto#${i}:`);
    const meta = r.querySelector('[data-pre-plain-text]');
    L.push(`    tiene [data-pre-plain-text]: ${!!meta}`);
    if (meta) {
      const span = meta.querySelector('span');
      L.push(`    meta > span innerText: "${(span?.innerText || '').slice(0,80)}"`);
    }
    const sel = r.querySelector('span.selectable-text');
    L.push(`    tiene span.selectable-text: ${!!sel} ("${(sel?.innerText || '').slice(0,50)}")`);
    const dir = r.querySelector('span[dir]');
    L.push(`    tiene span[dir]: ${!!dir} ("${(dir?.innerText || '').slice(0,50)}")`);
  });

  return L.join('\n');
})();
