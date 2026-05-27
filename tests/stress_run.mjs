/**
 * STRESS TEST runner — somete a Junior a una sesión larga de mensajes variados
 * para detectar bugs, atascos, pérdidas de contexto, mentiras del LLM, etc.
 *
 * MODO REAL: el worker procesa las acciones como en producción. Para revertir
 * después usar `node tests/stress_revert.mjs --apply`.
 *
 * Uso:
 *   node tests/stress_run.mjs --horas 4 --ritmo-seg 120 --tope-usd 5
 *   node tests/stress_run.mjs --reportar    # post-mortem desde JSONL
 *   node tests/stress_run.mjs --reanudar    # continuar test interrumpido
 *
 * Defaults: 4h, 120s entre mensajes, $5 USD tope hard.
 *
 * El runner:
 *   1. Toma snapshot pre-test (ambitos + counts de tablas) → guarda en JSON
 *   2. Escribe lock file (`tests/_stress_active.json`) con sesión_id + params
 *   3. Crea sesión dedicada con título identificable
 *   4. Loop: por turno toma un escenario random del dataset, inserta mensaje,
 *      espera respuesta, verifica expectativas, APPEND línea JSON a
 *      `_stress_progress.jsonl` (cada turno persistido a disco), log de
 *      progreso. Stop si timer expira o tope superado.
 *   5. Reporte final con métricas + borra lock file (test concluido normal).
 *
 * SUPERVIVENCIA A CORTES DE LUZ / CRASHES:
 *   - El lock file marca "hay test activo" — al volver, sabés que quedó algo.
 *   - El JSONL tiene cada turno completado. Si se corta, los datos están.
 *   - `--reportar`: lee lock + JSONL y arma el reporte completo aunque el
 *     proceso original haya muerto. No relanza nada.
 *   - `--reanudar`: lee el lock y continúa el test usando la misma sesión,
 *     respetando el tiempo restante (no empieza de cero).
 *   - El revert lee el lock file solo (sin --sesion manual).
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import { ESCENARIOS, META } from './stress_dataset.mjs';

const env = Object.fromEntries(fs.readFileSync('./.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Parámetros
const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i > -1 && argv[i+1] ? argv[i+1] : def;
}
// Estos cinco son `let` (no `const`) porque al usar --reanudar se sobrescriben
// con los valores del lock para preservar la config original del test interrumpido.
let HORAS         = Number(arg('--horas', '4'));
let RITMO_SEG     = Number(arg('--ritmo-seg', '120'));
let TOPE_USD      = Number(arg('--tope-usd', '5'));
let TIMEOUT_RESP  = Number(arg('--timeout-resp-seg', '180'));  // max 3 min para que Junior responda
// --cats <cat1,cat2,...> filtra el dataset a esas categorías (uso: stress enfocado).
// Sin flag o vacío → todas las categorías.
let CATS_FILTRO   = (arg('--cats', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const VERBOSE       = argv.includes('--verbose');
const MODO_REPORTAR = argv.includes('--reportar');
const MODO_REANUDAR = argv.includes('--reanudar');

const LOCK_FILE     = 'tests/_stress_active.json';
const JSONL_FILE    = 'tests/_stress_progress.jsonl';
const HALLAZGOS_MD  = 'tests/_stress_hallazgos.md';

// Documenta un hallazgo EN VIVO al markdown (append).
// Sobrevive a cortes de luz porque cada append es flush a disco al toque.
function anotarHallazgo(severidad, titulo, detalle) {
  const icono = { critico: '🔴', anomalia: '🟠', expectativa: '🟡', info: '🔵' }[severidad] ?? '·';
  const ts = new Date().toLocaleTimeString('es-CO');
  const linea = `\n### ${icono} ${ts} · ${titulo}\n${detalle}\n`;
  fs.appendFileSync(HALLAZGOS_MD, linea);
}

const DURACION_MS = HORAS * 60 * 60 * 1000;
const ahora = () => new Date().toISOString();
const ts = () => new Date().toLocaleTimeString('es-CO');

// Estado del runner
const state = {
  started_at: new Date(),
  sesion_id: null,
  msg_enviados: 0,
  msg_respondidos: 0,
  msg_error: 0,
  msg_timeout: 0,
  costo_acumulado: 0,
  por_categoria: {},
  expectativas_pass: 0,
  expectativas_fail: 0,
  fails_detalle: [],
  guards_activados: 0,
  warns_mentira: 0,           // se cuenta leyendo el log del worker
  acciones_totales: { correcciones: 0, memorias: 0, nuevosClientes: 0, resoluciones: 0, nuevasTareas: 0, tareasCompletar: 0, nuevosAgendamientos: 0, agendamientosCancelar: 0, notasPersona: 0, cierresChecklist: 0 },
  snapshot_pre: null,
};

async function tomarSnapshot() {
  const { data: personas } = await sb.from('personas').select('id, ambito_principal').is('deleted_at', null);
  const { count: tareas } = await sb.from('tareas').select('*', { count: 'exact', head: true }).is('deleted_at', null).eq('completada', false);
  const { count: agendamientos } = await sb.from('agendamientos').select('*', { count: 'exact', head: true }).is('deleted_at', null);
  const { count: cls_cerrados } = await sb.from('chat_checklist').select('*', { count: 'exact', head: true }).eq('cerrado_manual', true);
  const { count: memorias } = await sb.from('junior_memoria').select('*', { count: 'exact', head: true }).eq('vigente', true);
  return {
    ts: ahora(),
    ambitos: Object.fromEntries((personas ?? []).map(p => [p.id, p.ambito_principal])),
    counts: { tareas_activas: tareas, agendamientos_activos: agendamientos, cls_cerrados_manual: cls_cerrados, memorias_vigentes: memorias },
  };
}

async function crearSesion() {
  const titulo = `STRESS TEST ${new Date().toLocaleString('es-CO').replace(/[/: ]/g, '-')} — auto-generado`;
  const { data, error } = await sb.from('junior_sesiones').insert({ titulo }).select('id').single();
  if (error) throw new Error('No pude crear sesión: ' + error.message);
  return data.id;
}

// Dataset filtrado por --cats si se especifica. Se calcula con función para
// poder recomputarlo después de leer params del lock en --reanudar.
let ESCENARIOS_ACTIVOS = [];
function recomputarEscenariosActivos() {
  ESCENARIOS_ACTIVOS = CATS_FILTRO.length > 0
    ? ESCENARIOS.filter(s => CATS_FILTRO.includes(s.cat))
    : ESCENARIOS;
  if (ESCENARIOS_ACTIVOS.length === 0) {
    console.error(`❌ --cats "${CATS_FILTRO.join(',')}" no matchea ninguna categoría.`);
    console.error(`   Categorías disponibles: ${META.categorias.join(', ')}`);
    process.exit(2);
  }
}
recomputarEscenariosActivos();

// Mezclar dataset
function* generadorEscenarios() {
  let pool = [...ESCENARIOS_ACTIVOS];
  while (true) {
    if (pool.length === 0) pool = [...ESCENARIOS_ACTIVOS];
    const idx = Math.floor(Math.random() * pool.length);
    yield pool.splice(idx, 1)[0];
  }
}

// Esperar a que el worker procese un mensaje del usuario (busca la respuesta de junior siguiente)
async function esperarRespuesta(mensajeId, sesionId, timeoutMs) {
  const inicio = Date.now();
  while (Date.now() - inicio < timeoutMs) {
    const { data: msg } = await sb.from('junior_chat')
      .select('id, estado').eq('id', mensajeId).maybeSingle();
    if (msg?.estado === 'completo') {
      // Buscar la última respuesta de junior en la sesión POSTERIOR al mensaje del usuario
      const { data: resp } = await sb.from('junior_chat')
        .select('id, mensaje, estado, costo_usd, created_at')
        .eq('sesion_id', sesionId).eq('rol', 'junior')
        .gt('id', mensajeId)
        .order('id', { ascending: false }).limit(1);
      if (resp && resp.length > 0) return resp[0];
    } else if (msg?.estado === 'error') {
      return { error: true };
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  return { timeout: true };
}

// Verificar expectativas declaradas en el escenario
function verificar(escenario, respuesta) {
  if (!escenario.espera || escenario.espera.length === 0) return { ok: true, fails: [] };
  const fails = [];
  const resp = (respuesta.mensaje ?? '').toLowerCase();
  // Acciones — para verificar arrays necesitamos pedirlas a BD por mensaje_chat_id de la respuesta
  // Por simplicidad acá solo verificamos lo que se puede inferir del texto:
  for (const exp of escenario.espera) {
    if (exp.startsWith('RESP:')) {
      const regex = new RegExp(exp.slice(5), 'i');
      if (!regex.test(resp)) fails.push(`RESP no matchea: ${exp.slice(5)}`);
    }
    // ARRAY/GUARD/NO-MIENTE se verifican afuera con queries a BD
  }
  return { ok: fails.length === 0, fails };
}

// Contar acciones que generó la respuesta de Junior en BD
async function contarAcciones(mensajeId, sesionId, respuestaId, ventanaInicio) {
  // Buscar correcciones, tareas, agendamientos, etc. originadas en este turno
  // Las correcciones tienen mensaje_chat_id que apunta al msg del USUARIO (no la respuesta)
  const { data: instrs } = await sb.from('junior_instrucciones')
    .select('tipo').eq('mensaje_chat_id', mensajeId);
  const conteo = { correcciones: 0, memorias: 0, nuevos_clientes: 0 };
  for (const i of instrs ?? []) {
    if (i.tipo === 'correccion') conteo.correcciones++;
    else if (i.tipo === 'memoria') conteo.memorias++;
    else if (i.tipo === 'nuevo_cliente') conteo.nuevos_clientes++;
  }
  // Tareas/agendamientos/cierres creados en la ventana de este turno
  const { count: tareas } = await sb.from('tareas').select('*', { count: 'exact', head: true })
    .gte('created_at', ventanaInicio).eq('origen', 'chat');
  const { count: ags } = await sb.from('agendamientos').select('*', { count: 'exact', head: true })
    .gte('created_at', ventanaInicio);
  const { data: cls } = await sb.from('chat_checklist')
    .select('chat_id').eq('cerrado_manual', true).gte('actualizado_at', ventanaInicio);
  return { ...conteo, tareas_creadas: tareas ?? 0, agendamientos_creados: ags ?? 0, cierres_checklist: (cls ?? []).length };
}

async function detectarGuard(respuesta) {
  return (respuesta.mensaje ?? '').includes('🛑') || /bloque[ée]\s+las\s+\d+\s+acciones\s+destructivas/i.test(respuesta.mensaje ?? '');
}

function logProgreso(extra = '') {
  const elapsed = Date.now() - state.started_at.getTime();
  const pctTime = ((elapsed / DURACION_MS) * 100).toFixed(1);
  const pctCosto = ((state.costo_acumulado / TOPE_USD) * 100).toFixed(1);
  console.log(`[${ts()}] msg=${state.msg_enviados} resp=${state.msg_respondidos} err=${state.msg_error} t/o=${state.msg_timeout} | $${state.costo_acumulado.toFixed(4)} (${pctCosto}% tope) | tiempo ${pctTime}% ${extra}`);
}

// Reporta desde JSONL + lock (no relanza nada — post-mortem). Para usar tras un corte de luz.
async function reportarDesdeArchivos() {
  if (!fs.existsSync(LOCK_FILE)) { console.error(`No hay lock file en ${LOCK_FILE}. Nada que reportar.`); process.exit(1); }
  if (!fs.existsSync(JSONL_FILE)) { console.error(`No hay JSONL en ${JSONL_FILE}.`); process.exit(1); }
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  const turnos = fs.readFileSync(JSONL_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  console.log('═'.repeat(70));
  console.log('  REPORTE POST-MORTEM (desde lock + JSONL)');
  console.log('═'.repeat(70));
  console.log(`  Sesión:           s${lock.sesion_id}`);
  console.log(`  Inicio:           ${new Date(lock.started_at).toLocaleString('es-CO')}`);
  console.log(`  Parámetros:       ${HORAS}h, ${RITMO_SEG}s, $${TOPE_USD}`);
  console.log(`  Turnos en JSONL:  ${turnos.length}`);
  const completos = turnos.filter(t => t.resultado === 'completo');
  const errores = turnos.filter(t => t.resultado === 'error');
  const timeouts = turnos.filter(t => t.resultado === 'timeout');
  const costo = completos.reduce((s, t) => s + (t.costo_usd ?? 0), 0);
  const guards = completos.filter(t => t.guard).length;
  const expectFails = completos.filter(t => (t.expectativas_fail ?? []).length > 0).length;
  const porCat = {};
  for (const t of turnos) porCat[t.escenario?.cat] = (porCat[t.escenario?.cat] ?? 0) + 1;
  console.log(`\n  Resultados:`);
  console.log(`    completos:       ${completos.length}`);
  console.log(`    errores:         ${errores.length}`);
  console.log(`    timeouts:        ${timeouts.length}`);
  console.log(`    guards:          ${guards}`);
  console.log(`    expect_fail:     ${expectFails}`);
  console.log(`    costo total:     $${costo.toFixed(4)}`);
  console.log(`\n  Por categoría:`);
  for (const [k, v] of Object.entries(porCat).sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${v}`);
  console.log(`\n  Para revertir:  node tests/stress_revert.mjs --apply  (lee el lock solo)`);
  console.log(`  Para borrar lock (test concluido a mano):  rm ${LOCK_FILE} ${JSONL_FILE}`);
}

async function main() {
  // MODO REPORTAR — post-mortem desde archivos
  if (MODO_REPORTAR) { await reportarDesdeArchivos(); return; }

  // Verificar si hay test activo
  let lockExistente = null;
  if (fs.existsSync(LOCK_FILE)) {
    lockExistente = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    if (MODO_REANUDAR) {
      state.sesion_id = lockExistente.sesion_id;
      state.started_at = new Date(lockExistente.started_at);
      state.snapshot_pre = JSON.parse(fs.readFileSync(lockExistente.snapshot_pre_path, 'utf8'));
      // Restaurar params originales del test desde el lock (no usar defaults
      // ni los args que el usuario pueda haber pasado de nuevo). Bug detectado
      // 2026-05-27: sin esto el --reanudar perdía --cats y volvía a 4h/120s/$5.
      const p = lockExistente.params ?? {};
      if (p.HORAS != null)        HORAS = Number(p.HORAS);
      if (p.RITMO_SEG != null)    RITMO_SEG = Number(p.RITMO_SEG);
      if (p.TOPE_USD != null)     TOPE_USD = Number(p.TOPE_USD);
      if (p.TIMEOUT_RESP != null) TIMEOUT_RESP = Number(p.TIMEOUT_RESP);
      if (Array.isArray(p.CATS_FILTRO)) CATS_FILTRO = p.CATS_FILTRO;
      recomputarEscenariosActivos();
      console.log(`📂 REANUDANDO test activo: s${state.sesion_id}, iniciado ${state.started_at.toLocaleString('es-CO')}`);
      console.log(`   Params restaurados del lock: ${HORAS}h, ${RITMO_SEG}s ritmo, $${TOPE_USD} tope${CATS_FILTRO.length ? `, cats=${CATS_FILTRO.join(',')}` : ''}`);
      // Reconstruir contadores completos desde JSONL — antes solo se hidrataba
      // costo y status; guards, mentiras y acciones acumulaban desde 0 lo que
      // hacía que el reporte final post-reanudar fuera incompleto.
      if (fs.existsSync(JSONL_FILE)) {
        const turnos = fs.readFileSync(JSONL_FILE, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
        for (const t of turnos) {
          if (t.resultado === 'completo') { state.msg_respondidos++; state.costo_acumulado += t.costo_usd ?? 0; }
          else if (t.resultado === 'error') state.msg_error++;
          else if (t.resultado === 'timeout') state.msg_timeout++;
          state.msg_enviados++;
          if (t.guard) state.guards_activados++;
          if (Array.isArray(t.mentiras) && t.mentiras.length > 0) state.warns_mentira++;
          if (t.escenario?.cat) state.por_categoria[t.escenario.cat] = (state.por_categoria[t.escenario.cat] ?? 0) + 1;
          if (Array.isArray(t.expectativas_fail)) {
            if (t.expectativas_fail.length === 0) state.expectativas_pass++;
            else { state.expectativas_fail += t.expectativas_fail.length; state.fails_detalle.push({ msg_id: t.msg_id, escenario: t.escenario?.cat, expectativa_fail: t.expectativas_fail }); }
          }
          // Mapear nombres del JSONL → state.acciones_totales (shapes distintos por legacy)
          const a = t.acciones ?? {};
          state.acciones_totales.correcciones        += a.correcciones ?? 0;
          state.acciones_totales.memorias            += a.memorias ?? 0;
          state.acciones_totales.nuevosClientes      += a.nuevos_clientes ?? 0;
          state.acciones_totales.nuevasTareas        += a.tareas_creadas ?? 0;
          state.acciones_totales.nuevosAgendamientos += a.agendamientos_creados ?? 0;
          state.acciones_totales.cierresChecklist    += a.cierres_checklist ?? 0;
        }
        console.log(`   recuperados ${turnos.length} turnos del JSONL ($${state.costo_acumulado.toFixed(4)} ya gastado · ${state.guards_activados} guards · ${state.warns_mentira} mentiras · exp: ${state.expectativas_pass} pass / ${state.expectativas_fail} fail)`);
      }
    } else {
      console.error(`\n⚠  HAY UN TEST ACTIVO/INTERRUMPIDO (${LOCK_FILE})`);
      console.error(`   Sesión: s${lockExistente.sesion_id}, iniciado: ${new Date(lockExistente.started_at).toLocaleString('es-CO')}`);
      console.error(`\n   Opciones:`);
      console.error(`     1) ver reporte:  node tests/stress_run.mjs --reportar`);
      console.error(`     2) reanudar:     node tests/stress_run.mjs --reanudar`);
      console.error(`     3) revertir:     node tests/stress_revert.mjs --apply`);
      console.error(`     4) descartar:    rm ${LOCK_FILE} ${JSONL_FILE}`);
      process.exit(2);
    }
  }

  console.log('═'.repeat(70));
  console.log(MODO_REANUDAR ? '  STRESS TEST de Junior — REANUDANDO' : '  STRESS TEST de Junior — propósito del visor');
  console.log('═'.repeat(70));
  console.log(`  Duración: ${HORAS}h · Ritmo: 1 msg cada ${RITMO_SEG}s · Tope: $${TOPE_USD} USD`);
  if (CATS_FILTRO.length > 0) {
    console.log(`  Filtro --cats: ${CATS_FILTRO.join(', ')}`);
    const catsActivas = [...new Set(ESCENARIOS_ACTIVOS.map(s => s.cat))];
    console.log(`  Dataset filtrado: ${ESCENARIOS_ACTIVOS.length} escenarios (${catsActivas.length} categorías: ${catsActivas.join(', ')})`);
  } else {
    console.log(`  Escenarios en dataset: ${META.total_escenarios} (${META.categorias.length} categorías)`);
  }
  console.log(`  Inicio: ${state.started_at.toLocaleString('es-CO')}`);
  console.log('═'.repeat(70));

  let snapPath;
  if (!MODO_REANUDAR) {
    // Snapshot inicial
    console.log('\n[1] Tomando snapshot pre-test…');
    state.snapshot_pre = await tomarSnapshot();
    snapPath = `tests/_snapshot_${Date.now()}.json`;
    fs.writeFileSync(snapPath, JSON.stringify(state.snapshot_pre, null, 2));
    console.log(`    snapshot guardado en ${snapPath}`);
    console.log(`    estado: ${state.snapshot_pre.counts.tareas_activas} tareas, ${state.snapshot_pre.counts.agendamientos_activos} agendamientos, ${state.snapshot_pre.counts.cls_cerrados_manual} checklists cerrados, ${state.snapshot_pre.counts.memorias_vigentes} memorias`);

    // Crear sesión
    state.sesion_id = await crearSesion();
    console.log(`\n[2] Sesión de test creada: s${state.sesion_id}`);

    // Escribir lock file — incluye CATS_FILTRO para que --reanudar respete
    // el dataset enfocado del test original.
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      sesion_id: state.sesion_id,
      started_at: state.started_at.toISOString(),
      params: { HORAS, RITMO_SEG, TOPE_USD, TIMEOUT_RESP, CATS_FILTRO },
      snapshot_pre_path: snapPath,
    }, null, 2));
    console.log(`    lock file: ${LOCK_FILE}`);
    // Reset JSONL + bitácora de hallazgos
    if (fs.existsSync(JSONL_FILE)) fs.unlinkSync(JSONL_FILE);
    fs.writeFileSync(HALLAZGOS_MD, `# Bitácora de hallazgos — Stress Test\n\n**Sesión:** s${state.sesion_id}\n**Inicio:** ${state.started_at.toLocaleString('es-CO')}\n**Parámetros:** ${HORAS}h, ${RITMO_SEG}s entre msgs, tope $${TOPE_USD}\n\n---\n`);
    console.log(`    bitácora: ${HALLAZGOS_MD}`);
  } else {
    snapPath = lockExistente.snapshot_pre_path;
  }

  // Loop principal
  console.log(`\n[3] ${MODO_REANUDAR ? 'Continuando' : 'Arrancando'} loop principal…\n`);
  const gen = generadorEscenarios();
  const turnos = [];

  while (true) {
    const elapsed = Date.now() - state.started_at.getTime();
    if (elapsed >= DURACION_MS) {
      console.log(`\n⏰ Timer expirado (${HORAS}h). Cerrando.`);
      break;
    }
    if (state.costo_acumulado >= TOPE_USD) {
      console.log(`\n💰 Tope de presupuesto alcanzado ($${state.costo_acumulado.toFixed(4)} / $${TOPE_USD}). Cerrando.`);
      break;
    }

    const escenario = gen.next().value;
    const ventanaInicio = ahora();
    state.por_categoria[escenario.cat] = (state.por_categoria[escenario.cat] ?? 0) + 1;

    // Insertar mensaje
    state.msg_enviados++;
    const { data: msg, error: errIns } = await sb.from('junior_chat').insert({
      rol: 'usuario', mensaje: escenario.msg, estado: 'pendiente', sesion_id: state.sesion_id,
    }).select('id').single();
    if (errIns) {
      console.error(`[${ts()}] ❌ insertando msg: ${errIns.message}`);
      await new Promise(r => setTimeout(r, RITMO_SEG * 1000));
      continue;
    }

    if (VERBOSE) console.log(`[${ts()}] → msg ${msg.id} [${escenario.cat}] "${escenario.msg.slice(0, 80)}${escenario.msg.length > 80 ? '…' : ''}"`);

    // Esperar respuesta
    const resp = await esperarRespuesta(msg.id, state.sesion_id, TIMEOUT_RESP * 1000);

    const turno = { msg_id: msg.id, escenario, ventana_inicio: ventanaInicio, fin: ahora() };

    if (resp.timeout) {
      state.msg_timeout++;
      turno.resultado = 'timeout';
      console.log(`[${ts()}] ⏱ TIMEOUT msg ${msg.id} [${escenario.cat}] — Junior no respondió en ${TIMEOUT_RESP}s`);
      anotarHallazgo('critico', `TIMEOUT msg ${msg.id} [${escenario.cat}]`,
        `**Junior no respondió en ${TIMEOUT_RESP}s.** Worker probablemente atascado en re-síntesis o re-checklists.\n\n**Mensaje enviado:** "${escenario.msg.slice(0, 200)}"`);
    } else if (resp.error) {
      state.msg_error++;
      turno.resultado = 'error';
      console.log(`[${ts()}] ❌ ERROR msg ${msg.id} [${escenario.cat}]`);
      anotarHallazgo('critico', `ERROR msg ${msg.id} [${escenario.cat}]`,
        `Junior devolvió respuesta marcada como 'error'. Posible JSON inválido del LLM, parser falló los 2 intentos.\n\n**Mensaje enviado:** "${escenario.msg.slice(0, 200)}"\n**Respuesta:** "${(resp.mensaje ?? '').slice(0, 200)}"`);
    } else {
      state.msg_respondidos++;
      state.costo_acumulado += Number(resp.costo_usd ?? 0);
      const guard = await detectarGuard(resp);
      if (guard) {
        state.guards_activados++;
        anotarHallazgo('info', `GUARD activado msg ${msg.id} [${escenario.cat}]`,
          `Guard anti-ráfaga rechazó >5 acciones destructivas. ${escenario.cat === 'masivo_guard' ? '✓ Comportamiento esperado.' : '⚠ NO era escenario de ráfaga esperada.'}\n\n**Mensaje:** "${escenario.msg.slice(0, 200)}"`);
      }
      const acciones = await contarAcciones(msg.id, state.sesion_id, resp.id, ventanaInicio);
      const verif = verificar(escenario, resp);
      if (verif.ok) state.expectativas_pass++;
      else {
        state.expectativas_fail++;
        state.fails_detalle.push({ msg_id: msg.id, escenario: escenario.cat, expectativa_fail: verif.fails });
        anotarHallazgo('expectativa', `Expectativa NO cumplida msg ${msg.id} [${escenario.cat}]`,
          `**Mensaje:** "${escenario.msg.slice(0, 200)}"\n**Esperado:** ${escenario.espera?.join(', ')}\n**Falló:** ${verif.fails.join('; ')}\n**Respuesta de Junior:** "${(resp.mensaje ?? '').slice(0, 300)}"`);
      }
      // Latencia anormal (>60s)
      const latenciaSeg = (Date.now() - new Date(ventanaInicio).getTime()) / 1000;
      if (latenciaSeg > 60) {
        anotarHallazgo('anomalia', `LATENCIA ALTA msg ${msg.id} [${escenario.cat}] — ${latenciaSeg.toFixed(0)}s`,
          `Junior tardó ${latenciaSeg.toFixed(0)}s en responder (esperado <30s). Posible contexto inflado o backlog del worker.\n\n**Mensaje:** "${escenario.msg.slice(0, 200)}"`);
      }
      // Costo anormal (>$0.04 en un turno)
      if (Number(resp.costo_usd ?? 0) > 0.04) {
        anotarHallazgo('anomalia', `COSTO ALTO msg ${msg.id} [${escenario.cat}] — $${Number(resp.costo_usd).toFixed(4)}`,
          `Turno costó $${Number(resp.costo_usd).toFixed(4)} (esperado <$0.02). Posible contexto enorme o múltiples reintentos.\n\n**Mensaje:** "${escenario.msg.slice(0, 200)}"`);
      }
      // Detección de mentira: respuesta promete acción pero arrays vacíos.
      // BYPASS — si el worker ya antepuso un aviso ("⚠ Aviso del worker" para
      // mismatch o "⚠ Bloqueé N acciones" para guard anti-ráfaga), la respuesta
      // ya fue manejada. El runner NO debe volver a contar esa misma mentira;
      // matchearía el texto original que quedó debajo del aviso y daría falso
      // positivo. Falso positivo detectado en stress test 2026-05-27 (msgs 791,
      // 859, 965).
      const respCruda = resp.mensaje ?? '';
      const yaManejadaPorWorker = /^⚠\s*(Aviso del worker|Bloque[ée])/i.test(respCruda.trim());
      // Regex ampliada para capturar pretérito ("cerré/completé/marqué") Y
      // presente con sujeto implícito Junior ("cierro/completo/marco"). El
      // bug del runner v1 solo capturaba pretérito y dejaba pasar "Completo
      // todas sus tareas" (caso real visto en msg 597 del stress test 1).
      const respLower = respCruda.toLowerCase();
      const mentiras = [];
      if (!yaManejadaPorWorker) {
        if (/(cerr[ée]|cierro|cierra)\s+(el\s+|los\s+|todos\s+los\s+)?checklists?|caso\s+(terminado|cerrado)/i.test(respLower) && acciones.cierres_checklist === 0) {
          mentiras.push('cierresChecklist');
        }
        if (/(marqu[ée]|marco|marca)\s+(la\s+)?(tarea|tareas)\s+(como\s+)?(hecha|completada|completadas)|(complet[ée]|completo|completa)\s+(la\s+|las\s+|todas\s+las\s+)?(tarea|tareas)/i.test(respLower)) {
          const { data: recientes } = await sb.from('tareas')
            .select('id').gte('completada_at', ventanaInicio).eq('completada', true);
          if ((recientes ?? []).length === 0) mentiras.push('tareasCompletar');
        }
        if (/(cancel[ée]|cancelo|cancela|elimin[ée]|elimino|borra[s]?|borrar[áa]?)\s+(el\s+|los\s+|todos\s+los\s+)?agendamientos?|cit[ao]s?/i.test(respLower)) {
          const { data: cancRec } = await sb.from('agendamientos')
            .select('id').gte('deleted_at', ventanaInicio).not('deleted_at', 'is', null);
          if ((cancRec ?? []).length === 0) mentiras.push('agendamientosCancelar');
        }
      }
      // Nueva detección: promete reclasificar/marcar como no comercial pero el ámbito no cambió
      if (/(reclasif|marc[oóé])\s+.*(no\s+comercial|familia|proveedor|amigo)/i.test(respLower) || /sac[oóé]\s+.*flujo\s+comercial/i.test(respLower)) {
        // No verifica acá — el guard del bug 1 puede haberlo evitado legítimamente.
        // Solo log para inspección posterior.
      }
      if (mentiras.length > 0) {
        anotarHallazgo('critico', `MENTIRA DETECTADA msg ${msg.id} [${escenario.cat}] — arrays vacíos: ${mentiras.join(', ')}`,
          `Junior dijo en "respuesta" que ejecutó una acción, pero los arrays correspondientes vinieron vacíos. **El guard defensivo del worker debería haberlo cazado, verificar log.**\n\n**Mensaje:** "${escenario.msg.slice(0, 200)}"\n**Respuesta de Junior:** "${(resp.mensaje ?? '').slice(0, 400)}"`);
      }
      turno.resultado = 'completo';
      turno.respuesta = (resp.mensaje ?? '').slice(0, 300);
      turno.costo_usd = resp.costo_usd;
      turno.acciones = acciones;
      turno.guard = guard;
      turno.latencia_seg = latenciaSeg;
      turno.mentiras = mentiras;
      turno.expectativas_fail = verif.fails;
      // Sumar a totales
      state.acciones_totales.correcciones += acciones.correcciones;
      state.acciones_totales.memorias += acciones.memorias;
      state.acciones_totales.nuevosClientes += acciones.nuevos_clientes;
      state.acciones_totales.nuevasTareas += acciones.tareas_creadas;
      state.acciones_totales.nuevosAgendamientos += acciones.agendamientos_creados;
      state.acciones_totales.cierresChecklist += acciones.cierres_checklist;
      if (VERBOSE) console.log(`[${ts()}] ← respondió en ${((Date.now() - new Date(ventanaInicio).getTime()) / 1000).toFixed(0)}s · $${Number(resp.costo_usd).toFixed(4)}${guard ? ' 🛑GUARD' : ''}${verif.ok ? '' : ` ⚠ ${verif.fails.length} expect fail`}`);
    }
    turnos.push(turno);
    // PERSISTENCIA POR TURNO — sobrevive a cortes de luz / crashes
    fs.appendFileSync(JSONL_FILE, JSON.stringify(turno) + '\n');

    if (state.msg_enviados % 5 === 0) logProgreso();
    // Cada 30 min, snapshot intermedio
    if (state.msg_enviados % Math.max(1, Math.round(30 * 60 / RITMO_SEG)) === 0) {
      const inter = await tomarSnapshot();
      fs.writeFileSync(`tests/_snapshot_intermedio_${Date.now()}.json`, JSON.stringify(inter, null, 2));
      console.log(`  📸 snapshot intermedio guardado`);
    }

    // Sleep hasta el próximo turno
    await new Promise(r => setTimeout(r, RITMO_SEG * 1000));
  }

  // Snapshot final
  console.log('\n[4] Tomando snapshot post-test…');
  const snapPost = await tomarSnapshot();
  const snapPostPath = `tests/_snapshot_post_${Date.now()}.json`;
  fs.writeFileSync(snapPostPath, JSON.stringify(snapPost, null, 2));

  // Reporte
  console.log('\n' + '═'.repeat(70));
  console.log('  REPORTE FINAL');
  console.log('═'.repeat(70));
  const dur = ((Date.now() - state.started_at.getTime()) / 60000).toFixed(1);
  console.log(`  Duración real:           ${dur} min`);
  console.log(`  Sesión usada:            s${state.sesion_id}`);
  console.log(`  Mensajes enviados:       ${state.msg_enviados}`);
  console.log(`  Mensajes respondidos:    ${state.msg_respondidos}`);
  console.log(`  Errores:                 ${state.msg_error}`);
  console.log(`  Timeouts:                ${state.msg_timeout}`);
  console.log(`  Costo total:             $${state.costo_acumulado.toFixed(4)} USD`);
  console.log(`  Guards activados:        ${state.guards_activados}`);
  console.log(`  Expectativas pass:       ${state.expectativas_pass}`);
  console.log(`  Expectativas fail:       ${state.expectativas_fail}`);
  console.log('\n  Acciones generadas (en total durante el test):');
  for (const [k, v] of Object.entries(state.acciones_totales)) console.log(`    ${k}: ${v}`);
  console.log('\n  Mensajes por categoría:');
  for (const [k, v] of Object.entries(state.por_categoria).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k}: ${v}`);
  }
  if (state.fails_detalle.length > 0) {
    console.log(`\n  Top 10 fallas de expectativa:`);
    for (const f of state.fails_detalle.slice(0, 10)) {
      console.log(`    msg ${f.msg_id} [${f.escenario}] → ${f.expectativa_fail.join(', ')}`);
    }
  }

  // Persistir detalle completo
  const reportPath = `tests/_stress_report_${Date.now()}.json`;
  fs.writeFileSync(reportPath, JSON.stringify({
    started_at: state.started_at, finished_at: new Date(),
    sesion_id: state.sesion_id, parametros: { HORAS, RITMO_SEG, TOPE_USD },
    summary: {
      msg_enviados: state.msg_enviados, msg_respondidos: state.msg_respondidos,
      errores: state.msg_error, timeouts: state.msg_timeout,
      costo_usd: state.costo_acumulado, guards: state.guards_activados,
      expectativas_pass: state.expectativas_pass, expectativas_fail: state.expectativas_fail,
      por_categoria: state.por_categoria, acciones_totales: state.acciones_totales,
    },
    fails_detalle: state.fails_detalle,
    snapshot_pre: state.snapshot_pre,
    snapshot_post: snapPost,
    turnos,
  }, null, 2));
  console.log(`\n  Reporte JSON completo:   ${reportPath}`);
  console.log(`  Snapshot pre:            ${snapPath}`);
  console.log(`  Snapshot post:           ${snapPostPath}`);
  console.log(`  Bitácora de hallazgos:   ${HALLAZGOS_MD}`);
  console.log('\n  Para revertir:  node tests/stress_revert.mjs --apply');
  console.log('═'.repeat(70));

  // Cierre en la bitácora
  fs.appendFileSync(HALLAZGOS_MD, `\n---\n\n## Cierre del test\n\n- **Duración real:** ${dur} min\n- **Mensajes:** ${state.msg_enviados} enviados · ${state.msg_respondidos} respondidos · ${state.msg_error} errores · ${state.msg_timeout} timeouts\n- **Costo:** $${state.costo_acumulado.toFixed(4)}\n- **Guards activados:** ${state.guards_activados}\n- **Expectativas:** ${state.expectativas_pass} ok · ${state.expectativas_fail} fail\n\n**Acciones generadas:**\n${Object.entries(state.acciones_totales).map(([k, v]) => `- ${k}: ${v}`).join('\n')}\n`);

  // Borrar lock — test concluido normalmente. Si NO se borra, significa que
  // el proceso murió (corte de luz / kill) y al volver se ofrece reanudar/revertir.
  if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
