#!/usr/bin/env node
/**
 * F6.4 — Test E2E del MÓDULO 6 Postventa (5 sub-tabs)
 *
 * SEED: persona + cotización ganada.
 *
 * UI:
 *   6.1 Garantías — abrir garantía causa "producto" → trigger SQL setea responsable=empresa
 *   6.2 Mantenimientos — registrar tipo "lavado" costo 80k
 *   6.3 Satisfacción — marcar cliente "feliz"
 *   6.4 Google Reviews — iniciar workflow apto → marcar solicitada → estrellas=5 (trigger pasa a recibida)
 *   6.5 Reclamos sensibles — registrar motivo "mala_resena" severidad "alta"
 *
 * SQL: 5 inserts + verifica triggers (responsable auto, estado review auto).
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(__dirname, 'test_m6_shots');
mkdirSync(SHOTS, { recursive: true });

const CLEANUP = process.argv.includes('--cleanup');
const env = Object.fromEntries(readFileSync(join(__dirname, '.env'), 'utf8').split('\n')
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const SB_URL = env.VITE_SUPABASE_URL;
const DB_PWD = env.SUPABASE_DB_PASSWORD;
const ref = SB_URL.match(/https:\/\/([^.]+)\./)[1];

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m' };
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
  const cands = [
    `postgresql://postgres.${ref}:${pwd}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:${pwd}@db.${ref}.supabase.co:5432/postgres`,
  ];
  for (const c of cands) {
    const cl = new pg.Client({ connectionString: c, ssl: { rejectUnauthorized: false } });
    try { await cl.connect(); return cl; } catch { try { await cl.end(); } catch {} }
  }
  throw new Error('No conecté');
}

const TAG = '[TEST-M6]';

async function cleanupPrev(c) {
  await c.query(`DELETE FROM reclamos_sensibles WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM google_reviews WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM satisfaccion_postventa WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM mantenimientos WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM garantias WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM cotizaciones WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM mensajes WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM chats WHERE titulo LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM proyectos WHERE nombre LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM personas WHERE nombre LIKE $1`, [`${TAG}%`]);
}

async function seed(c) {
  step('Cleanup previo + seed nuevo…');
  await cleanupPrev(c);
  const p = await c.query(`INSERT INTO personas (nombre, telefono_e164, ambito_principal) VALUES ($1, '+573015556001', 'comercial') RETURNING id`, [`${TAG} Postventa Test`]);
  const A = Number(p.rows[0].id);
  const proy = await c.query(`INSERT INTO proyectos (persona_id, ambito, nombre, estado) VALUES ($1, 'comercial', $2, 'ganado') RETURNING id`, [A, `${TAG} Proyecto PV`]);
  const proyA = Number(proy.rows[0].id);
  const chat = await c.query(`INSERT INTO chats (canal, canal_chat_id, tipo, titulo, ambito, proyecto_id, ia_historico_procesado)
     VALUES ('whatsapp', $1, 'individual', $2, 'comercial', $3, true) RETURNING id`,
    ['573015556001@s.whatsapp.net', `${TAG} Postventa Test`, proyA]);
  const chatA = Number(chat.rows[0].id);
  await c.query(`INSERT INTO mensajes (chat_id, canal_msg_id, direccion, tipo, texto, ts_canal, persona_autor_id)
     VALUES ($1, 'test-m6-msg', 'entrante', 'texto', 'Test M6', NOW(), $2)`, [chatA, A]);
  const cot = await c.query(`INSERT INTO cotizaciones (persona_id, proyecto_id, numero_cotizacion, estado, subtotal, total, saldo)
     VALUES ($1, $2, 'TEST-M6-COT', 'ganada', 1500000, 1500000, 0) RETURNING id`, [A, proyA]);
  const cotId = Number(cot.rows[0].id);
  info(`A=${A}, cot=${cotId}`);
  return { A, cotId };
}

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
async function shot(page, name) { await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); info(`📸 ${name}.png`); }

async function ui_seleccionarCliente(page) {
  step('UI → Clientes → seleccionar Postventa Test…');
  await navegarModulo(page, 'Clientes');
  await sleep(1200);
  await shot(page, '01_clientes');
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('input')].find(i => i.type === 'search');
    if (s) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, '5556001');
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(700);
  const r = await page.evaluate(() => {
    const card = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Postventa Test'));
    if (card) { card.click(); return true; } return false;
  });
  if (!r) throw new Error('No encontré card');
  await sleep(1000);
}

async function ui_garantia(page) {
  step('UI → M6 → 6.1 Garantías → abrir garantía causa producto…');
  await navegarModulo(page, '6 · Postventa');
  await sleep(900);
  await shot(page, '02_garantias_inicial');

  await clickByText(page, 'button', '+ Abrir garantía');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Abrir garantía/.test(h.textContent || '')), 5000, 'modal garantía');
  await sleep(400);

  await fillField(page, 'Causa', 'producto');
  await fillField(page, 'Sistema', 'blackout');
  await fillField(page, 'Costo', '120000');
  await fillField(page, 'Solución', 'Cambio del tubo enrollable — garantía de empresa');
  await shot(page, '03_garantia_form');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '04_garantia_creada');

  const body = await page.evaluate(() => document.body.innerText);
  record('Garantías muestra "Defecto de producto"', body.includes('Defecto de producto'));
  record('Garantías muestra responsable "empresa" (auto desde trigger)', body.toLowerCase().includes('empresa'));
}

async function ui_mantenimiento(page) {
  step('UI → M6 → 6.2 Mantenimientos → registrar lavado…');
  await clickByText(page, 'button', '6.2 Mantenimientos');
  await sleep(800);
  await shot(page, '05_mantenimientos_inicial');

  await clickByText(page, 'button', '+ Registrar mantenimiento');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Registrar mantenimiento/.test(h.textContent || '')), 5000, 'modal mant');
  await sleep(400);

  await fillField(page, 'Tipo', 'lavado');
  await fillField(page, 'Instalador', 'Pedro test E2E');
  await fillField(page, 'Costo', '80000');
  await fillField(page, 'Notas', 'Lavado anual test E2E F6.4');
  await shot(page, '06_mantenimiento_form');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '07_mantenimiento_creado');

  const body = await page.evaluate(() => document.body.innerText);
  record('Mantenimientos muestra "Lavado"', body.includes('Lavado'));
}

async function ui_satisfaccion(page) {
  step('UI → M6 → 6.3 Satisfacción → marcar feliz…');
  await clickByText(page, 'button', '6.3 Satisfacción');
  await sleep(800);
  await shot(page, '08_satisfaccion_inicial');

  // Click en el botón "Feliz"
  const r = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /^Feliz$/.test(b.querySelector('strong')?.textContent ?? ''));
    if (btn) { btn.click(); return true; } return false;
  });
  record('UI Satisfacción: botón "Feliz" cliqueable', r);
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Cliente Feliz/.test(h.textContent || '')), 5000, 'modal satisfacción');
  await sleep(400);

  await fillField(page, 'Notas', 'Test E2E: cliente muy contento con la instalación');
  await shot(page, '09_satisfaccion_form');

  await clickByText(page, 'button', '✓ Registrar');
  await sleep(1500);
  await shot(page, '10_satisfaccion_marcada');

  const body = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  record('Satisfacción muestra "Estado actual" con Feliz', body.includes('estado actual') && body.includes('feliz'));
}

async function ui_reviews(page) {
  step('UI → M6 → 6.4 Google Reviews → workflow apto→solicitada→recibida 5★…');
  await clickByText(page, 'button', '6.4 Google Reviews');
  await sleep(1000);
  await shot(page, '11_reviews_inicial');

  // Click "Iniciar workflow" en el banner amarillo
  const initR = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Iniciar workflow'));
    if (btn) { btn.click(); return true; } return false;
  });
  if (!initR) throw new Error('No encontré botón Iniciar workflow');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Review/.test(h.textContent || '')), 5000, 'modal review');
  await sleep(400);

  // Marcar 5 estrellas directamente (trigger pasa a recibida)
  await fillField(page, 'Estrellas', '5');
  await fillField(page, 'Comentario', 'Excelente servicio, recomendados!');
  await shot(page, '12_review_form');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '13_review_guardada');

  const body = await page.evaluate(() => document.body.innerText);
  record('Reviews muestra "Recibida"', body.toLowerCase().includes('recibida'));
  record('Reviews muestra "Excelente servicio"', body.includes('Excelente servicio'));
}

async function ui_reclamos(page) {
  step('UI → M6 → 6.5 Reclamos sensibles → registrar mala_resena severidad alta…');
  await clickByText(page, 'button', '6.5 Reclamos sensibles');
  await sleep(800);
  await shot(page, '14_reclamos_inicial');

  await clickByText(page, 'button', '+ Registrar reclamo');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Registrar reclamo/.test(h.textContent || '')), 5000, 'modal reclamo');
  await sleep(400);

  await fillField(page, 'Motivo', 'mala_resena');
  await fillField(page, 'Severidad', 'alta');
  await fillField(page, 'Escalado a', 'jhon');
  await fillField(page, 'Acciones tomadas', 'Test E2E: llamar al cliente y ofrecer compensación');
  await shot(page, '15_reclamo_form');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '16_reclamo_guardado');

  const body = await page.evaluate(() => document.body.innerText);
  record('Reclamos muestra "Mala reseña"', body.toLowerCase().includes('mala reseña'));
  record('Reclamos muestra severidad "ALTA"', body.toUpperCase().includes('ALTA'));
}

async function verificarSQL(c, { A, cotId }) {
  step('Verificando en BD…');

  // Garantía
  const { rows: gs } = await c.query(`SELECT * FROM garantias WHERE persona_id = $1 AND deleted_at IS NULL`, [A]);
  record('garantias: 1 fila persistida', gs.length === 1, `BD ${gs.length}`);
  if (gs.length) {
    record('garantia: causa_codigo = "producto"', gs[0].causa_codigo === 'producto');
    record('garantia: responsable auto = "empresa" (trigger)', gs[0].responsable === 'empresa', `BD "${gs[0].responsable}"`);
    record('garantia: sistema = "blackout"', gs[0].sistema_safra_codigo === 'blackout');
    record('garantia: costo = 120.000', Number(gs[0].costo) === 120000);
    record('garantia: estado default = "abierta"', gs[0].estado === 'abierta');
  }

  // Mantenimiento
  const { rows: ms } = await c.query(`SELECT * FROM mantenimientos WHERE persona_id = $1 AND deleted_at IS NULL`, [A]);
  record('mantenimientos: 1 fila persistida', ms.length === 1, `BD ${ms.length}`);
  if (ms.length) {
    record('mantenimiento: tipo = "lavado"', ms[0].tipo === 'lavado');
    record('mantenimiento: costo = 80.000', Number(ms[0].costo) === 80000);
    record('mantenimiento: instalador = "Pedro test E2E"', ms[0].instalador === 'Pedro test E2E');
  }

  // Satisfacción
  const { rows: ss } = await c.query(`SELECT * FROM satisfaccion_postventa WHERE persona_id = $1 AND deleted_at IS NULL`, [A]);
  record('satisfaccion: 1 fila persistida', ss.length === 1, `BD ${ss.length}`);
  if (ss.length) {
    record('satisfaccion: estado_cliente = "feliz"', ss[0].estado_cliente === 'feliz');
    record('satisfaccion: fuente = "whatsapp" (default)', ss[0].fuente === 'whatsapp');
  }

  // Review (trigger debe haber pasado a estado=recibida con estrellas)
  const { rows: rs } = await c.query(`SELECT * FROM google_reviews WHERE persona_id = $1 AND deleted_at IS NULL`, [A]);
  record('google_reviews: 1 fila persistida', rs.length === 1, `BD ${rs.length}`);
  if (rs.length) {
    record('review: estrellas = 5', Number(rs[0].estrellas) === 5);
    record('review: estado auto = "recibida" (trigger desde estrellas)', rs[0].estado === 'recibida', `BD "${rs[0].estado}"`);
    record('review: resena_recibida_at NO null (auto)', rs[0].resena_recibida_at != null);
  }

  // Reclamo
  const { rows: rcs } = await c.query(`SELECT * FROM reclamos_sensibles WHERE persona_id = $1 AND deleted_at IS NULL`, [A]);
  record('reclamos_sensibles: 1 fila persistida', rcs.length === 1, `BD ${rcs.length}`);
  if (rcs.length) {
    record('reclamo: motivo = "mala_resena"', rcs[0].motivo === 'mala_resena');
    record('reclamo: severidad = "alta"', rcs[0].severidad === 'alta');
    record('reclamo: escalado_a = "jhon"', rcs[0].escalado_a === 'jhon');
  }

  // vw_reputacion
  const { rows: rep } = await c.query(`SELECT * FROM vw_reputacion`);
  record('vw_reputacion devuelve fila única', rep.length === 1);
  if (rep.length) {
    record('vw_reputacion: reviews_total >= 1', Number(rep[0].reviews_total) >= 1);
    record('vw_reputacion: cinco_estrellas >= 1', Number(rep[0].cinco_estrellas) >= 1);
    record('vw_reputacion: clientes_felices >= 1', Number(rep[0].clientes_felices) >= 1);
    record('vw_reputacion: reclamos_alta_severidad >= 1', Number(rep[0].reclamos_alta_severidad) >= 1);
  }
}

let pgClient = null, browser = null, page = null;
async function main() {
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`${C.bold}${C.magenta}   F6.4 — TEST E2E M6 POSTVENTA${C.reset}`);
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);

  sec(0, 'CONEXIONES');
  pgClient = await connectPg(); ok('PG');
  browser = await connectBrowser(); ok('Chrome');

  sec(1, 'SEED');
  const seeded = await seed(pgClient);
  ok('Seed listo');

  sec(2, 'UI E2E');
  page = await openVisor(browser);
  await ui_seleccionarCliente(page);
  await ui_garantia(page);
  await ui_mantenimiento(page);
  await ui_satisfaccion(page);
  await ui_reviews(page);
  await ui_reclamos(page);

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
