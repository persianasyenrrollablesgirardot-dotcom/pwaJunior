/**
 * HITO 1 — self-test del motor de tarjetas (persiste + idempotencia).
 * Corre el motor sobre Pedidos Cubides, lee de vuelta las 4 tablas V2 y verifica.
 * Correr: npx tsx tests/hito1_persistir_cubides.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { reconstruirTarjeta } from '../agentes/sintesis/tarjeta_engine.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
let fallos = 0;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? '✓' : '❌'} ${m}`); if (!c) fallos++; };

async function main() {
  const { data: ps } = await sb.from('personas').select('id').ilike('nombre', '%Cubides%').is('deleted_at', null);
  const personaId = ps?.[0]?.id;
  const { data: cl } = await sb.from('chat_checklist').select('chat_id').eq('persona_id', personaId).maybeSingle();
  const chatId = cl?.chat_id;
  if (!chatId) { console.error('No resolví el chat de Cubides'); process.exit(1); }
  console.log(`Cubides: persona #${personaId} · chat #${chatId}\n`);

  console.log('[1] Primera reconstrucción (debe escribir)…');
  const r1 = await reconstruirTarjeta(sb, chatId, { forzar: true });
  console.log(`    cambio=${r1.cambio} · estado=${r1.estado_conversacion} · tareas=${r1.n_tareas} · agenda=${r1.n_agenda} · $${r1.costo_usd.toFixed(4)}`);

  console.log('\n[2] Verificando persistencia en las 4 tablas V2…');
  const { data: tj } = await sb.from('tarjeta').select('*').eq('chat_id', chatId).maybeSingle();
  const { data: chk } = await sb.from('tarjeta_checklist').select('*').eq('chat_id', chatId).maybeSingle();
  const { data: tar } = await sb.from('tarjeta_tarea').select('*').eq('chat_id', chatId);
  const { data: age } = await sb.from('tarjeta_agenda').select('*').eq('chat_id', chatId);
  ok(!!tj, 'tarjeta persistida');
  ok(!!tj?.narrativa && tj.narrativa.length > 20, 'tarjeta tiene narrativa');
  ok(Array.isArray(tj?.contexto) && tj.contexto.length > 0, `tarjeta tiene contexto (${tj?.contexto?.length} módulos)`);
  ok(!!tj?.input_hash, 'tarjeta tiene input_hash');
  ok(tj?.dirty === false, 'tarjeta quedó dirty=false');
  ok(!!chk, `checklist persistido (estado=${chk?.estado_conversacion})`);
  ok(chk?.derivado_de_hash === tj?.input_hash, 'checklist derivado_de_hash coincide con la tarjeta');
  ok(Array.isArray(tar), `tareas persistidas (${tar?.length})`);
  ok(Array.isArray(age), `agenda persistida (${age?.length})`);

  console.log('\n[3] Segunda reconstrucción SIN forzar (debe ser idempotente)…');
  const r2 = await reconstruirTarjeta(sb, chatId);
  ok(r2.cambio === false, `idempotente: no rehizo (motivo: ${r2.motivo})`);
  ok(r2.costo_usd === 0, 'idempotente: costo $0 (no llamó al LLM)');

  console.log(`\n${fallos === 0 ? '✅ SELF-TEST OK' : `❌ ${fallos} fallos`}`);
  process.exit(fallos === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
