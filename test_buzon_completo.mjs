#!/usr/bin/env node
/**
 * Test E2E completo del buzón de validación:
 *   1. Ir al buzón con Jorge activo
 *   2. Verificar que el ítem A4_COTIZ aparece
 *   3. Verificar los 3 botones Aprobar / Rechazar / Editar existen
 *   4. Clic en Editar → modal abre, lo cierro sin guardar
 *   5. Clic en Rechazar → modal abre, lo cierro sin guardar
 *   6. (NO ejecuto Aprobar real para no escribir BD; verifico que botón existe)
 */

import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, 'test_buzon_completo_shots');
mkdirSync(SHOTS, { recursive: true });

const URL = 'http://localhost:5180/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const log = (s) => console.log(s);
const ok = (s) => log(`  ✓ ${s}`);
const fail = (s) => log(`  ✗ ${s}`);
const warn = (s) => log(`  ⚠ ${s}`);
const step = (s) => log(`\n▸ ${s}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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
    if (best) {
      best.scrollIntoView({ block: 'center' });
      best.click();
      return true;
    }
    return false;
  }, { text, exact });
}

async function visibleButtons(page) {
  return await page.evaluate(() => {
    return [...document.querySelectorAll('button')]
      .filter(b => b.offsetParent !== null)
      .map(b => (b.innerText || '').trim())
      .filter(t => t && t.length < 40);
  });
}

const findings = { ok: [], fail: [] };

async function main() {
  step('Lanzando Chrome');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const t = msg.text();
        if (!t.includes('Failed to load resource')) consoleErrors.push(`console: ${t}`);
      }
    });

    step('1. Cargar app');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1200);

    step('2. Ir a Clientes → seleccionar Jorge');
    await clickByText(page, '→ Ir a Clientes', { exact: false });
    await sleep(1500);
    await clickByText(page, 'Jorge Pozo Azul', { exact: false });
    await sleep(1500);
    ok('Jorge seleccionado');

    step('3. Ir a M1 Núcleo → tab Buzón');
    await clickByText(page, '1 · Núcleo', { exact: false });
    await sleep(1500);
    await clickByText(page, '1.7 Buzón', { exact: false });
    await sleep(1200);
    await shot(page, '01_buzon');

    step('4. Verificar contenido del ítem');
    const txt = await page.evaluate(() => document.body.innerText);
    const tieneItem = {
      cotizacionPropuesta: /cotizacion[\s_]propuesta/i.test(txt),
      tapaluces: /tapa\s*luz|tapaluz/i.test(txt),
      blackout: /blackout/i.test(txt),
      sala: /sala/i.test(txt),
    };
    Object.entries(tieneItem).forEach(([k, v]) => v ? ok(k) : fail(k));
    Object.entries(tieneItem).forEach(([k, v]) => (v ? findings.ok : findings.fail).push(`item.${k}`));

    step('5. Listar botones visibles en panel del buzón');
    const botones = await visibleButtons(page);
    log('  botones visibles:');
    botones.forEach(b => log(`    • ${b}`));

    const tieneBotones = {
      aprobar: botones.some(b => /aprobar/i.test(b)),
      rechazar: botones.some(b => /rechazar/i.test(b)),
      editar: botones.some(b => /editar/i.test(b)),
    };
    Object.entries(tieneBotones).forEach(([k, v]) => v ? ok(`botón ${k}`) : fail(`botón ${k} NO visible`));
    Object.entries(tieneBotones).forEach(([k, v]) => (v ? findings.ok : findings.fail).push(`boton.${k}`));

    if (!tieneBotones.aprobar && !tieneBotones.editar && !tieneBotones.rechazar) {
      warn('Ningún botón de acción visible. Quizás están abajo del scroll del panel derecho.');
      // intentar scrollear el panel derecho
      await page.evaluate(() => {
        const all = [...document.querySelectorAll('*')];
        const scrollables = all.filter(el => {
          const cs = getComputedStyle(el);
          return (cs.overflow === 'auto' || cs.overflowY === 'auto') && el.scrollHeight > el.clientHeight;
        });
        scrollables.forEach(el => el.scrollTop = el.scrollHeight);
      });
      await sleep(500);
      await shot(page, '02_buzon_scrolled');
      const botones2 = await visibleButtons(page);
      log('  botones tras scroll:');
      botones2.forEach(b => log(`    • ${b}`));
    }

    step('6. Probar clic en "Editar" (esperar modal)');
    const clickedEdit = await clickByText(page, 'Editar', { exact: false });
    if (clickedEdit) {
      await sleep(1000);
      await shot(page, '03_modal_editar');
      const txtEdit = await page.evaluate(() => document.body.innerText);
      const modalEdit = /editar.*aprobar|edici[oó]n|guardar/i.test(txtEdit);
      if (modalEdit) { ok('modal Editar abrió'); findings.ok.push('modal.editar'); }
      else { fail('modal Editar no detectado'); findings.fail.push('modal.editar'); }
      // Cerrar modal sin guardar
      const cerrado = await clickByText(page, 'Cancelar', { exact: false }) ||
                       await clickByText(page, 'Cerrar', { exact: false });
      if (cerrado) { ok('modal cerrado con Cancelar/Cerrar'); }
      else {
        warn('no encontré botón cancelar, presiono Escape');
        await page.keyboard.press('Escape');
      }
      await sleep(500);
    } else {
      fail('botón Editar no clickeable');
      findings.fail.push('click.editar');
    }

    step('7. Probar clic en "Rechazar" (esperar modal)');
    const clickedRej = await clickByText(page, 'Rechazar', { exact: false });
    if (clickedRej) {
      await sleep(1000);
      await shot(page, '04_modal_rechazar');
      const txtRej = await page.evaluate(() => document.body.innerText);
      const modalRej = /motivo|rechazar.*con/i.test(txtRej);
      if (modalRej) { ok('modal Rechazar abrió'); findings.ok.push('modal.rechazar'); }
      else { fail('modal Rechazar no detectado'); findings.fail.push('modal.rechazar'); }
      // Cerrar sin enviar
      const cerrado = await clickByText(page, 'Cancelar', { exact: false }) ||
                       await clickByText(page, 'Cerrar', { exact: false });
      if (!cerrado) await page.keyboard.press('Escape');
      await sleep(500);
    } else {
      fail('botón Rechazar no clickeable');
      findings.fail.push('click.rechazar');
    }

    step('8. Verificar botón Aprobar (sin hacer clic — no quiero escribir BD)');
    const finalBtns = await visibleButtons(page);
    if (finalBtns.some(b => /aprobar/i.test(b))) {
      ok('botón Aprobar sigue visible (no se invoca para no escribir BD)');
      findings.ok.push('boton.aprobar.visible');
    } else {
      fail('botón Aprobar desapareció');
      findings.fail.push('boton.aprobar.visible');
    }
    await shot(page, '05_estado_final');

    step('9. Errores de consola durante el test');
    if (consoleErrors.length) {
      consoleErrors.forEach(e => fail(e));
      findings.fail.push(`consola.${consoleErrors.length}_errores`);
    } else {
      ok('sin errores de consola');
      findings.ok.push('consola.limpia');
    }

    step('Resumen final');
    log(`  ✓ OK:    ${findings.ok.length} chequeos`);
    findings.ok.forEach(f => log(`    + ${f}`));
    log(`  ✗ FAIL:  ${findings.fail.length} chequeos`);
    findings.fail.forEach(f => log(`    - ${f}`));

    if (findings.fail.length === 0) {
      log('\n  ★ TEST PASS — buzón A4_COTIZ funciona end-to-end');
    } else {
      log('\n  ⚠ TEST PARCIAL — hay fallos');
    }
    log(`\n  Screenshots en: ${SHOTS}`);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
