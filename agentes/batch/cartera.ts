/**
 * DISPARADOR BATCH de A5_CARTERA (2026-05-30).
 *
 * A5_CARTERA es batch-oriented (no corre por mensaje). Faltaba el orquestador
 * que lo dispare → tenía 0 eventos. Este ciclo:
 *   1. Junta las personas con cotización de saldo > 0 (deuda ≥ MIN_DEUDA).
 *   2. Throttle: salta las ya evaluadas por A5_CARTERA en las últimas RE_EVAL_H horas.
 *   3. Para cada candidata, ejecuta A5_CARTERA (vía runner) anclado al último
 *      evento de la persona. A5_CARTERA decide si propone recordatorio de cobro.
 *
 * Se llama desde el worker con un setInterval LARGO (cartera no es tiempo real).
 * Solo lectura salvo lo que el propio A5_CARTERA escribe (su evento_pg).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { ejecutarAgente, cargarAgenteDefinicion } from '../lib/runner.js';
import { a5CarteraHooks } from '../L5_financiero/a5_cartera.js';

const MIN_DEUDA_COP = 5_000;
const RE_EVAL_H = 20;                 // no re-evaluar una persona si ya corrió hace <20h
const MAX_POR_CICLO = 8;              // tope por corrida (cada uno es 1 llamada LLM)
let enCurso = false;

export async function cicloCartera(sb: SupabaseClient, log: (m: string) => void = () => {}): Promise<number> {
  if (enCurso) return 0;
  enCurso = true;
  try {
    // 1. Personas con saldo pendiente en cotizaciones GANADAS (deuda real;
    //    una propuesta/negociación con total no es cartera cobrable todavía).
    const { data: cots } = await sb.from('cotizaciones')
      .select('persona_id, saldo').eq('estado', 'ganada').gt('saldo', 0).is('deleted_at', null);
    const deudaPorPersona = new Map<number, number>();
    for (const c of (cots ?? []) as any[]) {
      if (c.persona_id != null) deudaPorPersona.set(c.persona_id, (deudaPorPersona.get(c.persona_id) ?? 0) + Number(c.saldo ?? 0));
    }
    const candidatas = [...deudaPorPersona.entries()].filter(([, d]) => d >= MIN_DEUDA_COP).map(([pid]) => pid);
    if (candidatas.length === 0) return 0;

    // 2. Throttle: ya evaluadas por A5_CARTERA hace < RE_EVAL_H horas.
    const desde = new Date(Date.now() - RE_EVAL_H * 3600 * 1000).toISOString();
    const { data: recientes } = await sb.from('evento_pg')
      .select('persona_id').eq('agente_origen', 'A5_CARTERA').neq('confianza', 'RECHAZADO')
      .gte('ts_creado', desde).in('persona_id', candidatas);   // un rechazo no bloquea reintento
    const yaEval = new Set((recientes ?? []).map((e: any) => e.persona_id));
    const pendientes = candidatas.filter(p => !yaEval.has(p)).slice(0, MAX_POR_CICLO);
    if (pendientes.length === 0) return 0;

    // 3. Disparar A5_CARTERA por cada persona, anclado a su último evento.
    const def = await cargarAgenteDefinicion(sb, 'A5_CARTERA');
    let corridos = 0;
    for (const personaId of pendientes) {
      // Anclar a un MENSAJE real (tiene canal_msg_id citable). A5_CARTERA decide
      // sobre la persona, pero el validador exige ≥1 msg_id de evidencia para
      // INFERIDO → debe ser un mensaje que exista en el chat (si no, R-anti-alucinacion).
      const { data: ev } = await sb.from('evento_pg')
        .select('id, chat_id, proyecto_id, canal_msg_id')
        .eq('persona_id', personaId).is('deleted_at', null)
        .in('tipo_evento', ['mensaje_entrante', 'mensaje_saliente'])
        .not('canal_msg_id', 'is', null).not('chat_id', 'is', null)
        .order('ts_creado', { ascending: false }).limit(1).maybeSingle();
      if (!ev?.id || ev.chat_id == null) { log(`persona ${personaId}: sin mensaje ancla citable, skip`); continue; }
      try {
        const r = await ejecutarAgente(
          sb, def,
          { evento_id: ev.id, chat_id: ev.chat_id, persona_id: personaId, proyecto_id: ev.proyecto_id ?? null, ambito: 'comercial' },
          a5CarteraHooks,
          { skipLock: true },
        );
        if (r.ok) {
          corridos++;
          const cand = (r.output?.payload as any)?.es_candidato_recordatorio;
          log(`persona ${personaId} → ${r.output?.confianza}${cand ? ' · 💰 CANDIDATO cobro' : ' · no aplica'}`);
        } else if (r.motivo_skip !== 'lock') {
          log(`persona ${personaId}: ${r.error}`);
        }
      } catch (e: any) { log(`persona ${personaId}: ERROR ${e.message}`); }
    }
    return corridos;
  } finally {
    enCurso = false;
  }
}
