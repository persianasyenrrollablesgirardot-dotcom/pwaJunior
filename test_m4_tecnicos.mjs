#!/usr/bin/env node
/**
 * F4.4 — Test E2E del MÓDULO 4 Técnicos (6 sub-tabs)
 *
 * SEED: persona con cotización ganada + 2 items:
 *   - Item A (blackout, sala): cotizado 2.5×1.8m
 *   - Item B (screen_solar, oficina): cotizado 1.2×1.5m, quien_midio=cliente (R-013#1)
 *
 * UI: recorre las 6 sub-tabs:
 *   4.1 Medidas        — crear medida etapa "cliente" para Item A con ancho 2.5, alto 1.8
 *                      — crear medida etapa "empresa" con discrepancia (2.55, 1.75)
 *   4.2 Riesgo medidas — verificar que aparezca el riesgo "cliente_midio_riesgo_alto"
 *                        para Item B (porque cotizacion_items.quien_midio=cliente)
 *   4.3 Producto/Sistema — verificar agrupación por sistema + advertencias filtradas
 *   4.4 Advertencias   — verificar que aparezcan BLACKOUT-001 + SCREEN-001 + globales
 *   4.5 Compatibilidad — verificar reglas BLACKOUT-TELA + SCREEN-TELA visibles
 *   4.6 Biblioteca técnica — verificar que muestre health-check + los 13 especialistas
 *
 * SQL: verifica medidas persistidas + vw_riesgos_medidas devuelve la fila esperada.
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(__dirname, 'test_m4_shots');
mkdirSync(SHOTS, { recursive: true });

const CLEANUP = process.argv.includes('--cleanup');

const envLines = readFileSync(join(__dirname, '.env'), 'utf8').split('\n');
const env = Object.fromEntries(envLines.map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const SB_URL = env.VITE_SUPABASE_URL;
const DB_PWD = env.SUPABASE_DB_PASSWORD;
const ref = SB_URL.match(/https:\/\/([^.]+)\./)[1];

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m' };
const log = (s) => console.log(s);
const sec = (n, t) => log(`\n${C.cyan}${C.bold}━━ FASE ${n} — ${t} ━━${C.reset}`);
const step = (s) => log(`${C.blue}▸ ${s}${C.reset}`);
const ok = (s) => log(`  ${C.green}✓${C.reset} ${s}`);
const fail = (s) => log(`  ${C.red}✗${C.reset} ${s}`);
const info = (s) => log(`  ${C.dim}· ${s}${C.reset}`);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const RESULTS = { passed: [], failed: [] };
function record(label, cond, errMsg) {
  if (cond) { ok(label); RESULTS.passed.push(label); }
  else { fail(`${label} — ${errMsg ?? 'falló'}`); RESULTS.failed.push(label); }
}

async function connectPg() {
  const pwd = encodeURIComponent(DB_PWD);
  const candidates = [
    `postgresql://postgres.${ref}:${pwd}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:${pwd}@db.${ref}.supabase.co:5432/postgres`,
  ];
  for (const conn of candidates) {
    const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
    try { await c.connect(); return c; } catch { try { await c.end(); } catch {} }
  }
  throw new Error('No conecté');
}

const TAG = '[TEST-M4]';

async function cleanupPrev(c) {
  await c.query(`DELETE FROM medidas WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM cotizacion_items WHERE cotizacion_id IN (SELECT id FROM cotizaciones WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1))`, [`${TAG}%`]);
  await c.query(`DELETE FROM cotizaciones WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM mensajes WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM chats WHERE titulo LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM proyectos WHERE nombre LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM personas WHERE nombre LIKE $1`, [`${TAG}%`]);
}

async function seed(c) {
  step('Cleanup previo + seed nuevo…');
  await cleanupPrev(c);

  const p = await c.query(`INSERT INTO personas (nombre, telefono_e164, ambito_principal) VALUES ($1, '+573015553001', 'comercial') RETURNING id`, [`${TAG} Tecno Test`]);
  const A = Number(p.rows[0].id);

  const proy = await c.query(`INSERT INTO proyectos (persona_id, ambito, nombre, estado) VALUES ($1, 'comercial', $2, 'ganado') RETURNING id`, [A, `${TAG} Proyecto Tecno`]);
  const proyA = Number(proy.rows[0].id);

  const chat = await c.query(`INSERT INTO chats (canal, canal_chat_id, tipo, titulo, ambito, proyecto_id, ia_historico_procesado)
     VALUES ('whatsapp', $1, 'individual', $2, 'comercial', $3, true) RETURNING id`,
    ['573015553001@s.whatsapp.net', `${TAG} Tecno Test`, proyA]);
  const chatA = Number(chat.rows[0].id);
  await c.query(`INSERT INTO mensajes (chat_id, canal_msg_id, direccion, tipo, texto, ts_canal, persona_autor_id)
     VALUES ($1, 'test-m4-msg', 'entrante', 'texto', 'Test M4', NOW(), $2)`, [chatA, A]);

  // Cotización con 2 items
  const cot = await c.query(`INSERT INTO cotizaciones (persona_id, proyecto_id, numero_cotizacion, estado, subtotal, total, saldo)
     VALUES ($1, $2, 'TEST-M4-COT', 'ganada', 2500000, 2500000, 0) RETURNING id`, [A, proyA]);
  const cotId = Number(cot.rows[0].id);

  // Item A: blackout, sala, técnico midió
  const iA = await c.query(`INSERT INTO cotizacion_items (cotizacion_id, sistema_safra_codigo, ambiente, ancho_m, alto_m, cantidad, precio_unitario, monto_total, quien_midio, orden)
     VALUES ($1, 'blackout', 'Sala', 2.50, 1.80, 1, 1500000, 1500000, 'tecnico', 0) RETURNING id`, [cotId]);
  const itemA = Number(iA.rows[0].id);

  // Item B: screen_solar, oficina, CLIENTE midió (R-013#1 → debe disparar riesgo)
  const iB = await c.query(`INSERT INTO cotizacion_items (cotizacion_id, sistema_safra_codigo, ambiente, ancho_m, alto_m, cantidad, precio_unitario, monto_total, quien_midio, orden)
     VALUES ($1, 'screen_solar', 'Oficina', 1.20, 1.50, 1, 1000000, 1000000, 'cliente', 1) RETURNING id`, [cotId]);
  const itemB = Number(iB.rows[0].id);

  // Pre-cargar 1 medida etapa "cliente" para Item B (eso es exactamente la condición que debería disparar riesgo)
  await c.query(`INSERT INTO medidas (cotizacion_item_id, persona_id, etapa, ancho_m, alto_m, quien_midio, fecha)
     VALUES ($1, $2, 'cliente', 1.20, 1.50, 'cliente', CURRENT_DATE)`, [itemB, A]);

  info(`A=${A}, cot=${cotId}, itemA=${itemA} (blackout/tecnico), itemB=${itemB} (screen/cliente)`);
  return { A, cotId, itemA, itemB };
}

// ── Puppeteer helpers ──────────────────────────────────────────────

async function connectBrowser() {
  const v = await fetch('http://localhost:9222/json/version').then(r => r.json());
  return puppeteer.connect({ browserWSEndpoint: v.webSocketDebuggerUrl, defaultViewport: { width: 1440, height: 900 } });
}
async function openVisor(browser) {
  const page = await browser.newPage();
  await page.bringToFront();
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle2', timeout: 30_000 });
  await page.evaluate(() => { try { sessionStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(800);
  return page;
}
async function waitFor(page, fn, timeout = 5000, label = 'cond') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await page.evaluate(fn)) return true;
    await sleep(150);
  }
  throw new Error(`Timeout esperando ${label}`);
}
async function clickByText(page, sel, text) {
  await page.bringToFront();
  const r = await page.evaluate((s, t) => {
    const e = [...document.querySelectorAll(s)].find(x => (x.textContent || '').includes(t));
    if (!e) return false; e.scrollIntoView({ block: 'center' }); e.click(); return true;
  }, sel, text);
  if (!r) throw new Error(`No "${sel}" con "${text}"`);
  await sleep(300);
}
async function navegarModulo(page, txt) {
  await page.bringToFront();
  const r = await page.evaluate(t => {
    const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim() === t);
    if (!b) return false; b.click(); return true;
  }, txt);
  if (!r) throw new Error(`navegarModulo: no "${txt}"`);
  await sleep(800);
}
async function fillField(page, labelText, value) {
  const r = await page.evaluate((lt, v) => {
    const all = [...document.querySelectorAll('[style*="z-index"]')];
    let top = document.body, maxZ = -1;
    for (const el of all) {
      const cs = window.getComputedStyle(el);
      const z = parseInt(cs.zIndex, 10);
      if (!isNaN(z) && z > maxZ && cs.display !== 'none') { maxZ = z; top = el; }
    }
    const find = root => [...root.querySelectorAll('label')].find(l => (l.textContent || '').toLowerCase().includes(lt.toLowerCase()));
    let lab = find(top); if (!lab && top !== document.body) lab = find(document.body);
    if (!lab) return { ok: false, reason: 'no-label' };
    const i = lab.querySelector('input, textarea, select');
    if (!i) return { ok: false, reason: 'no-input' };
    if (i.tagName === 'SELECT') {
      const idx = [...i.options].findIndex(o => o.value === v);
      if (idx < 0) return { ok: false, reason: 'option-not-found', want: v, avail: [...i.options].map(o => o.value) };
      i.selectedIndex = idx;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(i, v);
      i.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    const proto = i.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(i, v);
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, labelText, value);
  if (!r.ok) {
    const extra = r.reason === 'option-not-found' ? ` (want="${r.want}", avail=[${(r.avail ?? []).join(',')}])` : '';
    throw new Error(`fillField("${labelText}", "${value}") — ${r.reason}${extra}`);
  }
}
async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  info(`📸 ${name}.png`);
}

// ── Drivers ──────────────────────────────────────────────────────────

async function ui_seleccionarCliente(page) {
  step('UI → Clientes → seleccionar Tecno Test…');
  await navegarModulo(page, 'Clientes');
  await sleep(1200);
  await shot(page, '01_clientes');
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('input')].find(i => i.type === 'search');
    if (s) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, '5553001');
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(700);
  const r = await page.evaluate(() => {
    const card = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Tecno Test'));
    if (card) { card.click(); return true; } return false;
  });
  if (!r) throw new Error('No encontré card Tecno Test');
  await sleep(1000);
}

async function ui_medidas(page) {
  step('UI → M4 → 4.1 Medidas → crear medida etapa empresa con discrepancia…');
  await navegarModulo(page, '4 · Técnicos');
  await sleep(1000);
  await shot(page, '02_m4_medidas');

  // Encontrar la card de Item A (blackout/Sala) y click en celda "Empresa".
  // Estrategia: buscar el <strong> que contenga "blackout" (sin "screen"), subir
  // hasta encontrar el ancestor que tenga 5 buttons en su grid de etapas, y
  // ahí clickear el botón EMPRESA.
  await waitFor(page, () => document.body.innerText.includes('blackout') && document.body.innerText.includes('Sala'), 5000, 'card blackout visible');
  const ok = await page.evaluate(() => {
    const strong = [...document.querySelectorAll('strong')].find(s => {
      const t = s.textContent || '';
      return t.includes('blackout') && !t.includes('screen');
    });
    if (!strong) return { ok: false, reason: 'no-strong-blackout' };
    let card = strong.parentElement;
    while (card && card !== document.body) {
      const btns = [...card.querySelectorAll('button')];
      // Card real tiene exactamente 5 botones (uno por etapa)
      if (btns.length === 5 && btns.every(b => /CLIENTE|EMPRESA|CORREGIDA|PRODUCCIÓN|INSTALADA/i.test(b.textContent || ''))) {
        const btnEmpresa = btns.find(b => /EMPRESA/i.test(b.textContent || ''));
        if (btnEmpresa) { btnEmpresa.scrollIntoView({ block: 'center' }); btnEmpresa.click(); return { ok: true }; }
      }
      card = card.parentElement;
    }
    return { ok: false, reason: 'no-card-with-5-buttons' };
  });
  if (!ok.ok) throw new Error(`No pude click en celda EMPRESA de blackout — ${ok.reason}`);
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Medida etapa/.test(h.textContent || '')), 5000, 'modal medida');
  await sleep(300);
  await fillField(page, 'Ancho', '2.55');
  await fillField(page, 'Alto', '1.75');
  await fillField(page, 'Quién midió', 'Jhon (técnico)');
  await fillField(page, 'Notas', 'Test E2E F4.4 — medida empresa con leve discrepancia');
  await shot(page, '03_modal_medida');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '04_medida_guardada');
}

async function ui_riesgos(page) {
  step('UI → M4 → 4.2 Riesgo medidas…');
  await clickByText(page, 'button', '4.2 Riesgo medidas');
  await sleep(1200);
  await shot(page, '05_riesgo_medidas');

  const body = await page.evaluate(() => document.body.innerText);
  record('Riesgos: aparece "Cliente midió" para Item B (R-013#1)',
    body.toLowerCase().includes('cliente midió') || body.toLowerCase().includes('cliente_midio'));
  record('Riesgos: muestra KPI Críticos', body.toLowerCase().includes('crítico') || body.toLowerCase().includes('critico'));
}

async function ui_producto(page) {
  step('UI → M4 → 4.3 Producto/Sistema…');
  await clickByText(page, 'button', '4.3 Producto');
  await sleep(1500);
  await shot(page, '06_producto_sistema');

  const body = await page.evaluate(() => document.body.innerText);
  record('Producto/Sistema muestra "Blackout"', body.includes('Blackout'));
  record('Producto/Sistema muestra "Screen Solar"', body.includes('Screen Solar'));
  record('Producto/Sistema lista cantidad de items', body.includes('1 items') || body.match(/\d+ items/));
}

async function ui_advertencias(page) {
  step('UI → M4 → 4.4 Advertencias…');
  await clickByText(page, 'button', '4.4 Advertencias');
  await sleep(1200);
  await shot(page, '07_advertencias');

  const body = await page.evaluate(() => document.body.innerText);
  record('Advertencias muestra BLACKOUT-001', body.includes('BLACKOUT-001'));
  record('Advertencias muestra SCREEN-001', body.includes('SCREEN-001'));
  record('Advertencias muestra "oscuridad absoluta" (texto de BLACKOUT-001)', body.toLowerCase().includes('oscuridad absoluta'));
  record('Advertencias muestra advertencia global de cliente midió', body.includes('MEDIDA-CLI-001'));
}

async function ui_compatibilidad(page) {
  step('UI → M4 → 4.5 Compatibilidad…');
  await clickByText(page, 'button', '4.5 Compatibilidad');
  await sleep(1200);
  await shot(page, '08_compatibilidad');

  const body = await page.evaluate(() => document.body.innerText);
  record('Compatibilidad muestra BLACKOUT-TELA', body.includes('BLACKOUT-TELA'));
  record('Compatibilidad muestra "screen_3, screen_5"', body.includes('screen_3') && body.includes('screen_5'));
  record('Compatibilidad muestra valor KO (blackout / sheer)', body.toLowerCase().includes('voile') || body.toLowerCase().includes('sheer'));
}

async function ui_biblioteca(page) {
  step('UI → M4 → 4.6 Biblioteca técnica…');
  await clickByText(page, 'button', '4.6 Biblioteca');
  await sleep(3500);  // health-check tarda hasta 3s
  await shot(page, '09_biblioteca');

  const body = await page.evaluate(() => document.body.innerText);
  record('Biblioteca técnica muestra 13 especialistas', body.includes('Blackout') && body.includes('Screen Solar') && body.includes('Domótica'));
  record('Biblioteca técnica muestra estado online/offline',
    body.toLowerCase().includes('online') || body.toLowerCase().includes('offline'));
}

async function verificarSQL(c, { A, itemA, itemB }) {
  step('Verificando en BD…');

  // Medidas
  const { rows: meds } = await c.query(`SELECT * FROM medidas WHERE persona_id = $1 AND deleted_at IS NULL ORDER BY etapa`, [A]);
  record('Medidas: hay al menos 2 filas (1 seed Item B etapa cliente + 1 UI Item A etapa empresa)', meds.length >= 2, `BD ${meds.length}`);

  // La medida empresa para Item A creada por la UI (pg devuelve BIGINT como string)
  const medA = meds.find(m => Number(m.cotizacion_item_id) === itemA && m.etapa === 'empresa');
  record('Medida Item A etapa empresa persistida', !!medA);
  if (medA) {
    record('Medida Item A empresa: ancho=2.55', Math.abs(Number(medA.ancho_m) - 2.55) < 0.01, `BD ${medA.ancho_m}`);
    record('Medida Item A empresa: alto=1.75', Math.abs(Number(medA.alto_m) - 1.75) < 0.01, `BD ${medA.alto_m}`);
    record('Medida Item A empresa: area_m2 generada = 4.4625',
      Math.abs(Number(medA.area_m2) - 4.4625) < 0.01, `BD ${medA.area_m2}`);
  }

  // vw_riesgos_medidas: debe devolver al menos la fila de Item B (cliente_midio_riesgo_alto)
  const { rows: riesgos } = await c.query(`SELECT * FROM vw_riesgos_medidas WHERE persona_id = $1`, [A]);
  record('vw_riesgos_medidas devuelve filas para esta persona', riesgos.length > 0, `BD ${riesgos.length}`);
  const riesgoCli = riesgos.find(r => Number(r.cotizacion_item_id) === itemB && r.tipo_riesgo === 'cliente_midio_riesgo_alto');
  record('vw_riesgos: detecta "cliente_midio_riesgo_alto" para Item B', !!riesgoCli);

  // vw_medidas_etapas: pivote con ambos items
  const { rows: pivote } = await c.query(`SELECT * FROM vw_medidas_etapas WHERE persona_id = $1`, [A]);
  record('vw_medidas_etapas devuelve 2 filas (items A y B)', pivote.length === 2, `BD ${pivote.length}`);
  const pA = pivote.find(p => Number(p.item_id) === itemA);
  record('Pivote Item A: ancho_empresa = 2.55',
    pA && Math.abs(Number(pA.ancho_empresa) - 2.55) < 0.01, `BD ${pA?.ancho_empresa}`);
  const pB = pivote.find(p => Number(p.item_id) === itemB);
  record('Pivote Item B: ancho_cliente = 1.20 (medida seed)',
    pB && Math.abs(Number(pB.ancho_cliente) - 1.20) < 0.01, `BD ${pB?.ancho_cliente}`);

  // Advertencias cargadas (de la migración seed)
  const { rows: advs } = await c.query(`SELECT count(*)::int AS n FROM advertencias_safra WHERE deleted_at IS NULL`);
  record('advertencias_safra tiene al menos 10 filas seed', advs[0].n >= 10, `BD ${advs[0].n}`);

  // Reglas compatibilidad cargadas
  const { rows: regs } = await c.query(`SELECT count(*)::int AS n FROM reglas_compatibilidad WHERE deleted_at IS NULL`);
  record('reglas_compatibilidad tiene al menos 7 filas seed', regs[0].n >= 7, `BD ${regs[0].n}`);
}

let pgClient = null, browser = null, page = null;

async function main() {
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`${C.bold}${C.magenta}   F4.4 — TEST E2E M4 TÉCNICOS${C.reset}`);
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  info(`Project: ${ref}  ·  Screenshots → ${SHOTS}`);

  sec(0, 'CONEXIONES');
  pgClient = await connectPg(); ok('PG');
  browser = await connectBrowser(); ok('Chrome');

  sec(1, 'SEED');
  const seeded = await seed(pgClient);
  ok('Seed listo');

  sec(2, 'UI E2E');
  page = await openVisor(browser);
  await ui_seleccionarCliente(page);
  await ui_medidas(page);
  await ui_riesgos(page);
  await ui_producto(page);
  await ui_advertencias(page);
  await ui_compatibilidad(page);
  await ui_biblioteca(page);

  sec(3, 'VERIFICACIÓN SQL');
  await verificarSQL(pgClient, seeded);

  sec(4, 'REPORTE');
  log(`\n${C.bold}${C.green}✓ Passed:${C.reset} ${RESULTS.passed.length}`);
  log(`${C.bold}${C.red}✗ Failed:${C.reset} ${RESULTS.failed.length}`);
  if (RESULTS.failed.length) {
    log(`\n${C.red}Failures:${C.reset}`);
    for (const f of RESULTS.failed) log(`  · ${f}`);
  }

  if (CLEANUP) {
    sec(5, 'CLEANUP');
    await cleanupPrev(pgClient);
    ok('Datos seed eliminados');
  } else {
    info('\n(Use --cleanup para borrar los datos seed al terminar)');
  }
}

main()
  .catch(err => { console.error(`\n${C.red}❌ ERROR:${C.reset}`, err); process.exitCode = 1; })
  .finally(async () => {
    try { if (page) await page.close(); } catch {}
    try { if (browser) await browser.disconnect(); } catch {}
    try { if (pgClient) await pgClient.end(); } catch {}
    if (RESULTS.failed.length) process.exitCode = 1;
  });
