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
    const personaJid = chat.tipo === 'grupo'
      ? (evt.payload?.autor_jid as string | undefined) ?? null
      : chat.canal_chat_id;

    if (!personaJid) {
      // grupo sin autor identificado → no podemos resolver
      console.warn(`[IDENTIDAD] evento ${evt.id} en grupo sin autor_jid`);
      return null;
    }

    let persona = await this.matchExactoPersona(personaJid);
    let fueCreado = false;

    if (!persona) {
      persona = await this.crearPersonaDesdeJid(personaJid, chat.titulo, chat.ambito);
      fueCreado = true;
    }

    // 3. Asegurar proyecto del chat
    let proyectoId = chat.proyecto_id;
    if (!proyectoId) {
      proyectoId = await this.crearProyectoParaChat(persona.id, chat);
      // Asociar el chat al proyecto creado
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

  // ─── Match exacto ──────────────────────────────────────────────────────

  private async matchExactoPersona(jid: string): Promise<{ id: number; nombre: string | null } | null> {
    // 1. Match por jid
    const { data: porJid } = await this.sb
      .from('personas')
      .select('id, nombre')
      .eq('jid', jid)
      .is('deleted_at', null)
      .limit(1)
      .maybeSingle();
    if (porJid) return porJid;

    // 2. Match por telefono normalizado
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
        return porTel;
      }
    }

    return null;
  }

  // ─── Crear persona/proyecto cuando no hay match ────────────────────────

  private async crearPersonaDesdeJid(jid: string, titulo: string | null, ambito: string): Promise<{ id: number; nombre: string | null }> {
    const tel = jidToTelefonoE164(jid);
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
    if (error || !data) throw new Error(`crear persona: ${error?.message}`);
    return data;
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
