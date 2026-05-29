/**
 * Re-corre A2_AMBITO sobre chats que hoy están `ambito='comercial'` y NO están
 * confirmados por Jhon, para detectar proveedor / personal / interno_equipo que
 * estén mal clasificados (caso Santiago). El postProcesar del agente aplica
 * directo a chats + personas + tarjeta (sin buzón).
 *
 * Correr:  npx tsx tests/recorrer_ambito.ts [chatId ...]
 *   sin args → todos los chats comercial no confirmados con persona resuelta.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { ejecutarAgente, cargarAgenteDefinicion } from '../agentes/lib/runner.js';
import { a2AmbitoHooks } from '../agentes/L2_routing/a2_ambito.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const argChats = process.argv.slice(2).map(Number).filter(n => Number.isInteger(n));

const agente = await cargarAgenteDefinicion(sb, 'A2_AMBITO');

let chatIds: number[];
if (argChats.length) {
  chatIds = argChats;
} else {
  const { data } = await sb.from('chats').select('id').eq('ambito','comercial').eq('ambito_confirmado', false).is('deleted_at', null);
  chatIds = (data ?? []).map((c: any) => c.id);
}
console.log(`A2_AMBITO re-run sobre ${chatIds.length} chat(s)\n`);

let reclasificados = 0, errores = 0, costo = 0;
const desglose: Record<string, number> = {};
for (const chatId of chatIds) {
  const { data: evt } = await sb.from('evento_pg')
    .select('id, chat_id, persona_id, proyecto_id, ambito')
    .eq('chat_id', chatId).not('persona_id', 'is', null)
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (!evt) { continue; }

  try {
    const r = await ejecutarAgente(sb, agente, {
      evento_id: evt.id, chat_id: evt.chat_id!, persona_id: evt.persona_id!,
      proyecto_id: evt.proyecto_id, ambito: evt.ambito,
    }, a2AmbitoHooks, { skipLock: true });
    costo += r.costo_usd;
    const p: any = r.output?.payload;
    if (p?.cambio_propuesto && p?.confianza_ambito !== 'DUDOSO') {
      reclasificados++;
      const k = p.ambito_propuesto as string;
      desglose[k] = (desglose[k] ?? 0) + 1;
      console.log(`  chat ${chatId} → ${k} (${p.confianza_ambito}) · ${(p.señales ?? []).slice(0,2).join('; ')}`);
    } else if (!r.ok) {
      errores++;
    }
  } catch (e: any) { errores++; }
}
console.log(`\nReclasificados: ${reclasificados} · errores: ${errores} · costo $${costo.toFixed(4)}`);
console.log('Desglose por ámbito nuevo:', JSON.stringify(desglose));
