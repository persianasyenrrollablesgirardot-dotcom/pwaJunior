/**
 * Re-deriva TODAS las tarjetas con el código nuevo (forzar) para poblar
 * agendamientos (calendario) con fechas estructuradas. Uso único tras cambiar
 * el agente de agenda. Correr: npx tsx tests/rederivar_todas.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { reconstruirTarjeta } from '../agentes/sintesis/tarjeta_engine.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data: tjs } = await sb.from('tarjeta').select('chat_id');
  const chatIds = (tjs ?? []).map((t: any) => t.chat_id);
  console.log(`Re-derivando ${chatIds.length} tarjetas (forzar)…`);
  let conAgenda = 0, costo = 0, i = 0;
  for (const chatId of chatIds) {
    i++;
    try {
      const r = await reconstruirTarjeta(sb, chatId, { forzar: true });
      costo += r.costo_usd;
      if ((r.n_agenda ?? 0) > 0) { conAgenda++; }
      if (i % 10 === 0) console.log(`  ${i}/${chatIds.length}… ($${costo.toFixed(3)})`);
    } catch (e: any) { console.error(`  chat ${chatId}: ${e.message}`); }
  }
  const { count: agV2 } = await sb.from('agendamientos').select('*', { count: 'exact', head: true })
    .eq('origen', 'agente_v2').is('deleted_at', null);
  console.log(`\nListo. Tarjetas con agenda: ${conAgenda} · agendamientos V2 en el calendario: ${agV2} · costo $${costo.toFixed(4)}`);
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
