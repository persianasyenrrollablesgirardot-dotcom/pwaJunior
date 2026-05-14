#!/usr/bin/env node
/**
 * Test UI buzón A4_COTIZ:
 *   1. Ir a Clientes, seleccionar Jorge Pozo Azul (persona 8, chat 19)
 *   2. Ir a M2 Comerciales
 *   3. Buscar el buzón con ítem cotizacion_propuesta
 *   4. Verificar que se ve el ítem y la propuesta de cotización
 */

import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = join(__dirname, 'test_buzon_shots');
mkdirSync(SHOTS, { recursive: true });

const URL = 'http://localhost:5180/';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PERSONA = 'Jorge Pozo Azul';

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
  // 1) Intento PRIMERO con elementos semánticamente clickeables.
  // 2) Si no, fallback a cualquier div/li/article con cursor:pointer.
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
        // Saltar contenedores muy grandes (probable padre que contiene el texto suelto)
        const ratio = t.length / text.length;
        if (ratio > 12) continue;
        // Preferir el MÁS PROFUNDO
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

async function pageText(page) {
  return await page.evaluate(() => document.body.innerText);
}

async function main() {
  step('Lanzando Chrome');
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    defaultViewport: { width: 1440, height: 900 },
    args: ['--no-sandbox'],
  });

  const findings = [];

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

    step('1. Cargando app');
    await page.goto(URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1200);
    await shot(page, '01_home');
    ok('app cargada');

    step('2. Click botón "→ Ir a Clientes" (más directo que el sidebar)');
    let okClientes = await clickByText(page, '→ Ir a Clientes', { exact: false });
    if (!okClientes) {
      warn('botón "Ir a Clientes" no visible, intento sidebar');
      okClientes = await clickByText(page, 'Clientes', { exact: true });
    }
    if (!okClientes) { fail('no pude entrar a Clientes'); findings.push('No se encontró ningún botón Clientes'); }
    else { ok('navegado a Clientes'); }
    await sleep(1800);
    await shot(page, '02_clientes');

    step(`3. Buscar y seleccionar persona "${PERSONA}"`);
    const okPersona = await clickByText(page, PERSONA, { exact: false });
    if (!okPersona) {
      warn(`no encontré "${PERSONA}" en la lista visible. Intento por input de búsqueda.`);
      // Probar buscar por search input
      const tieneSearch = await page.evaluate(() => {
        const inp = document.querySelector('input[type="search"], input[placeholder*="uscar" i], input[placeholder*="filtr" i]');
        if (inp) { inp.focus(); return true; }
        return false;
      });
      if (tieneSearch) {
        await page.keyboard.type('Jorge');
        await sleep(800);
        await shot(page, '03_search_jorge');
        const ok2 = await clickByText(page, PERSONA, { exact: false });
        if (ok2) ok('seleccioné Jorge tras buscar'); else findings.push('No pude seleccionar Jorge ni con búsqueda');
      } else {
        findings.push(`No encontré "${PERSONA}" y no hay input de búsqueda visible`);
      }
    } else {
      ok('seleccioné Jorge');
    }
    await sleep(1500);
    await shot(page, '04_jorge_seleccionado');

    step('4. Ir a M1 Núcleo (donde vive el Buzón de Validación)');
    const okM1 = await clickByText(page, '1 · Núcleo', { exact: false });
    if (!okM1) { fail('M1 Núcleo no encontrado'); findings.push('Botón M1 no encontrado'); }
    else { ok('clic M1 OK'); }
    await sleep(1800);
    await shot(page, '05_m1_nucleo');

    step('5. Buscar buzón / propuesta de cotización en pantalla');
    const txt = await pageText(page);
    const tienePalabras = {
      buzon: /buz[oó]n|pendiente|valid|aprobar|propuesta/i.test(txt),
      tapaluces: /tapa\s*luz|tapaluz/i.test(txt),
      cotizacionPropuesta: /cotizaci[oó]n.*propues|propues.*cotiz/i.test(txt),
      blackout: /blackout/i.test(txt),
      jorge: /jorge|pozo azul/i.test(txt),
    };
    log('  presencia de palabras clave en pantalla:');
    Object.entries(tienePalabras).forEach(([k, v]) => log(`    ${v ? '✓' : '·'} ${k}: ${v}`));

    // Si hay tab "Buzón" intentar abrirlo
    const subtabs = await page.evaluate(() => {
      const items = [];
      for (const el of document.querySelectorAll('[role="tab"], button, a')) {
        const t = (el.innerText || '').trim();
        if (t && t.length < 60 && /buz[oó]n|valid|propues|pendiente|2\.\d/i.test(t)) items.push(t);
      }
      return [...new Set(items)];
    });
    log('  tabs/botones candidatos del buzón:');
    subtabs.forEach(t => log(`    • ${t}`));

    // Intentar abrir "Buzón" o "Propuestas"
    for (const cand of ['Buzón', 'Buzon', 'Propuestas', 'Pendientes', 'Validación']) {
      const c = await clickByText(page, cand, { exact: false });
      if (c) { ok(`clic en "${cand}"`); await sleep(1500); await shot(page, `06_${cand.toLowerCase()}`); break; }
    }

    step('6. Buscar evidencia del ítem en pantalla post-click');
    const txt2 = await pageText(page);
    const tieneItem = {
      tapaluces: /tapa\s*luz|tapaluz/i.test(txt2),
      blackout: /blackout/i.test(txt2),
      sala: /sala/i.test(txt2),
      resumenLLM: /tapa luces.*blackout|blackout.*tapaluz/i.test(txt2),
    };
    log('  buscando ítem A4_COTIZ:');
    Object.entries(tieneItem).forEach(([k, v]) => log(`    ${v ? '✓' : '·'} ${k}: ${v}`));
    await shot(page, '07_final');

    // Capturar TODO el texto visible para debug
    writeFileSync(join(SHOTS, 'final_page_text.txt'), txt2);
    log(`\n  Texto final guardado en final_page_text.txt (${txt2.length} chars)`);

    if (consoleErrors.length) {
      step('Errores de consola durante el test');
      consoleErrors.forEach(e => fail(e));
    } else {
      ok('sin errores de consola');
    }

    step('Resumen findings');
    if (findings.length === 0 && (tieneItem.tapaluces || tieneItem.resumenLLM)) {
      ok('TEST PASS: ítem A4_COTIZ visible en buzón');
    } else {
      warn('TEST INCOMPLETO. Findings:');
      findings.forEach(f => log(`    - ${f}`));
      if (!tieneItem.tapaluces && !tieneItem.resumenLLM) {
        warn('No detecté el ítem de cotización en pantalla');
      }
    }

    log(`\nScreenshots en: ${SHOTS}`);
  } finally {
    await browser.close();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
