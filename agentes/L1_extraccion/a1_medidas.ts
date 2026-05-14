/**
 * A1_MEDIDAS — extractor de medidas (ancho × alto) con contexto.
 *
 * Complemento del regex (`agentes/extractor/regex.ts`):
 *   - El regex agarra "2.40 x 1.80 m", "240×180 cm", "2,4 m x 1,8 m" → ancho_m, alto_m.
 *   - A1_MEDIDAS agrega lo que el regex no puede:
 *       · ambiente al que pertenece la medida ("la sala mide 2.40×1.80")
 *       · quien midió (cliente / técnico / familiar / no_dicho)
 *       · medidas en lenguaje natural ("dos metros por uno y medio", "más o menos 2 m")
 *       · medidas únicas (solo alto o solo ancho) cuando se menciona explícito
 *       · confianza por ambigüedad ("tiene como 2 m" → DUDOSO)
 *
 * NO marca riesgos (eso es A6_MEDIDAS con R-013#1). NO escribe a tabla `medidas`
 * (eso requiere validación humana o A6 productivo). Solo emite payload.medidas
 * en evento_pg(tipo=dato_extraido, shadow=true).
 *
 * Tope $0.01/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

const QUIEN_MIDIO = ['cliente', 'tecnico', 'familiar', 'no_dicho'] as const;
type QuienMidio = typeof QUIEN_MIDIO[number];

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  ts_canal: string;
}

interface DatosA1Medidas {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
}

interface MedidaOutput {
  ancho_m: number | null;
  alto_m: number | null;
  ambiente: string | null;
  quien_midio: QuienMidio;
  msg_id: string;
  confianza_individual: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  texto_original: string;
  observacion?: string;
}

const N_CONTEXTO = 5;

// Sanity: medidas razonables para persianas / ventanas (en metros)
const MIN_M = 0.30;
const MAX_M = 8.0;

export const a1MedidasHooks: AgenteHooks<DatosA1Medidas> = {
  async cargarContexto(sb, params) {
    const { data: evt, error: eErr } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal, payload')
      .eq('id', params.evento_id)
      .single();
    if (eErr || !evt) throw new Error(`evento ${params.evento_id} no encontrado: ${eErr?.message}`);

    const evidIds = (evt.evidencia_ids as any)?.msg_ids ?? [];
    const msgIdPrincipal: string | null = evidIds[0] ?? null;

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
      if (!m?.texto) throw new Error(`evento ${params.evento_id} no tiene mensaje con texto asociado`);
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
          `[msg_id=${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 280)}`
        ).join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A1_MEDIDAS. Extraés dimensiones físicas mencionadas en mensajes WhatsApp.
NO sugerís cotizaciones. NO marcás riesgos. Solo extraés lo dicho.

Tipos de medida válidos:
  - Par ancho×alto:   "2.40 x 1.80 m", "240×180", "dos metros por uno y medio"
  - Solo ancho:       "tiene 2 m de ancho", "el ancho son 180 cm"
  - Solo alto:        "el alto es 2 metros", "mide 1.50 de alto"
  - Largo:            algunas persianas se piden por largo total

Para cada medida intentás extraer ADEMÁS:
  - ambiente:   "sala", "cocina", "habitación principal", "estudio", "balcón", "oficina"...
                Devolvé null si NO se menciona.
  - quien_midio: uno de los enums fijos:
       * "cliente"   → el propio cliente / "yo medí"
       * "tecnico"   → un técnico / "vino el muchacho a medir"
       * "familiar"  → esposa / hijo / hermano / "mi mujer midió"
       * "no_dicho"  → no se dice (default)

Sanity:
  - Convertí TODO a metros con 2 decimales.
  - Rango razonable: ${MIN_M}–${MAX_M} m. Fuera de eso → descartá (probablemente no es medida útil).
  - Si solo hay un número (ej. "1.80"), NO inventes un par; devolvé ancho XOR alto.
  - "2 metros de tela" → NO es medida (es cantidad de material), descartá.

Confianza por medida:
  - CONFIRMADO  → medida clara con unidad explícita ("2.40 x 1.80 m")
  - INFERIDO    → medida sin unidad pero plausible ("2.40 x 1.80")
  - DUDOSO      → con muletilla ("como 2 m", "más o menos 1.80")

Reglas duras:
  R-001 anti-alucinación: TODA medida debe citar msg_id.
                          NO infieras medidas que NO aparezcan en el texto.
  Anti-contaminación:     NO uses medidas de OTROS clientes que recuerdes.
                          Solo lo dicho en estos mensajes.

Si NO hay medidas en el mensaje analizado, devolvé medidas=[] e incluí
el msg_id del mensaje actual en evidencia_msg_ids igualmente.

CÁLCULO MECÁNICO de "confianza" global (NO es una opinión, es un cálculo):
  PASO 1: Contá las medidas extraídas.
  PASO 2:
    - 0 medidas                              → confianza = "CONFIRMADO"  (no va al buzón)
    - ≥1 medida, todas CONFIRMADO/INFERIDO   → confianza = "INFERIDO"   (Jhon revisa)
    - ≥1 medida con confianza_individual=DUDOSO → confianza = "DUDOSO"  (Jhon revisa, prioridad)

PROHIBIDO ABSOLUTO:
  ✗ medidas=[] con confianza="DUDOSO" o "INFERIDO" → ERROR mecánico (rechazado)
  ✗ medidas=[{...}] con confianza="CONFIRMADO"      → ERROR mecánico (rechazado)

LEÉ ESTO DOS VECES:
  "CONFIRMADO" con medidas=[] NO significa "estoy seguro de las medidas".
  Significa "estoy seguro de que NO hay medidas en este mensaje".
  Es el caso normal, no implica error.

Devolvés JSON EXACTO con la forma de los ejemplos siguientes.

EJEMPLO 1 — mensaje sin medidas ("ok, perfecto"):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": { "medidas": [], "resumen": "0 medidas extraídas" },
  "evidencia_msg_ids": ["ID_DEL_MENSAJE_ANALIZADO"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 2 — mensaje con 1 medida clara ("la sala mide 2.40 x 1.80 m"):
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "medidas": [
      {
        "ancho_m": 2.40,
        "alto_m": 1.80,
        "ambiente": "sala",
        "quien_midio": "cliente",
        "msg_id": "XYZ123",
        "confianza_individual": "CONFIRMADO",
        "texto_original": "2.40 x 1.80 m"
      }
    ],
    "resumen": "1 medida extraída"
  },
  "evidencia_msg_ids": ["XYZ123"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO RECIENTE DEL CHAT ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[msg_id=${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}):
${datos.mensaje_actual.texto}

Extraé medidas del MENSAJE A ANALIZAR. El contexto solo está para resolver
referencias ("la primera medida que te dije" → buscar la medida previa).
Si una medida aparece SOLO en contexto y no en el mensaje analizado, NO la incluyas.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const medidas = (out.payload as any)?.medidas;
    if (!Array.isArray(medidas)) throw new ValidacionError('schema', 'payload.medidas debe ser array');

    // Coherencia medidas ↔ confianza global
    if (medidas.length === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a1',
        `medidas=[] requiere confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (medidas.length > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a1',
        `medidas.length=${medidas.length} requiere confianza='INFERIDO' o 'DUDOSO', no 'CONFIRMADO'`);
    }

    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);

    for (const m of medidas as MedidaOutput[]) {
      if (m.ancho_m === null && m.alto_m === null) {
        throw new ValidacionError('schema', `medida sin ancho_m ni alto_m: ${JSON.stringify(m)}`);
      }
      for (const [k, v] of [['ancho_m', m.ancho_m], ['alto_m', m.alto_m]] as const) {
        if (v !== null) {
          if (typeof v !== 'number' || isNaN(v)) throw new ValidacionError('schema', `${k} no es número: ${v}`);
          if (v < MIN_M || v > MAX_M) throw new ValidacionError('schema', `${k}=${v} fuera de rango [${MIN_M}, ${MAX_M}]`);
        }
      }
      if (typeof m.msg_id !== 'string') throw new ValidacionError('schema', `medida sin msg_id: ${JSON.stringify(m)}`);
      const realMsgId = resolverMsgId(m.msg_id, msgIdsValidos);
      if (!realMsgId) {
        throw new ValidacionError('R-anti-alucinacion',
          `medida cita msg_id '${m.msg_id}' que no está en mensaje o contexto`);
      }
      m.msg_id = realMsgId;
      if (!QUIEN_MIDIO.includes(m.quien_midio)) {
        throw new ValidacionError('schema',
          `quien_midio inválido: ${JSON.stringify(m.quien_midio)} (válidos: ${QUIEN_MIDIO.join(',')})`);
      }
      if (m.confianza_individual && !['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(m.confianza_individual)) {
        throw new ValidacionError('schema', `confianza_individual inválida: ${m.confianza_individual}`);
      }
      if (m.ambiente !== null && m.ambiente !== undefined && typeof m.ambiente !== 'string') {
        throw new ValidacionError('schema', `ambiente debe ser string o null: ${JSON.stringify(m.ambiente)}`);
      }
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // L1 extracción: no escribe a tabla `medidas`. Eso es A6_MEDIDAS + buzón.
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
