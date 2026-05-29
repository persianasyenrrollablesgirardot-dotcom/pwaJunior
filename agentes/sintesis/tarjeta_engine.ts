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

export async function reconstruirTarjeta(
  sb: SupabaseClient, chatId: number, opts: { forzar?: boolean } = {},
): Promise<ResultadoReconstruir> {
  const personaId = await resolverPersona(sb, chatId);
  if (!personaId) {
    return { chat_id: chatId, persona_id: null, cambio: false, motivo: 'chat sin persona resoluble', hash: '', costo_usd: 0 };
  }

  // 1) Leer insumos SIN LLM y calcular el hash del input (hechos + notas + tipo).
  const ins = await leerInsumosTarjeta(sb, personaId);
  const inputHash = crypto.createHash('sha1')
    .update(JSON.stringify({ c: ins.contexto_estructurado, n: ins.notas, tipo: ins.tipo_contacto }))
    .digest('hex');

  const { data: previa } = await sb.from('tarjeta').select('input_hash').eq('chat_id', chatId).maybeSingle();
  const ahora = new Date().toISOString();

  // 2) Si el input no cambió → salir SIN gastar LLM (idempotencia real).
  if (!opts.forzar && previa?.input_hash === inputHash) {
    await sb.from('tarjeta').update({ dirty: false, actualizado_at: ahora }).eq('chat_id', chatId);
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
  if (age.agendamientos.length) {
    await sb.from('tarjeta_agenda').insert(age.agendamientos.map(x => ({
      chat_id: chatId, titulo: x.titulo, cuando: x.cuando, lugar: x.lugar, derivado_de_hash: inputHash,
    })) as any);
  }

  return {
    chat_id: chatId, persona_id: personaId, cambio: true, hash: inputHash,
    estado_conversacion: chk.estado_conversacion, n_tareas: tar.tareas.length, n_agenda: age.agendamientos.length,
    costo_usd: t.costo_usd + chk.costo_usd + tar.costo_usd + age.costo_usd,
  };
}
