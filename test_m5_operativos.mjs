#!/usr/bin/env node
/**
 * F5.4 — Test E2E del MÓDULO 5 Operativos (6 sub-tabs)
 *
 * SEED:
 *   - persona + proyecto + chat WhatsApp procesado
 *   - cotización GANADA (para que aparezca en Producción)
 *
 * UI:
 *   5.1 Producción       — crear orden + avanzar estado a "en_produccion"
 *   5.2 Instalaciones    — programar visita en zona ricaurte (trigger
 *                          auto-genera 15 items de checklist)
 *   5.3 Agenda           — verificar que la instalación aparece en agenda
 *   5.4 Rutas y zonas    — verificar agrupación por zona
 *   5.5 Tareas           — crear tarea tipo "llamar" + completarla inline
 *   5.6 Checklist        — marcar 3 items de la instalación
 *
 * SQL:
 *   - produccion_orden persistida con estado correcto
 *   - instalaciones tiene 1 fila + checklist auto-generó 15 items vía trigger
 *   - tareas: 1 fila completada con completada_at no null
 *   - 3 items de checklist marcados como completados
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(__dirname, 'test_m5_shots');
mkdirSync(SHOTS, { recursive: true });

const CLEANUP = process.argv.includes('--cleanup');

const envLines = readFileSync(join(__dirname, '.env'), 'utf8').split('\n');
const env = Object.fromEntries(envLines.map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
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

const TAG = '[TEST-M5]';

async function cleanupPrev(c) {
  await c.query(`DELETE FROM checklist_instalacion_items WHERE instalacion_id IN (SELECT id FROM instalaciones WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1))`, [`${TAG}%`]);
  await c.query(`DELETE FROM instalaciones WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM tareas WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM produccion_orden WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM cotizaciones WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM mensajes WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM chats WHERE titulo LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM proyectos WHERE nombre LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM personas WHERE nombre LIKE $1`, [`${TAG}%`]);
}

async function seed(c) {
  step('Cleanup previo + seed nuevo…');
  await cleanupPrev(c);

  const p = await c.query(`INSERT INTO personas (nombre, telefono_e164, ambito_principal) VALUES ($1, '+573015554001', 'comercial') RETURNING id`, [`${TAG} Operativo Test`]);
  const A = Number(p.rows[0].id);

  const proy = await c.query(`INSERT INTO proyectos (persona_id, ambito, nombre, estado) VALUES ($1, 'comercial', $2, 'ganado') RETURNING id`, [A, `${TAG} Proyecto Operativo`]);
  const proyA = Number(proy.rows[0].id);

  const chat = await c.query(`INSERT INTO chats (canal, canal_chat_id, tipo, titulo, ambito, proyecto_id, ia_historico_procesado)
     VALUES ('whatsapp', $1, 'individual', $2, 'comercial', $3, true) RETURNING id`,
    ['573015554001@s.whatsapp.net', `${TAG} Operativo Test`, proyA]);
  const chatA = Number(chat.rows[0].id);
  await c.query(`INSERT INTO mensajes (chat_id, canal_msg_id, direccion, tipo, texto, ts_canal, persona_autor_id)
     VALUES ($1, 'test-m5-msg', 'entrante', 'texto', 'Test M5', NOW(), $2)`, [chatA, A]);

  const cot = await c.query(`INSERT INTO cotizaciones (persona_id, proyecto_id, numero_cotizacion, estado, subtotal, total, saldo)
     VALUES ($1, $2, 'TEST-M5-COT', 'ganada', 2000000, 2000000, 0) RETURNING id`, [A, proyA]);
  const cotId = Number(cot.rows[0].id);

  info(`A=${A}, proyA=${proyA}, cot=${cotId}`);
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
async function shot(page, name) {
  await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false });
  info(`📸 ${name}.png`);
}

// ── Drivers ──────────────────────────────────────────────────────────

async function ui_seleccionarCliente(page) {
  step('UI → Clientes → seleccionar Operativo Test…');
  await navegarModulo(page, 'Clientes');
  await sleep(1200);
  await shot(page, '01_clientes');
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('input')].find(i => i.type === 'search');
    if (s) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, '5554001');
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(700);
  const r = await page.evaluate(() => {
    const card = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Operativo Test'));
    if (card) { card.click(); return true; } return false;
  });
  if (!r) throw new Error('No encontré card');
  await sleep(1000);
}

async function ui_produccion(page) {
  step('UI → M5 → 5.1 Producción → crear orden + avanzar estado…');
  await navegarModulo(page, '5 · Operativos');
  await sleep(1000);
  await shot(page, '02_produccion_inicial');

  await clickByText(page, 'button', '+ Crear orden producción');
  await sleep(1500);
  await shot(page, '03_produccion_orden_creada');

  // Avanzar a "en_produccion"
  await clickByText(page, 'button', '→ En producción');
  await sleep(1200);
  await shot(page, '04_produccion_avanzada');

  const body = await page.evaluate(() => document.body.innerText);
  record('Producción muestra "En producción"', body.toLowerCase().includes('en producción'));
}

async function ui_instalaciones(page) {
  step('UI → M5 → 5.2 Instalaciones → programar visita…');
  await clickByText(page, 'button', '5.2 Instalaciones');
  await sleep(800);
  await shot(page, '05_instalaciones_inicial');

  await clickByText(page, 'button', '+ Programar visita');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Programar instalación/.test(h.textContent || '')), 5000, 'modal instalación');
  await sleep(400);

  // Cotización default ya viene seleccionada; cambiar zona a ricaurte
  await fillField(page, 'Zona', 'ricaurte');
  await fillField(page, 'Instalador', 'Pedro (test E2E)');
  await fillField(page, 'Notas', 'Test E2E F5.4');
  await shot(page, '06_instalacion_form');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1800);
  await shot(page, '07_instalacion_creada');

  const body = await page.evaluate(() => document.body.innerText);
  record('Instalaciones muestra la visita "Pedro"', body.includes('Pedro'));
  record('Instalaciones muestra "ricaurte"', body.toLowerCase().includes('ricaurte'));
}

async function ui_agenda(page) {
  step('UI → M5 → 5.3 Agenda operativa…');
  await clickByText(page, 'button', '5.3 Agenda');
  await sleep(1200);
  await shot(page, '08_agenda');
  const body = await page.evaluate(() => document.body.innerText);
  record('Agenda muestra "Instalación" (tipo)', body.includes('Instalación'));
  record('Agenda muestra "Operativo Test" (persona)', body.includes('Operativo Test'));
}

async function ui_rutas(page) {
  step('UI → M5 → 5.4 Rutas y zonas…');
  await clickByText(page, 'button', '5.4 Rutas y zonas');
  await sleep(1500);
  await shot(page, '09_rutas');
  const body = await page.evaluate(() => document.body.innerText);
  record('Rutas muestra zona "Ricaurte" (donde está nuestra instalación)', body.includes('Ricaurte'));
  record('Rutas muestra el catálogo de zonas (Girardot urbano, Melgar, etc.)',
    body.includes('Girardot urbano') && body.includes('Melgar'));
}

async function ui_tareas(page) {
  step('UI → M5 → 5.5 Tareas → crear + completar…');
  await clickByText(page, 'button', '5.5 Tareas');
  await sleep(900);
  await shot(page, '10_tareas_inicial');

  await clickByText(page, 'button', '+ Nueva tarea');
  await waitFor(page, () => [...document.querySelectorAll('h2')].some(h => /Nueva tarea/.test(h.textContent || '')), 5000, 'modal tarea');
  await sleep(300);

  await fillField(page, 'Título', 'Test E2E llamar para confirmar abono');
  await fillField(page, 'Tipo', 'llamar');
  await fillField(page, 'Asignado a', 'jhon');
  await fillField(page, 'Prioridad', '3');
  await shot(page, '11_tarea_form');

  await clickByText(page, 'button', '✓ Guardar');
  await sleep(1500);
  await shot(page, '12_tarea_creada');

  // Completar la tarea recién creada via checkbox
  const completada = await page.evaluate(() => {
    const cb = [...document.querySelectorAll('input[type="checkbox"]')]
      .find(c => !c.checked && c.closest('div')?.textContent?.includes('Test E2E llamar'));
    if (cb) { cb.click(); return true; } return false;
  });
  record('UI Tareas: checkbox para completar funciona', completada);
  await sleep(1500);
  await shot(page, '13_tarea_completada');
}

async function ui_checklist(page) {
  step('UI → M5 → 5.6 Checklist → marcar 3 items…');
  await clickByText(page, 'button', '5.6 Checklist');
  await sleep(1500);
  await shot(page, '14_checklist_inicial');

  // Marcar primeros 3 checkboxes del checklist
  const marcados = await page.evaluate(() => {
    const cbs = [...document.querySelectorAll('input[type="checkbox"]')]
      .filter(c => !c.checked && c.closest('div')?.style?.borderRadius);
    let count = 0;
    for (const cb of cbs.slice(0, 3)) {
      cb.click();
      count++;
    }
    return count;
  });
  record('UI Checklist: 3 checkboxes marcados', marcados === 3, `marcados ${marcados}`);
  await sleep(2000);   // marcar 3 items dispara 3 updates
  await shot(page, '15_checklist_marcado');
}

async function verificarSQL(c, { A, cotId }) {
  step('Verificando en BD…');

  // Producción
  const { rows: prod } = await c.query(`SELECT * FROM produccion_orden WHERE persona_id = $1 AND deleted_at IS NULL`, [A]);
  record('produccion_orden: 1 fila persistida', prod.length === 1, `BD ${prod.length}`);
  if (prod.length) {
    record('produccion_orden: estado = "en_produccion"', prod[0].estado === 'en_produccion', `BD "${prod[0].estado}"`);
    record('produccion_orden: cotizacion_id correcto', Number(prod[0].cotizacion_id) === cotId);
  }

  // Instalaciones
  const { rows: inst } = await c.query(`SELECT * FROM instalaciones WHERE persona_id = $1 AND deleted_at IS NULL`, [A]);
  record('instalaciones: 1 fila persistida', inst.length === 1, `BD ${inst.length}`);
  if (inst.length) {
    record('instalaciones: zona_codigo = "ricaurte"', inst[0].zona_codigo === 'ricaurte');
    record('instalaciones: instalador = "Pedro (test E2E)"', inst[0].instalador === 'Pedro (test E2E)');
    record('instalaciones: resultado NULL (programada, sin ejecutar aún)', inst[0].resultado === null);

    // Trigger: checklist_instalacion_items debe tener 15 items auto-generados
    const { rows: chk } = await c.query(`SELECT * FROM checklist_instalacion_items WHERE instalacion_id = $1 AND deleted_at IS NULL`, [inst[0].id]);
    record('Trigger checklist auto-generó 15 items', chk.length === 15, `BD ${chk.length}`);
    record('Checklist: items distribuidos por fase (antes/durante/despues)',
      chk.some(i => i.fase === 'antes') && chk.some(i => i.fase === 'durante') && chk.some(i => i.fase === 'despues'));

    // De los 3 items marcados por la UI, deben quedar en completado=true
    const completados = chk.filter(i => i.completado);
    record('Checklist: 3 items marcados como completados desde UI', completados.length === 3, `BD ${completados.length}`);
    if (completados.length) {
      record('Checklist: completados tienen completado_at no null',
        completados.every(i => i.completado_at != null));
    }
  }

  // Tareas
  const { rows: tareas } = await c.query(`SELECT * FROM tareas WHERE persona_id = $1 AND deleted_at IS NULL`, [A]);
  record('tareas: 1 fila persistida', tareas.length === 1, `BD ${tareas.length}`);
  if (tareas.length) {
    record('tareas: tipo = "llamar"', tareas[0].tipo === 'llamar');
    record('tareas: prioridad = 3', Number(tareas[0].prioridad) === 3);
    record('tareas: completada = true (marcada inline)', tareas[0].completada === true);
    record('tareas: completada_at no null', tareas[0].completada_at != null);
    record('tareas: origen = "manual"', tareas[0].origen === 'manual');
  }

  // vw_agenda_operativa
  const { rows: agenda } = await c.query(`SELECT * FROM vw_agenda_operativa WHERE persona_id = $1`, [A]);
  // Después de completar la tarea, en la vista solo queda la instalación (la tarea completada se filtra)
  record('vw_agenda_operativa devuelve 1 item (instalación pendiente; tarea ya completada se excluye)',
    agenda.length === 1, `BD ${agenda.length}`);
  if (agenda.length) {
    record('vw_agenda_operativa: tipo = "instalacion"', agenda[0].tipo === 'instalacion');
  }
}

let pgClient = null, browser = null, page = null;
async function main() {
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`${C.bold}${C.magenta}   F5.4 — TEST E2E M5 OPERATIVOS${C.reset}`);
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
  await ui_produccion(page);
  await ui_instalaciones(page);
  await ui_agenda(page);
  await ui_rutas(page);
  await ui_tareas(page);
  await ui_checklist(page);

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
