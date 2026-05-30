/**
 * MOTOR DE TARJETAS V2 — reconstruye y PERSISTE una tarjeta + sus 3 derivados.
 *
 * Flujo (ARQUITECTURA_V2.md): resolver persona del chat → AGREGADOR arma la
 * tarjeta → si el input cambió (hash), upsert tarjeta + correr los 3 derivados
 * → upsert en sus tablas. Idempotente: si el hash no cambió, no rehace nada.
 *
 * Los derivados se REGENERAN enteros por chat (borrar+insertar) — son síntesis,
 * no gestión manual. Escriben en SUS tablas, nunca en la tarjeta (sin loops).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';
import { leerInsumosTarjeta, redactarNarrativa, type Tarjeta } from './agregador.js';
import { derivarChecklist, derivarTareas, derivarAgenda } from './derivados.js';
import { arreglarNombreSiFeo } from './nombres.js';

export interface ResultadoReconstruir {
  chat_id: number;
  persona_id: number | null;
  cambio: boolean;
  motivo?: string;
  hash: string;
  estado_conversacion?: string;
  n_tareas?: number;
  n_agenda?: number;
  costo_usd: number;
}

/** chat → persona (via chat_checklist; fallback proyecto). */
async function resolverPersona(sb: SupabaseClient, chatId: number): Promise<number | null> {
  const { data: cl } = await sb.from('chat_checklist').select('persona_id').eq('chat_id', chatId).maybeSingle();
  if (cl?.persona_id) return cl.persona_id as number;
  const { data: ch } = await sb.from('chats').select('proyecto_id').eq('id', chatId).maybeSingle();
  if (ch?.proyecto_id) {
    const { data: pr } = await sb.from('proyectos').select('persona_id').eq('id', ch.proyecto_id).maybeSingle();
    return (pr?.persona_id as number) ?? null;
  }
  return null;
}

/** ¿El nombre de la persona es un placeholder no resuelto? (FASE 9.1 @lid sin metadata). */
function nombreSinIdentificar(nombre: string | null | undefined): boolean {
  const n = (nombre ?? '').trim();
  return n.startsWith('⏳') || /^identificando/i.test(n);
}

/** ¿No es cliente real?
 *  - Verdicto explícito de A2_NOCLIENTE (es_cliente=false), o
 *  - Placeholder '⏳ Identificando…' (FASE 9.1): son jids @lid huérfanos
 *    sin nombre humano. WA Web no los resolvió, probablemente porque no
 *    están en la libreta. Los marcamos no-cliente automáticamente para
 *    que no contaminen el índice de Junior ni el listado comercial. */
async function verdictoNoCliente(sb: SupabaseClient, chatId: number, personaId: number | null): Promise<{ esNoCliente: boolean; subtipo: string | null }> {
  const { data } = await sb.from('evento_pg')
    .select('payload').eq('agente_origen', 'A2_NOCLIENTE').eq('chat_id', chatId)
    .order('ts_creado', { ascending: false }).limit(1);
  const p: any = data?.[0]?.payload;
  if (p && p.es_cliente === false) return { esNoCliente: true, subtipo: p.subtipo_no_cliente ?? null };
  if (personaId) {
    const { data: per } = await sb.from('personas').select('nombre').eq('id', personaId).maybeSingle();
    if (nombreSinIdentificar(per?.nombre)) return { esNoCliente: true, subtipo: 'sin_identificar' };
  }
  return { esNoCliente: false, subtipo: null };
}

export async function reconstruirTarjeta(
  sb: SupabaseClient, chatId: number, opts: { forzar?: boolean } = {},
): Promise<ResultadoReconstruir> {
  const personaId = await resolverPersona(sb, chatId);
  if (!personaId) {
    return { chat_id: chatId, persona_id: null, cambio: false, motivo: 'chat sin persona resoluble', hash: '', costo_usd: 0 };
  }
  const noCli = await verdictoNoCliente(sb, chatId, personaId);
  // Si el contacto quedó con nombre feo (status de WhatsApp / solo número),
  // intentar extraer un nombre útil de la conversación. Se auto-resuelve: una
  // vez con nombre bueno, no se vuelve a intentar.
  await arreglarNombreSiFeo(sb, personaId).catch(() => {});

  // 1) Leer insumos SIN LLM y calcular el hash del input (hechos + notas + tipo).
  const ins = await leerInsumosTarjeta(sb, personaId);
  const inputHash = crypto.createHash('sha1')
    .update(JSON.stringify({ c: ins.contexto_estructurado, n: ins.notas, tipo: ins.tipo_contacto }))
    .digest('hex');

  const { data: previa } = await sb.from('tarjeta').select('input_hash').eq('chat_id', chatId).maybeSingle();
  const ahora = new Date().toISOString();

  // 2) Si el input no cambió → salir SIN gastar LLM (idempotencia real).
  if (!opts.forzar && previa?.input_hash === inputHash) {
    // Aunque la tarjeta no cambie, el veredicto de no-cliente puede haber
    // cambiado (A2 corre aparte) → lo refrescamos igual (barato, sin LLM).
    await sb.from('tarjeta').update({
      dirty: false, actualizado_at: ahora,
      es_no_cliente: noCli.esNoCliente, no_cliente_subtipo: noCli.subtipo,
    } as any).eq('chat_id', chatId);
    return { chat_id: chatId, persona_id: personaId, cambio: false, motivo: 'sin cambios (hash igual)', hash: inputHash, costo_usd: 0 };
  }

  // 3) Cambió → recién acá se gasta el LLM en la narrativa.
  const { narrativa, costo_usd: costoNarrativa } = await redactarNarrativa(ins);
  const t: Tarjeta = { ...ins, narrativa, costo_usd: costoNarrativa };

  // Persistir tarjeta
  await sb.from('tarjeta').upsert({
    chat_id: chatId, persona_id: personaId, tipo_contacto: t.tipo_contacto,
    contexto: t.contexto_estructurado, notas: t.notas, narrativa: t.narrativa,
    input_hash: inputHash, dirty: false, costo_usd: t.costo_usd,
    es_no_cliente: noCli.esNoCliente, no_cliente_subtipo: noCli.subtipo,
    generado_at: ahora, actualizado_at: ahora,
  } as any);

  // Derivados: leen la tarjeta `t`, escriben en sus tablas (regeneración entera).
  const [chk, tar, age] = await Promise.all([derivarChecklist(t), derivarTareas(t), derivarAgenda(t)]);

  await sb.from('tarjeta_checklist').upsert({
    chat_id: chatId, estado_conversacion: chk.estado_conversacion,
    proximo_paso: chk.proximo_paso, derivado_de_hash: inputHash, actualizado_at: ahora,
  } as any);

  await sb.from('tarjeta_tarea').delete().eq('chat_id', chatId);
  if (tar.tareas.length) {
    await sb.from('tarjeta_tarea').insert(tar.tareas.map(x => ({
      chat_id: chatId, titulo: x.titulo, prioridad: x.prioridad, derivado_de_hash: inputHash,
    })) as any);
  }

  await sb.from('tarjeta_agenda').delete().eq('chat_id', chatId);
  // Dedup por (fecha/'por coordinar', hora, título normalizado) — derivarAgenda
  // a veces emite variaciones del mismo evento.
  const vistosAg = new Set<string>();
  const dedupTarjAg = age.agendamientos.filter(x => {
    const k = `${x.fecha ?? 'tbd'}|${x.hora ?? ''}|${(x.titulo ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30)}`;
    if (vistosAg.has(k)) return false;
    vistosAg.add(k); return true;
  });
  if (dedupTarjAg.length) {
    await sb.from('tarjeta_agenda').insert(dedupTarjAg.map(x => ({
      chat_id: chatId, titulo: x.titulo,
      cuando: x.fecha ? `${x.fecha} ${x.hora}` : 'por coordinar',
      lugar: x.lugar, derivado_de_hash: inputHash,
    })) as any);
  }

  // Calendario: alimentar la tabla canónica `agendamientos` con los que tienen
  // FECHA. origen='agente_v2' → regenero solo lo mío, sin tocar las citas
  // manuales (origen NULL) ni las que Jhon editó (origen='manual_edit').
  //
  // Dedup dentro de la lista del agente + dedup contra manual_edit existentes:
  // si Jhon ya reprogramó una cita (mismo persona + fecha + hora), NO emito otra
  // del agente para no duplicar visualmente.
  await sb.from('agendamientos').delete().eq('persona_id', personaId).eq('origen', 'agente_v2');
  const { data: manuales } = await sb.from('agendamientos')
    .select('fecha, hora_inicio').eq('persona_id', personaId).eq('origen', 'manual_edit');
  const yaManual = new Set((manuales ?? []).map((m: any) => `${m.fecha}|${m.hora_inicio ?? ''}`));
  const conFecha = age.agendamientos.filter(x => x.fecha);
  const vistos = new Set<string>();
  const dedupAge = conFecha.filter(x => {
    if (yaManual.has(`${x.fecha}|${x.hora ?? ''}`)) return false;
    const k = `${x.fecha}|${x.hora ?? ''}|${(x.titulo ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 30)}`;
    if (vistos.has(k)) return false;
    vistos.add(k); return true;
  });
  if (dedupAge.length) {
    await sb.from('agendamientos').insert(dedupAge.map(x => ({
      persona_id: personaId, titulo: x.titulo, tipo: x.tipo, fecha: x.fecha,
      hora_inicio: x.hora, direccion: x.lugar || null, origen: 'agente_v2',
    })) as any);
  }

  return {
    chat_id: chatId, persona_id: personaId, cambio: true, hash: inputHash,
    estado_conversacion: chk.estado_conversacion, n_tareas: tar.tareas.length, n_agenda: age.agendamientos.length,
    costo_usd: t.costo_usd + chk.costo_usd + tar.costo_usd + age.costo_usd,
  };
}

// ─── Ciclo: mantiene las tarjetas al día ─────────────────────────────────────
// Detecta qué tarjetas (re)construir (sin tarjeta / dirty / mensaje nuevo / nota
// nueva), respeta coalescing 30s y un tope por ciclo. Lo usan tanto el worker
// standalone como el worker principal (un cycle más, consistente con el resto).
const COALESCE_MS = 30_000;
const MAX_POR_CICLO = 6;
let cicloEnCurso = false;

export async function cicloTarjetas(sb: SupabaseClient, log: (m: string) => void = () => {}): Promise<number> {
  if (cicloEnCurso) return 0;
  cicloEnCurso = true;
  try {
    const { data: cks } = await sb.from('chat_checklist')
      .select('chat_id, persona_id, ultimo_mensaje_ts').not('persona_id', 'is', null);
    if (!cks?.length) return 0;

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

    // Síntesis más reciente por persona. La tarjeta se arma de modulo_sintesis,
    // que se actualiza DESPUÉS del mensaje. Si la síntesis es más nueva que la
    // tarjeta, hay que rehacer — si no, la tarjeta queda stale (caso Angie: se
    // reconstruyó con síntesis vieja y nunca se re-disparó al actualizarse).
    const { data: sints } = await sb.from('modulo_sintesis')
      .select('persona_id, generado_at').in('persona_id', personaIds);
    const ultimaSintesis = new Map<number, string>();
    for (const s of sints ?? []) {
      const prev = ultimaSintesis.get(s.persona_id);
      if (!prev || (s.generado_at ?? '') > prev) ultimaSintesis.set(s.persona_id, s.generado_at);
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
        const st = ultimaSintesis.get(c.persona_id);
        if (nt && new Date(nt).getTime() > actMs) motivo = 'nota nueva';
        else if (st && new Date(st).getTime() > actMs) motivo = 'síntesis nueva';
      }
      if (!motivo) continue;
      if (tj && ahora - actMs < COALESCE_MS) continue;       // coalescing
      candidatos.push({ chat_id: c.chat_id, motivo, nuevo: !tj });
    }
    if (!candidatos.length) return 0;

    candidatos.sort((a, b) => (b.nuevo ? 1 : 0) - (a.nuevo ? 1 : 0));  // backfill primero
    const lote = candidatos.slice(0, MAX_POR_CICLO);
    for (const x of lote) {
      try {
        const r = await reconstruirTarjeta(sb, x.chat_id);
        if (r.cambio) log(`chat ${x.chat_id} (${x.motivo}) → ${r.estado_conversacion} · ${r.n_tareas}t · ${r.n_agenda}a · $${r.costo_usd.toFixed(4)}`);
      } catch (e: any) { log(`chat ${x.chat_id}: ERROR ${e.message}`); }
    }
    return lote.length;
  } finally {
    cicloEnCurso = false;
  }
}
