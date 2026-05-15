/**
 * A1_MONTOS — extractor de montos en COP con contexto.
 *
 * Complemento del regex de montos (`agentes/extractor/regex.ts`):
 *   - El regex agarra "$850.000", "1.5M", "850 mil", "1.500.000 pesos" → monto_cop.
 *   - A1_MONTOS agrega lo que regex no puede:
 *       · tipo_monto inferido: precio_total / abono / saldo / costo /
 *         descuento / referencia_externa / no_dicho
 *       · emisor: cliente / negocio (según dirección del mensaje)
 *       · concepto asociado al monto si se menciona ("blackout sala")
 *       · montos en jerga colombiana: "lucas", "lukas", "milpa", "millón y medio"
 *       · confianza individual por ambigüedad ("como 800 mil" → DUDOSO)
 *
 * NO crea cotización (A4_COTIZ), NO crea abono (A5_ABONO).
 * Solo extrae y emite payload.montos en evento_pg(dato_extraido, shadow=true).
 *
 * Tope $0.01/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

const TIPOS_MONTO = [
  'precio_total',        // total de cotización ("son 1.5M en total")
  'precio_unitario',     // por unidad / por m² ("$50.000 el metro")
  'abono',               // pago realizado ("ya te abonó 500 mil")
  'saldo',               // queda pendiente ("debes 800 mil")
  'costo',               // costo proveedor / instalación interno
  'descuento',           // rebaja / promoción
  'referencia_externa',  // precio de la competencia ("en Homecenter está a X")
  'no_dicho',            // monto sin contexto claro
] as const;
type TipoMonto = typeof TIPOS_MONTO[number];

const EMISORES = ['cliente', 'negocio'] as const;
type Emisor = typeof EMISORES[number];

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  ts_canal: string;
}

interface DatosA1Montos {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
}

interface MontoOutput {
  monto_cop: number;
  tipo_monto: TipoMonto;
  emisor: Emisor;
  concepto: string | null;
  msg_id: string;
  confianza_individual: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  texto_original: string;
  observacion?: string;
}

const N_CONTEXTO = 5;
const MIN_COP = 5_000;       // mínimo razonable para una persiana
const MAX_COP = 50_000_000;  // tope superior (sanity)

export const a1MontosHooks: AgenteHooks<DatosA1Montos> = {
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

    const emisor: Emisor = datos.mensaje_actual.direccion === 'saliente' ? 'negocio' : 'cliente';

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A1_MONTOS. Extraés montos en pesos colombianos (COP) mencionados en el mensaje.
NO sugerís cotizaciones. NO marcás abonos. Solo extraés monto + contexto.

Para cada monto identificá:
  - monto_cop: número entero en pesos (ej. 850000 para $850.000)
  - tipo_monto: enum cerrado:
       * "precio_total"        → total de cotización / venta ("son 1.5M en total", "el valor sería 850 mil")
       * "precio_unitario"     → por unidad o m² ("$50.000 el metro")
       * "abono"               → pago realizado / "ya pagué" / "ya te abonó"
       * "saldo"               → pendiente / "debes" / "queda"
       * "costo"               → costo interno (proveedor / instalación)
       * "descuento"           → rebaja / promoción / "te lo dejo en"
       * "referencia_externa"  → precio de competencia ("en Homecenter está a X")
       * "no_dicho"            → sin contexto claro (default)
  - emisor: "cliente" o "negocio"
       Default sale del rol del mensaje analizado (este mensaje es de: ${emisor.toUpperCase()}).
       Cambialo solo si el monto cita explícitamente al otro lado.
  - concepto: producto/servicio asociado si se menciona ("blackout sala", "instalación", "motor"),
              null si NO se menciona.

Jerga colombiana válida:
  - "lucas" / "lukas" / "milpa" → mil pesos ("850 lucas" = 850.000)
  - "millón" / "millones" / "M" → 1.000.000 ("1.5M" = 1.500.000, "millón y medio" = 1.500.000)
  - "K" → mil ("350K" = 350.000)

Reglas duras:
  R-001: cada monto debe citar msg_id. NO inventes montos.
  Anti-contaminación: NO uses montos de OTROS clientes que recuerdes.

Sanity:
  - Rango: ${MIN_COP.toLocaleString('es-CO')} – ${MAX_COP.toLocaleString('es-CO')} COP.
    Fuera de eso → descartá (probable falso positivo).
  - "Cra 50 #80-15" NO es monto. "20 años" NO es monto. "2 metros" NO es monto.
    Sin señal monetaria (símbolo $, palabra "pesos/cop/lucas/M/K/mil", o separador de miles
    tipo 1.500.000) → descartá.

Confianza individual:
  - CONFIRMADO  → monto con señal explícita ("$850.000", "1.500.000 pesos")
  - INFERIDO    → monto con jerga clara ("1.5M", "850 mil")
  - DUDOSO      → muletilla / aproximado ("como 800 mil", "más o menos un millón")

Si NO hay montos en el mensaje analizado, devolvé montos=[] e incluí el msg_id
del mensaje actual en evidencia_msg_ids.

CÁLCULO MECÁNICO de "confianza" global (NO es una opinión, es un cálculo):
  PASO 1: Contá los montos extraídos.
  PASO 2:
    - 0 montos                                → confianza = "CONFIRMADO"  (no va al buzón)
    - ≥1 monto, todos CONFIRMADO/INFERIDO    → confianza = "INFERIDO"   (Jhon revisa)
    - ≥1 monto con confianza_individual=DUDOSO → confianza = "DUDOSO"   (Jhon revisa, prioridad)

PROHIBIDO ABSOLUTO:
  ✗ montos=[] con confianza="DUDOSO" o "INFERIDO" → ERROR mecánico (rechazado)
  ✗ montos=[{...}] con confianza="CONFIRMADO"      → ERROR mecánico (rechazado)

LEÉ ESTO DOS VECES:
  "CONFIRMADO" con montos=[] NO significa "estoy seguro de los montos".
  Significa "estoy seguro de que NO hay montos en este mensaje".
  Es el caso normal, no implica error.

Devolvés JSON EXACTO con la forma de los ejemplos siguientes.

EJEMPLO 1 — mensaje sin montos ("ok, gracias"):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": { "montos": [], "resumen": "0 montos extraídos" },
  "evidencia_msg_ids": ["ID_DEL_MENSAJE_ANALIZADO"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 2 — mensaje con 1 monto claro ("blackout sala $850.000"):
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "montos": [
      {
        "monto_cop": 850000,
        "tipo_monto": "precio_total",
        "emisor": "negocio",
        "concepto": "blackout sala",
        "msg_id": "XYZ123",
        "confianza_individual": "CONFIRMADO",
        "texto_original": "$850.000"
      }
    ],
    "resumen": "1 monto extraído"
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
[msg_id=${datos.mensaje_actual.canal_msg_id}] (${emisor.toUpperCase()}):
${datos.mensaje_actual.texto}

Extraé montos del MENSAJE A ANALIZAR. El contexto solo está para resolver
referencias ("el precio que te dije" → buscar el monto previo).
Si un monto aparece SOLO en contexto y no en el mensaje analizado, NO lo incluyas.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const montos = (out.payload as any)?.montos;
    if (!Array.isArray(montos)) throw new ValidacionError('schema', 'payload.montos debe ser array');

    // Coherencia montos ↔ confianza global
    if (montos.length === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a1',
        `montos=[] requiere confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (montos.length > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a1',
        `montos.length=${montos.length} requiere confianza='INFERIDO' o 'DUDOSO', no 'CONFIRMADO'`);
    }

    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);

    for (const m of montos as MontoOutput[]) {
      if (typeof m.monto_cop !== 'number' || !Number.isFinite(m.monto_cop)) {
        throw new ValidacionError('schema', `monto_cop no es número: ${JSON.stringify(m.monto_cop)}`);
      }
      if (m.monto_cop < MIN_COP || m.monto_cop > MAX_COP) {
        throw new ValidacionError('schema', `monto_cop=${m.monto_cop} fuera de rango [${MIN_COP}, ${MAX_COP}]`);
      }
      if (!TIPOS_MONTO.includes(m.tipo_monto)) {
        throw new ValidacionError('schema',
          `tipo_monto inválido: ${JSON.stringify(m.tipo_monto)} (válidos: ${TIPOS_MONTO.join(',')})`);
      }
      if (!EMISORES.includes(m.emisor)) {
        throw new ValidacionError('schema',
          `emisor inválido: ${JSON.stringify(m.emisor)} (válidos: ${EMISORES.join(',')})`);
      }
      if (m.concepto !== null && m.concepto !== undefined && typeof m.concepto !== 'string') {
        throw new ValidacionError('schema', `concepto debe ser string o null: ${JSON.stringify(m.concepto)}`);
      }
      if (typeof m.msg_id !== 'string') throw new ValidacionError('schema', `monto sin msg_id: ${JSON.stringify(m)}`);
      const realMsgId = resolverMsgId(m.msg_id, msgIdsValidos);
      if (!realMsgId) {
        throw new ValidacionError('R-anti-alucinacion',
          `monto cita msg_id '${m.msg_id}' que no está en mensaje o contexto`);
      }
      m.msg_id = realMsgId;
      if (m.confianza_individual && !['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(m.confianza_individual)) {
        throw new ValidacionError('schema', `confianza_individual inválida: ${m.confianza_individual}`);
      }
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // L1: no escribe a tablas de cotización / abono / factura.
    // Eso es L4 (A4_COTIZ) y L5 (A5_ABONO) cuando A1_MONTOS pase a productivo.
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
