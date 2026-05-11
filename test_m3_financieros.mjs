#!/usr/bin/env node
/**
 * F3.4 — Test E2E del MÓDULO 3 Financieros
 *
 * FASE 0 — Conectar BD + Chrome remoto :9222 + Vite :5173
 * FASE 1 — SEED: persona A con chat WhatsApp procesado + cotización ganada
 *          + persona B con cotización ganada con saldo (para verificar Cartera).
 * FASE 2 — UI Puppeteer recorre las 5 sub-tabs:
 *   3.1 Facturación      — crear factura asociada a cotización ganada
 *   3.2 Abonos           — crear abono pendiente + confirmar inline + verificar
 *                          que el saldo de cotización baja (trigger SQL)
 *   3.3 Cartera          — vista global, persona B con deuda visible
 *   3.4 Variaciones      — solo verificar placeholder "F3.4" visible
 *   3.5 Rentabilidad     — solo verificar placeholder "F3.5" visible
 * FASE 3 — Verificación SQL:
 *   - factura persistida con campos correctos
 *   - abono persistido + estado_validacion correcto
 *   - cotizaciones.abono_monto / saldo recalculados por trigger
 *   - vw_cartera refleja saldo restante
 * FASE 4 — Reporte
 * FASE 5 — Cleanup (opcional con --cleanup)
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(__dirname, 'test_m3_shots');
mkdirSync(SHOTS, { recursive: true });

const args = process.argv.slice(2);
const CLEANUP = args.includes('--cleanup');

// ─── ENV ────────────────────────────────────────────────────────────────

const envLines = readFileSync(join(__dirname, '.env'), 'utf8').split('\n');
const env = Object.fromEntries(
  envLines.map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()])
);
const SB_URL = env.VITE_SUPABASE_URL;
const DB_PWD = env.SUPABASE_DB_PASSWORD;
if (!SB_URL || !DB_PWD) { console.error('❌ Falta env'); process.exit(1); }
const ref = SB_URL.match(/https:\/\/([^.]+)\./)[1];

// ─── log helpers ─────────────────────────────────────────────────────────

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m' };
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
  else      { fail(`${label} — ${errMsg ?? 'falló'}`); RESULTS.failed.push(label); }
}

// ─── PG ──────────────────────────────────────────────────────────────────

async function connectPg() {
  const pwd = encodeURIComponent(DB_PWD);
  const candidates = [
    `postgresql://postgres.${ref}:${pwd}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${ref}:${pwd}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:${pwd}@db.${ref}.supabase.co:5432/postgres`,
  ];
  for (const conn of candidates) {
    const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
    try { await c.connect(); return c; }
    catch { try { await c.end(); } catch {} }
  }
  throw new Error('No conecté');
}

// ─── SEED ────────────────────────────────────────────────────────────────

const TAG = '[TEST-M3]';

async function cleanupPrev(c) {
  // Borrar en orden inverso a FKs
  await c.query(`DELETE FROM costos_proyecto WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM cotizacion_variaciones WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM abonos WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM facturas WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM cotizaciones WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1) OR proyecto_id IN (SELECT id FROM proyectos WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM mensajes WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM evento_pg WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM chats WHERE titulo LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM proyectos WHERE nombre LIKE $1`, [`${TAG}%`]);
  await c.query(`UPDATE personas SET referido_por_persona_id = NULL WHERE referido_por_persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM personas WHERE nombre LIKE $1`, [`${TAG}%`]);
}

async function seed(c) {
  step('Cleanup datos previos…');
  await cleanupPrev(c);

  step('Insertando personas + proyecto + chat procesado + cotización ganada…');
  const insP = async (nombre, tel) => {
    const r = await c.query(
      `INSERT INTO personas (nombre, telefono_e164, ambito_principal) VALUES ($1, $2, 'comercial') RETURNING id`,
      [nombre, tel],
    );
    return Number(r.rows[0].id);
  };

  const A = await insP(`${TAG} Andrés Pagador`, '+573015552001');
  const B = await insP(`${TAG} Beatriz Deudora`, '+573015552002');

  // Proyecto + chat + mensaje para que A aparezca en Clientes
  const proy = await c.query(
    `INSERT INTO proyectos (persona_id, ambito, nombre, estado) VALUES ($1, 'comercial', $2, 'ganado') RETURNING id`,
    [A, `${TAG} Proyecto Andrés`],
  );
  const proyA = Number(proy.rows[0].id);
  const chat = await c.query(
    `INSERT INTO chats (canal, canal_chat_id, tipo, titulo, ambito, proyecto_id, ia_historico_procesado)
     VALUES ('whatsapp', $1, 'individual', $2, 'comercial', $3, true) RETURNING id`,
    ['573015552001@s.whatsapp.net', `${TAG} Andrés Pagador`, proyA],
  );
  const chatA = Number(chat.rows[0].id);
  await c.query(
    `INSERT INTO mensajes (chat_id, canal_msg_id, direccion, tipo, texto, ts_canal, persona_autor_id)
     VALUES ($1, 'test-m3-msg-001', 'entrante', 'texto', 'Necesito factura', NOW(), $2)`,
    [chatA, A],
  );

  // Cotización GANADA para A (sin abonos todavía) — total $2.000.000
  const cotA = await c.query(`
    INSERT INTO cotizaciones (persona_id, proyecto_id, numero_cotizacion, estado, subtotal, total, saldo)
    VALUES ($1, $2, 'TEST-M3-COT-A', 'ganada', 2000000, 2000000, 2000000) RETURNING id
  `, [A, proyA]);
  const cotAId = Number(cotA.rows[0].id);

  // Cotización GANADA para B con saldo pendiente $800.000 (total $1.500.000, abono $700.000)
  const cotB = await c.query(`
    INSERT INTO cotizaciones (persona_id, numero_cotizacion, estado, subtotal, total, saldo)
    VALUES ($1, 'TEST-M3-COT-B', 'ganada', 1500000, 1500000, 800000) RETURNING id
  `, [B]);
  const cotBId = Number(cotB.rows[0].id);
  await c.query(`
    INSERT INTO abonos (cotizacion_id, persona_id, monto, fecha, metodo, referencia, estado_validacion, notas)
    VALUES ($1, $2, 700000, CURRENT_DATE - INTERVAL '5 days', 'bancolombia', 'TEST-ABO-BEAT-001', 'confirmado', 'Abono seed para test cartera')
  `, [cotBId, B]);

  info(`Personas → A=${A}, B=${B}; CotA=${cotAId} ($2M sin abonos), CotB=${cotBId} (saldo $800K)`);
  return { A, B, proyA, chatA, cotAId, cotBId };
}

// ─── PUPPETEER ───────────────────────────────────────────────────────────

async function connectBrowser() {
  const v = await fetch('http://localhost:9222/json/version').then(r => r.json());
  return puppeteer.connect({
    browserWSEndpoint: v.webSocketDebuggerUrl,
    defaultViewport: { width: 1440, height: 900 },
  });
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

async function clickByText(page, sel, text, { idx = 0 } = {}) {
  await page.bringToFront();
  const clicked = await page.evaluate((s, t, i) => {
    const els = [...document.querySelectorAll(s)];
    const matches = els.filter(e => (e.textContent || '').includes(t));
    const target = matches[i];
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  }, sel, text, idx);
  if (!clicked) throw new Error(`No encontré "${sel}" con texto "${text}"`);
  await sleep(300);
}

async function navegarModulo(page, txt) {
  await page.bringToFront();
  const clicked = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === t);
    if (!btn) return false;
    btn.click(); return true;
  }, txt);
  if (!clicked) throw new Error(`navegarModulo: no "${txt}"`);
  await sleep(800);
}

async function fillField(page, labelText, value) {
  const r = await page.evaluate((lt, v) => {
    const allEls = [...document.querySelectorAll('[style*="z-index"]')];
    let topContainer = document.body;
    let maxZ = -1;
    for (const el of allEls) {
      const cs = window.getComputedStyle(el);
      const z = parseInt(cs.zIndex, 10);
      if (!isNaN(z) && z > maxZ && cs.display !== 'none') { maxZ = z; topContainer = el; }
    }
    const find = (root) => {
      const labels = [...root.querySelectorAll('label')];
      return labels.find(l => (l.textContent || '').toLowerCase().includes(lt.toLowerCase()));
    };
    let lab = find(topContainer);
    if (!lab && topContainer !== document.body) lab = find(document.body);
    if (!lab) return { ok: false, reason: 'no-label' };
    const input = lab.querySelector('input, textarea, select');
    if (!input) return { ok: false, reason: 'no-input' };
    if (input.tagName === 'SELECT') {
      const options = [...input.options];
      const idx = options.findIndex(o => o.value === v);
      if (idx < 0) return { ok: false, reason: 'option-not-found', want: v, avail: options.map(o => o.value) };
      input.selectedIndex = idx;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(input, v);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
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

// ─── DRIVERS ─────────────────────────────────────────────────────────────

async function ui_clienteA(page) {
  step('UI → Clientes → buscar Andrés Pagador → seleccionar…');
  await navegarModulo(page, 'Clientes');
  await sleep(1200);
  await shot(page, '01_clientes');
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('input')].find(i => i.type === 'search');
    if (s) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, '5552001');
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(700);
  const clicked = await page.evaluate(() => {
    const card = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Andrés Pagador'));
    if (card) { card.click(); return true; } return false;
  });
  if (!clicked) throw new Error('No encontré card de Andrés');
  await sleep(1000);
}

async function ui_facturacion(page) {
  step('UI → M3 → 3.1 Facturación → crear factura asociada a cotización…');
  await navegarModulo(page, '3 · Financieros');
  await sleep(800);
  await shot(page, '02_m3_facturacion_inicial');

  await clickByText(page, 'button', '3.1 Facturación');
  await sleep(700);

  await clickByText(page, 'button', '+ Nueva factura');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Nueva factura/.test(h.textContent || '')), 5000, 'modal factura');
  await sleep(400);
  await shot(page, '03_modal_factura');

  await fillField(page, 'Número factura', 'TEST-FAC-001');
  await fillField(page, 'Estado', 'emitida');
  // Seleccionar cotización (debe auto-rellenar valor_total con 2.000.000)
  const cotOk = await page.evaluate(() => {
    const sels = [...document.querySelectorAll('select')];
    const cotSel = sels.find(s => [...s.options].some(o => /TEST-M3-COT-A/.test(o.textContent || '')));
    if (!cotSel) return false;
    const opt = [...cotSel.options].find(o => o.textContent.includes('TEST-M3-COT-A'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(cotSel, opt.value);
    cotSel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  });
  record('UI Facturación: select cotización tiene TEST-M3-COT-A', cotOk);
  await sleep(500);
  await fillField(page, 'Notas', 'Test E2E F3.4');
  await shot(page, '04_factura_lista');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '05_factura_guardada');
}

async function ui_abonos(page) {
  step('UI → M3 → 3.2 Abonos → crear abono pendiente + confirmar inline…');
  await clickByText(page, 'button', '3.2 Abonos');
  await sleep(800);
  await shot(page, '06_abonos_inicial');

  await clickByText(page, 'button', '+ Registrar abono');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Registrar abono/.test(h.textContent || '')), 5000, 'modal abono');
  await sleep(400);

  // Cotización ya viene seleccionada por default; setear monto, método, ref
  await fillField(page, 'Monto', '500000');
  await fillField(page, 'Método', 'nequi');
  await fillField(page, 'Cuenta receptora', 'Nequi 3015552001');
  await fillField(page, 'Referencia', 'TEST-ABO-001');
  await fillField(page, 'Estado validación', 'pendiente');
  await fillField(page, 'Notas', 'Test E2E abono pendiente F3.4');
  await shot(page, '07_abono_form');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1800);
  await shot(page, '08_abono_pendiente_creado');

  // Click "✓ Confirmar" inline en la card del abono recién creado
  const confirmado = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('✓ Confirmar'));
    if (!btn) return false;
    btn.click(); return true;
  });
  record('UI Abonos: botón ✓ Confirmar inline funcional', confirmado);
  await sleep(1500);
  await shot(page, '09_abono_confirmado');
}

async function ui_cartera(page) {
  step('UI → M3 → 3.3 Cartera (vista global)…');
  await clickByText(page, 'button', '3.3 Cartera');
  await sleep(1500);
  const body = await page.evaluate(() => document.body.innerText);
  record('Cartera muestra "Beatriz Deudora" (persona con saldo $800K)', body.includes('Beatriz Deudora'));
  record('Cartera muestra "Saldos pendientes" en título', body.toLowerCase().includes('saldos pendientes'));
  await shot(page, '10_cartera');
}

async function ui_variaciones(page) {
  step('UI → M3 → 3.4 Variaciones → registrar variación tipo descuento…');
  await clickByText(page, 'button', '3.4 Variaciones');
  await sleep(900);
  await shot(page, '11_variaciones_inicial');

  await clickByText(page, 'button', '+ Registrar variación');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Registrar variación/.test(h.textContent || '')), 5000, 'modal variación');
  await sleep(300);

  await fillField(page, 'Tipo', 'descuento');
  await fillField(page, 'Monto Δ', '-150000');  // descuento de $150K
  await fillField(page, 'Responsable', 'empresa');
  await fillField(page, 'Motivo', 'Test E2E descuento por pago contado');
  await shot(page, '12_variacion_form');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '13_variacion_guardada');

  const body = await page.evaluate(() => document.body.innerText);
  record('Variaciones muestra "Descuento" en card', body.includes('Descuento'));
  record('Variaciones muestra "-$ 150.000" o "150.000"', body.includes('150.000'));
}

async function ui_rentabilidad(page) {
  step('UI → M3 → 3.5 Rentabilidad → registrar costo + verificar margen…');
  await clickByText(page, 'button', '3.5 Rentabilidad');
  await sleep(1200);
  await shot(page, '14_rentabilidad_inicial');

  // Capturar pantalla con KPI venta_total = $2M antes del costo
  const antes = await page.evaluate(() => document.body.innerText);
  record('Rentabilidad muestra "Venta ganada"', antes.toLowerCase().includes('venta ganada'));
  record('Rentabilidad muestra "$ 2.000.000" de venta (cotización ganada seed)', antes.includes('2.000.000'));

  await clickByText(page, 'button', '+ Registrar costo');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Registrar costo/.test(h.textContent || '')), 5000, 'modal costo');
  await sleep(300);

  await fillField(page, 'Tipo', 'producto');
  await fillField(page, 'Monto', '600000');
  await fillField(page, 'Vendor', 'Tejidos Safra SAS');
  await fillField(page, 'Descripción', 'Tela blackout test E2E F3.8');
  await shot(page, '15_costo_form');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '16_costo_guardado');

  const despues = await page.evaluate(() => document.body.innerText);
  // Margen esperado: 2.000.000 + (-150.000 variación) − 600.000 = 1.250.000
  record('Rentabilidad recalcula margen con costo agregado',
    despues.includes('1.250.000') || despues.includes('1,250,000'),
    'no se vio "1.250.000" en pantalla',
  );
  record('Rentabilidad muestra costo "Producto"', despues.includes('Producto'));
}

// ─── VERIFICACIÓN SQL ────────────────────────────────────────────────────

async function verificarSQL(c, { A, cotAId }) {
  step('Verificando persistencia en BD…');

  // Factura
  const { rows: facts } = await c.query(
    `SELECT * FROM facturas WHERE persona_id = $1 AND numero_factura = 'TEST-FAC-001' AND deleted_at IS NULL`,
    [A],
  );
  record('Factura TEST-FAC-001 persistida', facts.length === 1);
  if (facts.length) {
    record('Factura: valor_total = 2.000.000 (auto-rellenado desde cotización)',
      Number(facts[0].valor_total) === 2000000, `BD ${facts[0].valor_total}`);
    record('Factura: cotizacion_id = CotA', Number(facts[0].cotizacion_id) === cotAId);
    record('Factura: estado = "emitida"', facts[0].estado === 'emitida');
  }

  // Abono
  const { rows: abos } = await c.query(
    `SELECT * FROM abonos WHERE persona_id = $1 AND referencia = 'TEST-ABO-001' AND deleted_at IS NULL`,
    [A],
  );
  record('Abono TEST-ABO-001 persistido', abos.length === 1);
  if (abos.length) {
    record('Abono: monto = 500.000', Number(abos[0].monto) === 500000, `BD ${abos[0].monto}`);
    record('Abono: método = nequi', abos[0].metodo === 'nequi');
    record('Abono: estado_validacion = "confirmado" (tras click inline)',
      abos[0].estado_validacion === 'confirmado', `BD "${abos[0].estado_validacion}"`);
    record('Abono: validado_at NO null (se setea cuando estado=confirmado)',
      abos[0].validado_at != null, `BD ${abos[0].validado_at}`);
  }

  // Trigger: cotización debe tener abono_monto=500000 y saldo=1500000
  const { rows: cots } = await c.query(`SELECT abono_monto, saldo, total FROM cotizaciones WHERE id = $1`, [cotAId]);
  if (cots.length) {
    record('Trigger SQL: cotizaciones.abono_monto = 500.000 tras abono confirmado',
      Number(cots[0].abono_monto) === 500000, `BD ${cots[0].abono_monto}`);
    record('Trigger SQL: cotizaciones.saldo = 1.500.000 (2M − 500K)',
      Number(cots[0].saldo) === 1500000, `BD ${cots[0].saldo}`);
  }

  // vw_cartera debe incluir a Beatriz con deuda $800K
  const { rows: cartera } = await c.query(`SELECT * FROM vw_cartera WHERE persona_nombre LIKE $1`, [`${TAG}%`]);
  record('vw_cartera incluye al menos 2 personas (Andrés con $1.5M restante + Beatriz con $800K)',
    cartera.length >= 2, `BD ${cartera.length}`);
  const beatriz = cartera.find(c => c.persona_nombre.includes('Beatriz'));
  record('vw_cartera: Beatriz deuda_total = 800.000',
    beatriz && Number(beatriz.deuda_total) === 800000,
    `BD ${beatriz?.deuda_total}`);
  const andres = cartera.find(c => c.persona_nombre.includes('Andrés'));
  record('vw_cartera: Andrés deuda_total = 1.500.000 (tras abono)',
    andres && Number(andres.deuda_total) === 1500000,
    `BD ${andres?.deuda_total}`);

  // 3.4 Variaciones persistidas
  const { rows: vars } = await c.query(
    `SELECT * FROM cotizacion_variaciones WHERE persona_id = $1 AND deleted_at IS NULL`,
    [A],
  );
  record('Variación registrada para Andrés', vars.length === 1, `BD ${vars.length}`);
  if (vars.length) {
    record('Variación: tipo = "descuento"', vars[0].tipo === 'descuento');
    record('Variación: monto_delta = -150.000', Number(vars[0].monto_delta) === -150000, `BD ${vars[0].monto_delta}`);
    record('Variación: responsable = "empresa"', vars[0].responsable === 'empresa');
  }

  // 3.5 Costos persistidos
  const { rows: costos } = await c.query(
    `SELECT * FROM costos_proyecto WHERE persona_id = $1 AND deleted_at IS NULL`,
    [A],
  );
  record('Costo registrado para Andrés', costos.length === 1, `BD ${costos.length}`);
  if (costos.length) {
    record('Costo: tipo = "producto"', costos[0].tipo === 'producto');
    record('Costo: monto = 600.000', Number(costos[0].monto) === 600000, `BD ${costos[0].monto}`);
    record('Costo: vendor = "Tejidos Safra SAS"', costos[0].vendor === 'Tejidos Safra SAS');
  }

  // vw_rentabilidad: venta=2M, variaciones=-150K, costo=600K, margen=1.250M
  const { rows: rent } = await c.query(`SELECT * FROM vw_rentabilidad WHERE persona_id = $1`, [A]);
  record('vw_rentabilidad incluye a Andrés', rent.length === 1);
  if (rent.length) {
    record('Rentabilidad: venta_total = 2.000.000',
      Number(rent[0].venta_total) === 2000000, `BD ${rent[0].venta_total}`);
    record('Rentabilidad: variaciones_neto = -150.000',
      Number(rent[0].variaciones_neto) === -150000, `BD ${rent[0].variaciones_neto}`);
    record('Rentabilidad: costo_total = 600.000',
      Number(rent[0].costo_total) === 600000, `BD ${rent[0].costo_total}`);
    record('Rentabilidad: margen = 1.250.000 (2M − 150K − 600K)',
      Number(rent[0].margen) === 1250000, `BD ${rent[0].margen}`);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────

let pgClient = null, browser = null, page = null;

async function main() {
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`${C.bold}${C.magenta}   F3.4 — TEST E2E M3 FINANCIEROS${C.reset}`);
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  info(`Project: ${ref}  ·  Screenshots → ${SHOTS}`);

  sec(0, 'CONEXIONES');
  pgClient = await connectPg(); ok('Postgres OK');
  browser = await connectBrowser(); ok('Chrome OK');

  sec(1, 'SEED');
  const seeded = await seed(pgClient);
  ok('Seed listo');

  sec(2, 'UI E2E');
  page = await openVisor(browser);
  await ui_clienteA(page);
  await ui_facturacion(page);
  await ui_abonos(page);
  await ui_cartera(page);
  await ui_variaciones(page);
  await ui_rentabilidad(page);

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
