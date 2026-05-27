/**
 * Revertir los cambios que hizo un STRESS TEST.
 *
 * Uso:
 *   node tests/stress_revert.mjs --sesion <id>           # dry-run (muestra qué haría)
 *   node tests/stress_revert.mjs --sesion <id> --apply   # aplica
 *
 * Qué revierte:
 *   1. Correcciones humanas con mensaje_chat_id dentro de la sesión del test → vigente=false
 *   2. junior_instrucciones de esa sesión → soft-delete (deleted_at)
 *   3. Tareas creadas DURANTE la ventana del test con origen='chat' → soft-delete
 *   4. Agendamientos creados DURANTE la ventana → soft-delete
 *   5. chat_checklist cerrado_manual=true marcados durante la ventana → cerrado_manual=false
 *   6. junior_memoria creadas durante la ventana → vigente=false
 *   7. personas.ambito_principal modificados durante la ventana → restaurar desde snapshot
 *   8. Re-abrir tareas comerciales que se hayan completado por el test
 *
 * NO revierte:
 *   - Re-síntesis (modulo_sintesis): regeneran solas con la próxima corrida normal.
 *     Solo cambia el `generado_at`; los datos son los mismos.
 *   - Mensajes del chat (junior_chat): se podrían borrar pero los dejamos como traza
 *     histórica. Se identifican por sesion_id.
 *
 * Si pasás --borrar-chat también, elimina los mensajes de la sesión.
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = Object.fromEntries(fs.readFileSync('./.env','utf8').split('\n').filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim()]}));
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const argv = process.argv.slice(2);
function arg(name, def) {
  const i = argv.indexOf(name);
  return i > -1 && argv[i+1] ? argv[i+1] : def;
}
const APPLY = argv.includes('--apply');
const BORRAR_CHAT = argv.includes('--borrar-chat');
let SESION = arg('--sesion');

// Si no se pasó --sesion, intentar leerla del lock file activo
const LOCK_FILE = 'tests/_stress_active.json';
if (!SESION && fs.existsSync(LOCK_FILE)) {
  const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
  SESION = lock.sesion_id;
  console.log(`📂 Usando sesión del lock file: s${SESION}`);
}

if (!SESION) { console.error('Falta --sesion <id> (y no hay lock file activo).'); process.exit(2); }

const sep = (t) => console.log('\n' + '═'.repeat(70) + '\n  ' + t + (APPLY ? ' [APPLY]' : ' [DRY-RUN]') + '\n' + '═'.repeat(70));

async function main() {
  if (!APPLY) console.log('\n⚠  MODO DRY-RUN. Para aplicar: agregá --apply\n');

  // Cargar la sesión + ventana de tiempo (del primer y último mensaje)
  const { data: sesion } = await sb.from('junior_sesiones').select('id, titulo, created_at, ultima_actividad').eq('id', SESION).maybeSingle();
  if (!sesion) { console.error(`Sesión s${SESION} no existe`); process.exit(2); }
  console.log(`\nSesión: s${sesion.id} "${sesion.titulo}"`);
  console.log(`Creada:   ${new Date(sesion.created_at).toLocaleString('es-CO')}`);
  console.log(`Última:   ${new Date(sesion.ultima_actividad).toLocaleString('es-CO')}`);
  const ventanaIni = sesion.created_at;
  const ventanaFin = new Date(new Date(sesion.ultima_actividad).getTime() + 5 * 60 * 1000).toISOString();  // +5min de margen

  // Mensajes de la sesión
  const { data: msgs } = await sb.from('junior_chat').select('id, rol').eq('sesion_id', SESION);
  const msgIdsUsuario = (msgs ?? []).filter(m => m.rol === 'usuario').map(m => m.id);
  console.log(`Mensajes en sesión: ${msgs?.length} (${msgIdsUsuario.length} del usuario)`);
  if (msgIdsUsuario.length === 0) {
    console.log('Sesión sin mensajes de usuario — nada que revertir.');
    return;
  }

  // ─── 1. Correcciones humanas con mensaje_chat_id en la sesión ─────────
  sep('1) Correcciones humanas a invalidar');
  // junior_instrucciones tiene mensaje_chat_id; las correcciones se asocian indirectamente.
  // Identificamos correcciones por origen='chat_junior' y created_at en ventana,
  // pero para más precisión cruzamos con junior_instrucciones.
  const { data: instrs } = await sb.from('junior_instrucciones')
    .select('mensaje_chat_id, persona_id, modulo, tipo')
    .in('mensaje_chat_id', msgIdsUsuario);
  const corrPersonaModulo = new Set((instrs ?? []).filter(i => i.tipo === 'correccion').map(i => `${i.persona_id}|${i.modulo}|${i.mensaje_chat_id}`));
  // Para invalidar las correcciones, las buscamos por persona+modulo+created_at en ventana
  const { data: corrs } = await sb.from('correcciones_humanas')
    .select('id, persona_id, modulo, hecho, created_at')
    .gte('created_at', ventanaIni).lte('created_at', ventanaFin)
    .eq('origen', 'chat_junior');
  console.log(`Correcciones candidatas (dentro de ventana, origen=chat_junior): ${corrs?.length}`);
  for (const c of (corrs ?? []).slice(0, 15)) {
    console.log(`  [c${c.id}|p${c.persona_id}|${c.modulo}] ${(c.hecho ?? '').slice(0, 80)}`);
  }
  if (APPLY && (corrs?.length ?? 0) > 0) {
    const { error } = await sb.from('correcciones_humanas').update({ vigente: false }).in('id', corrs.map(c => c.id));
    if (error) console.error('  ❌ ' + error.message); else console.log(`  ✓ ${corrs.length} correcciones marcadas vigente=false`);
  }

  // ─── 2. junior_instrucciones — soft-delete ─────────────────────────────
  sep('2) junior_instrucciones de la sesión');
  console.log(`Instrucciones: ${instrs?.length}`);
  if (APPLY && (instrs?.length ?? 0) > 0) {
    // No tienen deleted_at — solo las dejamos. Pero si querés podemos borrarlas duro.
    console.log('  (skip — instrucciones no tienen flag de soft-delete, quedan como traza)');
  }

  // ─── 3. Tareas creadas en ventana (CUALQUIER origen) → soft-delete ──────
  // Antes solo borraba origen='chat'. El stress test descubrió que las tareas
  // generadas por A_SINTESIS_M5 (origen='agente') quedaban como basura tras
  // el revert. Ahora se borran todas las creadas en la ventana del test.
  sep('3) Tareas creadas en ventana (TODAS las origenes) → soft-delete');
  const { data: tareas } = await sb.from('tareas')
    .select('id, persona_id, titulo, completada, deleted_at, created_at, origen, agente_origen')
    .gte('created_at', ventanaIni).lte('created_at', ventanaFin)
    .is('deleted_at', null);
  console.log(`Tareas a borrar: ${tareas?.length}`);
  for (const t of (tareas ?? []).slice(0, 15)) {
    console.log(`  #${t.id} (p${t.persona_id}) origen=${t.origen}${t.agente_origen ? '/' + t.agente_origen : ''} "${(t.titulo ?? '').slice(0, 60)}" comp=${t.completada}`);
  }
  if (APPLY && (tareas?.length ?? 0) > 0) {
    const { error } = await sb.from('tareas').update({ deleted_at: new Date().toISOString() }).in('id', tareas.map(t => t.id));
    if (error) console.error('  ❌ ' + error.message); else console.log(`  ✓ ${tareas.length} tareas soft-deleted`);
  }

  // ─── 4. Agendamientos creados en ventana → soft-delete ─────────────────
  sep('4) Agendamientos creados en ventana → soft-delete');
  const { data: ags } = await sb.from('agendamientos')
    .select('id, persona_id, titulo, fecha, deleted_at, created_at')
    .gte('created_at', ventanaIni).lte('created_at', ventanaFin)
    .is('deleted_at', null);
  console.log(`Agendamientos a borrar: ${ags?.length}`);
  for (const a of (ags ?? []).slice(0, 15)) {
    console.log(`  #${a.id} (p${a.persona_id}) ${a.fecha} "${a.titulo}"`);
  }
  if (APPLY && (ags?.length ?? 0) > 0) {
    const { error } = await sb.from('agendamientos').update({ deleted_at: new Date().toISOString() }).in('id', ags.map(a => a.id));
    if (error) console.error('  ❌ ' + error.message); else console.log(`  ✓ ${ags.length} agendamientos soft-deleted`);
  }

  // ─── 5. chat_checklist cerrado_manual=true durante la ventana → revertir ─
  sep('5) chat_checklist cerrado_manual durante ventana → revertir a false');
  const { data: cls } = await sb.from('chat_checklist')
    .select('chat_id, tipo, estado, cerrado_manual, motivo_cierre, actualizado_at')
    .eq('cerrado_manual', true).gte('actualizado_at', ventanaIni).lte('actualizado_at', ventanaFin);
  console.log(`Checklists a revertir: ${cls?.length}`);
  for (const c of cls ?? []) {
    console.log(`  chat${c.chat_id} motivo="${(c.motivo_cierre ?? '').slice(0, 60)}"`);
  }
  if (APPLY && (cls?.length ?? 0) > 0) {
    const { error } = await sb.from('chat_checklist').update({
      cerrado_manual: false, motivo_cierre: null, tipo: 'venta', estado: 'sin_responder',
    }).in('chat_id', cls.map(c => c.chat_id));
    if (error) console.error('  ❌ ' + error.message); else console.log(`  ✓ ${cls.length} checklists revertidos (A_CHECKLIST los regenera en próxima corrida)`);
  }

  // ─── 6. junior_memoria creadas en ventana → vigente=false ──────────────
  sep('6) junior_memoria creadas en ventana → vigente=false');
  const { data: mems } = await sb.from('junior_memoria')
    .select('id, tipo, contenido, created_at')
    .gte('created_at', ventanaIni).lte('created_at', ventanaFin)
    .eq('vigente', true);
  console.log(`Memorias a invalidar: ${mems?.length}`);
  for (const m of mems ?? []) {
    console.log(`  m${m.id} [${m.tipo}] ${(m.contenido ?? '').slice(0, 80)}`);
  }
  if (APPLY && (mems?.length ?? 0) > 0) {
    const { error } = await sb.from('junior_memoria').update({ vigente: false }).in('id', mems.map(m => m.id));
    if (error) console.error('  ❌ ' + error.message); else console.log(`  ✓ ${mems.length} memorias invalidadas`);
  }

  // ─── 7. personas.ambito_principal — restaurar desde snapshot pre ───────
  sep('7) personas.ambito_principal — restaurar desde snapshot pre');
  const snaps = fs.readdirSync('tests/').filter(f => /^_snapshot_\d+\.json$/.test(f)).sort();
  const ultimoSnap = snaps[snaps.length - 1];
  if (!ultimoSnap) {
    console.log('No hay snapshot pre — no se restaura ámbitos. (Si fue una sesión muy reciente, debería estar.)');
  } else {
    const snap = JSON.parse(fs.readFileSync(`tests/${ultimoSnap}`, 'utf8'));
    console.log(`Usando snapshot: tests/${ultimoSnap} (${snap.ts})`);
    const { data: pAhora } = await sb.from('personas').select('id, ambito_principal').is('deleted_at', null);
    const cambios = [];
    for (const p of pAhora ?? []) {
      const ambitoPre = snap.ambitos[p.id];
      if (ambitoPre !== undefined && ambitoPre !== p.ambito_principal) {
        cambios.push({ id: p.id, de: p.ambito_principal, a: ambitoPre });
      }
    }
    console.log(`Personas con ámbito cambiado: ${cambios.length}`);
    for (const c of cambios.slice(0, 20)) console.log(`  p${c.id}: ${c.de} → ${c.a}`);
    if (APPLY && cambios.length > 0) {
      for (const c of cambios) {
        await sb.from('personas').update({ ambito_principal: c.a, sintesis_pendiente: true }).eq('id', c.id);
      }
      console.log(`  ✓ ${cambios.length} ámbitos restaurados (re-síntesis encolada)`);
    }
  }

  // ─── 8. Re-abrir tareas comerciales completadas durante ventana ────────
  sep('8) Re-abrir tareas comerciales completadas durante ventana del test');
  const { data: tareasComp } = await sb.from('tareas')
    .select('id, titulo, completada_at, persona_id, deleted_at')
    .gte('completada_at', ventanaIni).lte('completada_at', ventanaFin)
    .eq('completada', true).is('deleted_at', null);
  console.log(`Tareas completadas en ventana: ${tareasComp?.length}`);
  if (APPLY && (tareasComp?.length ?? 0) > 0) {
    const { error } = await sb.from('tareas').update({ completada: false, completada_at: null }).in('id', tareasComp.map(t => t.id));
    if (error) console.error('  ❌ ' + error.message); else console.log(`  ✓ ${tareasComp.length} tareas reabiertas`);
  }
  for (const t of (tareasComp ?? []).slice(0, 10)) console.log(`  #${t.id} (p${t.persona_id}) "${(t.titulo ?? '').slice(0, 60)}"`);

  // ─── 8b. Personas (clientes nuevos) creadas en ventana → soft-delete ────
  // Bug detectado en stress test 1: Junior creó 6 personas duplicadas
  // (Sandra Pinilla x2, Patricia x4) y el revert no las borraba. Quedaba
  // basura en la lista de clientes. Ahora se borran personas + sus proyectos.
  sep('8b) Personas creadas en ventana (clientes nuevos del test) → soft-delete');
  const { data: pNew } = await sb.from('personas')
    .select('id, nombre, telefono_e164, origen')
    .gte('created_at', ventanaIni).lte('created_at', ventanaFin)
    .is('deleted_at', null);
  console.log(`Personas a borrar: ${pNew?.length}`);
  for (const p of (pNew ?? []).slice(0, 15)) {
    console.log(`  p${p.id} "${p.nombre}" origen=${p.origen} tel=${p.telefono_e164 ?? '-'}`);
  }
  if (APPLY && (pNew?.length ?? 0) > 0) {
    const ids = pNew.map(p => p.id);
    // Borrar proyectos asociados primero
    const { error: ep } = await sb.from('proyectos')
      .update({ deleted_at: new Date().toISOString() })
      .in('persona_id', ids).is('deleted_at', null);
    if (ep) console.error('  ❌ proyectos: ' + ep.message);
    const { error: epp } = await sb.from('personas')
      .update({ deleted_at: new Date().toISOString() }).in('id', ids);
    if (epp) console.error('  ❌ personas: ' + epp.message);
    else console.log(`  ✓ ${ids.length} personas + sus proyectos soft-deleted`);
  }

  // ─── 9. Borrar chat de la sesión si --borrar-chat ──────────────────────
  if (BORRAR_CHAT) {
    sep('9) Borrar mensajes de la sesión del test (--borrar-chat)');
    if (APPLY) {
      const { error } = await sb.from('junior_chat').delete().eq('sesion_id', SESION);
      if (error) console.error('  ❌ ' + error.message); else console.log(`  ✓ ${msgs.length} mensajes borrados`);
      await sb.from('junior_sesiones').delete().eq('id', SESION);
      console.log(`  ✓ sesión s${SESION} borrada`);
    } else {
      console.log(`Borraría ${msgs.length} mensajes + sesión s${SESION}`);
    }
  } else {
    sep('9) Mensajes de chat se conservan (usar --borrar-chat para borrar también)');
  }

  sep('LISTO');
  if (!APPLY) {
    console.log('Para aplicar: node tests/stress_revert.mjs --apply' + (arg('--sesion') ? ' --sesion ' + SESION : ''));
  } else {
    // Si revertimos con éxito y existe el lock file de la sesión revertida, lo borramos
    // (test "cerrado" — ya no hay nada que reanudar/reportar).
    if (fs.existsSync(LOCK_FILE)) {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
      if (String(lock.sesion_id) === String(SESION)) {
        fs.unlinkSync(LOCK_FILE);
        const JSONL = 'tests/_stress_progress.jsonl';
        if (fs.existsSync(JSONL)) fs.unlinkSync(JSONL);
        console.log('  🧹 lock + JSONL borrados (test revertido y archivado).');
      }
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
