#!/usr/bin/env node
/**
 * F2.4.T — Test E2E profundo MÓDULO 2 Comerciales
 *
 * Plan de prueba:
 *
 *   FASE 0 — Conectar a Postgres y a Chrome remoto (puerto 9222).
 *   FASE 1 — SEED de datos: 5 personas con red de referidos + cotización vieja
 *            (para tab 2.6 Recompra) + cleanup de runs previos.
 *   FASE 2 — Conducir UI vía Puppeteer:
 *     2.1 — Ir a "Clientes", seleccionar la persona principal del test
 *     2.2 — Entrar a M2 Comerciales
 *     2.3 — Sub-tab "2.1 Cotizaciones": crear cotización + 2 productos
 *           (item 1 medido por técnico, item 2 medido por cliente → R-013#1
 *           debe disparar bandera RIESGO), modificar descuento 10%, IVA 190.000,
 *           abono parcial 500.000.
 *     2.4 — Sub-tab "2.3 Objeciones": registrar 1 objeción (tipo precio)
 *     2.5 — Sub-tab "2.4 Seguimiento": verificar KPIs y card con próxima acción
 *     2.6 — Sub-tab "2.5 Referidos": verificar red (2 abajo + 1 arriba)
 *     2.7 — Sub-tab "2.6 Recompra": cambiar filtro a 3 meses → debe aparecer
 *           la persona con cotización vieja ganada
 *   FASE 3 — Verificación SQL: re-consultar BD y validar:
 *     - cotización persistida con total y saldo correctos
 *     - item con riesgo_medicion=true (por trigger)
 *     - objeción persistida
 *     - vw_comerciales_resumen refleja conteos
 *   FASE 4 — Reporte final con check/fail por etapa.
 *
 * Uso:
 *   node test_m2_comerciales.mjs            (corre todo; deja datos seed)
 *   node test_m2_comerciales.mjs --cleanup  (borra los datos seed al final)
 *
 * Requisitos:
 *   - Chrome corriendo con --remote-debugging-port=9222
 *   - Vite dev server corriendo en http://localhost:5173
 *   - .env con SUPABASE_DB_PASSWORD
 */

import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(__dirname, 'test_m2_shots');
mkdirSync(SHOTS, { recursive: true });

const args = process.argv.slice(2);
const CLEANUP = args.includes('--cleanup');
const HEADLESS_OPS = args.includes('--no-ui');   // sólo seed + SQL

// ─── 0. ENV ─────────────────────────────────────────────────────────────

const envLines = readFileSync(join(__dirname, '.env'), 'utf8').split('\n');
const env = Object.fromEntries(
  envLines.map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()])
);
const SB_URL = env.VITE_SUPABASE_URL;
const DB_PWD = env.SUPABASE_DB_PASSWORD;
if (!SB_URL || !DB_PWD) {
  console.error('❌ Falta VITE_SUPABASE_URL o SUPABASE_DB_PASSWORD en .env');
  process.exit(1);
}
const ref = SB_URL.match(/https:\/\/([^.]+)\./)[1];

// ─── log helpers ─────────────────────────────────────────────────────────

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const log = (s) => console.log(s);
const sec = (n, t) => log(`\n${C.cyan}${C.bold}━━ FASE ${n} — ${t} ━━${C.reset}`);
const step = (s) => log(`${C.blue}▸ ${s}${C.reset}`);
const ok = (s) => log(`  ${C.green}✓${C.reset} ${s}`);
const fail = (s) => log(`  ${C.red}✗${C.reset} ${s}`);
const warn = (s) => log(`  ${C.yellow}⚠${C.reset} ${s}`);
const info = (s) => log(`  ${C.dim}· ${s}${C.reset}`);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const RESULTS = { passed: [], failed: [], warned: [] };
function record(label, cond, errMsg) {
  if (cond) { ok(label); RESULTS.passed.push(label); }
  else      { fail(`${label} — ${errMsg ?? 'falló'}`); RESULTS.failed.push(label); }
}

// ─── 1. CONEXIÓN PG ──────────────────────────────────────────────────────

async function connectPg() {
  const pwd = encodeURIComponent(DB_PWD);
  const candidates = [
    `postgresql://postgres.${ref}:${pwd}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${ref}:${pwd}@aws-0-us-east-2.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${ref}:${pwd}@aws-0-us-west-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres.${ref}:${pwd}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`,
    `postgresql://postgres:${pwd}@db.${ref}.supabase.co:5432/postgres`,
  ];
  for (const conn of candidates) {
    const c = new pg.Client({ connectionString: conn, ssl: { rejectUnauthorized: false } });
    try { await c.connect(); return c; }
    catch { try { await c.end(); } catch {} }
  }
  throw new Error('No conecté a Postgres');
}

// ─── 2. SEED ─────────────────────────────────────────────────────────────

const TEST_TAG = '[TEST-M2]';
async function cleanupPrev(c) {
  // Cleanup en orden inverso al de las FKs. Identifico todo por TEST_TAG en
  // personas.nombre, proyectos.nombre o chats.titulo.
  await c.query(`
    DELETE FROM cotizaciones
    WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)
       OR proyecto_id IN (SELECT id FROM proyectos WHERE nombre LIKE $1)
  `, [`${TEST_TAG}%`]);
  await c.query(`
    DELETE FROM mensajes
    WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)
  `, [`${TEST_TAG}%`]);
  await c.query(`
    DELETE FROM evento_pg
    WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)
  `, [`${TEST_TAG}%`]);
  await c.query(`DELETE FROM chats WHERE titulo LIKE $1`, [`${TEST_TAG}%`]);
  await c.query(`DELETE FROM proyectos WHERE nombre LIKE $1`, [`${TEST_TAG}%`]);
  await c.query(`
    UPDATE personas SET referido_por_persona_id = NULL
    WHERE referido_por_persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)
  `, [`${TEST_TAG}%`]);
  await c.query(`DELETE FROM personas WHERE nombre LIKE $1`, [`${TEST_TAG}%`]);
}

async function seed(c) {
  step('Limpiando datos del run anterior (si existen)…');
  await cleanupPrev(c);

  step('Insertando 5 personas de prueba…');
  const insP = async (nombre, tel, refPor = null) => {
    const r = await c.query(
      `INSERT INTO personas (nombre, telefono_e164, ambito_principal, referido_por_persona_id)
       VALUES ($1, $2, 'comercial', $3) RETURNING id`,
      [nombre, tel, refPor],
    );
    return Number(r.rows[0].id);
  };

  // D será el referente de A; A refiere a B y C; E es la solita con compra vieja
  const D = await insP(`${TEST_TAG} Daniel Esquivel`,    '+573015551004');
  const A = await insP(`${TEST_TAG} Alfa Bermúdez`,      '+573015551001', D);
  const B = await insP(`${TEST_TAG} Bruno Carrillo`,     '+573015551002', A);
  const C_ID = await insP(`${TEST_TAG} Carla Díaz`,      '+573015551003', A);
  const E = await insP(`${TEST_TAG} Elena Forero`,       '+573015551005');
  info(`Personas → A=${A} (principal), B=${B}, C=${C_ID}, D=${D}, E=${E}`);

  step('Creando proyecto + chat WhatsApp procesado para persona A…');
  // proyecto comercial → chat WhatsApp procesado → 1 mensaje para que cuente
  const proy = await c.query(
    `INSERT INTO proyectos (persona_id, ambito, nombre, estado, origen)
     VALUES ($1, 'comercial', $2, 'abierto', 'whatsapp_inbound') RETURNING id`,
    [A, `${TEST_TAG} Proyecto Alfa`],
  );
  const proyectoA = Number(proy.rows[0].id);

  const chat = await c.query(
    `INSERT INTO chats (canal, canal_chat_id, tipo, titulo, ambito, ambito_confirmado,
                        proyecto_id, ia_historico_procesado)
     VALUES ('whatsapp', $1, 'individual', $2, 'comercial', true, $3, true)
     RETURNING id`,
    ['573015551001@s.whatsapp.net', `${TEST_TAG} Alfa Bermúdez`, proyectoA],
  );
  const chatA = Number(chat.rows[0].id);

  await c.query(
    `INSERT INTO mensajes (chat_id, canal_msg_id, direccion, tipo, texto, ts_canal, persona_autor_id)
     VALUES ($1, $2, 'entrante', 'texto', $3, NOW(), $4)`,
    [chatA, `test-msg-001`, 'Hola, necesito cotización de blackout para sala', A],
  );
  info(`Proyecto=${proyectoA}, Chat=${chatA}, 1 mensaje insertado`);

  step('Insertando cotización VIEJA GANADA para Elena (test recompra)…');
  await c.query(`
    INSERT INTO cotizaciones
      (persona_id, numero_cotizacion, fecha, estado, subtotal, total, abono_monto, saldo, updated_at)
    VALUES ($1, 'TEST-VIEJA-001', CURRENT_DATE - INTERVAL '10 months',
            'ganada', 2500000, 2500000, 2500000, 0, NOW() - INTERVAL '10 months')
  `, [E]);

  step('Insertando cotización GANADA para Bruno (test referidos red)…');
  await c.query(`
    INSERT INTO cotizaciones
      (persona_id, numero_cotizacion, fecha, estado, subtotal, total, abono_monto, saldo)
    VALUES ($1, 'TEST-REFB-001', CURRENT_DATE, 'ganada', 1800000, 1800000, 1800000, 0)
  `, [B]);

  step('Insertando 2da cotización (TEST-COT-002) para A para testear Comparador…');
  const cot2 = await c.query(`
    INSERT INTO cotizaciones
      (persona_id, proyecto_id, numero_cotizacion, fecha, estado, subtotal, total, saldo)
    VALUES ($1, $2, 'TEST-COT-002', CURRENT_DATE, 'negociando', 2500000, 2500000, 2500000)
    RETURNING id
  `, [A, proyectoA]);
  const cot2Id = Number(cot2.rows[0].id);
  await c.query(`
    INSERT INTO cotizacion_items
      (cotizacion_id, sistema_safra_codigo, ambiente, ancho_m, alto_m, cantidad, precio_unitario, monto_total, quien_midio, orden)
    VALUES
      ($1, 'blackout',       'Sala',     2.50, 1.80, 1, 1500000, 1500000, 'tecnico', 0),
      ($1, 'screen_solar',   'Comedor',  1.80, 1.50, 1, 1000000, 1000000, 'tecnico', 1)
  `, [cot2Id]);

  return { A, B, C: C_ID, D, E, proyectoA, chatA, cot2Id };
}

// ─── 3. CHROME / PUPPETEER ───────────────────────────────────────────────

async function connectBrowser() {
  step('Conectando a Chrome remoto :9222…');
  const v = await fetch('http://localhost:9222/json/version').then(r => r.json());
  const browser = await puppeteer.connect({
    browserWSEndpoint: v.webSocketDebuggerUrl,
    defaultViewport: { width: 1440, height: 900 },
  });
  return browser;
}

async function openVisor(browser) {
  step('Abriendo pestaña en http://localhost:5173 …');
  const page = await browser.newPage();
  await page.bringToFront();
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle2', timeout: 30_000 });
  // Limpiar sessionStorage para empezar con contexto activo vacío
  await page.evaluate(() => { try { sessionStorage.clear(); } catch {} });
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(800);
  return page;
}

// Espera hasta que aparezca un elemento que matchee el predicado
async function waitForCondition(page, fnSource, timeout = 5000, label = 'condición') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const ok = await page.evaluate(fnSource);
    if (ok) return true;
    await sleep(150);
  }
  throw new Error(`Timeout esperando ${label}`);
}

// click "+ Agregar producto" → esperar modal de item abierto
async function abrirModalItem(page) {
  await page.bringToFront();
  await sleep(200);
  // Click via evaluate (más confiable contra elementos detrás de overlays con React)
  const clicked = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => (b.textContent || '').trim().includes('+ Agregar producto'));
    if (!btn) return { ok: false, reason: 'no-button' };
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return { ok: true, text: (btn.textContent || '').trim() };
  });
  if (!clicked.ok) throw new Error(`abrirModalItem: ${clicked.reason}`);
  await waitForCondition(page,
    () => [...document.querySelectorAll('h3')].some(h => /Agregar producto|Editar producto/.test(h.textContent || '')),
    5000, 'modal item visible');
  await sleep(300);
}

// Click elemento por texto. Usa evaluate (más confiable contra overlays/React).
async function clickByText(page, selector, text, { exact = false, idx = 0 } = {}) {
  await page.bringToFront();
  const clicked = await page.evaluate((sel, txt, ex, i) => {
    const els = [...document.querySelectorAll(sel)];
    const matches = els.filter(e => {
      const t = (e.textContent || '').trim();
      return ex ? t === txt : t.includes(txt);
    });
    const target = matches[i];
    if (!target) return false;
    target.scrollIntoView({ block: 'center' });
    target.click();
    return true;
  }, selector, text, exact, idx);
  if (!clicked) throw new Error(`no encuentro "${selector}" con texto "${text}"`);
  await sleep(300);
}

async function shot(page, name) {
  const path = join(SHOTS, `${name}.png`);
  await page.screenshot({ path, fullPage: false });
  info(`📸 ${name}.png`);
}

// Cambiar valor de un input (clear + type)
async function setInputValue(page, sel, value) {
  await page.evaluate((s, v) => {
    const el = document.querySelector(s);
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                  || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
                  || Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      setter?.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, sel, value);
}

// Encontrar input con label cercana. Si hay modales superpuestos, busca en el
// modal con mayor z-index (el más reciente).
async function fillFieldByLabel(page, labelText, value) {
  const result = await page.evaluate((lt, v) => {
    const allEls = [...document.querySelectorAll('[style*="z-index"]')];
    let topContainer = document.body;
    let maxZ = -1;
    for (const el of allEls) {
      const cs = window.getComputedStyle(el);
      const z = parseInt(cs.zIndex, 10);
      if (!isNaN(z) && z > maxZ && cs.display !== 'none' && cs.visibility !== 'hidden') {
        maxZ = z;
        topContainer = el;
      }
    }
    const search = (root) => {
      const labels = [...root.querySelectorAll('label')];
      return labels.find(l => (l.textContent || '').toLowerCase().includes(lt.toLowerCase()));
    };
    let lab = search(topContainer);
    if (!lab && topContainer !== document.body) lab = search(document.body);
    if (!lab) return { ok: false, reason: 'no-label', maxZ };
    const input = lab.querySelector('input, textarea, select');
    if (!input) return { ok: false, reason: 'no-input' };

    if (input.tagName === 'SELECT') {
      const options = [...input.options];
      const idx = options.findIndex(o => o.value === v);
      if (idx < 0) {
        return { ok: false, reason: 'option-not-found', want: v, available: options.map(o => o.value) };
      }
      input.selectedIndex = idx;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(input, v);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }

    const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }, labelText, value);
  if (!result.ok) {
    const extra = result.reason === 'option-not-found'
      ? ` (want="${result.want}", available=[${(result.available ?? []).join(',')}])`
      : '';
    throw new Error(`fillFieldByLabel("${labelText}", "${value}") falló — ${result.reason ?? 'unknown'}${extra}`);
  }
}

// ─── 4. DRIVERS DE PANTALLAS ─────────────────────────────────────────────

async function navegarModulo(page, txt) {
  await page.bringToFront();
  const clicked = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === t);
    if (!btn) return false;
    btn.scrollIntoView({ block: 'center' });
    btn.click();
    return true;
  }, txt);
  if (!clicked) throw new Error(`navegarModulo: no encuentro botón sidebar "${txt}"`);
  await sleep(800);
}

async function navegarSubTab(page, txt) {
  await page.bringToFront();
  const clicked = await page.evaluate((t) => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes(t));
    if (!btn) return false;
    btn.click();
    return true;
  }, txt);
  if (!clicked) throw new Error(`navegarSubTab: no encuentro botón "${txt}"`);
  await sleep(500);
}

async function ui_clientesSeleccionar(page, terminoBusqueda, nombrePersona) {
  step(`UI → Clientes → buscar "${terminoBusqueda}" → click en "${nombrePersona}"…`);
  await navegarModulo(page, 'Clientes');
  await sleep(1200);  // recargar() puede tardar
  await shot(page, '01_clientes_listado');

  // Tipear en caja de búsqueda
  await page.evaluate((termino) => {
    const search = [...document.querySelectorAll('input')]
      .find(i => i.type === 'search' || (i.placeholder || '').toLowerCase().includes('buscar'));
    if (search) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(search, termino);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, terminoBusqueda);
  await sleep(800);

  // Click en la card cuyo button-text contiene el nombre
  const clicked = await page.evaluate((nombre) => {
    const cards = [...document.querySelectorAll('button')];
    const card = cards.find(b => (b.textContent || '').includes(nombre));
    if (card) { card.click(); return true; }
    return false;
  }, nombrePersona);
  if (!clicked) throw new Error(`No encontré card del cliente "${nombrePersona}" en Clientes`);
  await sleep(1200);
  await shot(page, '02_cliente_seleccionado');
}

async function ui_m2Cotizaciones(page) {
  step('UI → M2 Comerciales → 2.1 Cotizaciones → crear cotización…');
  await navegarModulo(page, '2 · Comerciales');
  await sleep(800);
  await shot(page, '03_m2_inicial');

  // El sub-tab default debería ser 2.1; si no, lo clickeamos
  try { await navegarSubTab(page, 'Cotizaciones'); } catch {}

  // Click "+ Nueva cotización" → esperar modal cotización
  await clickByText(page, 'button', '+ Nueva cotización');
  await waitForCondition(page,
    () => [...document.querySelectorAll('h2')].some(h => /Cotización/.test(h.textContent || '')),
    8000, 'modal cotización visible');
  await sleep(500);
  await shot(page, '04_modal_cotizacion_abierto');

  // Setear número y descuento + IVA
  await fillFieldByLabel(page, 'Número', 'TEST-COT-001');
  await fillFieldByLabel(page, 'Descuento %', '10');
  await fillFieldByLabel(page, 'IVA', '190000');

  // Click "+ Agregar producto" (item 1, técnico)
  step('   Agregando item 1 (técnico)…');
  await abrirModalItem(page);
  await fillFieldByLabel(page, 'Ambiente', 'Sala');
  await fillFieldByLabel(page, 'Ancho', '2.5');
  await fillFieldByLabel(page, 'Alto', '1.8');
  await fillFieldByLabel(page, 'Cantidad', '1');
  await fillFieldByLabel(page, 'Precio unitario', '850000');
  await fillFieldByLabel(page, 'Color', 'blanco');
  // Quien midió → técnico (ya viene por default 'tecnico' pero lo forzamos)
  await fillFieldByLabel(page, 'Quién midió', 'tecnico');
  await sleep(200);
  await shot(page, '05_item1_tecnico');
  await clickByText(page, 'button', '✓ Guardar producto');
  await sleep(900);

  // Item 2 (cliente → debe disparar warning R-013#1)
  step('   Agregando item 2 (medido por cliente → debe disparar R-013#1)…');
  await abrirModalItem(page);
  await shot(page, '05b_modal_item2_abierto');
  await fillFieldByLabel(page, 'Ambiente', 'Oficina');
  await fillFieldByLabel(page, 'Ancho', '1.2');
  await fillFieldByLabel(page, 'Alto', '1.5');
  await fillFieldByLabel(page, 'Cantidad', '2');
  await fillFieldByLabel(page, 'Precio unitario', '420000');
  await fillFieldByLabel(page, 'Quién midió', 'cliente');
  await sleep(300);
  // Validar warning R-013#1 visible
  const hayWarningR013 = await page.evaluate(() => {
    return document.body.innerText.includes('R-013#1');
  });
  record('UI muestra warning R-013#1 cuando quien_midio=cliente', hayWarningR013);
  await shot(page, '06_item2_cliente_warning');
  await clickByText(page, 'button', '✓ Guardar producto');
  await sleep(1000);

  // Abono parcial
  step('   Ingresando abono parcial 500.000…');
  await fillFieldByLabel(page, 'Monto', '500000');
  await fillFieldByLabel(page, 'Método', 'nequi');
  await fillFieldByLabel(page, 'Referencia', 'TEST-ABO-001');

  // Próxima acción
  await fillFieldByLabel(page, 'Próxima acción', 'recordar_cliente');
  await sleep(200);

  // Notas
  await fillFieldByLabel(page, 'Notas / detalle', 'Test E2E F2.4.T — cliente test referidos');
  await shot(page, '07_antes_guardar_cotizacion');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '08_despues_guardar_cotizacion');
}

async function ui_m2Comparador(page) {
  step('UI → M2 → 2.2 Comparador → validar 2 cotizaciones lado a lado…');
  await navegarSubTab(page, 'Comparador');
  await sleep(1200);
  const body = await page.evaluate(() => document.body.innerText);
  // El "empty state" dice "Necesitás al menos 2"; si aparece, ya falló
  record('Comparador NO muestra "Necesitás al menos 2"', !body.includes('Necesitás al menos 2'));
  // Auto-selecciona las 2 más recientes; deben aparecer ambos numeros en pantalla
  record('Comparador muestra TEST-COT-001', body.includes('TEST-COT-001'));
  record('Comparador muestra TEST-COT-002', body.includes('TEST-COT-002'));
  // Verificar que las 2 columnas se rendericen (subtotal de cada cot)
  const columnasCount = await page.evaluate(() => {
    return [...document.querySelectorAll('h2')].some(h => /Comparador de cotizaciones/.test(h.textContent || ''))
      ? document.querySelectorAll('[style*="grid-template-columns"]').length
      : 0;
  });
  record('Comparador renderizó el grid', columnasCount > 0);
  await shot(page, '08b_comparador');
}

async function ui_m2Objeciones(page) {
  step('UI → M2 → 2.3 Objeciones → registrar 1 objeción…');
  await navegarSubTab(page, 'Objeciones');
  await sleep(1200);  // recargar fetches cotizaciones + objeciones + tipos
  await shot(page, '09_objeciones_inicial');

  await clickByText(page, 'button', '+ Registrar objeción');
  // Esperar a que las options del select Tipo carguen (la opción "precio" debe existir)
  await waitForCondition(page,
    () => {
      const sels = [...document.querySelectorAll('select')];
      return sels.some(s => [...s.options].some(o => o.value === 'precio'));
    }, 5000, 'select Tipo con opciones cargadas');
  await sleep(200);
  await fillFieldByLabel(page, 'Tipo', 'precio');
  await fillFieldByLabel(page, 'Frase exacta del cliente', 'está muy caro comparado con otro proveedor');
  await fillFieldByLabel(page, '¿Qué se respondió', 'Le ofrecí 10% de descuento si paga al contado');
  await fillFieldByLabel(page, 'Resultado', 'pendiente');
  await sleep(200);
  await shot(page, '10_objecion_lista_para_guardar');
  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '11_objecion_guardada');
}

async function ui_m2Seguimiento(page) {
  step('UI → M2 → 2.4 Seguimiento…');
  await navegarSubTab(page, 'Seguimiento');
  await sleep(800);
  const kpis = (await page.evaluate(() => document.body.innerText)).toLowerCase();
  const hasKPI = kpis.includes('pendientes decisión') && kpis.includes('saldo');
  record('Seguimiento muestra KPIs', hasKPI);
  await shot(page, '12_seguimiento');
}

async function ui_m2Referidos(page) {
  step('UI → M2 → 2.5 Referidos…');
  await navegarSubTab(page, 'Referidos');
  await sleep(1500);  // las queries son varias
  const body = await page.evaluate(() => document.body.innerText);
  record('Referidos muestra "Bruno Carrillo" (referido por cliente activo)', body.includes('Bruno Carrillo'));
  record('Referidos muestra "Carla Díaz" (referido por cliente activo)', body.includes('Carla Díaz'));
  record('Referidos muestra "Daniel Esquivel" (referente del cliente activo)', body.includes('Daniel Esquivel'));
  await shot(page, '13_referidos');
}

async function ui_m2Recompra(page) {
  step('UI → M2 → 2.6 Recompra (vista global)…');
  await navegarSubTab(page, 'Recompra');
  await sleep(1000);
  // El default es 6 meses; la cotización vieja es de 10 meses, así que aparece.
  // Cambiar filtro a 3 meses por las dudas:
  await page.evaluate(() => {
    const sel = [...document.querySelectorAll('select')].find(s =>
      [...s.options].some(o => /3 meses|6 meses|12 meses/.test(o.textContent || '')));
    if (sel) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, '3');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });
  await sleep(1200);
  const body = await page.evaluate(() => document.body.innerText);
  record('Recompra muestra "Elena Forero" (cliente con compra hace 10 meses)', body.includes('Elena Forero'));
  await shot(page, '14_recompra');
}

// ─── 5. VERIFICACIÓN SQL POST ────────────────────────────────────────────

async function verificarSQL(c, personaA) {
  step('Verificando en BD que los datos quedaron persistidos…');

  // Cotización creada por la UI
  const { rows: cots } = await c.query(
    `SELECT * FROM cotizaciones WHERE persona_id = $1 AND numero_cotizacion = 'TEST-COT-001'`,
    [personaA],
  );
  record('Cotización TEST-COT-001 existe en BD', cots.length === 1);
  if (cots.length !== 1) return;
  const cot = cots[0];

  // subtotal esperado: 1*850000 + 2*420000 = 850000 + 840000 = 1.690.000
  const subtotalEsperado = 850000 + 2 * 420000;
  // descuento 10%: 169000
  // total: 1.690.000 - 169.000 + 190.000 IVA = 1.711.000
  const totalEsperado = subtotalEsperado * 0.9 + 190000;
  const saldoEsperado = totalEsperado - 500000;

  record(
    `Subtotal de cotización = ${subtotalEsperado.toLocaleString('es-CO')}`,
    Math.abs(Number(cot.subtotal) - subtotalEsperado) < 1,
    `BD trae ${cot.subtotal}`,
  );
  record(
    `Total de cotización = ${totalEsperado.toLocaleString('es-CO')}`,
    Math.abs(Number(cot.total) - totalEsperado) < 1,
    `BD trae ${cot.total}`,
  );
  record(
    `Saldo de cotización = ${saldoEsperado.toLocaleString('es-CO')}`,
    Math.abs(Number(cot.saldo) - saldoEsperado) < 1,
    `BD trae ${cot.saldo}`,
  );
  record(
    `Abono 500.000 registrado`,
    Number(cot.abono_monto) === 500000,
    `BD trae ${cot.abono_monto}`,
  );
  record(
    `Abono método = "nequi"`,
    cot.abono_metodo === 'nequi',
    `BD trae "${cot.abono_metodo}"`,
  );
  record(
    `Próxima acción = "recordar_cliente"`,
    cot.proxima_accion === 'recordar_cliente',
    `BD trae "${cot.proxima_accion}"`,
  );

  // Items
  const { rows: items } = await c.query(
    `SELECT * FROM cotizacion_items WHERE cotizacion_id = $1 AND deleted_at IS NULL ORDER BY id`,
    [cot.id],
  );
  record(`Cotización tiene 2 items`, items.length === 2, `BD tiene ${items.length}`);

  if (items.length >= 1) {
    record(`Item 1 medido por técnico → riesgo_medicion = false`,
      items[0].quien_midio === 'tecnico' && items[0].riesgo_medicion === false,
      `quien_midio="${items[0].quien_midio}" riesgo=${items[0].riesgo_medicion}`,
    );
    record(`Item 1 monto_total = 850.000`,
      Number(items[0].monto_total) === 850000, `BD ${items[0].monto_total}`);
  }
  if (items.length >= 2) {
    record(`Item 2 medido por cliente → riesgo_medicion = TRUE (trigger R-013#1)`,
      items[1].quien_midio === 'cliente' && items[1].riesgo_medicion === true,
      `quien_midio="${items[1].quien_midio}" riesgo=${items[1].riesgo_medicion}`,
    );
    record(`Item 2 area_m2 calculada por la BD = 1.8`,
      Math.abs(Number(items[1].area_m2) - 1.8) < 0.01,
      `BD ${items[1].area_m2}`,
    );
    record(`Item 2 monto_total = 840.000 (2×420.000)`,
      Number(items[1].monto_total) === 840000, `BD ${items[1].monto_total}`);
  }

  // Objeción (en CUALQUIERA de las cotizaciones de la persona A — la UI elige
  // la card más arriba que puede no ser TEST-COT-001 según el orden de fecha)
  const { rows: objs } = await c.query(
    `SELECT o.* FROM cotizacion_objeciones o
     JOIN cotizaciones c ON c.id = o.cotizacion_id
     WHERE c.persona_id = $1 AND o.deleted_at IS NULL`,
    [personaA],
  );
  record(`Objeción registrada (tipo=precio) en alguna cotización de la persona`,
    objs.length === 1 && objs[0].tipo_objecion_codigo === 'precio',
    `${objs.length} objeciones, tipo="${objs[0]?.tipo_objecion_codigo}"`,
  );

  // Vista vw_comerciales_resumen
  const { rows: resumen } = await c.query(
    `SELECT * FROM vw_comerciales_resumen WHERE persona_id = $1`, [personaA],
  );
  record(`vw_comerciales_resumen incluye persona A`, resumen.length === 1);
  if (resumen.length) {
    record(`Resumen: cotizaciones_total = 2 (seed TEST-COT-002 + UI TEST-COT-001)`,
      Number(resumen[0].cotizaciones_total) === 2,
      `BD ${resumen[0].cotizaciones_total}`,
    );
    record(`Resumen: saldo_pendiente_total > 0`,
      Number(resumen[0].saldo_pendiente_total) > 0,
      `BD ${resumen[0].saldo_pendiente_total}`,
    );
  }
}

// ─── 6. MAIN ─────────────────────────────────────────────────────────────

let pgClient = null;
let browser = null;
let page = null;

async function main() {
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`${C.bold}${C.magenta}   F2.4.T — TEST E2E PROFUNDO M2 COMERCIALES${C.reset}`);
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  info(`Project: ${ref}  ·  Vite: http://localhost:5173  ·  Chrome: :9222`);
  info(`Screenshots → ${SHOTS}`);

  // FASE 0
  sec(0, 'CONEXIONES');
  pgClient = await connectPg();
  ok('Conectado a Postgres');
  if (!HEADLESS_OPS) {
    browser = await connectBrowser();
    ok('Conectado a Chrome');
  }

  // FASE 1
  sec(1, 'SEED DE DATOS');
  const personas = await seed(pgClient);
  ok(`Personas seed creadas (A=${personas.A}, B=${personas.B}, C=${personas.C}, D=${personas.D}, E=${personas.E})`);
  ok('Cotización vieja ganada para E creada (10 meses atrás)');
  ok('Cotización ganada para B creada (red de A)');

  // FASE 2
  if (!HEADLESS_OPS) {
    sec(2, 'UI E2E — RECORRER 6 SUB-TABS DE M2');
    page = await openVisor(browser);
    await ui_clientesSeleccionar(page, '5551001', `${TEST_TAG} Alfa Bermúdez`);
    await ui_m2Cotizaciones(page);
    await ui_m2Comparador(page);
    await ui_m2Objeciones(page);
    await ui_m2Seguimiento(page);
    await ui_m2Referidos(page);
    await ui_m2Recompra(page);
  } else {
    warn('--no-ui: salto fase 2 UI');
  }

  // FASE 3
  sec(3, 'VERIFICACIÓN SQL POST-UI');
  await verificarSQL(pgClient, personas.A);

  // FASE 4
  sec(4, 'REPORTE FINAL');
  log(`\n${C.bold}${C.green}✓ Passed:${C.reset} ${RESULTS.passed.length}`);
  log(`${C.bold}${C.red}✗ Failed:${C.reset} ${RESULTS.failed.length}`);
  if (RESULTS.failed.length) {
    log(`\n${C.red}Failures:${C.reset}`);
    for (const f of RESULTS.failed) log(`  · ${f}`);
  }

  // CLEANUP
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
