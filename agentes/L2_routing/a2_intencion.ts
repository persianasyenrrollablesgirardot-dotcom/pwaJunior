/**
 * A2_INTENCION — clasificador de intención del mensaje (router del pipeline).
 *
 * CRÍTICO: el `payload.intencion` que emite este agente alimenta el `switch_on`
 * del PIPE_MENSAJE_COMERCIAL. Decide qué L4-L8 corren después:
 *
 *   intencion=cotizar         → A4_COTIZ + A4_COMPAT
 *   intencion=pagar           → A5_ABONO
 *   intencion=queja           → A8_GARANTIA + A8_RECLAMO
 *   intencion=consulta_estado → A7_ESTADO
 *   intencion=urgente         → A8_RECLAMO
 *   intencion=saludo          → (nada)
 *   intencion=otro            → A7_TAREAS (ruta _default)
 *
 * Una sola etiqueta por mensaje (no multi-label). Si el mensaje es ambiguo,
 * el LLM elige la MÁS PROBABLE; si dudás, "otro" + DUDOSO.
 *
 * Tope $0.01/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError } from '../lib/validador.js';

const INTENCIONES = [
  'cotizar',          // pregunta precio / pide cotización / interés inicial
  'pagar',            // confirma transferencia / abono / "ya pagué"
  'queja',            // se rompió / no funciona / reclamo
  'consulta_estado',  // "cuándo me entregan", "cómo va", "ya está listo"
  'urgente',          // necesita acción YA / amenaza / agresivo
  'saludo',           // hola, buenos días, sin más contenido
  'otro',             // charla, info, gratitud, cualquier otra cosa
] as const;
type Intencion = typeof INTENCIONES[number];

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  ts_canal: string;
}

interface DatosA2Intencion {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
}

interface IntencionOutput {
  intencion: Intencion;
  confianza_intencion: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  señales: string[];
}

const N_CONTEXTO = 5;

export const a2IntencionHooks: AgenteHooks<DatosA2Intencion> = {
  async cargarContexto(sb, params) {
    const { data: evt, error: eErr } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal, payload, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    if (eErr || !evt) throw new Error(`evento ${params.evento_id} no encontrado: ${eErr?.message}`);

    const evidIds = (evt.evidencia_ids as any)?.msg_ids ?? [];
    const msgIdPrincipal: string | null = evidIds[0] ?? evt.canal_msg_id ?? null;

    let mensajeActual: MensajeCtx | null = null;
    if (msgIdPrincipal) {
      const { data: m } = await sb.from('mensajes')
        .select('canal_msg_id, direccion, texto, ts_canal')
        .eq('chat_id', params.chat_id)
        .eq('canal_msg_id', msgIdPrincipal)
        .is('deleted_at', null)
        .maybeSingle();
      if (m?.texto) mensajeActual = { canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto, ts_canal: m.ts_canal };
    }
    if (!mensajeActual) {
      const { data: msgs } = await sb.from('mensajes')
        .select('canal_msg_id, direccion, texto, ts_canal')
        .eq('chat_id', params.chat_id)
        .is('deleted_at', null)
        .not('texto', 'is', null)
        .lte('ts_canal', evt.ts_canal ?? new Date().toISOString())
        .order('ts_canal', { ascending: false })
        .limit(1);
      const m = msgs?.[0];
      if (!m?.texto) throw new Error(`evento ${params.evento_id} no tiene mensaje con texto`);
      mensajeActual = { canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto, ts_canal: m.ts_canal };
    }

    const { data: ctxMsgs } = await sb.from('mensajes')
      .select('canal_msg_id, direccion, texto, ts_canal')
      .eq('chat_id', params.chat_id)
      .is('deleted_at', null)
      .not('texto', 'is', null)
      .lt('ts_canal', mensajeActual.ts_canal)
      .order('ts_canal', { ascending: false })
      .limit(N_CONTEXTO);

    const contexto: MensajeCtx[] = (ctxMsgs ?? [])
      .reverse()
      .filter(m => m.texto && m.texto.trim().length > 0)
      .map(m => ({
        canal_msg_id: m.canal_msg_id,
        direccion: m.direccion as any,
        texto: m.texto!,
        ts_canal: m.ts_canal,
      }));

    return { mensaje_actual: mensajeActual, mensajes_contexto: contexto };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 240)}`
        ).join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A2_INTENCION. Clasificás el mensaje en EXACTAMENTE UNA de 7 categorías.
Esta clasificación decide qué agentes corren después en el pipeline — sé preciso.

Categorías (mutuamente excluyentes):

  cotizar          → Cliente pregunta precio o pide cotización formal.
                     Señales: "cuánto cuesta", "precio", "valor", "presupuesto",
                              "cotización", "necesito X persianas", "cotízame".

  pagar            → Cliente confirma o reporta un pago.
                     Señales: "ya transferí", "consigné", "abono", "pagué",
                              "te mandé el comprobante", "ahí va el pago".

  queja            → Cliente reporta un problema con producto o servicio entregado.
                     Señales: "no funciona", "se rompió", "vino mal", "está mal hecho",
                              "el motor falla", "garantía", "reclamo".

  consulta_estado  → Cliente pregunta por el estado de su pedido / instalación.
                     Señales: "cuándo me entregan", "ya está listo", "cómo va",
                              "qué fecha", "para cuándo".

  urgente          → Lenguaje agresivo, amenaza pública o necesidad inmediata.
                     Señales: "URGENTE", "ya mismo", "voy a denunciar",
                              "voy a poner mala reseña", "llamo a la fiscal",
                              MAYÚSCULAS sostenidas, signos de exclamación excesivos.
                     NOTA: urgente DOMINA sobre queja. Si tiene queja + amenaza → urgente.

  saludo           → Solo saludo, sin contenido sustantivo.
                     Señales: "hola", "buenos días", "cómo está", "tardes", "qué tal".
                     SOLO si NO hay más contenido. "Hola, cuánto cuesta?" → cotizar.

  otro             → Charla, agradecimiento, info sin pedido claro, todo lo demás.
                     Si DUDÁS entre dos opciones → "otro" + confianza_intencion="DUDOSO".

Reglas:
  - UNA SOLA etiqueta. Si dudás, elegí la más probable.
  - confianza_intencion alta solo si las señales son explícitas.
  - Si DUDÁS → "otro" + DUDOSO (mejor caer al _default que fallar a una ruta errada).
  - R-001 anti-alucinación: TODA clasificación cita el msg_id que la motiva.

CÁLCULO MECÁNICO de "confianza" global (NO es una opinión, es una copia):
  out.confianza SIEMPRE = payload.confianza_intencion
    - confianza_intencion="CONFIRMADO" → out.confianza="CONFIRMADO"  (no va al buzón)
    - confianza_intencion="INFERIDO"   → out.confianza="INFERIDO"   (Jhon revisa)
    - confianza_intencion="DUDOSO"     → out.confianza="DUDOSO"     (Jhon revisa, prioridad)

PROHIBIDO ABSOLUTO:
  ✗ out.confianza ≠ payload.confianza_intencion → ERROR mecánico (rechazado)

Devolvés JSON EXACTO con la forma de los ejemplos siguientes.

EJEMPLO 1 — intención clara (cliente pide cotización):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "intencion": "cotizar",
    "confianza_intencion": "CONFIRMADO",
    "señales": ["frase 'cuánto cuesta'", "primer contacto"],
    "resumen": "Cliente pregunta precio inicial"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 2 — intención ambigua (cliente dice solo "ok"):
{
  "tipo_evento": "dato_extraido",
  "confianza": "DUDOSO",
  "payload": {
    "intencion": "otro",
    "confianza_intencion": "DUDOSO",
    "señales": ["mensaje sin contenido claro"],
    "resumen": "Respuesta corta, sin pedido específico"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO RECIENTE ===
${ctxLineas}

=== MENSAJE A CLASIFICAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${datos.mensaje_actual.texto}

Clasificá la intención del MENSAJE A CLASIFICAR (no del contexto).
Si el mensaje es del NEGOCIO (saliente), la "intención" se refiere a la
intención del CLIENTE que motiva la respuesta del negocio.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!INTENCIONES.includes(p?.intencion)) {
      throw new ValidacionError('schema',
        `intencion inválida: ${JSON.stringify(p?.intencion)} (válidas: ${INTENCIONES.join(',')})`);
    }
    if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(p?.confianza_intencion)) {
      throw new ValidacionError('schema', `confianza_intencion inválida: ${p?.confianza_intencion}`);
    }
    if (!Array.isArray(p?.señales)) {
      throw new ValidacionError('schema', 'payload.señales debe ser array');
    }
    if (!out.evidencia_msg_ids?.includes(datos.mensaje_actual.canal_msg_id)) {
      throw new ValidacionError('R-001',
        'evidencia_msg_ids debe incluir el msg_id del mensaje analizado');
    }
    // Coherencia mecánica: out.confianza copia payload.confianza_intencion
    if (out.confianza !== p.confianza_intencion) {
      throw new ValidacionError('coherencia-a2',
        `out.confianza='${out.confianza}' debe igualar payload.confianza_intencion='${p.confianza_intencion}'`);
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // L2 routing: emite el evento pero no escribe a tablas. La intención se
    // consume desde el contexto del pipeline en la fase siguiente.
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
