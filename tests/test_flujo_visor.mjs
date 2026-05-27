/**
 * Test E2E del propósito del visor — detecta regresiones del flujo:
 *   corrección → re-síntesis → modulo_sintesis actualizado → tabla de dominio reflejada
 *
 * No es un test unitario. Es un VERIFICADOR continuo del propósito.
 * Se puede correr periódicamente (manual o cron) para detectar al toque si
 * algún cambio reciente rompió el flujo.
 *
 * Uso:
 *   node tests/test_flujo_visor.mjs           # corre todas las verificaciones
 *   node tests/test_flujo_visor.mjs --pid 110 # foco en una persona
 *
 * Exit code:
 *   0  → todo OK (el visor cumple su propósito)
 *   1  → al menos una regresión detectada
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = Object.fromEntries(fs.readFileSync('./.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const focoArg = process.argv.indexOf('--pid');
const focoPid = focoArg > -1 ? Number(process.argv[focoArg + 1]) : null;

let pass = 0, fail = 0;
const fails = [];

function ok(msg) { pass++; console.log(`  ✓ ${msg}`); }
function bad(msg) { fail++; fails.push(msg); console.log(`  ❌ ${msg}`); }

async function main() {
  console.log('═'.repeat(70));
  console.log('  TEST E2E — Propósito del visor (flujo corrección→síntesis→tabla)');
  console.log('═'.repeat(70));
  console.log();

  // T1 — Toda corrección humana vigente debería estar asociada a una persona viva
  console.log('T1 · Correcciones vigentes apuntan a persona viva');
  const { data: corrHuerf } = await sb
    .from('correcciones_humanas')
    .select('id, persona_id, hecho, personas(id, deleted_at)')
    .eq('vigente', true).limit(500);
  const huerfanas = (corrHuerf ?? []).filter(c => !c.personas || c.personas.deleted_at);
  if (huerfanas.length === 0) ok(`${corrHuerf?.length ?? 0} correcciones — ninguna huérfana`);
  else bad(`${huerfanas.length} correcciones apuntan a personas borradas/inexistentes`);

  // T2 — Toda persona con corrección reciente debería tener síntesis post-corrección
  console.log('\nT2 · Síntesis al día (no quedó vieja después de una corrección)');
  const hace2h = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data: corrRec } = await sb
    .from('correcciones_humanas')
    .select('persona_id, modulo, created_at')
    .eq('vigente', true).gte('created_at', hace2h);
  const personasConCorrRec = new Map();
  for (const c of corrRec ?? []) {
    const prev = personasConCorrRec.get(c.persona_id);
    if (!prev || new Date(c.created_at) > new Date(prev)) {
      personasConCorrRec.set(c.persona_id, c.created_at);
    }
  }
  let stale = 0;
  for (const [pid, ultimaCorr] of personasConCorrRec) {
    if (focoPid && pid !== focoPid) continue;
    const { data: sints } = await sb.from('modulo_sintesis')
      .select('modulo, generado_at').eq('persona_id', pid);
    const obsoletas = (sints ?? []).filter(s => new Date(s.generado_at) < new Date(ultimaCorr));
    if (obsoletas.length > 0) {
      stale++;
      const { data: p } = await sb.from('personas').select('nombre').eq('id', pid).maybeSingle();
      bad(`p${pid} ${p?.nombre ?? '?'}: ${obsoletas.length} módulos viejos (${obsoletas.map(o => o.modulo).join(',')}) tras corrección de ${new Date(ultimaCorr).toLocaleString('es-CO')}`);
    }
  }
  if (stale === 0) ok(`${personasConCorrRec.size} personas con correcciones recientes — todas las síntesis al día`);

  // T3 — Toda persona comercial con corrección m3 debería tener al menos un abono o una nota explícita de "sin abono"
  console.log('\nT3 · Correcciones m3 (financieras) materializan en abonos');
  const { data: corrM3 } = await sb.from('correcciones_humanas')
    .select('persona_id, hecho').eq('modulo', 'm3').eq('vigente', true);
  const personasM3 = new Map();
  for (const c of corrM3 ?? []) personasM3.set(c.persona_id, c.hecho);
  let m3Gap = 0;
  for (const [pid, hecho] of personasM3) {
    if (focoPid && pid !== focoPid) continue;
    const { data: p } = await sb.from('personas').select('nombre, ambito_principal').eq('id', pid).maybeSingle();
    if (!p || p.ambito_principal !== 'comercial') continue;   // no comerciales no requieren abonos
    const { count } = await sb.from('abonos').select('*', { count: 'exact', head: true }).eq('persona_id', pid).is('deleted_at', null);
    if ((count ?? 0) === 0) {
      // Excepciones legítimas — NO requieren fila nueva en abonos:
      // - "sin abono", "no pagó" → ningún pago hecho.
      // - "saldo cobrado", "pagó el total", "paz y salvo" → cierre de saldo, no
      //   abono separado. El último abono parcial ya está en la tabla; el "final"
      //   es contable pero los pagos individuales ya están registrados.
      // - "cliente a paz y salvo" → cierre operativo, no asiento financiero nuevo.
      if (/sin (abono|pago)|no (abon|pag|ha pagado)|saldo (ya )?(cobrado|cerrado)|pag[óo] el total|paz y salvo/i.test(hecho)) continue;
      m3Gap++;
      bad(`p${pid} ${p.nombre}: corrección m3 "${hecho.slice(0, 60)}" pero 0 abonos en tabla`);
    }
  }
  if (m3Gap === 0) ok(`${personasM3.size} personas con corrección m3 — todas materializadas`);

  // T4 — sintesis_pendiente no debería haber backlog grande (>20 personas indica atasco)
  console.log('\nT4 · Backlog de re-síntesis razonable');
  const { count: pendientes } = await sb.from('personas').select('*', { count: 'exact', head: true }).eq('sintesis_pendiente', true);
  if ((pendientes ?? 0) <= 20) ok(`${pendientes} personas en cola de re-síntesis (OK ≤20)`);
  else bad(`${pendientes} personas en cola — backlog grande, worker puede estar atascado`);

  // T5 — Mensajes de junior_chat pendientes no más de 5 min
  console.log('\nT5 · Mensajes de Junior pendientes se procesan en <5 min');
  const hace5m = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: msgsPend } = await sb.from('junior_chat')
    .select('id, created_at').eq('estado', 'pendiente').eq('rol', 'usuario').lt('created_at', hace5m);
  if ((msgsPend ?? []).length === 0) ok('No hay mensajes de usuario pendientes desde hace >5 min');
  else bad(`${msgsPend.length} mensajes de usuario pendientes desde hace +5 min: ${msgsPend.map(m => `#${m.id}`).join(', ')}`);

  // T6 — chat_checklist coherente con ámbito
  console.log('\nT6 · Checklists activos solo para clientes comerciales');
  const { data: cls } = await sb.from('chat_checklist')
    .select('chat_id, persona_id, tipo, estado, cerrado_manual, personas(ambito_principal)')
    .neq('tipo', 'no_aplica').eq('cerrado_manual', false);
  const incongruentes = (cls ?? []).filter(c => c.personas && c.personas.ambito_principal && c.personas.ambito_principal !== 'comercial');
  if (incongruentes.length === 0) ok(`${cls?.length ?? 0} checklists activos — todos de clientes comerciales`);
  else bad(`${incongruentes.length} checklists activos para personas no-comerciales`);

  // T7 — No hay duplicados de agendamientos no resueltos
  console.log('\nT7 · No hay agendamientos duplicados (mismo persona+fecha+titulo)');
  const { data: ags } = await sb.from('agendamientos')
    .select('persona_id, fecha, titulo').is('deleted_at', null);
  const grupos = new Map();
  for (const a of ags ?? []) {
    const k = `${a.persona_id}|${a.fecha}|${(a.titulo || '').toLowerCase().trim()}`;
    grupos.set(k, (grupos.get(k) || 0) + 1);
  }
  const dups = [...grupos.entries()].filter(([_, n]) => n > 1);
  if (dups.length === 0) ok(`${ags?.length ?? 0} agendamientos — sin duplicados`);
  else bad(`${dups.length} grupos de agendamientos duplicados detectados`);

  // Resumen
  console.log('\n' + '═'.repeat(70));
  console.log(`  RESULTADO: ${pass} passed · ${fail} failed`);
  console.log('═'.repeat(70));
  if (fail > 0) {
    console.log('\nFallas:');
    for (const f of fails) console.log(`  · ${f}`);
    process.exit(1);
  } else {
    console.log('\n✓ El visor cumple su propósito (corrección → síntesis → tabla → coherencia operativa).');
    process.exit(0);
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });
