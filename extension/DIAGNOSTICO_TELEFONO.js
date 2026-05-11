/* ═══════════════════════════════════════════════════════════════════
 * DIAGNÓSTICO: ¿Dónde está el teléfono del contacto agendado?
 *
 * INSTRUCCIONES:
 *   1. Abre WhatsApp Web (web.whatsapp.com)
 *   2. Abre un chat de un contacto AGENDADO (con nombre, sin número visible)
 *   3. F12 → pestaña "Consola"
 *   4. Copia y pega TODO este archivo, presiona Enter
 *   5. Copia el resultado completo y pásamelo
 * ═══════════════════════════════════════════════════════════════════ */

(() => {
  const out = [];
  const log = (...args) => { out.push(args.join(' ')); console.log(...args); };

  log('═══ DIAGNÓSTICO TELÉFONO — inicio ═══');
  log('Fecha:', new Date().toISOString());
  log('User-Agent:', navigator.userAgent);
  log('');

  // 1) Header del chat
  const header = document.querySelector('#main header');
  log('─── 1) HEADER ───');
  if (!header) { log('❌ NO hay #main header'); return out.join('\n'); }
  log('Texto visible del header:', JSON.stringify(header.innerText));
  log('HTML del header (primeros 500):', header.outerHTML.slice(0, 500));
  log('');

  // 2) Todos los atributos del header y sus hijos
  log('─── 2) ATRIBUTOS EN EL HEADER ───');
  const allInHeader = header.querySelectorAll('*');
  const interesting = new Set();
  allInHeader.forEach(el => {
    for (const a of el.attributes) {
      const val = a.value;
      if (/\d{7,}/.test(val) || val.includes('@c.us') || val.includes('@s.whatsapp') || val.includes('whatsapp.net')) {
        interesting.add(`<${el.tagName.toLowerCase()}> ${a.name}="${val.slice(0, 200)}"`);
      }
    }
  });
  if (interesting.size === 0) log('(ningún atributo con números largos o JIDs en el header)');
  else interesting.forEach(s => log('  •', s));
  log('');

  // 3) Buscar data-id en toda la página
  log('─── 3) TODOS los data-id (primeros 10) ───');
  const dataIds = document.querySelectorAll('[data-id]');
  log('Total elementos con data-id:', dataIds.length);
  const samples = new Set();
  for (let i = 0; i < Math.min(dataIds.length, 10); i++) {
    samples.add(dataIds[i].getAttribute('data-id'));
  }
  samples.forEach(s => log('  •', s));
  log('');

  // 4) Buscar cualquier atributo con @c.us o @s.whatsapp
  log('─── 4) ATRIBUTOS con JID en toda la página ───');
  const all = document.querySelectorAll('*');
  const jidAttrs = new Map(); // nombreAtributo → count
  let sampleJid = null;
  for (const el of all) {
    for (const a of el.attributes) {
      if (a.value.includes('@c.us') || a.value.includes('@s.whatsapp') || a.value.includes('@lid')) {
        jidAttrs.set(a.name, (jidAttrs.get(a.name) || 0) + 1);
        if (!sampleJid) sampleJid = { tag: el.tagName, attr: a.name, value: a.value.slice(0, 300) };
      }
    }
  }
  if (jidAttrs.size === 0) log('❌ NO hay atributos con @c.us, @s.whatsapp o @lid');
  else {
    log('Atributos encontrados:');
    jidAttrs.forEach((n, k) => log(`  • ${k}: ${n} veces`));
    log('Ejemplo:', JSON.stringify(sampleJid));
  }
  log('');

  // 5) Buscar números de teléfono largos en atributos
  log('─── 5) ATRIBUTOS con números de 7+ dígitos (primeros 15) ───');
  const phoneAttrs = new Map();
  const phoneSamples = [];
  for (const el of all) {
    for (const a of el.attributes) {
      const m = a.value.match(/\b(\d{7,15})\b/);
      if (m && phoneSamples.length < 15) {
        const key = `<${el.tagName.toLowerCase()}> ${a.name}`;
        if (!phoneAttrs.has(key)) {
          phoneAttrs.set(key, true);
          phoneSamples.push(`  • ${key}="${a.value.slice(0, 150)}"`);
        }
      }
    }
  }
  if (phoneSamples.length === 0) log('(ningún atributo con números de 7+ dígitos)');
  else phoneSamples.forEach(s => log(s));
  log('');

  // 6) Texto visible en toda la página que parezca teléfono
  log('─── 6) TEXTOS visibles que parezcan teléfono ───');
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const phones = new Set();
  let node;
  while ((node = walker.nextNode())) {
    const txt = node.nodeValue.trim();
    if (/^\+?\d[\d\s\-]{7,}$/.test(txt)) phones.add(txt);
  }
  if (phones.size === 0) log('(sin textos que parezcan teléfono)');
  else phones.forEach(p => log('  •', p));
  log('');

  // 7) Intentar abrir el panel de info del contacto para ver qué expone
  log('─── 7) ELEMENTO clickeable del header (abre info contacto) ───');
  const clickable = header.querySelector('[role="button"]') || header.querySelector('div[tabindex]');
  if (clickable) {
    log('Elemento clickeable encontrado:', clickable.tagName, clickable.getAttribute('role') || '', clickable.getAttribute('aria-label') || '');
  } else {
    log('(no se encontró elemento clickeable obvio)');
  }
  log('');

  log('═══ FIN — copia TODO esto y pásalo ═══');
  return out.join('\n');
})();
