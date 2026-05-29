/** Arregla los nombres feos existentes (status WhatsApp / solo número / jid).
 * Correr: npx tsx tests/arreglar_nombres.ts */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { esNombreFeo, arreglarNombreSiFeo } from '../agentes/sintesis/nombres.js';
const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const { data: pers } = await sb.from('personas').select('id, nombre').is('deleted_at', null);
const feos = (pers ?? []).filter((p: any) => esNombreFeo(p.nombre));
console.log(`Personas con nombre feo: ${feos.length} de ${pers?.length}`);
let cambiados = 0, costo = 0;
for (const p of feos as any[]) {
  const r = await arreglarNombreSiFeo(sb, p.id);
  costo += r.costo_usd;
  if (r.cambiado) { cambiados++; console.log(`  #${p.id}: "${(p.nombre ?? '').slice(0, 35)}" → "${r.nombre}"`); }
}
console.log(`\nArreglados: ${cambiados}/${feos.length} · costo $${costo.toFixed(4)}`);
