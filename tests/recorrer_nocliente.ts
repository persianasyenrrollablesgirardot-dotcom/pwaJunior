/**
 * Re-corre A2_NOCLIENTE sobre chats existentes con el detector nuevo (colaborador).
 * Usa ejecutarAgente con skipLock=true → no toca el lock/intentos del evento fuente,
 * solo escribe un nuevo veredicto evento_pg (agente_origen=A2_NOCLIENTE). Luego
 * sincroniza tarjeta.es_no_cliente para que el efecto sea inmediato.
 *
 * Correr:  npx tsx tests/recorrer_nocliente.ts [chatId ...]
 *   sin args → todos los chats con tarjeta que hoy están es_no_cliente=false.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { ejecutarAgente, cargarAgenteDefinicion } from '../agentes/lib/runner.js';
import { a2NoClienteHooks } from '../agentes/L2_routing/a2_nocliente.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const argChats = process.argv.slice(2).map(Number).filter(n => Number.isInteger(n));

const agente = await cargarAgenteDefinicion(sb, 'A2_NOCLIENTE');

let chatIds: number[];
if (argChats.length) {
  chatIds = argChats;
} else {
  const { data: tjs } = await sb.from('tarjeta').select('chat_id').eq('es_no_cliente', false);
  chatIds = (tjs ?? []).map((t: any) => t.chat_id);
}
console.log(`A2_NOCLIENTE re-run sobre ${chatIds.length} chat(s)\n`);

let flagged = 0, costo = 0, errores = 0;
for (const chatId of chatIds) {
  // último evento con persona resuelta para este chat
  const { data: evt } = await sb.from('evento_pg')
    .select('id, chat_id, persona_id, proyecto_id, ambito')
    .eq('chat_id', chatId).not('persona_id', 'is', null)
    .order('id', { ascending: false }).limit(1).maybeSingle();
  if (!evt) { console.log(`  chat ${chatId}: sin evento con persona — skip`); continue; }

  try {
    const r = await ejecutarAgente(sb, agente, {
      evento_id: evt.id, chat_id: evt.chat_id!, persona_id: evt.persona_id!,
      proyecto_id: evt.proyecto_id, ambito: evt.ambito,
    }, a2NoClienteHooks, { skipLock: true });
    costo += r.costo_usd;
    const p: any = r.output?.payload;
    const esNoCli = !!(p && p.es_cliente === false);
    // sincronizar tarjeta de inmediato
    await sb.from('tarjeta').update({
      es_no_cliente: esNoCli, no_cliente_subtipo: esNoCli ? (p.subtipo_no_cliente ?? null) : null,
    }).eq('chat_id', chatId);
    if (esNoCli) { flagged++; console.log(`  chat ${chatId} → NO-CLIENTE (${p.subtipo_no_cliente}) · ${(p.señales ?? []).slice(0,2).join('; ')}`); }
    else if (!r.ok) { errores++; console.log(`  chat ${chatId}: ${r.error}`); }
  } catch (e: any) { errores++; console.log(`  chat ${chatId}: ERROR ${e.message}`); }
}
console.log(`\nMarcados no-cliente: ${flagged} · errores: ${errores} · costo $${costo.toFixed(4)}`);
