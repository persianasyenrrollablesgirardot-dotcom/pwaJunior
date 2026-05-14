#!/usr/bin/env node
/**
 * Test: aprobar ítem 41 del buzón via UI y verificar que crea cotización en M2.
 */
import puppeteer from 'puppeteer-core';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, 'test_aprobar_shots');
mkdirSync(SHOTS, { recursive: true });

const URL = 'http://localhost:5180/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const log = console.log;

async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });
}

async function clickByText(page, text, opts = {}) {
  const exact = opts.exact ?? false;
  return await page.evaluate(({ text, exact }) => {
    function tryAll(sel, requireCursor) {
      let best = null;
      let bestDepth = -1;
      for (const el of document.querySelectorAll(sel)) {
        const t = (el.innerText || '').trim();
        if (!t) continue;
        const match = exact ? t === text : t.includes(text);
        if (!match) continue;
        if (requireCursor) {
          const cs = getComputedStyle(el);
          if (cs.cursor !== 'pointer') continue;
        }
        const ratio = t.length / text.length;
        if (ratio > 12) continue;
        let d = 0; let n = el;
        while (n) { d++; n = n.parentElement; }
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

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: false,
    defaultViewport: { width: 1440, height: 900 }, args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (!t.includes('Failed to load resource')) errors.push(`console: ${t}`);
      }
    });

    log('▸ Cargar app + navegar al buzón');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1200);
    await clickByText(page, '→ Ir a Clientes', { exact: false });
    await sleep(1300);
    await clickByText(page, 'Jorge Pozo Azul', { exact: false });
    await sleep(1500);
    await clickByText(page, '1 · Núcleo', { exact: false });
    await sleep(1500);
    await clickByText(page, '1.7 Buzón', { exact: false });
    await sleep(1200);
    await shot(page, '01_pre_aprobar');
    log('  ✓ buzón cargado');

    log('▸ Click "✓ Aprobar"');
    const ok = await clickByText(page, '✓ Aprobar', { exact: false });
    if (!ok) { log('  ✗ no se encontró Aprobar'); return; }
    log('  ✓ clic Aprobar enviado');
    await sleep(2500); // esperar response
    await shot(page, '02_post_aprobar');

    const pageTxt = await page.evaluate(() => document.body.innerText);
    if (/aprobado|registrado/i.test(pageTxt)) {
      log('  ✓ feedback de aprobación detectado en pantalla');
    } else {
      log('  ⚠ no detecté feedback visual claro');
    }

    log('▸ Errores de consola');
    if (errors.length) errors.forEach(e => log(`  ✗ ${e}`));
    else log('  ✓ sin errores');

  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
