/**
 * HITO 1 — self-test del flujo de ACTUALIZACIÓN: nota nueva → tarjeta se reevalúa.
 * Inserta una nota para Cubides, reconstruye, verifica que la nota entró y la
 * narrativa cambió. Limpia la nota al final (hard-delete) y refresca.
 * Correr: npx tsx tests/hito1_actualizar_nota.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { reconstruirTarjeta } from '../agentes/sintesis/tarjeta_engine.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
let fallos = 0;
const ok = (c: boolean, m: string) => { console.log(`  ${c ? '✓' : '❌'} ${m}`); if (!c) fallos++; };
const NOTA = `TEST_NOTA_${Date.now()}: el cliente ya validó la medida y pagó el saldo completo, caso listo para instalar`;
let notaId: number | null = null;
let personaId: number | null = null;

async function leerTarjeta(chatId: number) {
  const { data } = await sb.from('tarjeta').select('narrativa, notas, input_hash').eq('chat_id', chatId).maybeSingle();
  return data as any;
}

async function main() {
  const { data: ps } = await sb.from('personas').select('id').ilike('nombre', '%Cubides%').is('deleted_at', null);
  personaId = ps?.[0]?.id;
  const { data: cl } = await sb.from('chat_checklist').select('chat_id').eq('persona_id', personaId).maybeSingle();
  const chatId = cl?.chat_id;
  if (!chatId) { console.error('No resolví el chat de Cubides'); process.exit(1); }

  console.log('[1] Baseline (reconstruir forzado)…');
  await reconstruirTarjeta(sb, chatId, { forzar: true });
  const antes = await leerTarjeta(chatId);
  console.log(`    notas antes: ${antes.notas.length} · hash ${antes.input_hash.slice(0, 8)}`);

  console.log('\n[2] Insertando nota nueva (simula la UI) + marcando dirty…');
  const { data: ins } = await sb.from('notas_libres')
    .insert({ persona_id: personaId, contenido: NOTA, visible_para: ['todos'], creado_por: 1 } as any)
    .select('id').single();
  notaId = ins!.id;
  await sb.from('tarjeta').update({ dirty: true }).eq('chat_id', chatId);
  console.log(`    nota #${notaId} insertada`);

  console.log('\n[3] Reconstruyendo (la nota cambió el input)…');
  const r = await reconstruirTarjeta(sb, chatId);
  const despues = await leerTarjeta(chatId);
  console.log(`    cambio=${r.cambio} · notas después: ${despues.notas.length} · hash ${despues.input_hash.slice(0, 8)}`);

  console.log('\n[4] Verificaciones:');
  ok(r.cambio === true, 'la tarjeta se reevaluó (hubo cambio)');
  ok(despues.input_hash !== antes.input_hash, 'el input_hash cambió (detectó info nueva)');
  ok((despues.notas as string[]).some(n => n.includes('TEST_NOTA_')), 'la nota nueva aparece en la tarjeta');
  ok(despues.narrativa !== antes.narrativa, 'la narrativa se regeneró');

  console.log('\n[5] Limpieza (borrar nota + refrescar)…');
  await sb.from('notas_libres').delete().eq('id', notaId);
  await reconstruirTarjeta(sb, chatId, { forzar: true });
  const final = await leerTarjeta(chatId);
  ok(!(final.notas as string[]).some(n => n.includes('TEST_NOTA_')), 'la nota de prueba quedó removida de la tarjeta');

  console.log(`\n${fallos === 0 ? '✅ SELF-TEST OK — la actualización con info nueva funciona' : `❌ ${fallos} fallos`}`);
  process.exit(fallos === 0 ? 0 : 1);
}

main().catch(async e => {
  console.error('FATAL:', e.message);
  if (notaId) await sb.from('notas_libres').delete().eq('id', notaId);
  process.exit(1);
});
