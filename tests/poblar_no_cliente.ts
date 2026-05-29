import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { data: tjs } = await sb.from('tarjeta').select('chat_id');
let flagged = 0;
for (const t of (tjs ?? []) as any[]) {
  const { data } = await sb.from('evento_pg').select('payload').eq('agente_origen','A2_NOCLIENTE').eq('chat_id', t.chat_id).order('ts_creado',{ascending:false}).limit(1);
  const p: any = data?.[0]?.payload;
  const esNoCli = !!(p && p.es_cliente === false);
  await sb.from('tarjeta').update({ es_no_cliente: esNoCli, no_cliente_subtipo: esNoCli ? (p.subtipo_no_cliente ?? null) : null }).eq('chat_id', t.chat_id);
  if (esNoCli) { flagged++; console.log(`  no-cliente: chat ${t.chat_id} (${p.subtipo_no_cliente ?? '?'})`); }
}
console.log(`\nTarjetas revisadas: ${tjs?.length} · marcadas no-cliente: ${flagged}`);
