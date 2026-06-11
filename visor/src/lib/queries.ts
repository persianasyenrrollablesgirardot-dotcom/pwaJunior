// Queries reales contra Supabase. Devuelven el shape esperado por los paneles
// (compatible con types de fakeData.ts).

import { supabase } from './supabase';
import type { Chat, Persona, Proyecto, Inmueble, Mensaje, EventoPG, ItemBuzon, Ambito, ProyectoEstado } from './fakeData';

export async function fetchChats(): Promise<Chat[]> {
  // Usa la vista vw_chats_estado_ia que ya trae el último mensaje + estado IA en 1 query
  const { data, error } = await supabase
    .from('vw_chats_estado_ia')
    .select('*')
    .order('ultimo_mensaje_ts', { ascending: false, nullsFirst: false })
    .limit(200);
  if (error) throw error;

  return (data ?? []).map((c: any) => ({
    id: c.id,
    canal: c.canal,
    titulo: c.titulo ?? '(sin título)',
    ambito: c.ambito as Ambito,
    ambito_confirmado: c.ambito_confirmado,
    proyecto_id: c.proyecto_id ?? undefined,
    ultimo_mensaje_preview: c.ultimo_mensaje_texto?.slice(0, 80) ?? (c.mensajes_total > 0 ? `[${c.ultimo_mensaje_tipo}]` : '(sin mensajes)'),
    ultimo_mensaje_ts: c.ultimo_mensaje_ts ?? c.updated_at,
    no_leidos: 0,
    ia_estado: c.ia_estado,
    ia_autorizado: c.ia_autorizado,
    ia_historico_procesado: c.ia_historico_procesado,
    ia_bloqueado: c.ia_bloqueado,
    ia_bloqueado_motivo: c.ia_bloqueado_motivo ?? undefined,
    ia_costo_acumulado_usd: Number(c.ia_costo_acumulado_usd ?? 0),
    mensajes_total: c.mensajes_total ?? 0,
  }));
}

// ─── Eliminar chat procesado en cascada (para re-procesar limpio) ───
//
// Borra todo lo que el procesamiento creó: mensajes, eventos, chat, y si el
// proyecto/persona/inmueble quedan huérfanos (sin otros chats que los referencien),
// también se borran. Catálogos/config NO se tocan.
//
// La extensión sigue conservando el chat en su IndexedDB local, así que cuando
// vuelvas a darle "Procesar" en M0 Captura, los mensajes vuelven a subir.

export interface PreviewEliminarChat {
  chat_id: number;
  chat_titulo: string;
  jid: string | null;
  mensajes: number;
  eventos: number;
  proyecto_id: number | null;
  persona_id: number | null;
  inmueble_id: number | null;
  proyecto_se_borra: boolean;     // true si no quedan otros chats con ese proyecto
  persona_se_borra: boolean;      // true si no quedan otros proyectos con esa persona
  inmueble_se_borra: boolean;     // true si no quedan otros proyectos con ese inmueble
  notas_libres: number;
  correcciones: number;
  buzon_pendiente: number;
}

export async function previewEliminarChat(chatId: number): Promise<PreviewEliminarChat> {
  const { data: chat, error: e1 } = await supabase.from('chats')
    .select('id, titulo, canal_chat_id, proyecto_id')
    .eq('id', chatId).single();
  if (e1 || !chat) throw new Error(`Chat ${chatId} no encontrado`);

  const [{ count: msgs }, { count: evts }] = await Promise.all([
    supabase.from('mensajes').select('id', { count: 'exact', head: true }).eq('chat_id', chatId),
    supabase.from('evento_pg').select('id', { count: 'exact', head: true }).eq('chat_id', chatId),
  ]);

  let personaId: number | null = null;
  let inmuebleId: number | null = null;
  let proyectoSeBorra = false, personaSeBorra = false, inmuebleSeBorra = false;
  let notasCount = 0, correccionesCount = 0, buzonCount = 0;

  if (chat.proyecto_id) {
    const { data: proy } = await supabase.from('proyectos')
      .select('persona_id, inmueble_id').eq('id', chat.proyecto_id).single();
    personaId = proy?.persona_id ?? null;
    inmuebleId = proy?.inmueble_id ?? null;

    // ¿proyecto queda huérfano?
    const { count: chatsRest } = await supabase.from('chats')
      .select('id', { count: 'exact', head: true })
      .eq('proyecto_id', chat.proyecto_id).neq('id', chatId);
    proyectoSeBorra = (chatsRest ?? 0) === 0;

    if (proyectoSeBorra) {
      // counts de items que se van a borrar al borrar el proyecto
      const [{ count: bz }, { count: cr }] = await Promise.all([
        supabase.from('buzon_validacion').select('id', { count: 'exact', head: true }).eq('proyecto_id', chat.proyecto_id),
        supabase.from('correcciones').select('id', { count: 'exact', head: true }).eq('proyecto_id', chat.proyecto_id),
      ]);
      buzonCount += bz ?? 0;
      correccionesCount += cr ?? 0;
    }
  }

  if (personaId && proyectoSeBorra) {
    // ¿persona queda sin proyectos tras borrar el proyecto actual?
    const { count: proyRest } = await supabase.from('proyectos')
      .select('id', { count: 'exact', head: true })
      .eq('persona_id', personaId).neq('id', chat.proyecto_id ?? 0);
    personaSeBorra = (proyRest ?? 0) === 0;
    if (personaSeBorra) {
      const { count: nl } = await supabase.from('notas_libres')
        .select('id', { count: 'exact', head: true }).eq('persona_id', personaId);
      notasCount += nl ?? 0;
    }
  }

  if (inmuebleId && proyectoSeBorra) {
    const { count: proyRest } = await supabase.from('proyectos')
      .select('id', { count: 'exact', head: true })
      .eq('inmueble_id', inmuebleId).neq('id', chat.proyecto_id ?? 0);
    inmuebleSeBorra = (proyRest ?? 0) === 0;
  }

  return {
    chat_id: chatId,
    chat_titulo: chat.titulo ?? '(sin título)',
    jid: chat.canal_chat_id ?? null,
    mensajes: msgs ?? 0,
    eventos: evts ?? 0,
    proyecto_id: chat.proyecto_id ?? null,
    persona_id: personaId,
    inmueble_id: inmuebleId,
    proyecto_se_borra: proyectoSeBorra,
    persona_se_borra: personaSeBorra,
    inmueble_se_borra: inmuebleSeBorra,
    notas_libres: notasCount,
    correcciones: correccionesCount,
    buzon_pendiente: buzonCount,
  };
}

/**
 * Re-clasifica el ámbito de un contacto (p.ej. cliente → proveedor).
 * Actualiza las 3 columnas de ámbito de forma coherente: chats.ambito (lo que
 * filtra el módulo Clientes), proyectos.ambito y personas.ambito_principal.
 * Registra el cambio en chat_ambito_historial (auditoría, best-effort).
 */
export async function reclasificarAmbito(args: {
  chatId: number;
  proyectoId: number | null;
  personaId: number | null;
  ambitoAnterior: string;
  ambitoNuevo: string;
}): Promise<void> {
  const { chatId, proyectoId, personaId, ambitoAnterior, ambitoNuevo } = args;

  const { error: e1 } = await supabase.from('chats')
    .update({ ambito: ambitoNuevo, ambito_confirmado: true }).eq('id', chatId);
  if (e1) throw new Error(`chats: ${e1.message}`);

  if (proyectoId != null) {
    const { error } = await supabase.from('proyectos')
      .update({ ambito: ambitoNuevo }).eq('id', proyectoId);
    if (error) throw new Error(`proyectos: ${error.message}`);
  }
  if (personaId != null) {
    // sintesis_pendiente=true → el worker re-sintetiza el contacto al toque,
    // así su análisis refleja el ámbito nuevo sin esperar actividad del chat.
    const { error } = await supabase.from('personas')
      .update({ ambito_principal: ambitoNuevo, sintesis_pendiente: true }).eq('id', personaId);
    if (error) throw new Error(`personas: ${error.message}`);
  }
  // Auditoría — best-effort: si falla no revierte el cambio ya aplicado.
  await supabase.from('chat_ambito_historial').insert({
    chat_id: chatId,
    ambito_anterior: ambitoAnterior,
    ambito_nuevo: ambitoNuevo,
    motivo: 'Reclasificado manualmente desde el módulo Clientes',
  });
}

export interface ResultadoEliminarChat {
  ok: true;
  mensajes_borrados: number;
  eventos_borrados: number;
  proyectos_borrados: number;
  personas_borradas: number;
  inmuebles_borrados: number;
}

export async function eliminarChatProcesado(chatId: number): Promise<ResultadoEliminarChat> {
  const { data: chat, error: e1 } = await supabase.from('chats')
    .select('id, canal_chat_id, proyecto_id').eq('id', chatId).single();
  if (e1 || !chat) throw new Error(`Chat ${chatId} no encontrado`);

  // Snapshot de IDs antes de borrar
  const proyectoId = chat.proyecto_id ?? null;
  let personaId: number | null = null;
  let inmuebleId: number | null = null;
  if (proyectoId) {
    const { data: proy } = await supabase.from('proyectos')
      .select('persona_id, inmueble_id').eq('id', proyectoId).single();
    personaId = proy?.persona_id ?? null;
    inmuebleId = proy?.inmueble_id ?? null;
  }

  const stats = { mensajes: 0, eventos: 0, proyectos: 0, personas: 0, inmuebles: 0 };

  // 1. Borrar dependencias del CHAT (orden FK)
  // 1.a correcciones / buzon_validacion / notas que apuntan a eventos del chat
  const { data: evtIds } = await supabase.from('evento_pg').select('id').eq('chat_id', chatId);
  const eventoIds = (evtIds ?? []).map(e => e.id);
  if (eventoIds.length > 0) {
    await supabase.from('correcciones').delete().in('evento_id', eventoIds);
    await supabase.from('buzon_validacion').delete().in('evento_id', eventoIds);
  }

  // F1.22 fix C5: SOFT-DELETE en lugar de hard-delete. Evita race condition contra
  // worker_pipeline que puede estar procesando el chat en paralelo. El worker ya
  // filtra `is('deleted_at', null)` así que no procesa los soft-deleted.
  const ahora = new Date().toISOString();
  const { count: nMsg } = await supabase.from('mensajes').update({ deleted_at: ahora }, { count: 'exact' }).eq('chat_id', chatId).is('deleted_at', null);
  stats.mensajes = nMsg ?? 0;
  // evento_pg también tiene deleted_at
  const { count: nEvt } = await supabase.from('evento_pg').update({ deleted_at: ahora }, { count: 'exact' }).eq('chat_id', chatId).is('deleted_at', null);
  stats.eventos = nEvt ?? 0;
  // chat_ambito_historial y chats_bloqueados son tablas pequeñas sin FK desde worker → hard-delete OK
  await supabase.from('chat_ambito_historial').delete().eq('chat_id', chatId);
  if (chat.canal_chat_id) {
    await supabase.from('chats_bloqueados').delete().eq('canal_chat_id', chat.canal_chat_id);
  }

  // 2. Soft-delete del chat
  await supabase.from('chats').update({ deleted_at: ahora }).eq('id', chatId);

  // 3. Si proyecto queda sin chats activos → soft-delete (con dependencias)
  if (proyectoId) {
    const { count: chatsRest } = await supabase.from('chats')
      .select('id', { count: 'exact', head: true })
      .eq('proyecto_id', proyectoId).is('deleted_at', null);
    if ((chatsRest ?? 0) === 0) {
      await supabase.from('correcciones').delete().eq('proyecto_id', proyectoId);
      await supabase.from('buzon_validacion').delete().eq('proyecto_id', proyectoId);
      await supabase.from('tag_asignacion').delete().eq('proyecto_id', proyectoId);
      await supabase.from('proyectos').update({ deleted_at: ahora }).eq('id', proyectoId);
      stats.proyectos = 1;
    }
  }

  // 4. Si persona queda sin proyectos activos → soft-delete
  if (personaId) {
    const { count: proyRest } = await supabase.from('proyectos')
      .select('id', { count: 'exact', head: true })
      .eq('persona_id', personaId).is('deleted_at', null);
    if ((proyRest ?? 0) === 0) {
      await supabase.from('notas_libres').delete().eq('persona_id', personaId);
      await supabase.from('tag_asignacion').delete().eq('persona_id', personaId);
      await supabase.from('rol_persona_inmueble').delete().eq('persona_id', personaId);
      await supabase.from('correcciones').delete().eq('persona_id', personaId);
      await supabase.from('buzon_validacion').delete().eq('persona_id', personaId);
      await supabase.from('personas_merge_log').delete().or(`persona_origen_id.eq.${personaId},persona_destino_id.eq.${personaId}`);
      await supabase.from('personas').update({ deleted_at: ahora }).eq('id', personaId);
      stats.personas = 1;
    }
  }

  // 5. Si inmueble queda sin proyectos activos → soft-delete
  if (inmuebleId) {
    const { count: proyRest } = await supabase.from('proyectos')
      .select('id', { count: 'exact', head: true })
      .eq('inmueble_id', inmuebleId).is('deleted_at', null);
    if ((proyRest ?? 0) === 0) {
      await supabase.from('rol_persona_inmueble').delete().eq('inmueble_id', inmuebleId);
      await supabase.from('inmuebles').update({ deleted_at: ahora }).eq('id', inmuebleId);
      stats.inmuebles = 1;
    }
  }

  return {
    ok: true,
    mensajes_borrados: stats.mensajes,
    eventos_borrados: stats.eventos,
    proyectos_borrados: stats.proyectos,
    personas_borradas: stats.personas,
    inmuebles_borrados: stats.inmuebles,
  };
}

// Acciones sobre chats — políticas IA

export async function autorizarChat(chatId: number): Promise<void> {
  const { error } = await supabase.from('chats').update({ ia_autorizado: true }).eq('id', chatId);
  if (error) throw error;
}

export async function marcarHistoricoProcesado(chatId: number, costoUsd: number): Promise<void> {
  const { error } = await supabase.from('chats').update({
    ia_autorizado: true,
    ia_historico_procesado: true,
    ia_costo_acumulado_usd: costoUsd,
  }).eq('id', chatId);
  if (error) throw error;

  // Log de auto-autorización
  await supabase.from('ia_auto_autorizaciones').insert({
    chat_id: chatId,
    origen: 'manual',
    costo_total_usd: costoUsd,
  });
}

export async function bloquearChat(chatId: number, motivo: string): Promise<void> {
  const { error } = await supabase.from('chats').update({
    ia_bloqueado: true,
    ia_bloqueado_motivo: motivo,
    ia_bloqueado_at: new Date().toISOString(),
  }).eq('id', chatId);
  if (error) throw error;
}

export async function desbloquearChat(chatId: number): Promise<void> {
  const { error } = await supabase.from('chats').update({
    ia_bloqueado: false,
    ia_bloqueado_motivo: null,
    ia_bloqueado_at: null,
  }).eq('id', chatId);
  if (error) throw error;
}

// ─── Personas (CRUD) ─────────────────────────────────────────────────

export async function actualizarPersona(id: number, cambios: Partial<{
  nombre: string; alias: string | null; telefono_e164: string | null;
  email: string | null; ciudad: string | null; rol: string | null;
  ambito_principal: string; notas: string | null;
  empresa: string | null;
  referido_por_persona_id: number | null;
  contacto_alterno_nombre: string | null;
  contacto_alterno_telefono: string | null;
}>): Promise<void> {
  // Cualquier edición de la ficha (nombre, ámbito, notas, contacto, ciudad…)
  // dispara re-síntesis: los analistas y Junior leen casi todos esos campos.
  const { error } = await supabase.from('personas')
    .update({ ...cambios, actualizado_por: 1, sintesis_pendiente: true }).eq('id', id);
  if (error) throw error;
}

export async function crearPersona(data: {
  nombre: string; telefono_e164?: string; email?: string;
  ambito_principal: string; ciudad?: string; rol?: string; notas?: string;
  empresa?: string;
  referido_por_persona_id?: number;
  contacto_alterno_nombre?: string;
  contacto_alterno_telefono?: string;
}): Promise<number> {
  const { data: out, error } = await supabase.from('personas').insert({ ...data, actualizado_por: 1 }).select('id').single();
  if (error || !out) throw error ?? new Error('insert persona falló');
  return out.id;
}

// ─── Notas libres ────────────────────────────────────────────────────

export interface NotaLibre {
  id: number;
  persona_id: number | null;
  proyecto_id: number | null;
  contenido: string;
  visible_para: string[];
  ts_creado: string;
}

export async function fetchNotasPersona(personaId: number): Promise<NotaLibre[]> {
  const { data, error } = await supabase
    .from('notas_libres')
    .select('id, persona_id, proyecto_id, contenido, visible_para, ts_creado')
    .eq('persona_id', personaId)
    .is('deleted_at', null)
    .order('ts_creado', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

export async function agregarNota(data: {
  persona_id?: number; proyecto_id?: number;
  contenido: string; visible_para?: string[];
}): Promise<void> {
  const { error } = await supabase.from('notas_libres').insert({
    persona_id: data.persona_id ?? null,
    proyecto_id: data.proyecto_id ?? null,
    contenido: data.contenido,
    visible_para: data.visible_para ?? ['todos'],
    creado_por: 1,
  });
  if (error) throw error;

  // Cada nota nueva debe disparar re-síntesis del contacto: los analistas y
  // Junior leen las notas como verdad prioritaria, así que el análisis
  // guardado quedó desactualizado en cuanto Jhon escribió la nota.
  if (data.persona_id != null) {
    await supabase.from('personas')
      .update({ sintesis_pendiente: true }).eq('id', data.persona_id);
  }
}

export async function eliminarNota(notaId: number): Promise<void> {
  // Conocer la persona ANTES del soft-delete: sacar una nota cambia lo que
  // los analistas ven y la síntesis tiene que refrescarse igual que al agregar.
  const { data: nota } = await supabase
    .from('notas_libres').select('persona_id').eq('id', notaId).maybeSingle();
  const { error } = await supabase
    .from('notas_libres')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', notaId);
  if (error) throw error;
  if (nota?.persona_id != null) {
    await supabase.from('personas')
      .update({ sintesis_pendiente: true }).eq('id', nota.persona_id);
  }
}

// ─── Cambiar ámbito de chat ──────────────────────────────────────────

export async function cambiarAmbitoChat(chatId: number, ambitoNuevo: string, motivo: string): Promise<void> {
  // 1. Cargar el ámbito actual
  const { data: chat, error: errLoad } = await supabase
    .from('chats').select('ambito').eq('id', chatId).single();
  if (errLoad || !chat) throw errLoad ?? new Error('chat no encontrado');

  const ambitoAnterior = chat.ambito;

  // 2. Update + marcar como confirmado
  const { error: errUpd } = await supabase
    .from('chats')
    .update({ ambito: ambitoNuevo, ambito_confirmado: true })
    .eq('id', chatId);
  if (errUpd) throw errUpd;

  // 3. Log en historial
  const { error: errLog } = await supabase.from('chat_ambito_historial').insert({
    chat_id: chatId,
    ambito_anterior: ambitoAnterior,
    ambito_nuevo: ambitoNuevo,
    cambiado_por: 1,
    motivo,
  });
  if (errLog) throw errLog;
}

// ─── Proyectos (CRUD) ────────────────────────────────────────────────

export async function actualizarProyecto(id: number, cambios: Partial<{
  nombre: string; estado: string; prioridad: number; notas: string | null;
}>): Promise<void> {
  const { error } = await supabase.from('proyectos').update({ ...cambios, actualizado_por: 1 }).eq('id', id);
  if (error) throw error;
}

export async function crearProyecto(data: {
  persona_id: number; inmueble_id?: number; ambito: string;
  nombre: string; estado?: string; origen?: string; prioridad?: number;
}): Promise<number> {
  const { data: out, error } = await supabase.from('proyectos').insert({
    persona_id: data.persona_id,
    inmueble_id: data.inmueble_id ?? null,
    ambito: data.ambito,
    nombre: data.nombre,
    estado: data.estado ?? 'abierto',
    origen: data.origen ?? 'manual',
    prioridad: data.prioridad ?? 5,
  }).select('id').single();
  if (error || !out) throw error ?? new Error('insert proyecto falló');
  return out.id;
}

// ─── Inmuebles (CRUD) ────────────────────────────────────────────────

export async function crearInmueble(data: {
  direccion?: string; ciudad?: string; barrio?: string; conjunto?: string;
  torre?: string; apartamento?: string; tipo?: string; notas?: string;
  restricciones_ingreso?: string; administracion_contacto?: string;
  parqueadero?: boolean; ascensor?: boolean; horarios_permitidos?: string;
}): Promise<number> {
  const { data: out, error } = await supabase.from('inmuebles').insert({ ...data, actualizado_por: 1 }).select('id').single();
  if (error || !out) throw error ?? new Error('insert inmueble falló');
  return out.id;
}

export async function actualizarInmueble(id: number, cambios: Partial<{
  direccion: string; ciudad: string; barrio: string; conjunto: string; torre: string;
  apartamento: string; tipo: string; notas: string | null;
  restricciones_ingreso: string | null; administracion_contacto: string | null;
  parqueadero: boolean; ascensor: boolean; horarios_permitidos: string | null;
}>): Promise<void> {
  const { error } = await supabase.from('inmuebles').update({ ...cambios, actualizado_por: 1 }).eq('id', id);
  if (error) throw error;
}

export async function vincularPersonaInmueble(personaId: number, inmuebleId: number, rol: string): Promise<void> {
  const { error } = await supabase.from('rol_persona_inmueble').insert({
    persona_id: personaId,
    inmueble_id: inmuebleId,
    rol,
  });
  if (error) throw error;
}

// ─── Fusionar personas duplicadas (sección 29) ───────────────────────

export async function fusionarPersonas(sobrevivienteId: number, fusionadaId: number, motivo: string): Promise<void> {
  // Fusión ATÓMICA vía la RPC `fusionar_persona_atomica` (migración 052) — la misma
  // que usa el worker. Corre en UNA transacción: mueve TODAS las tablas con
  // persona_id (auto-descubiertas), descarta la síntesis de la fusionada, hereda su
  // identidad (jid/tel/email/ciudad), registra el log, soft-deletea la fusionada y
  // cierra los duplicados pendientes. Antes esta versión del frontend solo movía 7
  // tablas (dejaba tareas/agendamientos/cotizaciones/tarjeta huérfanas) y no era
  // atómica. SECURITY DEFINER → funciona con la anon key del Visor.
  //
  // RETRY: el rol anon tiene statement_timeout=3s. La fusión normalmente tarda <1s,
  // pero la primera en frío (warmup de planes) o bajo carga del worker puede pasar
  // los 3s. Como es ATÓMICA (un timeout hace ROLLBACK total — no deja nada a medias),
  // reintentar es seguro: en el 2º intento ya está en caché y entra.
  let lastErr = '';
  for (let intento = 1; intento <= 3; intento++) {
    const { error } = await supabase.rpc('fusionar_persona_atomica', {
      p_sobreviviente: sobrevivienteId,
      p_fusionada: fusionadaId,
      p_motivo: motivo,
    });
    if (!error) return;
    lastErr = error.message;
    if (!/timeout|canceling statement|57014/i.test(error.message)) break;  // error real → no reintentar
    await new Promise(r => setTimeout(r, 800));
  }
  throw new Error(`fusión atómica: ${lastErr}`);
}

// ─── Transcripciones / media procesada (M1 sub-tab 1.7) ─────────────

export type EstadoTranscripcion =
  | 'transcrito'
  | 'pendiente_ia'
  | 'sin_ia'
  | 'irrecuperable_cdn'    // CDN de WhatsApp ya borró el archivo (>17d). NO se puede recuperar
  | 'error_temporal'       // network, rate limit, timeout — reintentable
  | 'error_inesperado'     // bug real, hay que mirar el detalle
  | 'no_aplica';

export interface ItemTranscripcion {
  id: number;
  chat_id: number;
  chat_jid: string | null;  // canal_chat_id (jid de WA) — necesario para invocar transcripción via extensión
  chat_titulo: string;
  proyecto_id: number | null;
  persona_id: number | null;
  persona_nombre: string | null;
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  tipo: string;             // audio, imagen, video, documento, ubicacion, etc.
  texto: string | null;     // texto plano original (caption en imagen/video, NULL en audio puro)
  ai_text: string | null;   // transcripción/descripción IA
  type_original: string | null;
  ts_canal: string;
  estado: EstadoTranscripcion;
  costo_estimado_usd: number;
}

const TIPOS_MEDIA = ['imagen', 'audio', 'video', 'documento', 'ubicacion', 'contacto'];

export async function fetchTranscripciones(): Promise<ItemTranscripcion[]> {
  // Solo de chats procesados (ia_historico_procesado=true o proyecto_id IS NOT NULL) — para no mezclar con crudos
  const { data, error } = await supabase
    .from('mensajes')
    .select(`
      id, chat_id, canal_msg_id, direccion, tipo, texto, metadata, ts_canal,
      chats!inner(id, titulo, canal_chat_id, ia_historico_procesado, proyecto_id, proyectos(persona_id, personas(nombre)))
    `)
    .in('tipo', TIPOS_MEDIA)
    .is('deleted_at', null)
    // F1.22 fix I2: filtrar en BD (antes filtraba en cliente con LIMIT 500 → estallable)
    .or('ia_historico_procesado.eq.true,proyecto_id.not.is.null', { foreignTable: 'chats' })
    .order('ts_canal', { ascending: false })
    .limit(2000);
  if (error) throw error;

  const cfg = await fetchConfiguracion(['ia_costo_estimado_por_mensaje_media_usd']);
  const costoMedia = Number(cfg.ia_costo_estimado_por_mensaje_media_usd ?? 0.005);

  return (data ?? [])
    .filter((m: any) => m.chats?.ia_historico_procesado === true || m.chats?.proyecto_id != null)
    .map((m: any): ItemTranscripcion => {
      const aiText = m.metadata?.ai_text ?? null;
      const aiStatus = m.metadata?.ai_status ?? null;
      const downloadStatus = m.metadata?.download_status ?? null;
      const tipoOriginal = m.metadata?.type_original ?? null;
      let estado: EstadoTranscripcion;
      if (m.tipo === 'ubicacion' || m.tipo === 'contacto') estado = 'no_aplica';
      else if (aiText && aiText.length > 0 && aiStatus === 'processed') estado = 'transcrito';
      else if (downloadStatus === 'lost' || aiStatus === 'skipped_cdn_lost') estado = 'irrecuperable_cdn';
      else if (aiStatus === 'error_temporal') estado = 'error_temporal';
      else if (aiStatus === 'error_inesperado' || m.metadata?.ai_error) estado = 'error_inesperado';
      else estado = 'sin_ia';  // captado pero IA no lo procesó (toggle off, etc.)
      return {
        id: m.id,
        chat_id: m.chat_id,
        chat_jid: m.chats?.canal_chat_id ?? null,
        chat_titulo: m.chats?.titulo ?? '(sin título)',
        proyecto_id: m.chats?.proyecto_id ?? null,
        persona_id: m.chats?.proyectos?.persona_id ?? null,
        persona_nombre: m.chats?.proyectos?.personas?.nombre ?? null,
        canal_msg_id: m.canal_msg_id,
        direccion: m.direccion,
        tipo: m.tipo,
        texto: m.texto,
        ai_text: aiText,
        type_original: tipoOriginal,
        ts_canal: m.ts_canal,
        estado,
        costo_estimado_usd: costoMedia,
      };
    });
}

// ─── M2 Comerciales: Cotizaciones / Items / Objeciones ──────────

export type EstadoCotizacion = 'propuesta' | 'negociando' | 'intencion_cierre' | 'ganada' | 'perdida' | 'vencida' | 'cancelada';

export interface Cotizacion {
  id: number;
  proyecto_id: number | null;
  persona_id: number | null;
  ambito: string;
  numero_cotizacion: string | null;
  fecha: string;
  fecha_vencimiento: string | null;
  estado: EstadoCotizacion;
  subtotal: number;
  descuento_pct: number;
  descuento_monto: number;
  iva_monto: number;
  total: number;
  abono_monto: number | null;
  abono_fecha: string | null;
  abono_metodo: string | null;
  abono_referencia: string | null;
  saldo: number;
  notas: string | null;
  proxima_accion: string | null;
  proxima_accion_fecha: string | null;
  agente_origen: string | null;
  confianza: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
}

export interface CotizacionItem {
  id: number;
  cotizacion_id: number;
  sistema_safra_codigo: string | null;
  ambiente: string | null;
  ancho_m: number | null;
  alto_m: number | null;
  area_m2: number | null;
  cantidad: number;
  precio_unitario: number;
  monto_total: number;
  color: string | null;
  accesorios: string[] | null;
  quien_midio: 'tecnico' | 'cliente' | 'familiar' | 'otro' | null;
  riesgo_medicion: boolean;
  notas: string | null;
  orden: number;
}

export interface CotizacionObjecion {
  id: number;
  cotizacion_id: number;
  persona_id: number | null;
  tipo_objecion_codigo: string;
  texto_cliente: string | null;
  respuesta_dada: string | null;
  resultado: 'resuelto' | 'persiste' | 'cliente_se_fue' | 'pendiente' | null;
  ts_objecion: string;
  notas: string | null;
}

export async function fetchCotizacionesPorPersona(personaId: number): Promise<Cotizacion[]> {
  const { data, error } = await supabase
    .from('cotizaciones')
    .select('*')
    .eq('persona_id', personaId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('fecha', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Cotizacion[];
}

export async function fetchItemsPorCotizacion(cotizacionId: number): Promise<CotizacionItem[]> {
  const { data, error } = await supabase
    .from('cotizacion_items')
    .select('*')
    .eq('cotizacion_id', cotizacionId)
    .is('deleted_at', null)
    .order('orden', { ascending: true });
  if (error) throw error;
  return (data ?? []) as CotizacionItem[];
}

export async function fetchObjecionesPorCotizacion(cotizacionId: number): Promise<CotizacionObjecion[]> {
  const { data, error } = await supabase
    .from('cotizacion_objeciones')
    .select('*')
    .eq('cotizacion_id', cotizacionId)
    .is('deleted_at', null)
    .order('ts_objecion', { ascending: false });
  if (error) throw error;
  return (data ?? []) as CotizacionObjecion[];
}

export interface CrearCotizacionInput {
  proyecto_id?: number | null;
  persona_id: number;
  ambito?: string;
  numero_cotizacion?: string | null;
  fecha?: string;
  fecha_vencimiento?: string | null;
  estado?: EstadoCotizacion;
  notas?: string | null;
  proxima_accion?: string | null;
  proxima_accion_fecha?: string | null;
}

export async function crearCotizacion(input: CrearCotizacionInput): Promise<Cotizacion> {
  const { data, error } = await supabase
    .from('cotizaciones')
    .insert({
      proyecto_id: input.proyecto_id ?? null,
      persona_id: input.persona_id,
      ambito: input.ambito ?? 'comercial',
      numero_cotizacion: input.numero_cotizacion ?? null,
      fecha: input.fecha ?? new Date().toISOString().slice(0, 10),
      fecha_vencimiento: input.fecha_vencimiento ?? null,
      estado: input.estado ?? 'propuesta',
      notas: input.notas ?? null,
      proxima_accion: input.proxima_accion ?? null,
      proxima_accion_fecha: input.proxima_accion_fecha ?? null,
      actualizado_por: 1,
    })
    .select('*').single();
  if (error) throw error;
  return data as Cotizacion;
}

export async function actualizarCotizacion(id: number, patch: Partial<Cotizacion>): Promise<void> {
  // Recalcular total/saldo a partir de subtotal, descuento, abono
  const { data: actual } = await supabase.from('cotizaciones').select('*').eq('id', id).single();
  if (!actual) throw new Error('cotización no encontrada');
  const merged = { ...actual, ...patch };
  const subtotal = Number(merged.subtotal ?? 0);
  const descPct = Number(merged.descuento_pct ?? 0);
  const descMonto = descPct > 0 ? subtotal * (descPct / 100) : Number(merged.descuento_monto ?? 0);
  const total = subtotal - descMonto + Number(merged.iva_monto ?? 0);
  const saldo = total - Number(merged.abono_monto ?? 0);
  const { error } = await supabase
    .from('cotizaciones')
    .update({ ...patch, descuento_monto: descMonto, total, saldo, actualizado_por: 1 })
    .eq('id', id);
  if (error) throw error;
}

export async function eliminarCotizacion(id: number): Promise<void> {
  const { error } = await supabase.from('cotizaciones').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

export async function crearItemCotizacion(cotizacionId: number, input: Partial<CotizacionItem>): Promise<CotizacionItem> {
  const monto = (input.cantidad ?? 1) * (input.precio_unitario ?? 0);
  const { data, error } = await supabase
    .from('cotizacion_items')
    .insert({
      cotizacion_id: cotizacionId,
      sistema_safra_codigo: input.sistema_safra_codigo ?? null,
      ambiente: input.ambiente ?? null,
      ancho_m: input.ancho_m ?? null,
      alto_m: input.alto_m ?? null,
      cantidad: input.cantidad ?? 1,
      precio_unitario: input.precio_unitario ?? 0,
      monto_total: monto,
      color: input.color ?? null,
      accesorios: input.accesorios ?? null,
      quien_midio: input.quien_midio ?? null,
      notas: input.notas ?? null,
      orden: input.orden ?? 0,
    })
    .select('*').single();
  if (error) throw error;
  await recalcularSubtotalCotizacion(cotizacionId);
  return data as CotizacionItem;
}

export async function actualizarItemCotizacion(itemId: number, patch: Partial<CotizacionItem>): Promise<void> {
  const merged = patch.cantidad != null || patch.precio_unitario != null
    ? { ...patch, monto_total: (patch.cantidad ?? 1) * (patch.precio_unitario ?? 0) }
    : patch;
  const { data: item, error: e1 } = await supabase
    .from('cotizacion_items')
    .update(merged)
    .eq('id', itemId)
    .select('cotizacion_id').single();
  if (e1) throw e1;
  if (item?.cotizacion_id) await recalcularSubtotalCotizacion(item.cotizacion_id);
}

export async function eliminarItemCotizacion(itemId: number): Promise<void> {
  const { data: item } = await supabase.from('cotizacion_items').select('cotizacion_id').eq('id', itemId).single();
  await supabase.from('cotizacion_items').update({ deleted_at: new Date().toISOString() }).eq('id', itemId);
  if (item?.cotizacion_id) await recalcularSubtotalCotizacion(item.cotizacion_id);
}

async function recalcularSubtotalCotizacion(cotizacionId: number): Promise<void> {
  const { data: items } = await supabase.from('cotizacion_items')
    .select('monto_total').eq('cotizacion_id', cotizacionId).is('deleted_at', null);
  const subtotal = (items ?? []).reduce((acc, it: any) => acc + Number(it.monto_total || 0), 0);
  await actualizarCotizacion(cotizacionId, { subtotal });
}

export async function crearObjecion(input: Omit<CotizacionObjecion, 'id' | 'ts_objecion'> & { ts_objecion?: string }): Promise<CotizacionObjecion> {
  const { data, error } = await supabase
    .from('cotizacion_objeciones')
    .insert({ ...input, ts_objecion: input.ts_objecion ?? new Date().toISOString() })
    .select('*').single();
  if (error) throw error;
  return data as CotizacionObjecion;
}

export async function eliminarObjecion(id: number): Promise<void> {
  await supabase.from('cotizacion_objeciones').update({ deleted_at: new Date().toISOString() }).eq('id', id);
}

export interface ResumenComercialPersona {
  persona_id: number;
  persona_nombre: string;
  persona_telefono: string | null;
  cotizaciones_total: number;
  cotizaciones_propuestas: number;
  cotizaciones_negociando: number;
  cotizaciones_ganadas: number;
  cotizaciones_perdidas: number;
  cotizaciones_vencidas: number;
  monto_propuesto_total: number;
  monto_ganado_total: number;
  abonos_total: number;
  saldo_pendiente_total: number;
  ultima_actividad: string | null;
}

export async function fetchResumenComercial(personaId?: number): Promise<ResumenComercialPersona[]> {
  let q = supabase.from('vw_comerciales_resumen').select('*');
  if (personaId != null) q = q.eq('persona_id', personaId);
  q = q.order('ultima_actividad', { ascending: false, nullsFirst: false });
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as any;
}

export async function fetchCotizacionesGlobal(opts: { recompraDesdeMeses?: number } = {}): Promise<{ cotizacion: Cotizacion; persona_nombre: string | null }[]> {
  const { data, error } = await supabase
    .from('cotizaciones')
    .select('*, personas!cotizaciones_persona_id_fkey(id, nombre)')
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  let rows = (data ?? []).map((r: any) => ({ cotizacion: r as Cotizacion, persona_nombre: r.personas?.nombre ?? null }));
  if (opts.recompraDesdeMeses != null) {
    const corte = new Date(); corte.setMonth(corte.getMonth() - opts.recompraDesdeMeses);
    rows = rows.filter(r => r.cotizacion.estado === 'ganada' && new Date(r.cotizacion.updated_at) < corte);
  }
  return rows;
}

export async function fetchTiposObjecion(): Promise<{ codigo: string; etiqueta: string }[]> {
  const { data, error } = await supabase.from('tipos_objecion').select('codigo, nombre').order('codigo');
  if (error) return [];
  return (data ?? []).map((r: any) => ({ codigo: r.codigo, etiqueta: r.nombre }));
}

export async function fetchSistemasSafra(): Promise<{ codigo: string; nombre: string }[]> {
  const { data, error } = await supabase.from('sistemas_safra').select('codigo, nombre').order('nombre');
  if (error) return [];
  return data ?? [];
}

// ═══════════════════════════════════════════════════════════════════════
// MÓDULO 3 — FINANCIEROS
// ═══════════════════════════════════════════════════════════════════════

export type EstadoFactura = 'borrador' | 'emitida' | 'enviada' | 'pagada' | 'anulada';
export type EstadoValidacionAbono = 'pendiente' | 'confirmado' | 'rechazado' | 'inconsistente';

export interface Factura {
  id: number;
  cotizacion_id: number | null;
  proyecto_id: number | null;
  persona_id: number | null;
  numero_factura: string;
  fecha: string;
  fecha_vencimiento: string | null;
  valor_total: number;
  estado: EstadoFactura;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Abono {
  id: number;
  cotizacion_id: number | null;
  factura_id: number | null;
  persona_id: number | null;
  monto: number;
  fecha: string;
  metodo: string | null;
  referencia: string | null;
  comprobante_url: string | null;
  cuenta_receptora: string | null;
  estado_validacion: EstadoValidacionAbono;
  validado_por: number | null;
  validado_at: string | null;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ResumenCartera {
  persona_id: number;
  persona_nombre: string;
  persona_telefono: string | null;
  persona_email: string | null;
  persona_ciudad: string | null;
  cotizaciones_con_saldo: number;
  facturas_pendientes: number;
  facturado_total: number;
  abonado_total: number;
  deuda_total: number;
  ultima_actividad: string | null;
}

// ── Facturas ──────────────────────────────────────────────────────────

export async function fetchFacturasPorPersona(personaId: number): Promise<Factura[]> {
  const { data, error } = await supabase
    .from('facturas')
    .select('*')
    .eq('persona_id', personaId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('fecha', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Factura[];
}

export interface CrearFacturaInput {
  cotizacion_id?: number | null;
  proyecto_id?: number | null;
  persona_id: number;
  numero_factura: string;
  fecha?: string;
  fecha_vencimiento?: string | null;
  valor_total: number;
  estado?: EstadoFactura;
  notas?: string | null;
}

export async function crearFactura(input: CrearFacturaInput): Promise<Factura> {
  const { data, error } = await supabase
    .from('facturas')
    .insert({
      cotizacion_id: input.cotizacion_id ?? null,
      proyecto_id: input.proyecto_id ?? null,
      persona_id: input.persona_id,
      numero_factura: input.numero_factura,
      fecha: input.fecha ?? new Date().toISOString().slice(0, 10),
      fecha_vencimiento: input.fecha_vencimiento ?? null,
      valor_total: input.valor_total,
      estado: input.estado ?? 'emitida',
      notas: input.notas ?? null,
      actualizado_por: 1,
    })
    .select('*').single();
  if (error) throw error;
  return data as Factura;
}

export async function actualizarFactura(id: number, patch: Partial<Factura>): Promise<void> {
  const { error } = await supabase
    .from('facturas')
    .update({ ...patch, actualizado_por: 1 })
    .eq('id', id);
  if (error) throw error;
}

export async function eliminarFactura(id: number): Promise<void> {
  const { error } = await supabase
    .from('facturas')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// ── Abonos ────────────────────────────────────────────────────────────

export async function fetchAbonosPorPersona(personaId: number): Promise<Abono[]> {
  const { data, error } = await supabase
    .from('abonos')
    .select('*')
    .eq('persona_id', personaId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('fecha', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Abono[];
}

export async function fetchAbonosPorCotizacion(cotizacionId: number): Promise<Abono[]> {
  const { data, error } = await supabase
    .from('abonos')
    .select('*')
    .eq('cotizacion_id', cotizacionId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('fecha', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Abono[];
}

export interface CrearAbonoInput {
  cotizacion_id?: number | null;
  factura_id?: number | null;
  persona_id: number;
  monto: number;
  fecha?: string;
  metodo?: string | null;
  referencia?: string | null;
  comprobante_url?: string | null;
  cuenta_receptora?: string | null;
  estado_validacion?: EstadoValidacionAbono;
  notas?: string | null;
}

export async function crearAbono(input: CrearAbonoInput): Promise<Abono> {
  const { data, error } = await supabase
    .from('abonos')
    .insert({
      cotizacion_id: input.cotizacion_id ?? null,
      factura_id: input.factura_id ?? null,
      persona_id: input.persona_id,
      monto: input.monto,
      fecha: input.fecha ?? new Date().toISOString().slice(0, 10),
      metodo: input.metodo ?? null,
      referencia: input.referencia ?? null,
      comprobante_url: input.comprobante_url ?? null,
      cuenta_receptora: input.cuenta_receptora ?? null,
      estado_validacion: input.estado_validacion ?? 'pendiente',
      notas: input.notas ?? null,
      actualizado_por: 1,
    })
    .select('*').single();
  if (error) throw error;
  return data as Abono;
}

export async function actualizarAbono(id: number, patch: Partial<Abono>): Promise<void> {
  // Si pasa de no-confirmado a confirmado, registrar quién lo validó
  const extra: any = { actualizado_por: 1 };
  if (patch.estado_validacion === 'confirmado' && !patch.validado_at) {
    extra.validado_at = new Date().toISOString();
    extra.validado_por = 1;
  }
  const { error } = await supabase
    .from('abonos')
    .update({ ...patch, ...extra })
    .eq('id', id);
  if (error) throw error;
}

export async function eliminarAbono(id: number): Promise<void> {
  const { error } = await supabase
    .from('abonos')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// ── Cartera (vista global) ───────────────────────────────────────────

export async function fetchCartera(): Promise<ResumenCartera[]> {
  const { data, error } = await supabase
    .from('vw_cartera')
    .select('*')
    .order('deuda_total', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ResumenCartera[];
}

// ── Variaciones económicas (3.4) ─────────────────────────────────────

export const TIPOS_VARIACION = [
  'descuento', 'cambio_producto', 'cambio_medida', 'motor_agregado',
  'ventana_eliminada', 'instalacion_negociada', 'cambio_garantia',
  'cambio_cliente', 'otro',
] as const;
export type TipoVariacion = typeof TIPOS_VARIACION[number];

export interface Variacion {
  id: number;
  cotizacion_id: number | null;
  factura_id: number | null;
  persona_id: number | null;
  tipo: TipoVariacion;
  monto_delta: number;
  motivo: string | null;
  fecha: string;
  responsable: 'empresa' | 'cliente' | 'tercero' | null;
  agente_origen: string | null;
  shadow: boolean;
  notas: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export async function fetchVariacionesPorPersona(personaId: number): Promise<Variacion[]> {
  const { data, error } = await supabase
    .from('cotizacion_variaciones')
    .select('*')
    .eq('persona_id', personaId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('fecha', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Variacion[];
}

export interface CrearVariacionInput {
  cotizacion_id?: number | null;
  factura_id?: number | null;
  persona_id: number;
  tipo: TipoVariacion;
  monto_delta: number;
  motivo?: string | null;
  fecha?: string;
  responsable?: 'empresa' | 'cliente' | 'tercero' | null;
  notas?: string | null;
}

export async function crearVariacion(input: CrearVariacionInput): Promise<Variacion> {
  const { data, error } = await supabase
    .from('cotizacion_variaciones')
    .insert({
      cotizacion_id: input.cotizacion_id ?? null,
      factura_id: input.factura_id ?? null,
      persona_id: input.persona_id,
      tipo: input.tipo,
      monto_delta: input.monto_delta,
      motivo: input.motivo ?? null,
      fecha: input.fecha ?? new Date().toISOString().slice(0, 10),
      responsable: input.responsable ?? null,
      notas: input.notas ?? null,
      actualizado_por: 1,
    })
    .select('*').single();
  if (error) throw error;
  return data as Variacion;
}

export async function actualizarVariacion(id: number, patch: Partial<Variacion>): Promise<void> {
  const { error } = await supabase
    .from('cotizacion_variaciones')
    .update({ ...patch, actualizado_por: 1 })
    .eq('id', id);
  if (error) throw error;
}

export async function eliminarVariacion(id: number): Promise<void> {
  const { error } = await supabase
    .from('cotizacion_variaciones')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// ── Costos / Rentabilidad (3.5) ──────────────────────────────────────

export const TIPOS_COSTO = [
  'producto', 'motor', 'viatico', 'visita_extra', 'retrabajo',
  'garantia_ejecutada', 'mano_obra', 'otro',
] as const;
export type TipoCosto = typeof TIPOS_COSTO[number];

export interface Costo {
  id: number;
  cotizacion_id: number | null;
  proyecto_id: number | null;
  persona_id: number | null;
  tipo: TipoCosto;
  descripcion: string | null;
  monto: number;
  fecha: string;
  vendor: string | null;
  comprobante_url: string | null;
  agente_origen: string | null;
  shadow: boolean;
  notas: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export async function fetchCostosPorPersona(personaId: number): Promise<Costo[]> {
  const { data, error } = await supabase
    .from('costos_proyecto')
    .select('*')
    .eq('persona_id', personaId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('fecha', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Costo[];
}

export interface CrearCostoInput {
  cotizacion_id?: number | null;
  proyecto_id?: number | null;
  persona_id: number;
  tipo: TipoCosto;
  descripcion?: string | null;
  monto: number;
  fecha?: string;
  vendor?: string | null;
  comprobante_url?: string | null;
  notas?: string | null;
}

export async function crearCosto(input: CrearCostoInput): Promise<Costo> {
  const { data, error } = await supabase
    .from('costos_proyecto')
    .insert({
      cotizacion_id: input.cotizacion_id ?? null,
      proyecto_id: input.proyecto_id ?? null,
      persona_id: input.persona_id,
      tipo: input.tipo,
      descripcion: input.descripcion ?? null,
      monto: input.monto,
      fecha: input.fecha ?? new Date().toISOString().slice(0, 10),
      vendor: input.vendor ?? null,
      comprobante_url: input.comprobante_url ?? null,
      notas: input.notas ?? null,
      actualizado_por: 1,
    })
    .select('*').single();
  if (error) throw error;
  return data as Costo;
}

export async function actualizarCosto(id: number, patch: Partial<Costo>): Promise<void> {
  const { error } = await supabase
    .from('costos_proyecto')
    .update({ ...patch, actualizado_por: 1 })
    .eq('id', id);
  if (error) throw error;
}

export async function eliminarCosto(id: number): Promise<void> {
  const { error } = await supabase
    .from('costos_proyecto')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export interface ResumenRentabilidad {
  persona_id: number;
  persona_nombre: string;
  cotizaciones_ganadas: number;
  venta_total: number;
  costo_total: number;
  variaciones_neto: number;
  margen: number;
}

export async function fetchRentabilidadPorPersona(personaId: number): Promise<ResumenRentabilidad | null> {
  const { data, error } = await supabase
    .from('vw_rentabilidad')
    .select('*')
    .eq('persona_id', personaId)
    .maybeSingle();
  if (error) throw error;
  return data as ResumenRentabilidad | null;
}

// ═══════════════════════════════════════════════════════════════════════
// MÓDULO 4 — TÉCNICOS
// ═══════════════════════════════════════════════════════════════════════

export const ETAPAS_MEDIDA = ['cliente', 'empresa', 'corregida', 'produccion', 'instalada'] as const;
export type EtapaMedida = typeof ETAPAS_MEDIDA[number];

export interface Medida {
  id: number;
  cotizacion_item_id: number | null;
  persona_id: number | null;
  etapa: EtapaMedida;
  ancho_m: number | null;
  alto_m: number | null;
  area_m2: number | null;
  quien_midio: string | null;
  fecha: string;
  evidencia_url: string | null;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MedidaEtapas {
  item_id: number;
  cotizacion_id: number;
  persona_id: number;
  sistema_safra_codigo: string | null;
  ambiente: string | null;
  ancho_cotizado: number | null;
  alto_cotizado: number | null;
  ancho_cliente: number | null;
  alto_cliente: number | null;
  ancho_empresa: number | null;
  alto_empresa: number | null;
  ancho_corregida: number | null;
  alto_corregida: number | null;
  ancho_produccion: number | null;
  alto_produccion: number | null;
  ancho_instalada: number | null;
  alto_instalada: number | null;
}

export interface Advertencia {
  id: number;
  codigo: string;
  sistema_codigo: string | null;
  titulo: string;
  texto: string;
  severidad: 'info' | 'warning' | 'critico';
  contexto: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ReglaCompatibilidad {
  id: number;
  codigo: string;
  sistema_codigo: string | null;
  componente: string;
  valores_ok: string[] | null;
  valores_ko: string[] | null;
  regla: string | null;
  severidad: 'info' | 'warning' | 'critico';
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface RiesgoMedida {
  medida_id: number;
  cotizacion_item_id: number;
  persona_id: number;
  cotizacion_id: number;
  numero_cotizacion: string | null;
  sistema_safra_codigo: string | null;
  ambiente: string | null;
  etapa: EtapaMedida;
  ancho_m: number | null;
  alto_m: number | null;
  area_m2: number | null;
  quien_midio: string | null;
  fecha: string;
  tipo_riesgo: string | null;
  severidad: 'info' | 'warning' | 'critico' | null;
}

// ── Medidas (4.1) ────────────────────────────────────────────────────

export async function fetchMedidasPorItem(itemId: number): Promise<Medida[]> {
  const { data, error } = await supabase
    .from('medidas')
    .select('*')
    .eq('cotizacion_item_id', itemId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('etapa', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Medida[];
}

export async function fetchMedidasEtapasPorPersona(personaId: number): Promise<MedidaEtapas[]> {
  const { data, error } = await supabase
    .from('vw_medidas_etapas')
    .select('*')
    .eq('persona_id', personaId)
    .order('item_id', { ascending: false });
  if (error) throw error;
  return (data ?? []) as MedidaEtapas[];
}

export interface CrearMedidaInput {
  cotizacion_item_id: number;
  persona_id: number;
  etapa: EtapaMedida;
  ancho_m?: number | null;
  alto_m?: number | null;
  quien_midio?: string | null;
  fecha?: string;
  evidencia_url?: string | null;
  notas?: string | null;
}

export async function crearMedida(input: CrearMedidaInput): Promise<Medida> {
  const { data, error } = await supabase
    .from('medidas')
    .insert({
      cotizacion_item_id: input.cotizacion_item_id,
      persona_id: input.persona_id,
      etapa: input.etapa,
      ancho_m: input.ancho_m ?? null,
      alto_m: input.alto_m ?? null,
      quien_midio: input.quien_midio ?? null,
      fecha: input.fecha ?? new Date().toISOString().slice(0, 10),
      evidencia_url: input.evidencia_url ?? null,
      notas: input.notas ?? null,
      actualizado_por: 1,
    })
    .select('*').single();
  if (error) throw error;
  return data as Medida;
}

export async function actualizarMedida(id: number, patch: Partial<Medida>): Promise<void> {
  const { error } = await supabase
    .from('medidas')
    .update({ ...patch, actualizado_por: 1 })
    .eq('id', id);
  if (error) throw error;
}

export async function eliminarMedida(id: number): Promise<void> {
  const { error } = await supabase
    .from('medidas')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

// ── Riesgos (4.2) — vista ────────────────────────────────────────────

export async function fetchRiesgosPorPersona(personaId: number): Promise<RiesgoMedida[]> {
  const { data, error } = await supabase
    .from('vw_riesgos_medidas')
    .select('*')
    .eq('persona_id', personaId)
    .not('tipo_riesgo', 'is', null)
    .order('severidad', { ascending: true });   // critico < info por alfabético — invertimos en UI
  if (error) throw error;
  return (data ?? []) as RiesgoMedida[];
}

// ── Advertencias (4.4) ───────────────────────────────────────────────

export async function fetchAdvertenciasPorSistemas(sistemas: string[]): Promise<Advertencia[]> {
  if (sistemas.length === 0) {
    // Solo las globales (sin sistema)
    const { data, error } = await supabase
      .from('advertencias_safra')
      .select('*')
      .is('sistema_codigo', null)
      .is('deleted_at', null)
      .order('severidad', { ascending: true });
    if (error) throw error;
    return (data ?? []) as Advertencia[];
  }
  const { data, error } = await supabase
    .from('advertencias_safra')
    .select('*')
    .or(`sistema_codigo.in.(${sistemas.map(s => `"${s}"`).join(',')}),sistema_codigo.is.null`)
    .is('deleted_at', null)
    .order('severidad', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Advertencia[];
}

// ── Compatibilidad (4.5) ─────────────────────────────────────────────

export async function fetchReglasCompatibilidad(sistemaCodigo?: string): Promise<ReglaCompatibilidad[]> {
  let q = supabase.from('reglas_compatibilidad').select('*').is('deleted_at', null);
  if (sistemaCodigo) q = q.eq('sistema_codigo', sistemaCodigo);
  const { data, error } = await q.order('componente', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ReglaCompatibilidad[];
}

// ═══════════════════════════════════════════════════════════════════════
// MÓDULO 5 — OPERATIVOS
// ═══════════════════════════════════════════════════════════════════════

export const ESTADOS_PRODUCCION = [
  'pendiente_abono', 'pedido_proveedor', 'en_produccion',
  'listo_para_instalar', 'retenido', 'entregado', 'instalado',
] as const;
export type EstadoProduccion = typeof ESTADOS_PRODUCCION[number];

export const TIPOS_TAREA = [
  'llamar', 'enviar_cotizacion', 'confirmar_pago', 'pedir_ficha',
  'agendar_instalacion', 'reclamar_proveedor', 'pedir_resena', 'otro',
] as const;
export type TipoTarea = typeof TIPOS_TAREA[number];

export type ResultadoInstalacion = 'completa' | 'parcial' | 'fallida' | 'reagendada';
export type FaseChecklist = 'antes' | 'durante' | 'despues';

export interface ProduccionOrden {
  id: number;
  cotizacion_id: number | null;
  persona_id: number | null;
  estado: EstadoProduccion;
  fecha_inicio: string | null;
  fecha_estimada_lista: string | null;
  fecha_entrega: string | null;
  vendor: string | null;
  motivo_retencion: string | null;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Instalacion {
  id: number;
  cotizacion_id: number | null;
  proyecto_id: number | null;
  persona_id: number | null;
  zona_codigo: string | null;
  fecha_programada: string;
  hora_programada: string | null;
  fecha_real: string | null;
  hora_real: string | null;
  instalador: string | null;
  resultado: ResultadoInstalacion | null;
  fotos_urls: string[] | null;
  pendientes: string | null;
  incidencias: string | null;
  recibido_por_cliente: boolean;
  firma_cliente_url: string | null;
  saldo_cobrado: number | null;
  resena_pedida: boolean;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Tarea {
  id: number;
  persona_id: number | null;
  cotizacion_id: number | null;
  proyecto_id: number | null;
  titulo: string;
  descripcion: string | null;
  tipo: TipoTarea;
  fecha_vence: string | null;
  hora_vence: string | null;
  completada: boolean;
  completada_at: string | null;
  asignado_a: string | null;
  origen: 'manual' | 'chat' | 'agente' | 'sistema';
  origen_chat_id: number | null;
  prioridad: number;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ChecklistItem {
  id: number;
  instalacion_id: number;
  template_codigo: string | null;
  fase: FaseChecklist;
  descripcion: string;
  orden: number;
  completado: boolean;
  completado_at: string | null;
  foto_url: string | null;
  notas: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AgendaItem {
  tipo: 'instalacion' | 'tarea';
  source_id: number;
  persona_id: number | null;
  persona_nombre: string | null;
  cotizacion_id: number | null;
  numero_cotizacion: string | null;
  zona_codigo: string | null;
  fecha: string | null;
  hora: string | null;
  titulo: string;
  estado: string | null;
  prioridad: number;
}

// ── Producción (5.1) ─────────────────────────────────────────────────

export async function fetchProduccionPorPersona(personaId: number): Promise<ProduccionOrden[]> {
  const { data, error } = await supabase
    .from('produccion_orden')
    .select('*')
    .eq('persona_id', personaId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ProduccionOrden[];
}

export async function upsertProduccion(input: Partial<ProduccionOrden> & { cotizacion_id: number; persona_id: number }): Promise<ProduccionOrden> {
  // Si ya existe orden para la cotización, update; si no, insert
  const { data: existing } = await supabase
    .from('produccion_orden')
    .select('id').eq('cotizacion_id', input.cotizacion_id).is('deleted_at', null).maybeSingle();
  if (existing) {
    const { data, error } = await supabase
      .from('produccion_orden')
      .update({ ...input, actualizado_por: 1 })
      .eq('id', existing.id)
      .select('*').single();
    if (error) throw error;
    return data as ProduccionOrden;
  }
  const { data, error } = await supabase
    .from('produccion_orden')
    .insert({ ...input, actualizado_por: 1 })
    .select('*').single();
  if (error) throw error;
  return data as ProduccionOrden;
}

export async function cambiarEstadoProduccion(id: number, estado: EstadoProduccion, motivo?: string): Promise<void> {
  const patch: any = { estado, actualizado_por: 1 };
  if (estado === 'retenido' && motivo) patch.motivo_retencion = motivo;
  if (estado === 'entregado' && !patch.fecha_entrega) patch.fecha_entrega = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('produccion_orden').update(patch).eq('id', id);
  if (error) throw error;
}

// ── Instalaciones (5.2) ──────────────────────────────────────────────

export async function fetchInstalacionesPorPersona(personaId: number): Promise<Instalacion[]> {
  const { data, error } = await supabase
    .from('instalaciones')
    .select('*')
    .eq('persona_id', personaId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('fecha_programada', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Instalacion[];
}

export interface CrearInstalacionInput {
  cotizacion_id?: number | null;
  proyecto_id?: number | null;
  persona_id: number;
  zona_codigo?: string | null;
  fecha_programada: string;
  hora_programada?: string | null;
  instalador?: string | null;
  notas?: string | null;
}

export async function crearInstalacion(input: CrearInstalacionInput): Promise<Instalacion> {
  const { data, error } = await supabase
    .from('instalaciones')
    .insert({ ...input, actualizado_por: 1 })
    .select('*').single();
  if (error) throw error;
  return data as Instalacion;
}

export async function actualizarInstalacion(id: number, patch: Partial<Instalacion>): Promise<void> {
  const { error } = await supabase.from('instalaciones').update({ ...patch, actualizado_por: 1 }).eq('id', id);
  if (error) throw error;
}

export async function eliminarInstalacion(id: number): Promise<void> {
  const { error } = await supabase.from('instalaciones').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// ── Tareas (5.5) ─────────────────────────────────────────────────────

export async function fetchTareasPorPersona(personaId: number, incluirCompletadas = false): Promise<Tarea[]> {
  let q = supabase.from('tareas').select('*').eq('persona_id', personaId).eq('shadow', false).is('deleted_at', null);
  if (!incluirCompletadas) q = q.eq('completada', false);
  const { data, error } = await q.order('fecha_vence', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as Tarea[];
}

export async function fetchTareasGlobal(incluirCompletadas = false): Promise<Tarea[]> {
  let q = supabase.from('tareas').select('*').eq('shadow', false).is('deleted_at', null);
  if (!incluirCompletadas) q = q.eq('completada', false);
  const { data, error } = await q.order('fecha_vence', { ascending: true, nullsFirst: false }).limit(200);
  if (error) throw error;
  return (data ?? []) as Tarea[];
}

export interface TareaConPersona extends Tarea {
  persona: { id: number; nombre: string | null } | null;
}

/** Igual que fetchTareasGlobal pero embebe la persona vinculada (nombre, id).
 * Usado en visualizaciones cross-cliente cuando hace falta el nombre. */
export async function fetchTareasGlobalConPersona(incluirCompletadas = false): Promise<TareaConPersona[]> {
  let q = supabase.from('tareas')
    .select('*, persona:personas(id, nombre)')
    .eq('shadow', false).is('deleted_at', null);
  if (!incluirCompletadas) q = q.eq('completada', false);
  const { data, error } = await q.order('fecha_vence', { ascending: true, nullsFirst: false }).limit(500);
  if (error) throw error;
  return (data ?? []) as TareaConPersona[];
}

/** Tareas TRANSVERSALES (sin cliente vinculado): persona_id IS NULL.
 * Son las que nacen en el chat con Junior o que Jhon crea como acciones
 * personales / cross-cliente / con terceros (proveedores, instaladores, etc.).
 * Las tareas DE cliente (persona_id != null) viven en M5 del cliente, no acá. */
export async function fetchTareasTransversales(incluirCompletadas = false): Promise<Tarea[]> {
  let q = supabase.from('tareas')
    .select('*').is('persona_id', null)
    .eq('shadow', false).is('deleted_at', null);
  if (!incluirCompletadas) q = q.eq('completada', false);
  const { data, error } = await q.order('fecha_vence', { ascending: true, nullsFirst: false }).limit(500);
  if (error) throw error;
  return (data ?? []) as Tarea[];
}

/** Lista mínima de personas con id+nombre para el selector del modal de tareas. */
export async function fetchPersonasMinimo(): Promise<{ id: number; nombre: string | null }[]> {
  const { data, error } = await supabase.from('personas')
    .select('id, nombre').is('deleted_at', null).order('nombre');
  if (error) throw error;
  return (data ?? []) as { id: number; nombre: string | null }[];
}

export interface CrearTareaInput {
  persona_id?: number | null;
  cotizacion_id?: number | null;
  proyecto_id?: number | null;
  titulo: string;
  descripcion?: string | null;
  tipo?: TipoTarea;
  fecha_vence?: string | null;
  hora_vence?: string | null;
  asignado_a?: string | null;
  origen?: 'manual' | 'chat' | 'agente' | 'sistema';
  origen_chat_id?: number | null;
  prioridad?: number;
}

export async function crearTarea(input: CrearTareaInput): Promise<Tarea> {
  const { data, error } = await supabase
    .from('tareas')
    .insert({ ...input, tipo: input.tipo ?? 'otro', origen: input.origen ?? 'manual', actualizado_por: 1 })
    .select('*').single();
  if (error) throw error;
  return data as Tarea;
}

export async function actualizarTarea(id: number, patch: Partial<Tarea>): Promise<void> {
  const extra: any = { actualizado_por: 1 };
  if (patch.completada === true && !patch.completada_at) extra.completada_at = new Date().toISOString();
  const { error } = await supabase.from('tareas').update({ ...patch, ...extra }).eq('id', id);
  if (error) throw error;

  // CASCADA FRONTEND: Si se completa la tarea, borrar su agendamiento vinculado
  if (patch.completada === true) {
    await supabase.from('agendamientos')
      .update({ deleted_at: new Date().toISOString() } as any)
      .eq('notas', `Sincronizado desde tarea #${id}`)
      .is('deleted_at', null);
  }
}

export async function eliminarTarea(id: number): Promise<void> {
  const { error } = await supabase.from('tareas').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;

  // CASCADA FRONTEND: Si se elimina la tarea, borrar su agendamiento vinculado
  await supabase.from('agendamientos')
    .update({ deleted_at: new Date().toISOString() } as any)
    .eq('notas', `Sincronizado desde tarea #${id}`)
    .is('deleted_at', null);
}

// ── Checklist (5.6) ──────────────────────────────────────────────────

export async function fetchChecklistDeInstalacion(instalacionId: number): Promise<ChecklistItem[]> {
  const { data, error } = await supabase
    .from('checklist_instalacion_items')
    .select('*')
    .eq('instalacion_id', instalacionId)
    .is('deleted_at', null)
    .order('fase', { ascending: true })
    .order('orden', { ascending: true });
  if (error) throw error;
  return (data ?? []) as ChecklistItem[];
}

export async function marcarChecklistItem(id: number, completado: boolean, foto_url?: string | null, notas?: string | null): Promise<void> {
  const patch: any = { completado };
  if (completado) patch.completado_at = new Date().toISOString();
  else patch.completado_at = null;
  if (foto_url !== undefined) patch.foto_url = foto_url;
  if (notas !== undefined) patch.notas = notas;
  const { error } = await supabase.from('checklist_instalacion_items').update(patch).eq('id', id);
  if (error) throw error;
}

// ── Agenda operativa (5.3) ───────────────────────────────────────────

export async function fetchAgendaPorRango(desde?: string, hasta?: string): Promise<AgendaItem[]> {
  let q = supabase.from('vw_agenda_operativa').select('*');
  if (desde) q = q.gte('fecha', desde);
  if (hasta) q = q.lte('fecha', hasta);
  const { data, error } = await q.order('fecha', { ascending: true, nullsFirst: false }).order('hora', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as AgendaItem[];
}

// ── Zonas (5.4) ──────────────────────────────────────────────────────

export interface Zona {
  codigo: string;
  nombre: string;
  costo_traslado_incluido: boolean;
  notas: string | null;
  orden: number;
}

export async function fetchZonas(): Promise<Zona[]> {
  const { data, error } = await supabase.from('zonas_instalacion').select('*').order('orden');
  if (error) throw error;
  return (data ?? []) as Zona[];
}

// ═══════════════════════════════════════════════════════════════════════
// MÓDULO 6 — POSTVENTA
// ═══════════════════════════════════════════════════════════════════════

export type EstadoGarantia = 'abierta' | 'en_diagnostico' | 'en_reparacion' | 'resuelta' | 'rechazada' | 'cerrada';
export type ResponsableGarantia = 'empresa' | 'cliente' | 'tercero';
export const TIPOS_MANTENIMIENTO = ['lavado','perfilado','cambio_cadenilla','cambio_control','cambio_tubo','nivelacion','ajuste_soporte','cambio_peso_inferior','otro'] as const;
export type TipoMantenimiento = typeof TIPOS_MANTENIMIENTO[number];
export type ResultadoMantenimiento = 'completo' | 'parcial' | 'no_aplicable' | 'pendiente_repuesto' | 'reagendado';
export type EstadoSatisfaccion = 'feliz' | 'confundido' | 'molesto' | 'sin_respuesta' | 'pendiente_ajuste';
export type EstadoReview = 'no_apto' | 'apto' | 'solicitada' | 'recibida' | 'rechazada_cliente' | 'ignorada';
export const MOTIVOS_RECLAMO = ['cliente_molesto','garantia_mal_manejada','dano_costoso','publicacion_negativa','mala_resena','incumplimiento','otro'] as const;
export type MotivoReclamo = typeof MOTIVOS_RECLAMO[number];
export type SeveridadReclamo = 'baja' | 'media' | 'alta' | 'critica';
export type EstadoReclamo = 'abierto' | 'en_contencion' | 'escalado' | 'resuelto' | 'cerrado_negativo';

export interface CausaGarantia {
  codigo: string;
  nombre: string;
  responsable_default: ResponsableGarantia;
  notas: string | null;
}

export interface Garantia {
  id: number;
  cotizacion_id: number | null;
  instalacion_id: number | null;
  persona_id: number | null;
  sistema_safra_codigo: string | null;
  fecha_apertura: string;
  causa_codigo: string;
  responsable: ResponsableGarantia | null;
  costo: number;
  solucion: string | null;
  estado: EstadoGarantia;
  fecha_cierre: string | null;
  evidencia_urls: string[] | null;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Mantenimiento {
  id: number;
  cotizacion_id: number | null;
  persona_id: number | null;
  tipo: TipoMantenimiento;
  fecha_programada: string | null;
  fecha_real: string | null;
  instalador: string | null;
  costo: number;
  resultado: ResultadoMantenimiento | null;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface SatisfaccionPostventa {
  id: number;
  instalacion_id: number | null;
  cotizacion_id: number | null;
  persona_id: number | null;
  estado_cliente: EstadoSatisfaccion;
  fecha_check: string;
  fuente: string | null;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface GoogleReview {
  id: number;
  persona_id: number | null;
  cotizacion_id: number | null;
  apto_para_resena: boolean;
  solicitud_enviada_at: string | null;
  resena_recibida_at: string | null;
  estrellas: number | null;
  comentario: string | null;
  url_resena: string | null;
  estado: EstadoReview;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ReclamoSensible {
  id: number;
  persona_id: number | null;
  cotizacion_id: number | null;
  garantia_id: number | null;
  motivo: MotivoReclamo;
  severidad: SeveridadReclamo;
  estado: EstadoReclamo;
  escalado_a: string | null;
  fecha_apertura: string;
  fecha_resolucion: string | null;
  acciones_tomadas: string | null;
  resultado: string | null;
  notas: string | null;
  agente_origen: string | null;
  shadow: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface Reputacion {
  reviews_total: number;
  estrellas_promedio: number | null;
  cinco_estrellas: number;
  tres_o_menos: number;
  solicitadas_pendientes: number;
  aptos_sin_solicitar: number;
  clientes_felices: number;
  clientes_molestos: number;
  reclamos_activos: number;
  reclamos_alta_severidad: number;
}

// ── Catálogo de causas (existente desde 003) ────────────────────────

export async function fetchCausasGarantia(): Promise<CausaGarantia[]> {
  const { data, error } = await supabase.from('causas_garantia').select('*').order('codigo');
  if (error) throw error;
  return (data ?? []) as CausaGarantia[];
}

// ── Garantías (6.1) ──────────────────────────────────────────────────

export async function fetchGarantiasPorPersona(personaId: number): Promise<Garantia[]> {
  const { data, error } = await supabase
    .from('garantias')
    .select('*')
    .eq('persona_id', personaId)
    .eq('shadow', false)
    .is('deleted_at', null)
    .order('fecha_apertura', { ascending: false });
  if (error) throw error;
  return (data ?? []) as Garantia[];
}

export interface CrearGarantiaInput {
  cotizacion_id?: number | null;
  instalacion_id?: number | null;
  persona_id: number;
  sistema_safra_codigo?: string | null;
  fecha_apertura?: string;
  causa_codigo: string;
  responsable?: ResponsableGarantia | null;
  costo?: number;
  solucion?: string | null;
  estado?: EstadoGarantia;
  notas?: string | null;
}

export async function crearGarantia(input: CrearGarantiaInput): Promise<Garantia> {
  const { data, error } = await supabase
    .from('garantias')
    .insert({
      cotizacion_id: input.cotizacion_id ?? null,
      instalacion_id: input.instalacion_id ?? null,
      persona_id: input.persona_id,
      sistema_safra_codigo: input.sistema_safra_codigo ?? null,
      fecha_apertura: input.fecha_apertura ?? new Date().toISOString().slice(0, 10),
      causa_codigo: input.causa_codigo,
      responsable: input.responsable ?? null,
      costo: input.costo ?? 0,
      solucion: input.solucion ?? null,
      estado: input.estado ?? 'abierta',
      notas: input.notas ?? null,
      actualizado_por: 1,
    })
    .select('*').single();
  if (error) throw error;
  return data as Garantia;
}

export async function actualizarGarantia(id: number, patch: Partial<Garantia>): Promise<void> {
  const { error } = await supabase.from('garantias').update({ ...patch, actualizado_por: 1 }).eq('id', id);
  if (error) throw error;
}

export async function eliminarGarantia(id: number): Promise<void> {
  const { error } = await supabase.from('garantias').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// ── Mantenimientos (6.2) ─────────────────────────────────────────────

export async function fetchMantenimientosPorPersona(personaId: number): Promise<Mantenimiento[]> {
  const { data, error } = await supabase
    .from('mantenimientos').select('*')
    .eq('persona_id', personaId).eq('shadow', false).is('deleted_at', null)
    .order('fecha_programada', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return (data ?? []) as Mantenimiento[];
}

export interface CrearMantenimientoInput {
  cotizacion_id?: number | null;
  persona_id: number;
  tipo: TipoMantenimiento;
  fecha_programada?: string | null;
  fecha_real?: string | null;
  instalador?: string | null;
  costo?: number;
  resultado?: ResultadoMantenimiento | null;
  notas?: string | null;
}

export async function crearMantenimiento(input: CrearMantenimientoInput): Promise<Mantenimiento> {
  const { data, error } = await supabase
    .from('mantenimientos')
    .insert({ ...input, costo: input.costo ?? 0, actualizado_por: 1 })
    .select('*').single();
  if (error) throw error;
  return data as Mantenimiento;
}

export async function actualizarMantenimiento(id: number, patch: Partial<Mantenimiento>): Promise<void> {
  const { error } = await supabase.from('mantenimientos').update({ ...patch, actualizado_por: 1 }).eq('id', id);
  if (error) throw error;
}

export async function eliminarMantenimiento(id: number): Promise<void> {
  const { error } = await supabase.from('mantenimientos').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// ── Satisfacción (6.3) ───────────────────────────────────────────────

export async function fetchSatisfaccionPorPersona(personaId: number): Promise<SatisfaccionPostventa[]> {
  const { data, error } = await supabase
    .from('satisfaccion_postventa').select('*')
    .eq('persona_id', personaId).eq('shadow', false).is('deleted_at', null)
    .order('fecha_check', { ascending: false });
  if (error) throw error;
  return (data ?? []) as SatisfaccionPostventa[];
}

export interface CrearSatisfaccionInput {
  instalacion_id?: number | null;
  cotizacion_id?: number | null;
  persona_id: number;
  estado_cliente: EstadoSatisfaccion;
  fecha_check?: string;
  fuente?: string | null;
  notas?: string | null;
}

export async function crearSatisfaccion(input: CrearSatisfaccionInput): Promise<SatisfaccionPostventa> {
  const { data, error } = await supabase
    .from('satisfaccion_postventa')
    .insert({ ...input, actualizado_por: 1 })
    .select('*').single();
  if (error) throw error;
  return data as SatisfaccionPostventa;
}

// ── Google Reviews (6.4) ─────────────────────────────────────────────

export async function fetchReviewsPorPersona(personaId: number): Promise<GoogleReview[]> {
  const { data, error } = await supabase
    .from('google_reviews').select('*')
    .eq('persona_id', personaId).eq('shadow', false).is('deleted_at', null)
    .order('updated_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as GoogleReview[];
}

export async function upsertReview(personaId: number, cotizacionId: number | null, patch: Partial<GoogleReview>): Promise<GoogleReview> {
  let existingId: number | null = null;
  if (cotizacionId) {
    const { data } = await supabase.from('google_reviews')
      .select('id').eq('persona_id', personaId).eq('cotizacion_id', cotizacionId).is('deleted_at', null).maybeSingle();
    existingId = data?.id ?? null;
  }
  if (existingId) {
    const { data, error } = await supabase
      .from('google_reviews')
      .update({ ...patch, actualizado_por: 1 })
      .eq('id', existingId).select('*').single();
    if (error) throw error;
    return data as GoogleReview;
  }
  const { data, error } = await supabase
    .from('google_reviews')
    .insert({ persona_id: personaId, cotizacion_id: cotizacionId, ...patch, actualizado_por: 1 })
    .select('*').single();
  if (error) throw error;
  return data as GoogleReview;
}

// ── Reclamos sensibles (6.5) ─────────────────────────────────────────

export async function fetchReclamosPorPersona(personaId: number): Promise<ReclamoSensible[]> {
  const { data, error } = await supabase
    .from('reclamos_sensibles').select('*')
    .eq('persona_id', personaId).eq('shadow', false).is('deleted_at', null)
    .order('severidad', { ascending: false })  // critica > alta > media > baja alfabéticamente
    .order('fecha_apertura', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ReclamoSensible[];
}

export interface CrearReclamoInput {
  persona_id: number;
  cotizacion_id?: number | null;
  garantia_id?: number | null;
  motivo: MotivoReclamo;
  severidad?: SeveridadReclamo;
  escalado_a?: string | null;
  acciones_tomadas?: string | null;
  notas?: string | null;
}

export async function crearReclamo(input: CrearReclamoInput): Promise<ReclamoSensible> {
  const { data, error } = await supabase
    .from('reclamos_sensibles')
    .insert({ ...input, severidad: input.severidad ?? 'media', actualizado_por: 1 })
    .select('*').single();
  if (error) throw error;
  return data as ReclamoSensible;
}

export async function actualizarReclamo(id: number, patch: Partial<ReclamoSensible>): Promise<void> {
  const extra: any = { actualizado_por: 1 };
  if (patch.estado === 'resuelto' && !patch.fecha_resolucion) extra.fecha_resolucion = new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('reclamos_sensibles').update({ ...patch, ...extra }).eq('id', id);
  if (error) throw error;
}

// ── Reputación global ────────────────────────────────────────────────

export async function fetchReputacion(): Promise<Reputacion | null> {
  const { data, error } = await supabase.from('vw_reputacion').select('*').maybeSingle();
  if (error) throw error;
  return data as Reputacion | null;
}

// ═══════════════════════════════════════════════════════════════════════
// MÓDULO 7 — EVIDENCIAS
// ═══════════════════════════════════════════════════════════════════════

export const TIPOS_EVIDENCIA = ['foto','video','audio','comprobante','factura','cotizacion_pdf','pdf','imagen_medida','documento','otro'] as const;
export type TipoEvidencia = typeof TIPOS_EVIDENCIA[number];

export interface Evidencia {
  id: number;
  persona_id: number | null;
  cotizacion_id: number | null;
  instalacion_id: number | null;
  factura_id: number | null;
  abono_id: number | null;
  garantia_id: number | null;
  evento_pg_id: number | null;
  tipo: TipoEvidencia;
  url: string;
  mime: string | null;
  bytes: number | null;
  descripcion: string | null;
  capturado_por: string | null;
  texto_extraido: string | null;
  fecha: string;
  agente_origen: string | null;
  shadow: boolean;
  notas: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface EvidenciaUnificada {
  uid: string;
  fuente: 'evidencia_manual' | 'mensaje_wa' | 'abono_comprobante' | 'instalacion_foto' | 'garantia_evidencia';
  source_id: number;
  persona_id: number | null;
  tipo: TipoEvidencia | 'otro';
  url: string | null;
  mime: string | null;
  descripcion: string | null;
  quien: string | null;
  texto_extraido: string | null;
  ts: string;
  cotizacion_id: number | null;
  instalacion_id: number | null;
  factura_id: number | null;
  abono_id: number | null;
  garantia_id: number | null;
  evento_pg_id: number | null;
}

export async function fetchEvidenciasPorPersona(personaId: number): Promise<EvidenciaUnificada[]> {
  const { data, error } = await supabase
    .from('vw_evidencias_unificadas')
    .select('*')
    .eq('persona_id', personaId)
    .order('ts', { ascending: false });
  if (error) throw error;
  return (data ?? []) as EvidenciaUnificada[];
}

export async function fetchEvidenciasGlobal(): Promise<EvidenciaUnificada[]> {
  const { data, error } = await supabase
    .from('vw_evidencias_unificadas')
    .select('*')
    .order('ts', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as EvidenciaUnificada[];
}

export async function fetchTranscripcionesAudioGlobal(): Promise<{
  id: number; chat_id: number; texto: string; ts_canal: string;
  media_url: string | null; persona_nombre: string | null;
}[]> {
  const { data, error } = await supabase
    .from('mensajes')
    .select('id, chat_id, texto, ts_canal, media_url, chats!inner(proyectos(personas(nombre)))')
    .eq('tipo', 'audio')
    .not('texto', 'is', null)
    .is('deleted_at', null)
    .order('ts_canal', { ascending: false })
    .limit(300);
  if (error) throw error;
  return (data ?? []).map((r: any) => ({
    id: r.id, chat_id: r.chat_id, texto: r.texto, ts_canal: r.ts_canal,
    media_url: r.media_url,
    persona_nombre: r.chats?.proyectos?.personas?.nombre ?? null,
  }));
}

export interface CrearEvidenciaInput {
  persona_id: number;
  cotizacion_id?: number | null;
  instalacion_id?: number | null;
  factura_id?: number | null;
  abono_id?: number | null;
  garantia_id?: number | null;
  evento_pg_id?: number | null;
  tipo: TipoEvidencia;
  url: string;
  mime?: string | null;
  bytes?: number | null;
  descripcion?: string | null;
  capturado_por?: string | null;
  texto_extraido?: string | null;
  fecha?: string;
  notas?: string | null;
}

export async function crearEvidencia(input: CrearEvidenciaInput): Promise<Evidencia> {
  const { data, error } = await supabase
    .from('evidencias')
    .insert({ ...input, actualizado_por: 1 })
    .select('*').single();
  if (error) throw error;
  return data as Evidencia;
}

export async function actualizarEvidencia(id: number, patch: Partial<Evidencia>): Promise<void> {
  const { error } = await supabase.from('evidencias').update({ ...patch, actualizado_por: 1 }).eq('id', id);
  if (error) throw error;
}

export async function eliminarEvidencia(id: number): Promise<void> {
  const { error } = await supabase.from('evidencias').update({ deleted_at: new Date().toISOString() }).eq('id', id);
  if (error) throw error;
}

// Para eventos con evidencia
// ═══════════════════════════════════════════════════════════════════════
// MÓDULO TRANSVERSAL — CONJUNTOS RESIDENCIALES (Gestor_Prospectos sync)
// ═══════════════════════════════════════════════════════════════════════

export interface Conjunto {
  id: number;
  nombre: string;
  sector: string;
  direccion: string | null;
  estado_prospeccion: 'pendiente' | 'visitado' | 'cliente' | 'descartado';
  prioridad: number;
  administracion_contacto: string | null;
  porteria_telefono: string | null;
  zona_codigo: string | null;
  ciudad: string | null;
  last_visit: string | null;
}

export interface ConjuntoResumen extends Conjunto {
  inmuebles_vinculados: number;
  personas_clientes: number;
  cotizaciones_ganadas: number;
  ingreso_total_conjunto: number;
}

export async function fetchConjuntos(filtroNombre?: string, sector?: string): Promise<Conjunto[]> {
  let q = supabase.from('conjuntos').select('*').is('deleted_at', null);
  if (sector) q = q.eq('sector', sector);
  if (filtroNombre) q = q.ilike('nombre', `%${filtroNombre}%`);
  const { data, error } = await q.order('prioridad', { ascending: false }).order('nombre').limit(200);
  if (error) throw error;
  return (data ?? []) as Conjunto[];
}

export async function fetchConjuntosResumen(): Promise<ConjuntoResumen[]> {
  const { data, error } = await supabase.from('vw_conjuntos_resumen')
    .select('*')
    .order('personas_clientes', { ascending: false })
    .order('prioridad', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as ConjuntoResumen[];
}

export async function fetchSectores(): Promise<string[]> {
  const { data, error } = await supabase.from('conjuntos').select('sector').is('deleted_at', null);
  if (error) return [];
  return [...new Set((data ?? []).map((r: any) => r.sector))].sort();
}

// ═══════════════════════════════════════════════════════════════════════
// PLANTILLAS DE RESPUESTA WHATSAPP (auto-respuestas curadas)
// ═══════════════════════════════════════════════════════════════════════

export interface PlantillaRespuesta {
  id: number;
  codigo: string;
  tipo: 'bienvenida'|'ausencia'|'recibido'|'cierre'|'agradecimiento'|'garantia_recibida'|'medida_recibida'|'cita_confirmada'|'otro';
  texto: string;
  activo: boolean;
  prioridad: number;
  variables: string[] | null;
  notas: string | null;
}

export async function fetchPlantillasRespuesta(tipo?: string): Promise<PlantillaRespuesta[]> {
  let q = supabase.from('plantillas_respuesta').select('*').eq('activo', true);
  if (tipo) q = q.eq('tipo', tipo);
  const { data, error } = await q.order('prioridad', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PlantillaRespuesta[];
}

// ═══════════════════════════════════════════════════════════════════════
// PERSONAS MENCIONADAS (base para agente A-Geo futuro)
// ═══════════════════════════════════════════════════════════════════════

export interface PersonaMencionada {
  id: number;
  persona_id: number | null;
  nombre_mencionado: string;
  rol_inferido: string | null;
  persona_referida_id: number | null;
  conjunto_id: number | null;
  contexto: string | null;
  confianza: string | null;
  created_at: string;
}

export async function fetchPersonasMencionadasPorPersona(personaId: number): Promise<PersonaMencionada[]> {
  const { data, error } = await supabase
    .from('personas_mencionadas').select('*')
    .eq('persona_id', personaId).is('deleted_at', null)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as PersonaMencionada[];
}

export async function fetchEventosConEvidenciaPorPersona(personaId: number): Promise<any[]> {
  // Usa el chat_id del proyecto del cliente activo. Buscamos eventos de chats
  // pertenecientes a proyectos del cliente, con evidencia_ids no vacío.
  const { data, error } = await supabase
    .from('evento_pg')
    .select('id, tipo, ts_canal, payload, evidencia_ids, chat_id, chats(proyectos(persona_id))')
    .not('evidencia_ids', 'is', null)
    .order('ts_canal', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []).filter((e: any) => e.chats?.proyectos?.persona_id === personaId);
}

// ─── Eventos (detalle + linaje) ──────────────────────────────────────

export async function fetchEventoDetalle(eventoId: number): Promise<any | null> {
  const { data, error } = await supabase
    .from('evento_pg')
    .select('*')
    .eq('id', eventoId)
    .single();
  if (error) return null;
  return data;
}

export interface MensajeExpandido {
  id: number;
  canal_msg_id: string;
  tipo: string;
  direccion: 'entrante' | 'saliente';
  texto: string | null;
  ai_text: string | null;
  ai_kind: string | null;
  ai_status: string | null;
  download_status: string | null;
  ts_canal: string;
}

/** Trae los mensajes citados por un evento (via evidencia_ids.msg_ids), con texto completo + ai_text. */
export async function fetchMensajesEvidencia(canalMsgIds: string[]): Promise<MensajeExpandido[]> {
  if (!canalMsgIds?.length) return [];
  const { data, error } = await supabase
    .from('mensajes')
    .select('id, canal_msg_id, tipo, direccion, texto, metadata, ts_canal')
    .in('canal_msg_id', canalMsgIds)
    .is('deleted_at', null)
    .order('ts_canal', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((m: any) => ({
    id: m.id,
    canal_msg_id: m.canal_msg_id,
    tipo: m.tipo,
    direccion: m.direccion,
    texto: m.texto,
    ai_text: m.metadata?.ai_text ?? null,
    ai_kind: m.metadata?.ai_kind ?? null,
    ai_status: m.metadata?.ai_status ?? null,
    download_status: m.metadata?.download_status ?? null,
    ts_canal: m.ts_canal,
  }));
}

export async function fetchLinajeEvento(eventoId: number): Promise<any[]> {
  // Cadena ascendente: del evento actual hacia su raíz (siguiendo evento_padre_id).
  // F1.22 fix C4: detectar ciclos con Set de ids vistos para no hacer queries
  // redundantes si por bug existe un ciclo en evento_padre_id.
  const cadena: any[] = [];
  const vistos = new Set<number>();
  let actualId: number | null = eventoId;
  while (actualId !== null && cadena.length < 30) {
    if (vistos.has(actualId)) {
      console.warn(`[fetchLinajeEvento] ciclo detectado en evento_padre_id en id=${actualId}, cortando`);
      break;
    }
    vistos.add(actualId);
    const evt: any = await fetchEventoDetalle(actualId);
    if (!evt) break;
    cadena.push(evt);
    actualId = evt.evento_padre_id;
  }
  return cadena.reverse();  // de raíz a hoja
}

export async function fetchEventosHijos(eventoId: number): Promise<any[]> {
  const { data, error } = await supabase
    .from('evento_pg')
    .select('id, tipo_evento, agente_origen, confianza, ts_canal, payload, estado')
    .eq('evento_padre_id', eventoId)
    .order('ts_creado', { ascending: true });
  if (error) return [];
  return data ?? [];
}

// ─── Buzón de validación (acciones humanas) ──────────────────────────

export async function aprobarItemBuzon(itemId: number, comentario?: string): Promise<void> {
  // RPC atómica: marca el buzón como aprobado y, si el ítem tiene
  // entidad polimórfica (cotizacion / abono / medida / etc), levanta su
  // shadow=false para que aparezca en el módulo correspondiente.
  // Antes esto era un UPDATE plano que solo cambiaba estado, dejando la
  // entidad shadow huérfana → el ítem nunca llegaba a M2/M3/etc.
  const { error } = await supabase.rpc('aprobar_buzon_atomic', {
    p_buzon_id: itemId,
    p_resuelto_por: 1, // Jhon (rol dueño) por ahora
    p_comentario: comentario ?? null,
  });
  if (error) throw error;
}

export async function rechazarItemBuzon(itemId: number, motivo: string): Promise<void> {
  const { error } = await supabase
    .from('buzon_validacion')
    .update({
      estado: 'rechazado',
      resuelto_at: new Date().toISOString(),
      comentario_humano: motivo,
      resuelto_por: 1,
    })
    .eq('id', itemId);
  if (error) throw error;
}

export async function editarYAprobarItemBuzon(
  itemId: number,
  edicion: Record<string, any>,
  motivoEdicion: string,
): Promise<void> {
  // F1.22 fix C3: ATÓMICO via RPC. Antes se hacían 4 operaciones secuenciales sin
  // transacción → si fallaba a mitad el buzón quedaba 'editado' sin correcciones.
  const { data: item, error: errLoad } = await supabase
    .from('buzon_validacion')
    .select('detalle, evento_id, persona_id, proyecto_id, ambito')
    .eq('id', itemId)
    .single();
  if (errLoad || !item) throw errLoad ?? new Error('item no encontrado');

  const correccionesPayload = Object.keys(edicion).map(campo => ({
    campo,
    valor_original: item.detalle?.[campo] ?? null,
    valor_corregido: edicion[campo],
    motivo: motivoEdicion,
  }));

  const { error } = await supabase.rpc('editar_y_aprobar_buzon_atomic', {
    p_item_id: itemId,
    p_edicion: edicion,
    p_correcciones: correccionesPayload,
    p_evento_origen: item.evento_id,
    p_persona_id: item.persona_id,
    p_proyecto_id: item.proyecto_id,
    p_ambito: item.ambito ?? 'comercial',
    p_resuelto_por: 1,
    p_comentario: motivoEdicion,
  });
  if (error) throw error;
}

// Configuración global
export async function fetchConfiguracion(claves: string[]): Promise<Record<string, any>> {
  const { data, error } = await supabase
    .from('configuracion_sistema')
    .select('clave, valor')
    .in('clave', claves);
  if (error) throw error;
  const out: Record<string, any> = {};
  for (const row of data ?? []) out[row.clave] = row.valor;
  return out;
}

// Guarda (upsert) una clave de configuración global.
export async function guardarConfiguracion(clave: string, valor: any): Promise<void> {
  const { error } = await supabase
    .from('configuracion_sistema')
    .upsert({ clave, valor, actualizado_at: new Date().toISOString() }, { onConflict: 'clave' });
  if (error) throw error;
}

// Estimación de costo de procesamiento de un chat
export async function estimarCostoChat(chatId: number): Promise<{ mensajes_total: number; mensajes_texto: number; mensajes_media: number; costo_estimado_usd: number }> {
  const { data: msgs } = await supabase
    .from('mensajes')
    .select('tipo')
    .eq('chat_id', chatId)
    .is('deleted_at', null);
  const total = msgs?.length ?? 0;
  const media = (msgs ?? []).filter(m => ['imagen','audio','video','documento'].includes(m.tipo)).length;
  const texto = total - media;

  const cfg = await fetchConfiguracion(['ia_costo_estimado_por_mensaje_texto_usd', 'ia_costo_estimado_por_mensaje_media_usd']);
  const costoTexto = Number(cfg.ia_costo_estimado_por_mensaje_texto_usd ?? 0.0007);
  const costoMedia = Number(cfg.ia_costo_estimado_por_mensaje_media_usd ?? 0.005);
  return {
    mensajes_total: total,
    mensajes_texto: texto,
    mensajes_media: media,
    costo_estimado_usd: texto * costoTexto + media * costoMedia,
  };
}

export async function fetchMensajesByChat(chatId: number): Promise<Mensaje[]> {
  const { data, error } = await supabase
    .from('mensajes')
    .select('id, chat_id, direccion, tipo, texto, ts_canal')
    .eq('chat_id', chatId)
    .is('deleted_at', null)
    .order('ts_canal', { ascending: true })
    .limit(200);
  if (error) throw error;

  return (data ?? []).map(m => ({
    id: m.id,
    chat_id: m.chat_id,
    direccion: m.direccion as 'entrante' | 'saliente',
    tipo: (m.tipo as any) ?? 'texto',
    texto: m.texto ?? undefined,
    ts: m.ts_canal,
  }));
}

export async function fetchPersonas(): Promise<Persona[]> {
  const { data, error } = await supabase
    .from('personas')
    .select('id, nombre, alias, telefono_e164, email, ambito_principal, ciudad, rol, notas, empresa, referido_por_persona_id, contacto_alterno_nombre, contacto_alterno_telefono')
    .is('deleted_at', null)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []).map((p: any) => ({
    id: p.id,
    nombre: p.nombre ?? '(sin nombre)',
    alias: p.alias ?? undefined,
    telefono: p.telefono_e164 ?? undefined,
    email: p.email ?? undefined,
    ambito: (p.ambito_principal ?? 'comercial') as Ambito,
    ciudad: p.ciudad ?? undefined,
    rol: p.rol ?? undefined,
    notas: p.notas ?? undefined,
    empresa: p.empresa ?? undefined,
    referido_por_persona_id: p.referido_por_persona_id ?? undefined,
    contacto_alterno_nombre: p.contacto_alterno_nombre ?? undefined,
    contacto_alterno_telefono: p.contacto_alterno_telefono ?? undefined,
  }));
}

export async function fetchInmuebles(): Promise<Inmueble[]> {
  const { data, error } = await supabase
    .from('inmuebles')
    .select('id, direccion, ciudad, barrio, conjunto, torre, apartamento, tipo, notas, restricciones_ingreso, administracion_contacto, parqueadero, ascensor, horarios_permitidos')
    .is('deleted_at', null)
    .limit(100);
  if (error) throw error;
  return (data ?? []).map((i: any) => ({
    id: i.id,
    direccion: i.direccion ?? '',
    ciudad: i.ciudad ?? '',
    barrio: i.barrio ?? undefined,
    conjunto: i.conjunto ?? undefined,
    torre: i.torre ?? undefined,
    apartamento: i.apartamento ?? undefined,
    tipo: i.tipo ?? 'otro',
    notas: i.notas ?? undefined,
    restricciones_ingreso: i.restricciones_ingreso ?? undefined,
    administracion_contacto: i.administracion_contacto ?? undefined,
    parqueadero: i.parqueadero ?? undefined,
    ascensor: i.ascensor ?? undefined,
    horarios_permitidos: i.horarios_permitidos ?? undefined,
  }));
}

export async function fetchProyectos(): Promise<Proyecto[]> {
  const { data, error } = await supabase
    .from('proyectos')
    .select('id, persona_id, inmueble_id, ambito, nombre, estado, origen, fecha_apertura, prioridad')
    .is('deleted_at', null)
    .order('fecha_apertura', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []).map(p => ({
    id: p.id,
    persona_id: p.persona_id,
    inmueble_id: p.inmueble_id ?? undefined,
    ambito: p.ambito as Ambito,
    nombre: p.nombre ?? 'Proyecto',
    estado: p.estado as ProyectoEstado,
    origen: p.origen ?? '',
    fecha_apertura: p.fecha_apertura,
    prioridad: p.prioridad ?? 5,
  }));
}

// Texto legible para un evento del timeline. Si el mensaje no trae texto
// (notificaciones de sistema, llamadas, media sin caption, mensaje sin
// descifrar), describe QUÉ es usando el tipo + subtipo del mensaje, en vez
// de dejar el resumen vacío o mostrar el ID crudo.
function resumenEvento(payload: any, tipoEvento: string): string {
  const preview = typeof payload?.preview === 'string' ? payload.preview.trim() : '';
  if (preview) return preview;
  if (tipoEvento === 'mensaje_entrante' || tipoEvento === 'mensaje_saliente') {
    const tc  = (payload?.tipo_canonical ?? '') as string;
    const sub = String(payload?.subtype ?? '');
    const saliente = tipoEvento === 'mensaje_saliente';

    // Llamadas
    if (tc === 'call_log') {
      if (/miss|reject|fail|timeout|no_answer|unavailable/i.test(sub)) return '📞 Llamada perdida';
      return saliente ? '📞 Llamada saliente' : '📞 Llamada recibida';
    }
    // Cambios de grupo
    if (tc === 'gp2') {
      const GP2: Record<string, string> = {
        create: '👥 Grupo creado',                 add: '👥 Alguien se unió al grupo',
        remove: '👥 Alguien salió del grupo',      leave: '👥 Alguien dejó el grupo',
        subject: '👥 Cambió el nombre del grupo',  description: '👥 Cambió la descripción del grupo',
        picture: '👥 Cambió la foto del grupo',    announcement: '👥 Cambió la configuración del grupo',
      };
      return GP2[sub] || '👥 Cambio en el grupo';
    }
    // Cifrado / protocolo / borrados
    if (tc === 'e2e_notification') return '🔒 Aviso de cifrado de extremo a extremo';
    if (tc === 'ciphertext')       return '⏳ Mensaje aún sin descifrar';
    if (tc === 'protocol')         return '⚙️ Mensaje de protocolo de WhatsApp';
    if (tc === 'revoked')          return '🚫 Mensaje eliminado por el remitente';
    // Notificaciones con plantilla (sistema / cuentas de negocio)
    if (tc === 'notification_template' || tc === 'notification') {
      return sub ? `🔔 Notificación de WhatsApp · ${sub}` : '🔔 Notificación de WhatsApp';
    }
    // Media sin texto / fallback
    if (payload?.tiene_media) return '📎 Archivo multimedia (sin texto)';
    return sub ? `💬 Mensaje de sistema · ${sub}` : '💬 Mensaje sin texto capturado';
  }
  // Eventos no-mensaje (inferencia, medida, tarea…) sin preview: se conserva
  // el fallback previo para no perder información de esos eventos.
  return JSON.stringify(payload ?? {}).slice(0, 100);
}

export async function fetchEventos(filtros?: { personaId?: number; proyectoId?: number; chatId?: number }): Promise<EventoPG[]> {
  let q = supabase
    .from('evento_pg')
    .select('id, tipo_evento, estado, ambito, persona_id, proyecto_id, payload, evidencia_ids, agente_origen, confianza, prioridad, ts_canal, ts_creado')
    .is('deleted_at', null);
  // Si hay filtros, los aplicamos en BD (no en cliente — evita perder eventos por LIMIT global).
  if (filtros?.chatId != null)     q = q.eq('chat_id', filtros.chatId);
  else if (filtros?.proyectoId != null) q = q.eq('proyecto_id', filtros.proyectoId);
  else if (filtros?.personaId != null)  q = q.eq('persona_id', filtros.personaId);
  q = q.order('ts_creado', { ascending: false }).limit(filtros ? 500 : 50);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map(e => ({
    id: e.id,
    tipo_evento: e.tipo_evento,
    estado: e.estado,
    ambito: e.ambito as Ambito,
    persona_id: e.persona_id ?? undefined,
    proyecto_id: e.proyecto_id ?? undefined,
    payload_resumen: resumenEvento(e.payload, e.tipo_evento),
    evidencia_msg_ids: e.evidencia_ids?.msg_ids ?? [],
    agente_origen: e.agente_origen ?? undefined,
    confianza: e.confianza ?? undefined,
    prioridad: e.prioridad,
    ts_canal: e.ts_canal,
    ts_creado: e.ts_creado,
  }));
}

export async function fetchBuzon(): Promise<ItemBuzon[]> {
  const { data, error } = await supabase
    .from('vw_buzon_pendientes')
    .select('*')
    .limit(100);
  if (error) throw error;
  return (data ?? []).map(b => ({
    id: b.id,
    evento_id: b.evento_id,
    persona_id: b.persona_id ?? null,
    proyecto_id: b.proyecto_id ?? null,
    persona_nombre: b.persona_nombre ?? '(sin persona)',
    proyecto_nombre: b.proyecto_nombre ?? undefined,
    ambito: b.ambito as Ambito,
    tipo_decision: b.tipo_decision,
    resumen: b.resumen,
    detalle: b.detalle ?? {},
    evidencia_msg_ids: b.evidencia_ids?.msg_ids ?? [],
    reglas_aplicadas: b.reglas_aplicadas ?? [],
    prioridad: b.prioridad,
    horas_pendiente: Math.round(b.horas_pendiente ?? 0),
    agente_origen: '',
    confianza: 'INFERIDO' as const,
  }));
}

// ─── Métricas para Centro de Control ─────────────────────────────────

export interface MetricasCentro {
  // KPIs principales
  chats_procesados: number;
  personas: number;
  proyectos_activos: number;
  proyectos_total: number;
  eventos_hoy: number;
  buzon_pendientes: number;
  buzon_alta: number;
  costo_dia_usd: number;
  tope_diario_usd: number;
  modo_ia: 'OFF' | 'ON';

  // Salud del worker pipeline
  eventos_nuevos: number;        // pendientes de procesar
  eventos_ambiguos: number;      // requieren humano
  eventos_error: number;         // dead-letter
  ultimo_evento_procesado_at: string | null;

  // Media
  media_total: number;
  media_con_aitext: number;
}

export interface UltimoEvento {
  id: number;
  tipo_evento: string;
  estado: string;
  ambito: string;
  ts_creado: string;
  agente_origen: string | null;
  preview: string | null;
  persona_nombre: string | null;
}

export async function fetchMetricas(): Promise<MetricasCentro> {
  const today = new Date(); today.setHours(0,0,0,0);
  const todayIso = today.toISOString();

  const [
    procesados, personas, proyectosAct, proyectosAll,
    eventosHoy, buzonAll, buzonAlta,
    nuevos, ambiguos, errores,
    ultimo, mediaTotal, mediaConAi,
    cfg,
  ] = await Promise.all([
    supabase.from('chats').select('id', { count: 'exact', head: true }).eq('ia_historico_procesado', true).is('deleted_at', null),
    supabase.from('personas').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    supabase.from('proyectos').select('id', { count: 'exact', head: true }).in('estado', ['abierto', 'en_progreso']).is('deleted_at', null),
    supabase.from('proyectos').select('id', { count: 'exact', head: true }).is('deleted_at', null),
    supabase.from('evento_pg').select('id', { count: 'exact', head: true }).gte('ts_creado', todayIso),
    supabase.from('buzon_validacion').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente'),
    supabase.from('buzon_validacion').select('id', { count: 'exact', head: true }).eq('estado', 'pendiente').lte('prioridad', 2),
    supabase.from('evento_pg').select('id', { count: 'exact', head: true }).eq('estado', 'NUEVO').is('deleted_at', null),
    supabase.from('evento_pg').select('id', { count: 'exact', head: true }).eq('estado', 'AMBIGUO').is('deleted_at', null),
    supabase.from('evento_pg').select('id', { count: 'exact', head: true }).eq('estado', 'ERROR').is('deleted_at', null),
    supabase.from('evento_pg').select('ts_procesado').not('ts_procesado','is',null).order('ts_procesado',{ascending:false}).limit(1),
    supabase.from('mensajes').select('id', { count: 'exact', head: true }).in('tipo', ['imagen','audio','video','documento']).is('deleted_at', null),
    supabase.from('mensajes').select('id', { count: 'exact', head: true }).in('tipo', ['imagen','audio','video','documento']).not('metadata->>ai_text','is',null).is('deleted_at', null),
    fetchConfiguracion(['ia_modo_global','ia_tope_diario_alerta_usd']),
  ]);

  // Costo del día: suma costo_usd de evento_pg de hoy
  const { data: costos } = await supabase
    .from('evento_pg')
    .select('costo_usd')
    .gte('ts_creado', todayIso);
  const costo_dia_usd = (costos ?? []).reduce((sum, c) => sum + Number(c.costo_usd ?? 0), 0);

  return {
    chats_procesados: procesados.count ?? 0,
    personas: personas.count ?? 0,
    proyectos_activos: proyectosAct.count ?? 0,
    proyectos_total: proyectosAll.count ?? 0,
    eventos_hoy: eventosHoy.count ?? 0,
    buzon_pendientes: buzonAll.count ?? 0,
    buzon_alta: buzonAlta.count ?? 0,
    costo_dia_usd,
    tope_diario_usd: Number(cfg.ia_tope_diario_alerta_usd ?? 5),
    modo_ia: ((cfg.ia_modo_global ?? 'OFF') === 'ON' ? 'ON' : 'OFF'),
    eventos_nuevos: nuevos.count ?? 0,
    eventos_ambiguos: ambiguos.count ?? 0,
    eventos_error: errores.count ?? 0,
    ultimo_evento_procesado_at: ultimo.data?.[0]?.ts_procesado ?? null,
    media_total: mediaTotal.count ?? 0,
    media_con_aitext: mediaConAi.count ?? 0,
  };
}

export async function fetchUltimosEventos(limit: number = 8): Promise<UltimoEvento[]> {
  const { data, error } = await supabase
    .from('evento_pg')
    .select(`id, tipo_evento, estado, ambito, ts_creado, agente_origen, payload, persona_id, personas(nombre)`)
    .is('deleted_at', null)
    .order('ts_creado', { ascending: false })
    .limit(limit);
  if (error) return [];
  return (data ?? []).map((e: any) => ({
    id: e.id,
    tipo_evento: e.tipo_evento,
    estado: e.estado,
    ambito: e.ambito,
    ts_creado: e.ts_creado,
    agente_origen: e.agente_origen ?? null,
    preview: e.payload?.preview ?? null,
    persona_nombre: e.personas?.nombre ?? null,
  }));
}
