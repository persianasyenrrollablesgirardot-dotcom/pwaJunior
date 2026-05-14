#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, 'test_m2_post_aprobar_shots');
mkdirSync(SHOTS, { recursive: true });
const URL = 'http://localhost:5180/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function clickByText(page, text, opts = {}) {
  const exact = opts.exact ?? false;
  return await page.evaluate(({ text, exact }) => {
    function tryAll(sel, requireCursor) {
      let best = null, bestDepth = -1;
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.innerText || '').trim();
        if (!t) continue;
        const m = exact ? t === text : t.includes(text);
        if (!m) continue;
        if (requireCursor) { if (getComputedStyle(el).cursor !== 'pointer') continue; }
        if (t.length / text.length > 12) continue;
        let d = 0, n = el; while (n) { d++; n = n.parentElement; }
        if (d > bestDepth) { best = el; bestDepth = d; }
      }
      return best;
    }
    let best = tryAll('button, a, [role="tab"], [role="button"], [role="link"]', false);
    if (!best) best = tryAll('div, li, article, section', true);
    if (best) { best.scrollIntoView({ block: 'center' }); best.click(); return true; }
    return false;
  }, { text, exact });
}

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: false,
  defaultViewport: { width: 1440, height: 900 }, args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage();
  console.log('▸ Ir a Clientes → Jorge → M2 Comerciales');
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1200);
  await clickByText(page, '→ Ir a Clientes', { exact: false });
  await sleep(1300);
  await clickByText(page, 'Jorge Pozo Azul', { exact: false });
  await sleep(1500);
  await clickByText(page, '2 · Comerciales', { exact: false });
  await sleep(2000);
  await page.screenshot({ path: join(SHOTS, 'm2_cotizaciones.png'), fullPage: true });

  const txt = await page.evaluate(() => document.body.innerText);
  console.log('▸ Buscando indicios de la nueva cotización');
  const tieneCotizaciones = /cotizaciones de jorge.*\(([0-9]+)\)/i.exec(txt);
  if (tieneCotizaciones) console.log(`  ✓ contador: "Cotizaciones de Jorge ... (${tieneCotizaciones[1]})"`);
  const tieneTapaluces = /tapa\s*luz|tapaluz/i.test(txt);
  const tieneBlackout = /blackout/i.test(txt);
  const tieneSala = /sala/i.test(txt);
  console.log(`  tapaluces en lista: ${tieneTapaluces ? '✓' : '✗'}`);
  console.log(`  blackout en lista: ${tieneBlackout ? '✓' : '✗'}`);
  console.log(`  sala en lista: ${tieneSala ? '✓' : '✗'}`);

  // Intentar hacer clic en la cotización nueva para ver el detalle
  console.log('\n▸ Abrir detalle de cotización shadow promovida (por texto "Faltan medidas")');
  const cardSeleccionado = await clickByText(page, 'Faltan medidas', { exact: false }) ||
                            await clickByText(page, 'tapa', { exact: false });
  if (cardSeleccionado) {
    await sleep(1500);
    await page.screenshot({ path: join(SHOTS, 'm2_detalle.png'), fullPage: true });
    const txt2 = await page.evaluate(() => document.body.innerText);
    const tieneItem2 = {
      blackout: /blackout/i.test(txt2),
      sala: /sala/i.test(txt2),
      tapa: /tapa/i.test(txt2),
    };
    console.log('  detalle:');
    Object.entries(tieneItem2).forEach(([k, v]) => console.log(`    ${v ? '✓' : '·'} ${k}`));
  } else {
    console.log('  ⚠ no encontré card con tapa/blackout para abrir');
  }

  console.log(`\nScreenshots en: ${SHOTS}`);
} finally {
  await browser.close();
}
