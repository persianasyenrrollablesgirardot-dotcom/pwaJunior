/**
 * Aplica + verifica los dos fixes:
 *  FIX 1 — resuelve los eventos AMBIGUO salientes con el matcher nuevo (deja de
 *          requerir autor_jid en salientes → se atribuyen a la persona del chat).
 *  FIX 2 — verifica el gate A2_NOCLIENTE en sintetizarPersona (no-cliente → $0).
 *
 * Correr: npx tsx tests/fix_identidad_nocliente.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { IdentidadService } from '../identidad/matcher.js';
import { sintetizarPersona } from '../agentes/sintesis/analistas.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  // ─── FIX 1 ───────────────────────────────────────────────────────────
  const svc = new IdentidadService(sb);
  const { data: amb } = await sb.from('evento_pg').select('*')
    .eq('estado', 'AMBIGUO').eq('tipo_evento', 'mensaje_saliente').is('deleted_at', null);
  console.log(`[FIX 1] AMBIGUO salientes a resolver con el matcher nuevo: ${amb?.length ?? 0}`);
  let resueltos = 0, siguen = 0;
  for (const evt of amb ?? []) {
    try {
      const r = await svc.resolverEvento(evt as any);
      if (r) { await svc.aplicarResolucion(evt.id, r); resueltos++; }
      else siguen++;
    } catch (e: any) { console.error(`  ev${evt.id}: ${e.message}`); siguen++; }
  }
  console.log(`  → resueltos (ahora IDENTIFICADO): ${resueltos} · siguen sin resolver: ${siguen}`);
  const { count: quedan } = await sb.from('evento_pg').select('*', { count: 'exact', head: true })
    .eq('estado', 'AMBIGUO').is('deleted_at', null);
  console.log(`  AMBIGUO TOTAL restantes en el sistema: ${quedan}`);

  // ─── FIX 2 ───────────────────────────────────────────────────────────
  const { data: evs } = await sb.from('evento_pg').select('chat_id, persona_id, payload')
    .eq('agente_origen', 'A2_NOCLIENTE').limit(2000);
  const noCli = (evs ?? []).filter((e: any) => e.payload?.es_cliente === false);
  console.log(`\n[FIX 2] chats marcados no-cliente por A2: ${new Set(noCli.map((e: any) => e.chat_id)).size}`);
  // resolver persona del primer no-cliente
  let personaNoCli: number | null = noCli.find((e: any) => e.persona_id)?.persona_id ?? null;
  const chatNoCli = noCli[0]?.chat_id;
  if (!personaNoCli && chatNoCli) {
    const { data: cl } = await sb.from('chat_checklist').select('persona_id').eq('chat_id', chatNoCli).maybeSingle();
    personaNoCli = cl?.persona_id ?? null;
  }
  if (!personaNoCli) { console.log('  (no pude resolver la persona del no-cliente — gate no verificable acá)'); return; }
  console.log(`  Probando gate en persona #${personaNoCli} (chat ${chatNoCli})…`);
  const r = await sintetizarPersona(sb, personaNoCli);
  console.log(`  sintetizarPersona → ok=${r.ok} fallidos=${r.fallidos} costo=$${r.costo_usd.toFixed(4)}`);
  console.log(r.costo_usd === 0 && r.ok === 0
    ? '  ✅ GATE OK: el no-cliente NO gastó tokens de síntesis'
    : '  ⚠ el gate NO frenó la síntesis — revisar');
}
main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
