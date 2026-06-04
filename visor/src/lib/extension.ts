// Cliente del Visor para hablar con la extensión Chrome.
// La extensión expone chrome.runtime.onMessageExternal con los handlers V3_*.
// El Visor (declarado en manifest externally_connectable) puede invocarlos vía chrome.runtime.sendMessage.
//
// Si la extensión no está instalada o no responde, devolvemos { error } y la UI muestra fallback.

const EXTENSION_ID = 'oomdmlhadnonedbdjdcfkpceaijpkelj';

// Tipo del chrome.runtime expuesto a la página (cuando externally_connectable está activo)
declare global {
  interface Window {
    chrome?: {
      runtime?: {
        sendMessage(extId: string, msg: any, cb: (response: any) => void): void;
        lastError?: { message: string };
      };
    };
  }
}

export interface ChatStats {
  total: number;
  texto: number; imagen: number; video: number; audio: number;
  documento: number; ubicacion: number; contacto: number; sticker: number; sistema: number;
  entrantes: number; salientes: number;
  pct_entrante: number;
  last_ts: number | null;
  first_ts: number | null;
}

export interface ChatCaptura {
  jid: string;
  titulo: string;
  phoneNumber: string | null;
  profilePicUrl: string | null;
  isAddressBook: boolean;
  isBusiness: boolean;
  verifiedName: string | null;
  isGroup: boolean;
  isStatus: boolean;
  bloqueado: boolean;
  stats: ChatStats;
  no_cliente_tags: string[];
  no_cliente_score: number;
}

export interface MensajeCanonico {
  id: string;
  chat_id: string;
  type: string;
  text: string | null;
  caption: string | null;
  is_owner: boolean;
  timestamp_ms: number;
  ai_text?: string;
  mimetype?: string;
}

function send<T = any>(msg: any): Promise<T> {
  return new Promise((resolve, reject) => {
    if (!window.chrome?.runtime?.sendMessage) {
      reject(new Error('chrome.runtime no disponible. ¿Extensión Visor PG instalada?'));
      return;
    }
    try {
      window.chrome.runtime.sendMessage(EXTENSION_ID, msg, (response) => {
        if (window.chrome?.runtime?.lastError) {
          reject(new Error(window.chrome.runtime.lastError.message));
          return;
        }
        if (!response) { reject(new Error('respuesta vacía')); return; }
        if (response.error) { reject(new Error(response.error)); return; }
        resolve(response);
      });
    } catch (e: any) {
      reject(e);
    }
  });
}

export async function ping(): Promise<{ pong: true; version: string; ts: number }> {
  return await send({ type: 'V3_PING' });
}

export async function listarChats(): Promise<ChatCaptura[]> {
  const r = await send<{ ok: true; data: ChatCaptura[] }>({ type: 'V3_LIST_CHATS' });
  return r.data;
}

export async function obtenerMensajes(jid: string, limit: number = 200): Promise<MensajeCanonico[]> {
  const r = await send<{ ok: true; data: MensajeCanonico[] }>({ type: 'V3_GET_MESSAGES', jid, limit });
  return r.data;
}

export async function procesarChat(jid: string): Promise<{ ok: true; chat_id_db: number; mensajes_subidos: number; eventos_creados: number; re_sync?: boolean; mensajes_total?: number; reparados?: number }> {
  return await send({ type: 'V3_PROCESS_CHAT', jid });
}

export async function bloquearChatExt(jid: string, motivo: string, titulo?: string): Promise<{ ok: true }> {
  return await send({ type: 'V3_BLOCK_CHAT', jid, motivo, titulo });
}

export async function desbloquearChatExt(jid: string, motivo?: string): Promise<{ ok: true }> {
  return await send({ type: 'V3_UNBLOCK_CHAT', jid, motivo });
}

export async function listarBloqueados(): Promise<string[]> {
  const r = await send<{ ok: true; data: string[] }>({ type: 'V3_LIST_BLOQUEADOS' });
  return r.data;
}

// Re-barrer el historial completo de WhatsApp: resetea el estado de barrido del
// content script (ws_v2_state) para que vuelva a capturar TODO el historial, no
// solo tiempo real. Útil cuando Captura muestra los chats "sin mensajes".
export async function reBarrerHistorial(): Promise<{ ok: boolean; avisados: number; nota: string }> {
  return await send({ type: 'V3_RESET_SWEEP' });
}

// Prende/apaga el modo IA tiempo real en la extensión (procesamiento automático).
export async function setRealtimeExtension(enabled: boolean): Promise<{ ok: boolean; realtime: boolean }> {
  return await send({ type: 'V3_SET_REALTIME', enabled });
}

// ─── Semáforo de conexión de WhatsApp Web ────────────────────────
export interface WaStatus {
  ok: boolean;
  conectado: boolean;           // true = WhatsApp Web abierto + logueado = capturando
  motivo: string;               // ok | sin_pestana | qr | cargando | sin_respuesta | sin_extension | error_tabs
  detalle: string;              // texto legible para el tooltip / badge
  estado?: string;              // logueado | qr | cargando
}

// Consulta si WhatsApp Web está abierto, logueado y capturando en tiempo real.
// No lanza: si la extensión no está, devuelve conectado=false con motivo 'sin_extension'.
export async function estadoWhatsApp(): Promise<WaStatus> {
  try {
    return await send<WaStatus>({ type: 'V3_WA_STATUS' });
  } catch (e: any) {
    return { ok: false, conectado: false, motivo: 'sin_extension', detalle: 'Extensión de captura no conectada' };
  }
}

// ─── Transcripción de media ──────────────────────────────────────

export interface EstimadoMediaChat {
  procesables: { audios: number; imagenes: number; pdfs: number };
  omitidos: {
    sticker: number; status_broadcast: number; forwarded_many: number;
    video: number; burst_limit: number; ya_procesado: number;
  };
  duracion_audio_seg: number;
  costo_estimado_usd: number;
  desglose_costos: { audios: number; imagenes: number; pdfs: number };
}

export interface ResultadoTranscripcion {
  ok: true;
  stats: {
    audios: number; imagenes: number; pdfs: number;
    errores: number;                          // errores inesperados (bugs reales)
    errores_temporales: number;               // network/timeout/rate-limit, reintentables
    irrecuperables_cdn: number;               // CDN de WhatsApp ya borró el archivo (>17d)
    errores_inesperados_detalle: Array<{ msg_id: string; kind: string; error: string }>;
    cache_hits: number;
    no_existentes_en_supabase: number;
    omitidos_total: number;
    detalle_omitidos: EstimadoMediaChat['omitidos'];
    chat_id_db: number;
  };
}

export async function estimarMediaChat(jid: string): Promise<EstimadoMediaChat> {
  await sincronizarKeysExtension();   // garantiza que la extensión tenga las keys (no-op si ya estaban)
  return await send({ type: 'V3_ESTIMATE_CHAT_MEDIA', jid });
}

export async function transcribirMediaChat(jid: string): Promise<ResultadoTranscripcion> {
  await sincronizarKeysExtension();
  return await send({ type: 'V3_TRANSCRIBE_CHAT_MEDIA', jid });
}

// ─── Sync de keys Visor → extensión (sin popup manual) ──────────
//
// F1.22 fix C1: las keys de OpenAI/DeepSeek YA NO están en el bundle del Visor.
// Antes: import.meta.env.VITE_* las inyectaba en el JS público (visible en DevTools).
// Ahora: el Visor en runtime hace fetch('/api/keys') que el Vite middleware sirve
// SOLO a localhost. Build de producción no las tiene.
//
// La supabase ANON_KEY sigue en VITE_ porque es pública por diseño.

let keysSincronizadasYa = false;

export async function sincronizarKeysExtension(force = false): Promise<{ ok: boolean; detalle?: any; error?: string }> {
  if (keysSincronizadasYa && !force) return { ok: true, detalle: 'cached' };
  try {
    const supabaseKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
    let openaiKey: string | undefined;
    let deepseekKey: string | undefined;
    try {
      const r = await fetch('/api/keys');
      if (r.ok) {
        const j = await r.json();
        openaiKey = j.openaiKey || undefined;
        deepseekKey = j.deepseekKey || undefined;
      }
    } catch (_) { /* offline o servidor caído — seguir con lo que tengamos */ }

    console.log('[VPG-SYNC-KEYS]', {
      tiene_supabase: !!supabaseKey,
      tiene_openai:   !!openaiKey,
      tiene_deepseek: !!deepseekKey,
    });
    if (!supabaseKey && !openaiKey && !deepseekKey) {
      return { ok: false, error: 'sin keys (verificar .env + Vite dev server corriendo en localhost)' };
    }
    const r = await send<{ ok: true; tiene_supabase: boolean; tiene_openai: boolean; tiene_deepseek: boolean }>({
      type: 'V3_SET_KEYS', supabaseKey, openaiKey, deepseekKey,
    });
    keysSincronizadasYa = true;
    return { ok: true, detalle: r };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

// Helper para verificar conexión con la extensión.
// Hace ping y, si conecta, sincroniza keys automáticamente.
export async function chequearExtension(): Promise<{ conectada: boolean; version?: string; mensaje: string }> {
  try {
    const r = await ping();
    // Sync silencioso de keys (idempotente, primer call hace el push)
    sincronizarKeysExtension().catch(() => {});
    return { conectada: true, version: r.version, mensaje: 'Extensión v' + r.version + ' OK' };
  } catch (e: any) {
    return { conectada: false, mensaje: e.message };
  }
}
