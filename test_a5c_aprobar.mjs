#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, 'test_a5c_shots');
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
  const errs = [];
  page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('Failed to load')) errs.push(`console: ${m.text()}`); });

  console.log('▸ Cargar app + ir a Jorge + M1 Buzón');
  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(1200);
  await clickByText(page, '→ Ir a Clientes');
  await sleep(1500);
  await clickByText(page, 'Jorge Pozo Azul');
  await sleep(1500);
  await clickByText(page, '1 · Núcleo');
  await sleep(1500);
  await clickByText(page, '1.7 Buzón');
  await sleep(1200);
  await page.screenshot({ path: join(SHOTS, '01_buzon.png'), fullPage: true });

  // Seleccionar el ítem de comprobante $750.000
  console.log('▸ Seleccionar ítem $750.000');
  await clickByText(page, '750.000');
  await sleep(800);
  await page.screenshot({ path: join(SHOTS, '02_seleccionado.png'), fullPage: true });

  console.log('▸ Aprobar');
  const ok = await clickByText(page, '✓ Aprobar');
  if (!ok) { console.log('  ✗ no encontró Aprobar'); }
  else console.log('  ✓ clic Aprobar');
  await sleep(2500);
  await page.screenshot({ path: join(SHOTS, '03_post_aprobar.png'), fullPage: true });

  console.log('▸ Ir a M3 Financieros → tab Abonos');
  await clickByText(page, '3 · Financieros');
  await sleep(1800);
  await clickByText(page, 'Abonos');
  await sleep(1500);
  await page.screenshot({ path: join(SHOTS, '04_m3_abonos.png'), fullPage: true });

  const txt = await page.evaluate(() => document.body.innerText);
  const tiene = {
    monto750: /750\.000|750000/.test(txt),
    referencia: /0000057800|57800/.test(txt),
    transferencia: /transferencia/i.test(txt),
  };
  console.log('▸ Abono aparece en M3:');
  Object.entries(tiene).forEach(([k, v]) => console.log(`  ${v ? '✓' : '✗'} ${k}`));

  if (errs.length) errs.forEach(e => console.log(`  ✗ ${e}`));
  else console.log('  ✓ sin errores de consola');

  console.log(`\nScreenshots en: ${SHOTS}`);
} finally {
  await browser.close();
}
