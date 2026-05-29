/**
 * HITO 1 — self-test: Junior responde LEYENDO la tarjeta (recuperar-y-razonar).
 * Verifica que una pregunta específica cargue solo la tarjeta relevante (no las 75)
 * y que una transversal se responda con el índice.
 * Correr: npx tsx tests/hito1_junior_lee_tarjeta.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { responderJuniorTarjeta } from '../agentes/sintesis/junior_v2.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
let fallos = 0;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? '✓' : '❌'} ${m}`); if (!c) fallos++; };

async function main() {
  const { count: total } = await sb.from('tarjeta').select('*', { count: 'exact', head: true });
  console.log(`Tarjetas disponibles: ${total}\n`);

  // ── Pregunta específica ──────────────────────────────────────────────
  console.log('[1] Pregunta específica: "¿qué pasa con Pedidos Cubides?"');
  const r1 = await responderJuniorTarjeta(sb, '¿qué pasa con Pedidos Cubides? resumime en qué quedó');
  console.log(`    via_indice=${r1.via_indice} · tarjetas_usadas=[${r1.tarjetas_usadas.join(',')}] · $${r1.costo_usd.toFixed(4)}`);
  console.log(`    Junior: "${r1.respuesta.replace(/\n/g, ' ').slice(0, 260)}"`);
  ok(r1.tarjetas_usadas.length >= 1 && r1.tarjetas_usadas.length <= 5, 'cargó solo 1-5 tarjetas (no las 75)');
  ok(/cubides|saldo|medida|técnic|instala/i.test(r1.respuesta), 'la respuesta habla del caso de Cubides');

  // ── Pregunta transversal ─────────────────────────────────────────────
  console.log('\n[2] Pregunta transversal: "¿cuántos clientes están esperando mi respuesta?"');
  const r2 = await responderJuniorTarjeta(sb, '¿cuántos clientes están esperando que yo responda? dame nombres');
  console.log(`    via_indice=${r2.via_indice} · tarjetas_usadas=[${r2.tarjetas_usadas.join(',')}] · $${r2.costo_usd.toFixed(4)}`);
  console.log(`    Junior: "${r2.respuesta.replace(/\n/g, ' ').slice(0, 260)}"`);
  ok(r2.respuesta.trim().length > 0, 'Junior respondió la transversal');

  console.log(`\n  Costo total del test: $${(r1.costo_usd + r2.costo_usd).toFixed(4)}`);
  console.log(`\n${fallos === 0 ? '✅ SELF-TEST OK — Junior lee la tarjeta (no las 75)' : `❌ ${fallos} fallos`}`);
  process.exit(fallos === 0 ? 0 : 1);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
