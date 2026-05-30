/**
 * Contexto activo global — el "cliente que estoy mirando" compartido por TODOS los módulos.
 *
 * Modelo mental: el Visor es UNA consola de operación, no 11 paneles desconectados.
 * Si Jhon selecciona a Jorge en M0 Captura, todos los demás módulos (M1.Identidad,
 * M1.Transcripciones, M2.Comerciales, etc.) deben mostrar la info de Jorge automáticamente.
 *
 * Estado:
 *   - personaActivaId  → quien
 *   - proyectoActivoId → qué proyecto suyo
 *   - chatActivoId     → qué conversación suya (chats.id de Supabase)
 *   - chatActivoJid    → jid de WhatsApp (para invocar a la extensión)
 *
 * Persistencia: sessionStorage. Sobrevive F5 (Vite HMR), se limpia al cerrar la pestaña.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'visor_contexto_activo_v1';

export interface ContextoActivo {
  personaActivaId:  number | null;
  proyectoActivoId: number | null;
  chatActivoId:     number | null;
  chatActivoJid:    string | null;
  // Etiquetas para mostrar (cache para no requerir lookup en cada render)
  personaActivaNombre:  string | null;
  proyectoActivoNombre: string | null;
  chatActivoTitulo:     string | null;
}

const VACIO: ContextoActivo = {
  personaActivaId: null, proyectoActivoId: null, chatActivoId: null, chatActivoJid: null,
  personaActivaNombre: null, proyectoActivoNombre: null, chatActivoTitulo: null,
};

interface ContextoActivoAPI extends ContextoActivo {
  seleccionarPersona:  (id: number, nombre: string) => void;
  seleccionarProyecto: (id: number, nombre: string, personaId?: number, personaNombre?: string) => void;
  seleccionarChat:     (id: number, titulo: string, jid: string, opts?: { proyectoId?: number; proyectoNombre?: string; personaId?: number; personaNombre?: string }) => void;
  limpiar: () => void;
  hayContexto: boolean;   // true si hay al menos persona/proyecto/chat seteado
}

const Ctx = createContext<ContextoActivoAPI | null>(null);

function leerSession(): ContextoActivo {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return VACIO;
    const obj = JSON.parse(raw);
    return { ...VACIO, ...obj };
  } catch {
    return VACIO;
  }
}

function escribirSession(c: ContextoActivo) {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch {}
}

export function ContextoActivoProvider({ children }: { children: ReactNode }) {
  const [estado, setEstado] = useState<ContextoActivo>(() => leerSession());

  useEffect(() => { escribirSession(estado); }, [estado]);

  const api: ContextoActivoAPI = {
    ...estado,
    hayContexto: !!(estado.personaActivaId || estado.proyectoActivoId || estado.chatActivoId),

    seleccionarPersona: (id, nombre) => setEstado(s => ({
      ...s,
      personaActivaId: id, personaActivaNombre: nombre,
      // Si cambió la persona, limpiar proyecto/chat — los detalles los recarga el panel
      ...(s.personaActivaId !== id ? { proyectoActivoId: null, proyectoActivoNombre: null, chatActivoId: null, chatActivoJid: null, chatActivoTitulo: null } : {}),
    })),

    seleccionarProyecto: (id, nombre, personaId, personaNombre) => setEstado(s => ({
      ...s,
      proyectoActivoId: id, proyectoActivoNombre: nombre,
      ...(personaId != null ? { personaActivaId: personaId, personaActivaNombre: personaNombre ?? s.personaActivaNombre } : {}),
      // Si cambió el proyecto, el chat puede ser otro
      ...(s.proyectoActivoId !== id ? { chatActivoId: null, chatActivoJid: null, chatActivoTitulo: null } : {}),
    })),

    seleccionarChat: (id, titulo, jid, opts) => setEstado(s => ({
      ...s,
      chatActivoId: id, chatActivoTitulo: titulo, chatActivoJid: jid,
      ...(opts?.proyectoId != null ? { proyectoActivoId: opts.proyectoId, proyectoActivoNombre: opts.proyectoNombre ?? s.proyectoActivoNombre } : {}),
      ...(opts?.personaId  != null ? { personaActivaId:  opts.personaId,  personaActivaNombre:  opts.personaNombre  ?? s.personaActivaNombre  } : {}),
    })),

    limpiar: () => setEstado(VACIO),
  };

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useContextoActivo(): ContextoActivoAPI {
  const v = useContext(Ctx);
  if (!v) throw new Error('useContextoActivo() requiere <ContextoActivoProvider>');
  return v;
}
