/**
 * HITO 1 — demuestra el FLUJO sobre Pedidos Cubides real:
 *   tarjeta (agregador) → los 3 agentes derivados leen ESA tarjeta y producen su salida.
 *
 * Foco (feedback_v2_prioridad_mecanica): que el flujo FUNCIONE y los 3 agentes
 * cumplan su módulo. No se persiste nada todavía.
 *
 * Correr: npx tsx tests/hito1_flujo_cubides.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { construirTarjeta } from '../agentes/sintesis/agregador.js';
import { derivarChecklist, derivarTareas, derivarAgenda } from '../agentes/sintesis/derivados.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const L = '═'.repeat(70);

async function main() {
  const { data: ps } = await sb.from('personas').select('id, nombre').ilike('nombre', '%Cubides%').is('deleted_at', null);
  if (!ps?.length) { console.error('No encontré a Pedidos Cubides.'); process.exit(1); }
  const persona = ps[0];

  console.log(`\n[1] AGREGADOR → arma la tarjeta de "${persona.nombre}" (#${persona.id})…`);
  const t = await construirTarjeta(sb, persona.id);
  console.log(`    ✓ tarjeta lista · ${t.contexto_estructurado.length} módulos · ${t.notas.length} notas`);

  console.log(`\n[2] Los 3 agentes derivados leen ESA tarjeta (en paralelo)…`);
  const [chk, tar, age] = await Promise.all([
    derivarChecklist(t), derivarTareas(t), derivarAgenda(t),
  ]);

  console.log(`\n${L}`);
  console.log(`  TARJETA: ${t.nombre}  ·  estado general:`);
  console.log(L);
  console.log('  ' + t.narrativa.replace(/\n/g, '\n  '));

  console.log(`\n  ✅ CHECKLIST (agente derivado)`);
  console.log(`     estado: ${chk.estado_conversacion}`);
  console.log(`     próximo paso: ${chk.proximo_paso}`);

  console.log(`\n  📋 TAREAS (agente derivado): ${tar.tareas.length}`);
  for (const x of tar.tareas) console.log(`     ${x.prioridad === 1 ? '🔴' : x.prioridad === 2 ? '🟡' : '⚪'} ${x.titulo}`);
  if (!tar.tareas.length) console.log('     (ninguna)');

  console.log(`\n  📅 AGENDAMIENTO (agente derivado): ${age.agendamientos.length}`);
  for (const x of age.agendamientos) console.log(`     • ${x.titulo} — ${x.fecha ? `${x.fecha} ${x.hora}` : 'por coordinar'}${x.lugar ? ' · ' + x.lugar : ''}`);
  if (!age.agendamientos.length) console.log('     (nada concreto que agendar)');

  const total = t.costo_usd + chk.costo_usd + tar.costo_usd + age.costo_usd;
  console.log(`\n${L}`);
  console.log(`  Costo total del flujo (agregador + 3 derivados): $${total.toFixed(4)} USD`);
  console.log(L);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
