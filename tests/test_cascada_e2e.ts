/**
 * Test E2E DETERMINÍSTICO de la cascada de cierre de checklist.
 *
 * No usa el LLM. Crea un escenario controlado (persona + chat + checklist +
 * tareas + agendamientos), llama EXACTAMENTE la misma función que usa el worker
 * (cascadaCierreChecklist) y verifica el estado ANTES/DESPUÉS. Limpia todo al
 * final (hard-delete de los registros de prueba).
 *
 * Correr: npx tsx tests/test_cascada_e2e.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import { cascadaCierreChecklist } from '../agentes/sintesis/cascada.js';

const env = Object.fromEntries(fs.readFileSync('./.env', 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

const SUFIJO = `E2E_CASCADA_${Date.now()}`;
let personaId: number | null = null;
let chatId: number | null = null;

function check(cond: boolean, msg: string) {
  console.log(`  ${cond ? '✓' : '❌ FALLÓ:'} ${msg}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log('═'.repeat(64));
  console.log('  TEST E2E — CASCADA DE CIERRE DE CHECKLIST');
  console.log('═'.repeat(64));

  // ─── SETUP ───────────────────────────────────────────────────────────
  console.log('\n[1] Creando escenario de prueba…');
  const { data: persona, error: ep } = await sb.from('personas')
    .insert({ nombre: `CASCADA_TEST (${SUFIJO})`, ambito_principal: 'comercial' } as any)
    .select('id').single();
  if (ep) throw new Error('crear persona: ' + ep.message);
  personaId = persona.id;
  console.log(`    persona #${personaId}`);

  const { data: chat, error: ec } = await sb.from('chats')
    .insert({ canal: 'whatsapp', canal_chat_id: SUFIJO, tipo: 'individual', ambito: 'comercial' } as any)
    .select('id').single();
  if (ec) throw new Error('crear chat: ' + ec.message);
  chatId = chat.id;
  console.log(`    chat #${chatId}`);

  await sb.from('chat_checklist').insert({
    chat_id: chatId, persona_id: personaId, tipo: 'venta', estado: 'te_toca',
    proximo_paso: 'Confirmar instalación', pasos: [], compromisos: [],
  } as any);
  console.log(`    checklist abierto (estado=te_toca)`);

  // 3 tareas activas
  await sb.from('tareas').insert([
    { persona_id: personaId, titulo: `T1 cobrar saldo (${SUFIJO})`, tipo: 'confirmar_pago', completada: false, origen: 'manual' },
    { persona_id: personaId, titulo: `T2 llamar cliente (${SUFIJO})`, tipo: 'llamar', completada: false, origen: 'manual' },
    { persona_id: personaId, titulo: `T3 enviar reseña (${SUFIJO})`, tipo: 'pedir_resena', completada: false, origen: 'manual' },
  ] as any);
  console.log(`    3 tareas activas creadas`);

  // 2 agendamientos futuros
  const manana = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const enUnaSemana = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  await sb.from('agendamientos').insert([
    { persona_id: personaId, titulo: `A1 visita medidas (${SUFIJO})`, tipo: 'visita_medidas', fecha: manana, hora_inicio: '10:00' },
    { persona_id: personaId, titulo: `A2 instalación (${SUFIJO})`, tipo: 'instalacion', fecha: enUnaSemana, hora_inicio: '14:00' },
  ] as any);
  console.log(`    2 agendamientos futuros creados (${manana}, ${enUnaSemana})`);

  // ─── SNAPSHOT ANTES ──────────────────────────────────────────────────
  console.log('\n[2] Estado ANTES de cerrar el checklist:');
  const antesT = await sb.from('tareas').select('id', { count: 'exact', head: true }).eq('persona_id', personaId).eq('completada', false).is('deleted_at', null);
  const antesA = await sb.from('agendamientos').select('id', { count: 'exact', head: true }).eq('persona_id', personaId).is('deleted_at', null);
  const antesCl = await sb.from('chat_checklist').select('cerrado_manual, estado').eq('chat_id', chatId).single();
  console.log(`    tareas activas: ${antesT.count}`);
  console.log(`    agendamientos futuros activos: ${antesA.count}`);
  console.log(`    checklist cerrado_manual: ${antesCl.data?.cerrado_manual} (estado: ${antesCl.data?.estado})`);

  // ─── EJECUTAR CASCADA (la MISMA función del worker) ──────────────────
  console.log('\n[3] Ejecutando cascadaCierreChecklist() — la MISMA función que usa el worker…');
  const res = await cascadaCierreChecklist(sb, chatId!, 'E2E: instalado y pagado, caso terminado');
  console.log(`    resultado: ok=${res.ok} persona=${res.personaId} tareasCompletadas=[${res.tareasCompletadas.join(',')}] agendamientosCancelados=[${res.agendamientosCancelados.join(',')}]`);

  // ─── SNAPSHOT DESPUÉS ────────────────────────────────────────────────
  console.log('\n[4] Estado DESPUÉS:');
  const despT = await sb.from('tareas').select('id', { count: 'exact', head: true }).eq('persona_id', personaId).eq('completada', false).is('deleted_at', null);
  const despA = await sb.from('agendamientos').select('id', { count: 'exact', head: true }).eq('persona_id', personaId).is('deleted_at', null);
  const despCl = await sb.from('chat_checklist').select('cerrado_manual, estado').eq('chat_id', chatId).single();
  console.log(`    tareas activas: ${despT.count}`);
  console.log(`    agendamientos futuros activos: ${despA.count}`);
  console.log(`    checklist cerrado_manual: ${despCl.data?.cerrado_manual} (estado: ${despCl.data?.estado})`);

  // ─── ASSERTS ─────────────────────────────────────────────────────────
  console.log('\n[5] Verificaciones:');
  check(antesT.count === 3, `había 3 tareas activas ANTES (hubo ${antesT.count})`);
  check(antesA.count === 2, `había 2 agendamientos activos ANTES (hubo ${antesA.count})`);
  check(res.ok === true, 'cascada devolvió ok=true');
  check(res.tareasCompletadas.length === 3, `cascada completó 3 tareas (completó ${res.tareasCompletadas.length})`);
  check(res.agendamientosCancelados.length === 2, `cascada canceló 2 agendamientos (canceló ${res.agendamientosCancelados.length})`);
  check(despT.count === 0, `0 tareas activas DESPUÉS (quedaron ${despT.count})`);
  check(despA.count === 0, `0 agendamientos activos DESPUÉS (quedaron ${despA.count})`);
  check(despCl.data?.cerrado_manual === true, 'checklist quedó cerrado_manual=true');

  // ─── CLEANUP ─────────────────────────────────────────────────────────
  console.log('\n[6] Limpiando datos de prueba (hard-delete)…');
  await sb.from('tareas').delete().eq('persona_id', personaId);
  await sb.from('agendamientos').delete().eq('persona_id', personaId);
  await sb.from('chat_checklist').delete().eq('chat_id', chatId);
  await sb.from('chats').delete().eq('id', chatId);
  await sb.from('personas').delete().eq('id', personaId);
  console.log('    limpio.');

  console.log('\n' + '═'.repeat(64));
  console.log(process.exitCode === 1 ? '  ❌ TEST FALLÓ — ver arriba' : '  ✅ TEST PASÓ — la cascada funciona end-to-end');
  console.log('═'.repeat(64));
}

main().catch(async (e) => {
  console.error('\nFATAL:', e.message);
  // Cleanup defensivo
  if (personaId) {
    await sb.from('tareas').delete().eq('persona_id', personaId);
    await sb.from('agendamientos').delete().eq('persona_id', personaId);
  }
  if (chatId) {
    await sb.from('chat_checklist').delete().eq('chat_id', chatId);
    await sb.from('chats').delete().eq('id', chatId);
  }
  if (personaId) await sb.from('personas').delete().eq('id', personaId);
  process.exit(1);
});
