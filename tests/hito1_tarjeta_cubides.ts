/**
 * HITO 1 — construye y MUESTRA la tarjeta real de Pedidos Cubides.
 * No persiste nada: solo arma la tarjeta con datos reales para que Jhon la
 * valide. Corre el agregador real (pasa por DeepSeek — regla: test por LLM real).
 *
 * Correr: npx tsx tests/hito1_tarjeta_cubides.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { construirTarjeta } from '../agentes/sintesis/agregador.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // Buscar a Pedidos Cubides por nombre (robusto ante cambios de id)
  const { data: ps } = await sb.from('personas')
    .select('id, nombre').ilike('nombre', '%Cubides%').is('deleted_at', null);
  if (!ps || ps.length === 0) { console.error('No encontré a Pedidos Cubides.'); process.exit(1); }
  const persona = ps[0];
  console.log(`\nConstruyendo tarjeta real de "${persona.nombre}" (#${persona.id})…\n`);

  const t = await construirTarjeta(sb, persona.id);

  const L = '═'.repeat(70);
  console.log(L);
  console.log(`  TARJETA — ${t.nombre}   [tipo_contacto: ${t.tipo_contacto}]`);
  console.log(L);

  console.log(`\n🧠 ESTADO GENERAL (narrativa del agregador · LLM):\n`);
  console.log('   ' + t.narrativa.replace(/\n/g, '\n   '));

  console.log(`\n📝 NOTAS DE JHON (verdad prioritaria): ${t.notas.length}`);
  for (const n of t.notas) console.log(`   • ${n}`);

  console.log(`\n🗂  CONTEXTO ESTRUCTURADO (${t.contexto_estructurado.length} módulos · verbatim de los 32 agentes):`);
  if (t.contexto_estructurado.length === 0) console.log('   (todavía no hay síntesis por módulo para este cliente)');
  for (const c of t.contexto_estructurado) {
    console.log(`\n   ── ${c.modulo.toUpperCase()} · ${c.titulo}${c.alerta ? `   ⚠ ${c.alerta}` : ''}`);
    console.log('   ' + (c.sintesis ?? '').replace(/\n/g, '\n   '));
  }

  console.log(`\n${L}`);
  console.log(`  Costo de armar esta tarjeta: $${t.costo_usd.toFixed(4)} USD`);
  console.log(L);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
