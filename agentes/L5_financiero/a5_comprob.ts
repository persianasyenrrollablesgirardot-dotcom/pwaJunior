/**
 * A5_COMPROB — validador de comprobantes de pago.
 *
 * Cierra el flujo de pagos:
 *   Cliente manda foto → A1_OCR la describe (metadata.ai_text)
 *   → A5_COMPROB extrae monto/banco/referencia/cuenta del texto OCR
 *   → compara con saldo esperado de la cotización
 *   → si match exacto = INFERIDO + abono propuesto
 *   → si difiere significativamente = ALERTA + observación
 *   → si no es comprobante = no aplica (devuelve hay_comprobante=false)
 *
 * Distinto de A5_ABONO:
 *   - A5_ABONO mira TEXTO del cliente ("ya te pagué $500.000")
 *   - A5_COMPROB mira IMAGEN del comprobante en sí (OCR via Vision)
 *
 * Ambos pueden emitir en el mismo evento (foto con caption). A5_COMPROB es
 * la fuente de verdad fuerte del monto (foto, no afirmación verbal).
 *
 * REGLAS DURAS:
 *   R-009: aunque tenga foto, NO confirma abono solo (sigue siendo INFERIDO,
 *     no CONFIRMADO). Solo el humano contra extracto bancario.
 *   R-001: ningún cambio a abono_recibido sin validación humana.
 *
 * tipo_evento='abono'. Tope $0.03/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  tipo: string;
  ts_canal: string;
  metadata: any;
}

interface CotizacionActiva {
  id: number;
  estado: string;
  total: number;
  abono_acumulado: number;
  saldo: number;
}

interface DatosA5Comprob {
  mensaje_actual: MensajeCtx;
  mensajes_contexto_textos: MensajeCtx[];   // contexto del cliente (para correlación)
  cotizacion_activa: CotizacionActiva | null;
  ocr_disponible: string | null;             // metadata.ai_text del comprobante
}

interface DatosComprobante {
  monto_visible: number | null;
  banco_emisor: string | null;
  fecha_visible: string | null;
  referencia_visible: string | null;
  cuenta_destino_visible: string | null;
}

interface ValidacionMatch {
  esperado_monto: number | null;
  diferencia: number | null;
  es_abono_parcial: boolean;
  monto_coincide: boolean;
}

const TOLERANCIA_MATCH_COP = 100; // diferencia ≤ $100 → considerar match exacto

export const a5ComprobHooks: AgenteHooks<DatosA5Comprob> = {
  async cargarContexto(sb, params) {
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    // Eventos originales (mensaje_*) traen canal_msg_id directo; eventos
    // derivados traen evidencia_ids.msg_ids. Tomar el primero disponible.
    const msgIdPrincipal: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? evt?.canal_msg_id ?? null;
    if (!msgIdPrincipal) throw new Error(`evento ${params.evento_id} sin canal_msg_id ni evidencia_ids.msg_ids`);

    const { data: m } = await sb.from('mensajes')
      .select('canal_msg_id, direccion, texto, tipo, ts_canal, metadata')
      .eq('chat_id', params.chat_id)
      .eq('canal_msg_id', msgIdPrincipal)
      .is('deleted_at', null)
      .maybeSingle();
    if (!m) throw new Error(`mensaje ${msgIdPrincipal} no encontrado`);

    const mensajeActual: MensajeCtx = {
      canal_msg_id: m.canal_msg_id, direccion: m.direccion as any,
      texto: m.texto ?? '', tipo: m.tipo, ts_canal: m.ts_canal,
      metadata: m.metadata ?? {},
    };

    // Contexto: últimos 3 mensajes del cliente con texto (para correlacionar
    // con caption "ya te pagué 500 mil" si el cliente lo escribió aparte)
    const { data: ctxMsgs } = await sb.from('mensajes')
      .select('canal_msg_id, direccion, texto, tipo, ts_canal, metadata')
      .eq('chat_id', params.chat_id)
      .is('deleted_at', null)
      .lt('ts_canal', mensajeActual.ts_canal)
      .order('ts_canal', { ascending: false })
      .limit(3);
    const ctxTextos: MensajeCtx[] = (ctxMsgs ?? [])
      .reverse()
      .map(x => ({
        canal_msg_id: x.canal_msg_id, direccion: x.direccion as any,
        texto: x.texto ?? '', tipo: x.tipo, ts_canal: x.ts_canal, metadata: x.metadata ?? {},
      }));

    // Cotización activa
    let cotActiva: CotizacionActiva | null = null;
    if (params.proyecto_id) {
      const { data: c } = await sb.from('cotizaciones')
        .select('id, estado, total, abono_monto, saldo')
        .eq('proyecto_id', params.proyecto_id)
        .is('deleted_at', null)
        .in('estado', ['propuesta', 'negociando', 'intencion_cierre', 'ganada'])
        .order('fecha', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (c) {
        cotActiva = {
          id: c.id, estado: c.estado,
          total: Number(c.total ?? 0),
          abono_acumulado: Number(c.abono_monto ?? 0),
          saldo: Number(c.saldo ?? 0),
        };
      }
    }

    // OCR del comprobante (ya hecho por extensión vía Vision)
    const ocr: string | null = mensajeActual.metadata?.ai_text ?? null;

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto_textos: ctxTextos,
      cotizacion_activa: cotActiva,
      ocr_disponible: ocr,
    };
  },

  construirPrompt(datos, agente) {
    const ctxStr = datos.mensajes_contexto_textos.length === 0
      ? '(sin contexto)'
      : datos.mensajes_contexto_textos.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'})${m.tipo !== 'texto' ? ` [${m.tipo}]` : ''}: ${truncar(m.texto, 160)}`
        ).join('\n');

    const cotStr = datos.cotizacion_activa
      ? `Cotización activa #${datos.cotizacion_activa.id}: total=$${datos.cotizacion_activa.total.toLocaleString('es-CO')}, abonado=$${datos.cotizacion_activa.abono_acumulado.toLocaleString('es-CO')}, saldo=$${datos.cotizacion_activa.saldo.toLocaleString('es-CO')}`
      : 'NO hay cotización activa.';

    const ocrStr = datos.ocr_disponible
      ? `=== TEXTO OCR DEL COMPROBANTE ===\n${truncar(datos.ocr_disponible, 1500)}\n`
      : '⚠ No hay OCR disponible (mensaje sin Vision processing). Si el mensaje tampoco es imagen → devolvé hay_comprobante=false.';

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A5_COMPROB. Analizás el TEXTO OCR de una foto de comprobante de pago
y extraés:
  - monto_visible: número que el comprobante muestra como valor de la transacción
  - banco_emisor: el banco que originó (Bancolombia, Davivienda, Nequi, etc.)
  - fecha_visible: fecha de la transacción (YYYY-MM-DD)
  - referencia_visible: número de operación, CUS, comprobante #
  - cuenta_destino_visible: cuenta a la que entró el dinero (parcial OK: "...12345")

ANTI-ALUCINACIÓN CRÍTICO:
  SOLO incluí campos que aparezcan LITERALMENTE en el OCR (texto pasado más abajo).
  Si el OCR no menciona un campo → ese campo va NULL.
  NUNCA completes "banco_emisor" o "referencia_visible" con valores que recuerdes
  de otros comprobantes — son valores del COMPROBANTE ACTUAL únicamente.
  Si el OCR es muy corto/ambiguo (ej. "TRANSF... 500...") y no podés extraer
  los campos clave, devolvé hay_comprobante=true con todos los campos null
  excepto los que SÍ aparecen + confianza=DUDOSO.

Y validás:
  - monto_coincide: si el monto extraído coincide con el saldo esperado de la
    cotización activa (tolerancia ${TOLERANCIA_MATCH_COP} COP).
  - es_abono_parcial: si el monto es MENOR al saldo total esperado.
  - diferencia: esperado_saldo - monto_visible (positivo si abono parcial).

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  REGLA: comprobantes requieren validación humana contra extracto (R-009).
         NUNCA CONFIRMADO. Pero "no es comprobante" sí (estoy seguro de eso).

  caso A — hay_comprobante=false (mensaje NO es comprobante):
    out.confianza = "CONFIRMADO" (no va al buzón, no aporta revisar)

  caso B — hay_comprobante=true:
    SI monto_visible == null O OCR confuso       → out.confianza = "DUDOSO"
    SI hay datos y validacion_match.monto_coincide=false (mismatch real)
                                                  → out.confianza = "ALERTA"  (prioridad 1)
    SI hay datos y match o sin cotización activa → out.confianza = "INFERIDO" (buzón normal)

PROHIBIDO ABSOLUTO:
  ✗ hay_comprobante=true con out.confianza="CONFIRMADO" → ERROR (R-009)
  ✗ hay_comprobante=false con out.confianza != "CONFIRMADO" → ERROR mecánico

R-009 / R-001: aunque tengamos comprobante, NO podemos confirmar abono solos.
  El humano valida contra el extracto bancario. Por eso ni siquiera CONFIRMADO
  para el caso de match exacto: nuestro tope es INFERIDO.

NO ES COMPROBANTE:
  Si el OCR claramente describe otra cosa (foto del producto, foto de medida,
  meme, etc.) → hay_comprobante=false, datos_comprobante=null, validación=null.

CONTEXTO:
${cotStr}

${ocrStr}

Salida JSON EXACTA:
{
  "tipo_evento": "abono",
  "confianza": "INFERIDO",
  "payload": {
    "hay_comprobante": true,
    "datos_comprobante": {
      "monto_visible": 500000,
      "banco_emisor": "Bancolombia",
      "fecha_visible": "2026-05-10",
      "referencia_visible": "78445A",
      "cuenta_destino_visible": "...12345"
    },
    "validacion_match": {
      "esperado_monto": 850000,
      "diferencia": 350000,
      "es_abono_parcial": true,
      "monto_coincide": false
    },
    "alertas": ["Monto del comprobante ($500.000) es menor al saldo esperado ($850.000). Diferencia $350.000 — puede ser abono parcial."],
    "cotizacion_id_sugerido": ${datos.cotizacion_activa?.id ?? 'null'},
    "resumen": "Comprobante Bancolombia $500.000 (abono parcial del saldo $850.000)"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001","R-009"]
}

Si NO hay comprobante (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "abono",
  "confianza": "CONFIRMADO",
  "payload": {
    "hay_comprobante": false,
    "datos_comprobante": null,
    "validacion_match": null,
    "alertas": [],
    "cotizacion_id_sugerido": null,
    "resumen": "Mensaje no es comprobante de pago"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO PREVIO ===
${ctxStr}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] tipo=${datos.mensaje_actual.tipo} (${datos.mensaje_actual.direccion}): ${datos.mensaje_actual.texto || '(sin caption)'}

${datos.ocr_disponible ? '(el OCR está arriba en el system prompt)' : '(no hay OCR — usar texto si existe)'}

Determiná si esto es un comprobante de pago y validalo contra la cotización
activa.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.hay_comprobante !== 'boolean') {
      throw new ValidacionError('schema', 'hay_comprobante debe ser boolean');
    }
    if (p.hay_comprobante) {
      if (!p.datos_comprobante || typeof p.datos_comprobante !== 'object') {
        throw new ValidacionError('schema', 'hay_comprobante=true requiere datos_comprobante');
      }
      const d: DatosComprobante = p.datos_comprobante;
      if (d.monto_visible !== null && d.monto_visible !== undefined) {
        if (typeof d.monto_visible !== 'number' || d.monto_visible < 1000 || d.monto_visible > 200_000_000) {
          throw new ValidacionError('schema', `monto_visible fuera de rango: ${d.monto_visible}`);
        }
      }
      if (d.fecha_visible !== null && d.fecha_visible !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d.fecha_visible)) {
          throw new ValidacionError('schema', `fecha_visible formato inválido: ${d.fecha_visible}`);
        }
      }
      const v: ValidacionMatch | null = p.validacion_match;
      if (v) {
        // Si no hay cotización activa (esperado_monto=null), monto_coincide y
        // es_abono_parcial pueden ser null (no hay nada contra qué comparar).
        const hayEsperado = v.esperado_monto !== null && v.esperado_monto !== undefined;
        if (hayEsperado) {
          if (typeof v.monto_coincide !== 'boolean') throw new ValidacionError('schema', 'con esperado_monto, monto_coincide debe ser boolean');
          if (typeof v.es_abono_parcial !== 'boolean') throw new ValidacionError('schema', 'con esperado_monto, es_abono_parcial debe ser boolean');
        } else {
          // Sin cotización activa: aceptamos null o boolean
          if (v.monto_coincide !== null && v.monto_coincide !== undefined && typeof v.monto_coincide !== 'boolean') {
            throw new ValidacionError('schema', 'monto_coincide debe ser null o boolean');
          }
          if (v.es_abono_parcial !== null && v.es_abono_parcial !== undefined && typeof v.es_abono_parcial !== 'boolean') {
            throw new ValidacionError('schema', 'es_abono_parcial debe ser null o boolean');
          }
        }
        if (v.esperado_monto !== null && v.esperado_monto !== undefined && d.monto_visible !== null && d.monto_visible !== undefined) {
          const diffEsperada = v.esperado_monto - d.monto_visible;
          if (v.diferencia !== null && v.diferencia !== undefined) {
            if (Math.abs((v.diferencia as number) - diffEsperada) > 1) {
              throw new ValidacionError('coherencia-a5c',
                `diferencia=${v.diferencia} inconsistente con esperado(${v.esperado_monto})-monto(${d.monto_visible})=${diffEsperada}`);
            }
          }
        }
      }
      if (p.cotizacion_id_sugerido !== null && p.cotizacion_id_sugerido !== undefined) {
        if (datos.cotizacion_activa === null) {
          throw new ValidacionError('coherencia-a5c', 'cotizacion_id_sugerido pero no hay cotización activa');
        }
        if (p.cotizacion_id_sugerido !== datos.cotizacion_activa.id) {
          throw new ValidacionError('coherencia-a5c',
            `cotizacion_id_sugerido=${p.cotizacion_id_sugerido} no coincide con la activa`);
        }
      }
    } else {
      if (p.datos_comprobante !== null && p.datos_comprobante !== undefined) {
        throw new ValidacionError('schema', 'hay_comprobante=false requiere datos_comprobante=null');
      }
    }
    if (!Array.isArray(p?.alertas)) {
      throw new ValidacionError('schema', 'payload.alertas debe ser array');
    }

    // Coherencia mecánica out.confianza ↔ hay_comprobante
    if (!p.hay_comprobante && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a5c',
        `hay_comprobante=false requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.hay_comprobante && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('R-009',
        `hay_comprobante=true no puede tener out.confianza='CONFIRMADO' (R-009: humano valida contra extracto)`);
    }
    if (p.hay_comprobante) {
      const d: DatosComprobante = p.datos_comprobante;
      if ((d.monto_visible == null) && out.confianza !== 'DUDOSO') {
        throw new ValidacionError('coherencia-a5c',
          `monto_visible=null requiere out.confianza='DUDOSO', recibido '${out.confianza}'`);
      }
    }

    // Resolver msg_ids con tolerancia prefijo
    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto_textos.map(m => m.canal_msg_id),
    ]);
    if (Array.isArray(out.evidencia_msg_ids)) {
      for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
        const real = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
        if (real) out.evidencia_msg_ids[i] = real;
      }
    }
  },

  async postProcesar(sb: SupabaseClient, out, ctx) {
    if (ctx.agente.shadow) return;
    const p = out.payload as any;
    if (!p.hay_comprobante) return;
    const d = p.datos_comprobante as DatosComprobante;
    if (d.monto_visible == null) return;   // sin monto no podemos crear abono (NOT NULL)

    const notas = Array.isArray(p.alertas) && p.alertas.length > 0
      ? `[A5_COMPROB] ${p.alertas.join(' | ')}`
      : '[A5_COMPROB] comprobante OCR' + (d.banco_emisor ? ` (banco: ${d.banco_emisor})` : '');

    // metodo está acotado por CHECK constraint: bancolombia/nequi/daviplata/efectivo/transferencia/tarjeta/consignacion/otro
    const METODOS_OK = new Set(['bancolombia', 'nequi', 'daviplata', 'efectivo', 'transferencia', 'tarjeta', 'consignacion']);
    const metodoNorm = d.banco_emisor ? d.banco_emisor.toLowerCase() : 'transferencia';
    const metodo = METODOS_OK.has(metodoNorm) ? metodoNorm : 'transferencia';

    const { data: ab, error } = await sb.from('abonos').insert({
      cotizacion_id: p.cotizacion_id_sugerido ?? null,
      persona_id: ctx.persona_id,
      monto: d.monto_visible,
      fecha: d.fecha_visible ?? new Date().toISOString().slice(0, 10),
      metodo,
      referencia: d.referencia_visible,
      cuenta_receptora: d.cuenta_destino_visible,
      estado_validacion: 'pendiente',
      shadow: true,
      agente_origen: ctx.agente.codigo,
      notas,
    } as any).select('id').single();
    if (error || !ab) {
      throw new Error(`A5_COMPROB insert abono: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'abono', entidad_id: ab.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
