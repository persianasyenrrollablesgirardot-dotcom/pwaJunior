/**
 * Servicio de Identidad (L1) — sección 8 de ARQUITECTURA.md
 *
 * Resuelve persona_id, proyecto_id, ambito de cada evento_pg con estado='NUEVO'
 * y lo actualiza a estado='IDENTIFICADO'.
 *
 * Algoritmo (cascada):
 *   1. Match exacto por jid / telefono / email → persona resuelta
 *   2. Match difuso (>85% nombre+ciudad) → AUTO_MATCH (revertible)        [F1.7 simple: omitido, queda para F2+]
 *   3. Match contextual (proyecto activo)                                 [F1.7 simple: omitido, queda para F2+]
 *   4. Sin match → crea persona + proyecto nuevos
 *   5. Match dudoso (60-85%) → AMBIGUO, escalar al buzón                  [F1.7 simple: omitido]
 *
 * MVP F1.7: solo paso 1 + paso 4. Lo demás se agrega en MÓDULO 1 final.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Tipos de mensaje que SÍ son conversación real (no notificaciones de sistema).
// Se usa para decidir si un chat merece persona/proyecto: un chat que solo tiene
// notification_template / call_log / protocol / e2e_notification queda sin
// materializar (no más contactos "⏳ Identificando…" sin nada que identificar).
const TIPOS_CONTENIDO = new Set([
  'text', 'chat', 'extendedtext', 'texto',
  'image', 'imagen', 'video', 'audio', 'ptt',
  'document', 'documento', 'location', 'live_location', 'ubicacion',
  'vcard', 'contact', 'contacto', 'sticker', 'album',
  'buttons_response', 'list_response', 'template_button_reply',
]);

interface EventoNuevo {
  id: number;
  canal: string;
  canal_msg_id: string | null;
  chat_id: number | null;
  persona_id: number | null;
  proyecto_id: number | null;
  ambito: string;
  tipo_evento: string;
  payload: Record<string, any>;
  ts_canal: string;
  ts_creado: string;
}

interface ChatRow {
  id: number;
  canal_chat_id: string;       // jid en whatsapp
  tipo: 'individual' | 'grupo' | 'difusion';
  titulo: string | null;
  ambito: string;
  proyecto_id: number | null;
}

interface PersonaResuelta {
  persona_id: number;
  proyecto_id: number;
  inmueble_id: number | null;
  ambito: string;
  fue_creado: boolean;          // true si tuvimos que crearla
}

// E.164 normalizer: '573225458821@c.us' → '+573225458821'
function jidToTelefonoE164(jid: string | null): string | null {
  if (!jid) return null;
  if (jid.endsWith('@c.us')) {
    const num = jid.replace(/@c\.us$/, '').replace(/[^\d]/g, '');
    return num ? '+' + num : null;
  }
  return null;
}

export class IdentidadService {
  constructor(private sb: SupabaseClient) {}

  /**
   * Resuelve identidad para un evento_pg con estado='NUEVO'.
   * Si el evento ya tiene chat_id, usamos el ámbito y proyecto del chat.
   * Si el chat no tiene proyecto, creamos uno nuevo.
   */
  async resolverEvento(evt: EventoNuevo): Promise<PersonaResuelta | null> {
    if (!evt.chat_id) {
      console.warn(`[IDENTIDAD] evento ${evt.id} sin chat_id, no se puede resolver`);
      return null;
    }

    // 1. Cargar el chat
    const { data: chat, error: chatErr } = await this.sb
      .from('chats')
      .select('id, canal_chat_id, tipo, titulo, ambito, proyecto_id')
      .eq('id', evt.chat_id)
      .single<ChatRow>();
    if (chatErr || !chat) {
      console.error(`[IDENTIDAD] chat ${evt.chat_id} no encontrado: ${chatErr?.message}`);
      return null;
    }

    // 2. Resolver persona del chat
    // Para chats individuales: la persona es el dueño del jid (canal_chat_id).
    // Para grupos: la persona es el AUTOR del mensaje (vendrá en payload.autor_jid).
    // Mensajes SALIENTES: los manda el negocio (Jhon), no hay autor externo que
    // identificar. Se atribuyen a la persona/proyecto del chat. Antes caían como
    // AMBIGUO en chats de grupo (sin autor_jid) y se trababan acumulándose.
    const esSaliente = evt.tipo_evento === 'mensaje_saliente';

    const personaJid = chat.tipo === 'grupo'
      ? (evt.payload?.autor_jid as string | undefined) ?? null
      : chat.canal_chat_id;

    let persona: { id: number; nombre: string | null };
    let fueCreado = false;
    let cruceTelefono = false;

    if (personaJid) {
      const match = await this.matchExactoPersona(personaJid);
      if (match) {
        persona = { id: match.id, nombre: match.nombre };
        cruceTelefono = match.matchedBy === 'telefono';
      } else {
        // Opción 3 (2026-06-04): NO materializar persona/proyecto para chats que
        // SOLO tienen notificaciones de sistema (call_log, notification_template,
        // protocol, e2e_notification, change_number…) sin NINGUNA conversación
        // real. Estos contactos @lid sin nombre ni teléfono quedaban como
        // "⏳ Identificando…" para siempre (WhatsApp no expone con qué resolverlos).
        // Si más adelante llega un mensaje real, ahí sí se crea la persona. El
        // evento queda AMBIGUO (estado terminal, no reintenta).
        const tipoCanon = String(evt.payload?.tipo_canonical ?? evt.payload?.tipo ?? '').toLowerCase();
        const esSistema = !!tipoCanon && !TIPOS_CONTENIDO.has(tipoCanon);
        if (esSistema && !(await this.chatTieneContenidoReal(chat.id))) {
          return null;
        }
        persona = await this.crearPersonaDesdeJid(personaJid, chat.titulo, chat.ambito);
        fueCreado = true;
      }
    } else if (esSaliente) {
      // Saliente sin autor (típico en grupos): atribuir a la persona del chat.
      const pc = await this.personaDelChat(chat);
      if (!pc) {
        console.warn(`[IDENTIDAD] evento ${evt.id} saliente sin persona resoluble (chat ${chat.id})`);
        return null;
      }
      persona = pc;
    } else {
      // Entrante de grupo sin autor → no podemos saber quién escribió.
      console.warn(`[IDENTIDAD] evento ${evt.id} en grupo sin autor_jid`);
      return null;
    }

    // 3. Asegurar proyecto del chat
    let proyectoId = chat.proyecto_id;
    if (!proyectoId) {
      // F7.2 — cruce automático: si la persona ya tiene un proyecto que Jhon
      // registró a mano por Junior y todavía sin chat, el chat de WhatsApp se
      // engancha a ESE proyecto en vez de crear uno duplicado. Así el cliente
      // del local conserva un único expediente al escribir luego por WhatsApp.
      const proyManual = await this.proyectoManualReutilizable(persona.id);
      if (proyManual) {
        proyectoId = proyManual;
        console.log(
          `[IDENTIDAD] cruce automático — chat ${chat.id} enganchado al proyecto ` +
          `manual ${proyManual} de la persona ${persona.id}` +
          `${cruceTelefono ? ' (reconocida por teléfono)' : ''}`,
        );
      } else {
        proyectoId = await this.crearProyectoParaChat(persona.id, chat);
      }
      // Asociar el chat al proyecto resuelto
      await this.sb.from('chats').update({ proyecto_id: proyectoId }).eq('id', chat.id);
    }

    return {
      persona_id: persona.id,
      proyecto_id: proyectoId!,
      inmueble_id: null,
      ambito: chat.ambito,
      fue_creado: fueCreado,
    };
  }

  /**
   * Aplica la resolución al evento_pg: setea persona_id, proyecto_id, estado=IDENTIFICADO.
   */
  async aplicarResolucion(eventoId: number, r: PersonaResuelta): Promise<void> {
    const { error } = await this.sb
      .from('evento_pg')
      .update({
        persona_id:   r.persona_id,
        proyecto_id:  r.proyecto_id,
        inmueble_id:  r.inmueble_id,
        ambito:       r.ambito,
        estado:       'IDENTIFICADO',
        ts_procesado: new Date().toISOString(),
      })
      .eq('id', eventoId);
    if (error) throw new Error(`update evento_pg ${eventoId}: ${error.message}`);
  }

  /**
   * ¿El chat tiene algún mensaje de CONTENIDO real (no de sistema)? Se usa para
   * no crear persona/proyecto en chats que solo registran notificaciones/llamadas.
   */
  private async chatTieneContenidoReal(chatId: number): Promise<boolean> {
    const { data } = await this.sb
      .from('mensajes')
      .select('id')
      .eq('chat_id', chatId)
      .neq('tipo', 'sistema')
      .is('deleted_at', null)
      .limit(1);
    return !!(data && data.length);
  }

  /** Persona asociada a un chat (vía su proyecto) — para atribuir mensajes salientes. */
  private async personaDelChat(chat: ChatRow): Promise<{ id: number; nombre: string | null } | null> {
    if (chat.proyecto_id) {
      const { data: proy } = await this.sb.from('proyectos').select('persona_id').eq('id', chat.proyecto_id).maybeSingle();
      if (proy?.persona_id) {
        const { data: p } = await this.sb.from('personas').select('id, nombre').eq('id', proy.persona_id).is('deleted_at', null).maybeSingle();
        if (p) return p;
      }
    }
    if (chat.tipo !== 'grupo') {
      const m = await this.matchExactoPersona(chat.canal_chat_id);
      if (m) return { id: m.id, nombre: m.nombre };
    }
    return null;
  }

  // ─── Match exacto ──────────────────────────────────────────────────────

  private async matchExactoPersona(
    jid: string,
  ): Promise<{ id: number; nombre: string | null; matchedBy: 'jid' | 'telefono' } | null> {
    // 1. Match por jid
    const { data: porJid } = await this.sb
      .from('personas')
      .select('id, nombre')
      .eq('jid', jid)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (porJid) return { ...porJid, matchedBy: 'jid' };

    // 2. Match por telefono normalizado — F7.2: este es el CRUCE automático.
    // La persona la registró Jhon a mano por Junior (tiene telefono pero aún
    // sin jid) y ahora escribe por WhatsApp → la reconocemos y la unimos en
    // vez de crear un cliente duplicado.
    const tel = jidToTelefonoE164(jid);
    if (tel) {
      const { data: porTel } = await this.sb
        .from('personas')
        .select('id, nombre')
        .eq('telefono_e164', tel)
        .is('deleted_at', null)
        .limit(1)
        .maybeSingle();
      if (porTel) {
        // Encontramos por teléfono pero sin jid asociado → asociar para futuras búsquedas
        await this.sb.from('personas').update({ jid }).eq('id', porTel.id);
        return { ...porTel, matchedBy: 'telefono' };
      }
    }

    return null;
  }

  // ─── F7.2: reutilizar proyecto registrado a mano ───────────────────────

  /**
   * Busca un proyecto que Jhon registró a mano (origen='manual') para esta
   * persona, que siga abierto y todavía sin ningún chat enganchado. Devuelve
   * su id para reutilizarlo en el cruce automático, o null si no hay.
   */
  private async proyectoManualReutilizable(personaId: number): Promise<number | null> {
    const { data: proys } = await this.sb
      .from('proyectos')
      .select('id')
      .eq('persona_id', personaId)
      .eq('origen', 'manual')
      .in('estado', ['abierto', 'en_progreso'])
      .is('deleted_at', null)
      .order('fecha_apertura', { ascending: false });
    if (!proys || proys.length === 0) return null;

    for (const p of proys) {
      const { count } = await this.sb
        .from('chats')
        .select('id', { count: 'exact', head: true })
        .eq('proyecto_id', p.id)
        .is('deleted_at', null);
      if (!count) return p.id;          // proyecto manual sin chat → reutilizable
    }
    return null;
  }

  // ─── Crear persona/proyecto cuando no hay match ────────────────────────

  private async crearPersonaDesdeJid(jid: string, titulo: string | null, ambito: string): Promise<{ id: number; nombre: string | null }> {
    const tel = jidToTelefonoE164(jid);
    // ANTES de crear: ¿existe una persona SOFT-DELETED con este mismo jid?
    // matchExactoPersona excluye borradas (deleted_at IS NULL), así que si una
    // persona se borró SIN mover sus datos (chat/checklist/citas siguen colgando
    // de ella), el matcher caería acá y crearía una persona NUEVA vacía → el
    // historial queda huérfano bajo la borrada y la activa nace sin nada. Ese fue
    // el bug del par #251(borrada, con datos)/#265(activa, vacía) de Jhon Guerrero
    // (2026-06-03). Fix: REVIVIR la borrada (la más antigua = la original con
    // historial) en vez de crear una nueva. El índice único parcial no se viola
    // porque estamos en el create path: no hay ninguna activa con este jid.
    if (jid) {
      const { data: borrada } = await this.sb.from('personas')
        .select('id, nombre')
        .eq('jid', jid)
        .not('deleted_at', 'is', null)
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();
      if (borrada) {
        await this.sb.from('personas')
          .update({ deleted_at: null, ambito_principal: ambito, sintesis_pendiente: true })
          .eq('id', borrada.id);
        return borrada;
      }
    }
    const row = {
      nombre:           titulo || tel || jid,
      jid,
      telefono_e164:    tel,
      ambito_principal: ambito,
    };
    const { data, error } = await this.sb
      .from('personas')
      .insert(row)
      .select('id, nombre')
      .single();
    if (data) return data;
    // Carrera: otro worker creó la persona con el mismo jid entre el match y este
    // insert. El índice único parcial personas_jid_activa_uniq (migr 043) rechaza
    // el duplicado con code 23505. Reusamos la existente en vez de propagar el error.
    if (error?.code === '23505' && jid) {
      const { data: existente } = await this.sb.from('personas')
        .select('id, nombre').eq('jid', jid).is('deleted_at', null).limit(1).maybeSingle();
      if (existente) return existente;
    }
    throw new Error(`crear persona: ${error?.message}`);
  }

  private async crearProyectoParaChat(personaId: number, chat: ChatRow): Promise<number> {
    const row = {
      persona_id:   personaId,
      ambito:       chat.ambito,
      nombre:       'Conversación inicial',           // genérico; humano lo renombra
      estado:       'abierto' as const,
      origen:       'whatsapp_inbound',
      prioridad:    5,
    };
    const { data, error } = await this.sb
      .from('proyectos')
      .insert(row)
      .select('id')
      .single();
    if (error || !data) throw new Error(`crear proyecto: ${error?.message}`);
    return data.id;
  }
}

// ─── Stand-alone para test rápido (no se importa en workers) ──────────────

if (typeof process !== 'undefined' && process.argv[1]?.endsWith('matcher.ts')) {
  // Test rápido: leer 1 evento_pg NUEVO y resolverlo
  (async () => {
    const url = process.env.VITE_SUPABASE_URL ?? '';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    if (!url || !key) {
      console.error('Falta VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en env');
      process.exit(1);
    }
    const sb = createClient(url, key);
    const svc = new IdentidadService(sb);
    const { data: evts } = await sb.from('evento_pg').select('*').eq('estado', 'NUEVO').limit(1);
    if (!evts || evts.length === 0) {
      console.log('No hay eventos NUEVO');
      return;
    }
    const evt = evts[0];
    console.log('Resolviendo evento', evt.id);
    const r = await svc.resolverEvento(evt);
    if (r) {
      await svc.aplicarResolucion(evt.id, r);
      console.log('Resuelto:', r);
    } else {
      console.log('No se pudo resolver');
    }
  })().catch(e => { console.error(e); process.exit(1); });
}
