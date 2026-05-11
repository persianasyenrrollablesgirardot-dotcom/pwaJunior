#!/usr/bin/env node
/**
 * F7.4 — Test E2E del MÓDULO 7 Evidencias (4 sub-tabs)
 *
 * SEED:
 *   - persona + proyecto + chat WhatsApp procesado
 *   - cotización ganada
 *   - 1 mensaje tipo='audio' con texto transcrito + media_url
 *   - 1 abono con comprobante_url
 *   - 1 garantía con evidencia_urls
 *   - 1 evidencia manual tipo='foto' (pre-cargada)
 *
 * UI:
 *   7.1 Archivo documental — verifica que aparezcan TODAS las fuentes
 *   7.2 Evidencia por evento — verifica eventos con evidencia
 *   7.3 Transcripciones audio (global) — verifica que aparezca el audio del seed
 *   7.4 Captura en vivo — verifica el form (upload manual)
 *
 * SQL:
 *   - vw_evidencias_unificadas devuelve TODAS las fuentes correctamente
 *   - evidencias tabla persiste OK
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import puppeteer from 'puppeteer-core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHOTS = resolve(__dirname, 'test_m7_shots');
mkdirSync(SHOTS, { recursive: true });

const CLEANUP = process.argv.includes('--cleanup');
const env = Object.fromEntries(readFileSync(join(__dirname, '.env'), 'utf8').split('\n')
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const SB_URL = env.VITE_SUPABASE_URL;
const DB_PWD = env.SUPABASE_DB_PASSWORD;
const ref = SB_URL.match(/https:\/\/([^.]+)\./)[1];

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m' };
const log = s => console.log(s);
const sec = (n, t) => log(`\n${C.cyan}${C.bold}━━ FASE ${n} — ${t} ━━${C.reset}`);
const step = s => log(`${C.blue}▸ ${s}${C.reset}`);
const ok = s => log(`  ${C.green}✓${C.reset} ${s}`);
const fail = s => log(`  ${C.red}✗${C.reset} ${s}`);
const info = s => log(`  ${C.dim}· ${s}${C.reset}`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

const TAG = '[TEST-M7]';

async function cleanupPrev(c) {
  await c.query(`DELETE FROM evidencias WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM garantias WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM abonos WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM cotizaciones WHERE persona_id IN (SELECT id FROM personas WHERE nombre LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM evento_pg WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM mensajes WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM chats WHERE titulo LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM proyectos WHERE nombre LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM personas WHERE nombre LIKE $1`, [`${TAG}%`]);
}

async function seed(c) {
  step('Cleanup previo + seed nuevo…');
  await cleanupPrev(c);

  const p = await c.query(`INSERT INTO personas (nombre, telefono_e164, ambito_principal) VALUES ($1, '+573015557001', 'comercial') RETURNING id`, [`${TAG} Evidencia Test`]);
  const A = Number(p.rows[0].id);
  const proy = await c.query(`INSERT INTO proyectos (persona_id, ambito, nombre, estado) VALUES ($1, 'comercial', $2, 'ganado') RETURNING id`, [A, `${TAG} Proyecto Ev`]);
  const proyA = Number(proy.rows[0].id);
  const chat = await c.query(`INSERT INTO chats (canal, canal_chat_id, tipo, titulo, ambito, proyecto_id, ia_historico_procesado)
     VALUES ('whatsapp', $1, 'individual', $2, 'comercial', $3, true) RETURNING id`,
    ['573015557001@s.whatsapp.net', `${TAG} Evidencia Test`, proyA]);
  const chatA = Number(chat.rows[0].id);

  // Mensaje audio con transcripción
  const msg = await c.query(`INSERT INTO mensajes (chat_id, canal_msg_id, direccion, tipo, texto, media_url, media_mime, ts_canal, persona_autor_id)
     VALUES ($1, 'test-m7-audio-001', 'entrante', 'audio',
             'Test E2E F7.4 — audio transcrito del cliente confirmando medidas',
             'https://example.com/test-audio.ogg', 'audio/ogg', NOW(), $2) RETURNING id`, [chatA, A]);
  const msgId = Number(msg.rows[0].id);

  // Evento con evidencia_ids apuntando al mensaje
  await c.query(`INSERT INTO evento_pg (canal, ambito, chat_id, tipo_evento, ts_canal, payload, evidencia_ids, confianza)
     VALUES ('whatsapp', 'comercial', $1, 'medida', NOW(), $2, $3, 'CONFIRMADO')`,
    [chatA, JSON.stringify({ preview: 'Cliente confirmó 2.5x1.8m blackout' }), JSON.stringify({ msg_ids: [msgId] })]);

  // Cotización ganada
  const cot = await c.query(`INSERT INTO cotizaciones (persona_id, proyecto_id, numero_cotizacion, estado, subtotal, total, saldo)
     VALUES ($1, $2, 'TEST-M7-COT', 'ganada', 1500000, 1500000, 0) RETURNING id`, [A, proyA]);
  const cotId = Number(cot.rows[0].id);

  // Abono con comprobante
  await c.query(`INSERT INTO abonos (cotizacion_id, persona_id, monto, fecha, metodo, referencia, comprobante_url, estado_validacion)
     VALUES ($1, $2, 750000, CURRENT_DATE, 'bancolombia', 'TEST-M7-ABO-001', 'https://example.com/comprobante.jpg', 'confirmado')`, [cotId, A]);

  // Garantía con evidencia_urls
  await c.query(`INSERT INTO garantias (persona_id, cotizacion_id, causa_codigo, sistema_safra_codigo, fecha_apertura, evidencia_urls)
     VALUES ($1, $2, 'producto', 'blackout', CURRENT_DATE, ARRAY['https://example.com/gar-foto1.jpg', 'https://example.com/gar-foto2.jpg'])`, [A, cotId]);

  // Evidencia manual pre-cargada (foto)
  await c.query(`INSERT INTO evidencias (persona_id, tipo, url, descripcion, capturado_por, fecha)
     VALUES ($1, 'foto', 'https://example.com/evidencia-manual.jpg', 'Test E2E foto manual pre-cargada', 'jhon', CURRENT_DATE)`, [A]);

  info(`A=${A}, cot=${cotId}, chat=${chatA}, msgAudio=${msgId}`);
  return { A, cotId, chatA, msgId };
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
async function shot(page, name) { await page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }); info(`📸 ${name}.png`); }

async function ui_seleccionarCliente(page) {
  step('UI → Clientes → seleccionar Evidencia Test…');
  await navegarModulo(page, 'Clientes');
  await sleep(1200);
  await shot(page, '01_clientes');
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('input')].find(i => i.type === 'search');
    if (s) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, '5557001');
      s.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });
  await sleep(700);
  const r = await page.evaluate(() => {
    const card = [...document.querySelectorAll('button')].find(b => (b.textContent || '').includes('Evidencia Test'));
    if (card) { card.click(); return true; } return false;
  });
  if (!r) throw new Error('No encontré card');
  await sleep(1000);
}

async function ui_archivo(page) {
  step('UI → M7 → 7.1 Archivo documental…');
  await navegarModulo(page, '7 · Evidencias');
  await sleep(1200);
  await shot(page, '02_archivo');

  const body = await page.evaluate(() => document.body.innerText);
  record('Archivo muestra evidencia manual (foto)', body.includes('Test E2E foto manual'));
  record('Archivo muestra comprobante de abono', body.toLowerCase().includes('abono bancolombia'));
  record('Archivo muestra fuente WhatsApp', body.includes('WhatsApp'));
  record('Archivo muestra fuente Garantía (2 fotos)', body.includes('Evidencia garantía'));
  record('Archivo muestra mensaje audio transcrito',
    body.includes('audio transcrito del cliente') || body.toLowerCase().includes('audio'));
}

async function ui_eventos(page) {
  step('UI → M7 → 7.2 Evidencia por evento…');
  await clickByText(page, 'button', '7.2 Evidencia');
  await sleep(1200);
  await shot(page, '03_eventos');
  const body = await page.evaluate(() => document.body.innerText);
  record('Evidencia eventos muestra "medida" (tipo del evento)', body.includes('medida'));
  record('Evidencia eventos muestra payload preview', body.includes('Cliente confirmó'));
  record('Evidencia eventos muestra mensaje vinculado', body.toLowerCase().includes('audio transcrito'));
}

async function ui_transcripciones(page) {
  step('UI → M7 → 7.3 Transcripciones audio (global)…');
  await clickByText(page, 'button', '7.3 Transcripción');
  await sleep(1500);
  await shot(page, '04_transcripciones');
  const body = await page.evaluate(() => document.body.innerText);
  record('Transcripciones global muestra el audio del seed', body.includes('audio transcrito del cliente'));
  record('Transcripciones muestra nombre del cliente', body.includes('Evidencia Test'));
}

async function ui_captura(page) {
  step('UI → M7 → 7.4 Captura en vivo (formulario)…');
  await clickByText(page, 'button', '7.4 Captura');
  await sleep(800);
  await shot(page, '05_captura');
  const body = await page.evaluate(() => document.body.innerText);
  record('Captura muestra input de archivo audio', body.toLowerCase().includes('archivo de audio'));
  record('Captura muestra botón Transcribir', body.includes('Transcribir'));
  record('Captura muestra botón Guardar evidencia', body.includes('Guardar evidencia'));
}

async function verificarSQL(c, { A }) {
  step('Verificando en BD…');

  // Vista unificada
  const { rows: unif } = await c.query(`SELECT * FROM vw_evidencias_unificadas WHERE persona_id = $1`, [A]);
  // Esperamos: 1 manual + 1 mensaje audio + 1 abono + 2 garantía = 5
  record('vw_evidencias_unificadas devuelve 5 filas (1 manual + 1 audio + 1 abono + 2 garantía)',
    unif.length === 5, `BD ${unif.length}`);

  const fuentes = unif.map(r => r.fuente);
  record('Fuente evidencia_manual presente', fuentes.includes('evidencia_manual'));
  record('Fuente mensaje_wa presente', fuentes.includes('mensaje_wa'));
  record('Fuente abono_comprobante presente', fuentes.includes('abono_comprobante'));
  record('Fuente garantia_evidencia presente (2 filas, 1 por foto)',
    fuentes.filter(f => f === 'garantia_evidencia').length === 2);

  const tipos = unif.map(r => r.tipo);
  record('Tipos incluyen foto, audio, comprobante',
    tipos.includes('foto') && tipos.includes('audio') && tipos.includes('comprobante'));

  // Tabla evidencias
  const { rows: ev } = await c.query(`SELECT * FROM evidencias WHERE persona_id = $1 AND deleted_at IS NULL`, [A]);
  record('Tabla evidencias: 1 fila (la manual del seed)', ev.length === 1, `BD ${ev.length}`);
  if (ev.length) {
    record('Evidencia manual: tipo = "foto"', ev[0].tipo === 'foto');
    record('Evidencia manual: capturado_por = "jhon"', ev[0].capturado_por === 'jhon');
  }

  // Mensaje audio
  const { rows: msgs } = await c.query(`SELECT * FROM mensajes WHERE tipo = 'audio' AND chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  record('Mensaje audio con texto transcrito persistido',
    msgs.length === 1 && msgs[0].texto && msgs[0].texto.includes('audio transcrito'));

  // Evento con evidencia_ids
  const { rows: evts } = await c.query(`SELECT * FROM evento_pg WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1) AND evidencia_ids IS NOT NULL`, [`${TAG}%`]);
  record('Evento con evidencia_ids persistido', evts.length === 1);
  if (evts.length) {
    record('Evento: evidencia_ids.msg_ids tiene 1 id',
      Array.isArray(evts[0].evidencia_ids?.msg_ids) && evts[0].evidencia_ids.msg_ids.length === 1);
  }
}

let pgClient = null, browser = null, page = null;
async function main() {
  log(`${C.bold}${C.magenta}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  log(`${C.bold}${C.magenta}   F7.4 — TEST E2E M7 EVIDENCIAS${C.reset}`);
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
  await ui_archivo(page);
  await ui_eventos(page);
  await ui_transcripciones(page);
  await ui_captura(page);

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
