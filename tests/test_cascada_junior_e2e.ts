/**
 * Test E2E de la cascada de cierre VÍA JUNIOR (camino real con LLM).
 *
 * Diferencia con test_cascada_e2e.ts: aquel llama cascadaCierreChecklist()
 * directamente (mecánica pura, sin LLM). ESTE prueba lo único que aquel no
 * cubre: que JUNIOR, ante un mensaje en lenguaje natural ("cerrá el caso de
 * X"), EMITA cierresChecklist apuntando al chat correcto — y que la cascada
 * corra sobre ese cierre.
 *
 * FIXTURE AISLADO — cero riesgo a datos reales:
 *   · Crea persona + chat + checklist + 3 tareas + 2 agendamientos de prueba.
 *   · Llama responderJunior() real (1 invocación LLM, ~$0.01).
 *   · SEGURIDAD: corre cascadaCierreChecklist SOLO para el chat del fixture.
 *     Si Junior emitiera un cierre para un chat REAL (alucinación), se reporta
 *     como hallazgo pero NO se ejecuta — no se toca ningún dato real.
 *   · Hard-delete del fixture al final (y en catch defensivo).
 *
 * Correr: npx tsx tests/test_cascada_junior_e2e.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { responderJunior } from '../agentes/sintesis/junior_chat.js';
import { cascadaCierreChecklist } from '../agentes/sintesis/cascada.js';

const env = createClient(
  process.env.VITE_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const sb = env;

const SUFIJO = `JUNIOR_CASCADA_${Date.now()}`;
const NOMBRE = `Cliente Demo Cascada QA ${SUFIJO}`;
let personaId: number | null = null;
let chatId: number | null = null;
let sesionId: number | null = null;

function check(cond: boolean, msg: string) {
  console.log(`  ${cond ? '✓' : '❌ FALLÓ:'} ${msg}`);
  if (!cond) process.exitCode = 1;
}

async function limpiar() {
  if (personaId) {
    await sb.from('tareas').delete().eq('persona_id', personaId);
    await sb.from('agendamientos').delete().eq('persona_id', personaId);
  }
  if (chatId) {
    await sb.from('chat_checklist').delete().eq('chat_id', chatId);
    await sb.from('chats').delete().eq('id', chatId);
  }
  if (personaId) await sb.from('personas').delete().eq('id', personaId);
  if (sesionId) {
    await sb.from('junior_chat').delete().eq('sesion_id', sesionId);
    await sb.from('junior_sesiones').delete().eq('id', sesionId);
  }
}

async function main() {
  console.log('═'.repeat(68));
  console.log('  TEST E2E — CASCADA DE CIERRE VÍA JUNIOR (camino real con LLM)');
  console.log('═'.repeat(68));

  // ─── SETUP ───────────────────────────────────────────────────────────
  console.log('\n[1] Creando fixture aislado…');
  const { data: persona, error: ep } = await sb.from('personas')
    .insert({ nombre: NOMBRE, ambito_principal: 'comercial' } as any)
    .select('id').single();
  if (ep) throw new Error('crear persona: ' + ep.message);
  personaId = persona.id;

  const { data: chat, error: ec } = await sb.from('chats')
    .insert({ canal: 'whatsapp', canal_chat_id: SUFIJO, tipo: 'individual', ambito: 'comercial' } as any)
    .select('id').single();
  if (ec) throw new Error('crear chat: ' + ec.message);
  chatId = chat.id;

  await sb.from('chat_checklist').insert({
    chat_id: chatId, persona_id: personaId, tipo: 'venta', estado: 'te_toca',
    proximo_paso: 'Confirmar instalación y cobro', pasos: [], compromisos: [],
  } as any);

  await sb.from('tareas').insert([
    { persona_id: personaId, titulo: `T1 cobrar saldo (${SUFIJO})`, tipo: 'confirmar_pago', completada: false, origen: 'manual' },
    { persona_id: personaId, titulo: `T2 llamar cliente (${SUFIJO})`, tipo: 'llamar', completada: false, origen: 'manual' },
    { persona_id: personaId, titulo: `T3 pedir reseña (${SUFIJO})`, tipo: 'pedir_resena', completada: false, origen: 'manual' },
  ] as any);

  const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const enUnaSemana = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await sb.from('agendamientos').insert([
    { persona_id: personaId, titulo: `A1 visita (${SUFIJO})`, tipo: 'visita_medidas', fecha: manana, hora_inicio: '10:00' },
    { persona_id: personaId, titulo: `A2 instalación (${SUFIJO})`, tipo: 'instalacion', fecha: enUnaSemana, hora_inicio: '14:00' },
  ] as any);
  console.log(`    persona #${personaId} "${NOMBRE}"`);
  console.log(`    chat #${chatId} · checklist abierto · 3 tareas · 2 agendamientos`);

  const { data: ses } = await sb.from('junior_sesiones')
    .insert({ titulo: `TEST CASCADA JUNIOR ${SUFIJO}` } as any).select('id').single();
  sesionId = ses!.id;
  console.log(`    sesión Junior s${sesionId}`);

  // ─── PEDIRLE A JUNIOR QUE CIERRE EL CASO (LLM real) ──────────────────
  const pregunta = `cerrá el caso de ${NOMBRE} — ya pagó el saldo completo, la instalación quedó completada y el cliente está satisfecho. Caso terminado.`;
  console.log('\n[2] Llamando a responderJunior() — LLM real (1 invocación)…');
  console.log(`    mensaje: "${pregunta}"`);
  const r = await responderJunior(sb, pregunta, [], sesionId!);
  console.log(`    ok=${r.ok} · costo=$${Number(r.costo_usd).toFixed(4)}`);
  console.log(`    cierresChecklist emitidos: ${JSON.stringify(r.cierresChecklist)}`);
  console.log(`    tareasCompletar emitidos:  ${JSON.stringify(r.tareasCompletar)}`);
  console.log(`    agendamientosCancelar:     ${JSON.stringify(r.agendamientosCancelar)}`);
  console.log(`    respuesta de Junior: "${(r.respuesta ?? '').slice(0, 240)}"`);

  // ─── SEGURIDAD: separar el cierre del fixture de cualquier chat ajeno ─
  const cierresFixture = (r.cierresChecklist ?? []).filter(c => c.chat_id === chatId);
  const cierresAjenos = (r.cierresChecklist ?? []).filter(c => c.chat_id !== chatId);
  if (cierresAjenos.length > 0) {
    console.log(`\n  ⚠ Junior emitió cierre(s) para chat(s) AJENO(s) al fixture: ${cierresAjenos.map(c => c.chat_id).join(', ')}`);
    console.log(`    → NO se ejecutan (protección de datos reales). Esto sería una alucinación a revisar.`);
  }

  // ─── EJECUTAR CASCADA SOLO SOBRE EL FIXTURE (réplica del worker) ──────
  console.log('\n[3] Ejecutando cascada SOLO sobre el chat del fixture…');
  let resCascada = null;
  for (const cc of cierresFixture) {
    resCascada = await cascadaCierreChecklist(sb, cc.chat_id, cc.motivo ?? '');
    console.log(`    cascada chat ${cc.chat_id}: ok=${resCascada.ok} · tareas=[${resCascada.tareasCompletadas.join(',')}] · agend=[${resCascada.agendamientosCancelados.join(',')}]`);
  }

  // ─── SNAPSHOT DESPUÉS ────────────────────────────────────────────────
  console.log('\n[4] Estado del fixture DESPUÉS:');
  const despT = await sb.from('tareas').select('id', { count: 'exact', head: true }).eq('persona_id', personaId).eq('completada', false).is('deleted_at', null);
  const despA = await sb.from('agendamientos').select('id', { count: 'exact', head: true }).eq('persona_id', personaId).is('deleted_at', null);
  const despCl = await sb.from('chat_checklist').select('cerrado_manual, estado').eq('chat_id', chatId).single();
  console.log(`    tareas activas: ${despT.count} · agendamientos activos: ${despA.count} · checklist cerrado_manual: ${despCl.data?.cerrado_manual}`);

  // ─── VERIFICACIONES ──────────────────────────────────────────────────
  console.log('\n[5] Verificaciones:');
  check(r.ok === true, 'Junior respondió ok=true (JSON válido)');
  check((r.respuesta ?? '').trim().length > 0, 'Junior dio una respuesta no vacía');
  check(cierresFixture.length > 0, `Junior EMITIÓ cierresChecklist para el chat del fixture (#${chatId})`);
  check(cierresAjenos.length === 0, 'Junior NO emitió cierres para chats ajenos (sin alucinación)');
  if (cierresFixture.length > 0) {
    check(resCascada?.ok === true, 'la cascada corrió ok sobre el fixture');
    check((resCascada?.tareasCompletadas.length ?? 0) === 3, `la cascada completó las 3 tareas (completó ${resCascada?.tareasCompletadas.length ?? 0})`);
    check((resCascada?.agendamientosCancelados.length ?? 0) === 2, `la cascada canceló los 2 agendamientos (canceló ${resCascada?.agendamientosCancelados.length ?? 0})`);
    check(despT.count === 0, `0 tareas activas DESPUÉS (quedaron ${despT.count})`);
    check(despA.count === 0, `0 agendamientos activos DESPUÉS (quedaron ${despA.count})`);
    check(despCl.data?.cerrado_manual === true, 'checklist del fixture quedó cerrado_manual=true');
  } else {
    console.log('    (Junior no emitió el cierre del fixture — no se evalúa la cascada. Ver respuesta arriba.)');
  }

  // ─── CLEANUP ─────────────────────────────────────────────────────────
  console.log('\n[6] Limpiando fixture (hard-delete)…');
  await limpiar();
  console.log('    limpio.');

  console.log('\n' + '═'.repeat(68));
  console.log(process.exitCode === 1 ? '  ❌ TEST FALLÓ — ver arriba' : '  ✅ TEST PASÓ — Junior emite el cierre y la cascada corre end-to-end');
  console.log('═'.repeat(68));
}

main().catch(async (e) => {
  console.error('\nFATAL:', e.message);
  await limpiar();
  process.exit(1);
});
