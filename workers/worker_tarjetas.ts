/**
 * WORKER DE TARJETAS V2 — mantiene las tarjetas al día.
 *
 * Cada ciclo detecta qué tarjetas hay que (re)construir:
 *   · sin tarjeta todavía          → backfill (construcción inicial)
 *   · dirty=true                   → marcada por la UI al agregar una nota
 *   · mensaje nuevo                → chat_checklist.ultimo_mensaje_ts > tarjeta.actualizado_at
 *   · nota nueva                   → notas_libres.ts_creado > tarjeta.actualizado_at
 * y llama al motor (reconstruirTarjeta), que es idempotente por hash: si el
 * input no cambió, no gasta LLM.
 *
 * Coalescing: una tarjeta no se rehace si se actualizó hace <30s (evita
 * thrashing en ráfagas). Tope por ciclo para no quemar todo de golpe.
 *
 * Aislado: corre como proceso aparte, NO toca el worker principal.
 * Correr: npx tsx workers/worker_tarjetas.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { reconstruirTarjeta } from '../agentes/sintesis/tarjeta_engine.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const POLL_MS = 8000;
const COALESCE_MS = 30_000;
const MAX_POR_CICLO = 6;
const ts = () => new Date().toLocaleTimeString('es-CO');

let enCurso = false;
async function ciclo(): Promise<void> {
  if (enCurso) return;
  enCurso = true;
  try {
    // Universo de tarjetas = chats con persona conocida (vía chat_checklist).
    const { data: cks } = await sb.from('chat_checklist')
      .select('chat_id, persona_id, ultimo_mensaje_ts').not('persona_id', 'is', null);
    if (!cks?.length) return;

    const { data: tjs } = await sb.from('tarjeta').select('chat_id, actualizado_at, dirty');
    const tjMap = new Map((tjs ?? []).map((t: any) => [t.chat_id, t]));

    const personaIds = [...new Set(cks.map((c: any) => c.persona_id))];
    const { data: notas } = await sb.from('notas_libres')
      .select('persona_id, ts_creado').in('persona_id', personaIds).is('deleted_at', null);
    const ultimaNota = new Map<number, string>();
    for (const n of notas ?? []) {
      const prev = ultimaNota.get(n.persona_id);
      if (!prev || (n.ts_creado ?? '') > prev) ultimaNota.set(n.persona_id, n.ts_creado);
    }

    const ahora = Date.now();
    const candidatos: { chat_id: number; motivo: string; nuevo: boolean }[] = [];
    for (const c of cks) {
      const tj: any = tjMap.get(c.chat_id);
      const actMs = tj?.actualizado_at ? new Date(tj.actualizado_at).getTime() : 0;
      let motivo = '';
      if (!tj) motivo = 'backfill';
      else if (tj.dirty) motivo = 'dirty';
      else if (c.ultimo_mensaje_ts && new Date(c.ultimo_mensaje_ts).getTime() > actMs) motivo = 'mensaje nuevo';
      else {
        const nt = ultimaNota.get(c.persona_id);
        if (nt && new Date(nt).getTime() > actMs) motivo = 'nota nueva';
      }
      if (!motivo) continue;
      // Coalescing (no aplica al backfill, que no tiene actualizado_at).
      if (tj && ahora - actMs < COALESCE_MS) continue;
      candidatos.push({ chat_id: c.chat_id, motivo, nuevo: !tj });
    }
    if (!candidatos.length) return;

    // Backfill primero (para poblar rápido), luego el resto.
    candidatos.sort((a, b) => (b.nuevo ? 1 : 0) - (a.nuevo ? 1 : 0));
    const lote = candidatos.slice(0, MAX_POR_CICLO);
    for (const x of lote) {
      try {
        const r = await reconstruirTarjeta(sb, x.chat_id);
        if (r.cambio) console.log(`[${ts()}] chat ${x.chat_id} (${x.motivo}) → ${r.estado_conversacion} · ${r.n_tareas}t · ${r.n_agenda}a · $${r.costo_usd.toFixed(4)}`);
        else console.log(`[${ts()}] chat ${x.chat_id} (${x.motivo}) → sin cambios ($0)`);
      } catch (e: any) {
        console.error(`[${ts()}] chat ${x.chat_id}: ${e.message}`);
      }
    }
    console.log(`[${ts()}] ciclo: ${lote.length}/${candidatos.length} procesados`);
  } finally {
    enCurso = false;
  }
}

console.log('[TARJETAS] worker V2 arrancando…');
await ciclo();
setInterval(() => { ciclo().catch(e => console.error('[TARJETAS]', e.message)); }, POLL_MS);
