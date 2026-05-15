/**
 * A5_ABONO — detector de confirmaciones de pago/abono.
 *
 * Cuando el cliente dice "ya transferí $500.000" o "acabo de pagar 850k a
 * Bancolombia", A5_ABONO propone el abono al buzón para que Jhon valide.
 *
 * REGLAS DURAS:
 *   - R-009: SOLO FOTO de comprobante NO puede ser CONFIRMADO. Si no hay texto
 *     que diga el monto, confianza=DUDOSO + solo_foto_comprobante=true.
 *   - R-001: estado_validacion SIEMPRE 'pendiente'. El humano lo cambia a
 *     'confirmado' tras verificar contra extracto bancario.
 *   - NO inventar montos. NO inferir transferencias por mensaje de "Te debo X"
 *     (eso es saldo, no abono).
 *
 * Distingue:
 *   - Confirmación de pago YA hecho ("ya transferí", "acabo de pagar") → abono
 *   - Promesa futura ("mañana te pago") → NO es abono
 *   - Pregunta ("cuánto debo?") → NO es abono
 *   - Saldo pendiente ("me queda X") → NO es abono (eso es A5_CARTERA)
 *
 * tipo_evento='abono'. Tope $0.03/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

const METODOS_VALIDOS = ['bancolombia', 'nequi', 'daviplata', 'efectivo', 'transferencia', 'tarjeta', 'consignacion', 'otro'] as const;
type MetodoPago = typeof METODOS_VALIDOS[number];

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  tipo: string;             // 'texto' | 'imagen' | 'audio' | ...
  ts_canal: string;
}

interface CotizacionActiva {
  id: number;
  estado: string;
  total: number;
  abono_acumulado: number;       // total ya abonado
  saldo: number;
}

interface DatosA5Abono {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  cotizacion_activa: CotizacionActiva | null;
  hay_imagen_reciente: boolean;     // foto/comprobante en últimos 3 mensajes
}

interface AbonoOutput {
  monto: number | null;            // null si no se infiere
  metodo: MetodoPago;
  referencia: string | null;
  cuenta_receptora: string | null;
  solo_foto_comprobante: boolean;
  fecha_inferida: string | null;   // YYYY-MM-DD, default hoy si no dice
}

const N_CONTEXTO = 5;
const MIN_MONTO_COP = 5_000;
const MAX_MONTO_COP = 100_000_000;

export const a5AbonoHooks: AgenteHooks<DatosA5Abono> = {
  async cargarContexto(sb, params) {
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    const msgIdPrincipal: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? evt?.canal_msg_id ?? null;

    let mensajeActual: MensajeCtx | null = null;
    if (msgIdPrincipal) {
      const { data: m } = await sb.from('mensajes')
        .select('canal_msg_id, direccion, texto, tipo, ts_canal')
        .eq('chat_id', params.chat_id)
        .eq('canal_msg_id', msgIdPrincipal)
        .is('deleted_at', null)
        .maybeSingle();
      if (m) mensajeActual = { canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto ?? '', tipo: m.tipo, ts_canal: m.ts_canal };
    }
    if (!mensajeActual) {
      const { data: msgs } = await sb.from('mensajes')
        .select('canal_msg_id, direccion, texto, tipo, ts_canal')
        .eq('chat_id', params.chat_id)
        .is('deleted_at', null)
        .lte('ts_canal', evt?.ts_canal ?? new Date().toISOString())
        .order('ts_canal', { ascending: false })
        .limit(1);
      const m = msgs?.[0];
      if (!m) throw new Error(`evento ${params.evento_id} sin mensaje asociado`);
      mensajeActual = { canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto ?? '', tipo: m.tipo, ts_canal: m.ts_canal };
    }

    const { data: ctxMsgs } = await sb.from('mensajes')
      .select('canal_msg_id, direccion, texto, tipo, ts_canal')
      .eq('chat_id', params.chat_id)
      .is('deleted_at', null)
      .lt('ts_canal', mensajeActual.ts_canal)
      .order('ts_canal', { ascending: false })
      .limit(N_CONTEXTO);

    const contexto: MensajeCtx[] = (ctxMsgs ?? [])
      .reverse()
      .map(m => ({
        canal_msg_id: m.canal_msg_id, direccion: m.direccion as any,
        texto: m.texto ?? '', tipo: m.tipo, ts_canal: m.ts_canal,
      }));

    // Imagen reciente (últimos 3 mensajes incluyendo el actual)
    const ventanaImagen = [...contexto.slice(-2), mensajeActual];
    const hayImagen = ventanaImagen.some(m => m.tipo === 'imagen' || m.tipo === 'documento');

    // Cotización activa (con saldo)
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

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      cotizacion_activa: cotActiva,
      hay_imagen_reciente: hayImagen,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m => {
          const tipo = m.tipo !== 'texto' ? ` [${m.tipo}]` : '';
          return `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'})${tipo}: ${truncar(m.texto, 180)}`;
        }).join('\n');

    const cotStr = datos.cotizacion_activa
      ? `Cotización activa #${datos.cotizacion_activa.id} estado=${datos.cotizacion_activa.estado} · total=$${datos.cotizacion_activa.total.toLocaleString('es-CO')} · abonado=$${datos.cotizacion_activa.abono_acumulado.toLocaleString('es-CO')} · saldo=$${datos.cotizacion_activa.saldo.toLocaleString('es-CO')}`
      : 'NO hay cotización activa para este proyecto.';

    const imgStr = datos.hay_imagen_reciente
      ? '⚠ Hay imagen/comprobante adjunto en últimos mensajes — si el cliente dice "te paso el comprobante" pero NO menciona monto en texto, marcá solo_foto_comprobante=true (R-009).'
      : 'No hay imagen reciente.';

    const tipoMsg = datos.mensaje_actual.tipo !== 'texto' ? ` [${datos.mensaje_actual.tipo}]` : '';

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A5_ABONO. Detectás cuando el cliente CONFIRMA un pago/abono ya realizado.

DETECTAR:
  - "ya transferí $500.000"  → abono CONFIRMADO con monto
  - "acabo de pagar 850k a Bancolombia" → abono con método=bancolombia
  - "te consigné el saldo, $350.000" → abono
  - "ahí va el pago" + texto con monto → abono
  - "ya pagué" SIN monto → abono DUDOSO (R-001: sin monto, requiere humano)

NO DETECTAR:
  - "mañana te pago" → promesa futura, NO es abono
  - "cuánto debo?" → pregunta, NO es abono
  - "me queda 500 mil" → saldo, NO es abono (eso lo agarra A5_CARTERA)
  - "te debía 500 mil" → mención de deuda, NO confirma pago
  - Mensaje del NEGOCIO (saliente) → NO aplica, somos nosotros emitiendo

REGLAS DURAS:
  R-009 SOLO FOTO DE COMPROBANTE:
    Si el cliente mandó FOTO/IMAGEN pero NO menciona el monto en TEXTO,
    es solo_foto_comprobante=true. En ese caso:
      - confianza="DUDOSO" (NO puede ser CONFIRMADO sin texto explícito)
      - monto puede ir null o lo que extraigas del texto si lo hay
  R-001: estado_validacion SIEMPRE "pendiente" (este agente NO confirma abonos;
    eso lo hace el humano contra el extracto bancario).

CAMPOS:
  - monto: número entero en COP. null si no se infiere (cliente solo dice "ya pagué")
  - metodo: enum cerrado, default "transferencia" si dice "transfer"/"transferí",
            "bancolombia" si menciona Bancolombia/Bancol, "nequi", "daviplata",
            "efectivo" si dice efectivo/cash, "otro" si dudás.
  - referencia: número de operación/comprobante mencionado (string).
  - cuenta_receptora: a qué cuenta entró el dinero si se menciona.
  - solo_foto_comprobante: true si solo hay foto, false si hay texto con monto.
  - fecha_inferida: YYYY-MM-DD. Si dice "hoy"/"ahora" → fecha actual.
                    Si dice "ayer" → ayer. Si no dice → hoy.

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  REGLA: abonos requieren validación humana SIEMPRE (R-001). NUNCA CONFIRMADO
         cuando hay_abono=true. Pero "estoy seguro de que NO hay abono" sí.

  caso A — hay_abono=false (mensaje NO confirma pago, R-001 sin alucinación):
    out.confianza = "CONFIRMADO"  (no va al buzón, no aporta revisar)

  caso B — hay_abono=true:
    SI abono.solo_foto_comprobante=true → out.confianza = "DUDOSO"   (R-009)
    SI abono.monto == null              → out.confianza = "DUDOSO"   (sin monto claro)
    SI todo claro (monto + método)      → out.confianza = "INFERIDO" (buzón para Jhon)

PROHIBIDO ABSOLUTO:
  ✗ hay_abono=true con out.confianza="CONFIRMADO" → ERROR (R-001)
  ✗ hay_abono=false con out.confianza != "CONFIRMADO" → ERROR mecánico

CONTEXTO DE COTIZACIÓN:
  ${cotStr}
  ${imgStr}

Salida JSON EXACTA — caso CON abono:
{
  "tipo_evento": "abono",
  "confianza": "INFERIDO",
  "payload": {
    "hay_abono": true,
    "abono": {
      "monto": 500000,
      "metodo": "bancolombia",
      "referencia": "Op 78445A",
      "cuenta_receptora": null,
      "solo_foto_comprobante": false,
      "fecha_inferida": "2026-05-11"
    },
    "cotizacion_id_sugerido": ${datos.cotizacion_activa?.id ?? 'null'},
    "monto_coincide_saldo": false,
    "resumen": "Cliente abonó $500.000 vía Bancolombia. Ref Op 78445A."
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001","R-009"]
}

Caso SIN abono detectado (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "abono",
  "confianza": "CONFIRMADO",
  "payload": {
    "hay_abono": false,
    "abono": null,
    "cotizacion_id_sugerido": null,
    "monto_coincide_saldo": false,
    "resumen": "Mensaje no confirma pago"
  },
  "evidencia_msg_ids": ["<msg_id_actual>"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'})${tipoMsg}: ${datos.mensaje_actual.texto || '(sin texto)'}

Determiná si el MENSAJE A ANALIZAR confirma un pago ya realizado.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.hay_abono !== 'boolean') {
      throw new ValidacionError('schema', 'hay_abono debe ser boolean');
    }
    if (p.hay_abono) {
      const a: AbonoOutput = p.abono;
      if (!a || typeof a !== 'object') throw new ValidacionError('schema', 'hay_abono=true requiere abono');
      if (a.monto !== null && a.monto !== undefined) {
        if (typeof a.monto !== 'number' || a.monto < MIN_MONTO_COP || a.monto > MAX_MONTO_COP) {
          throw new ValidacionError('schema', `monto fuera de rango [${MIN_MONTO_COP},${MAX_MONTO_COP}]: ${a.monto}`);
        }
      }
      if (!METODOS_VALIDOS.includes(a.metodo)) {
        throw new ValidacionError('schema', `método inválido: '${a.metodo}'`);
      }
      if (typeof a.solo_foto_comprobante !== 'boolean') {
        throw new ValidacionError('schema', 'solo_foto_comprobante debe ser boolean');
      }
      if (a.fecha_inferida !== null && a.fecha_inferida !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(a.fecha_inferida)) {
          throw new ValidacionError('schema', `fecha_inferida formato inválido: ${a.fecha_inferida}`);
        }
      }
      if (p.cotizacion_id_sugerido !== null && p.cotizacion_id_sugerido !== undefined) {
        if (datos.cotizacion_activa === null) {
          throw new ValidacionError('coherencia-a5',
            'cotizacion_id_sugerido pero no hay cotización activa');
        }
        if (p.cotizacion_id_sugerido !== datos.cotizacion_activa.id) {
          throw new ValidacionError('coherencia-a5',
            `cotizacion_id_sugerido=${p.cotizacion_id_sugerido} no coincide con la activa (${datos.cotizacion_activa.id})`);
        }
      }
      if (typeof p.monto_coincide_saldo !== 'boolean') {
        throw new ValidacionError('schema', 'monto_coincide_saldo debe ser boolean');
      }
    } else {
      if (p.abono !== null && p.abono !== undefined) {
        throw new ValidacionError('schema', 'Si hay_abono=false, abono debe ser null');
      }
    }

    // Coherencia mecánica out.confianza ↔ hay_abono
    if (!p.hay_abono && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a5',
        `hay_abono=false requiere out.confianza='CONFIRMADO' (no hay nada que validar), recibido '${out.confianza}'`);
    }
    if (p.hay_abono && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a5',
        `hay_abono=true no puede tener out.confianza='CONFIRMADO' — R-001 exige validación humana (usar INFERIDO o DUDOSO)`);
    }
    if (p.hay_abono) {
      const a = p.abono as AbonoOutput;
      if (a.solo_foto_comprobante && out.confianza !== 'DUDOSO') {
        throw new ValidacionError('R-009',
          `solo_foto_comprobante=true requiere out.confianza='DUDOSO' (sin texto de monto), recibido '${out.confianza}'`);
      }
      if (a.monto === null && out.confianza !== 'DUDOSO') {
        throw new ValidacionError('coherencia-a5',
          `monto=null requiere out.confianza='DUDOSO', recibido '${out.confianza}'`);
      }
    }

    // Resolver msg_ids con tolerancia de prefijo true_/false_
    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);
    if (Array.isArray(out.evidencia_msg_ids)) {
      for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
        const real = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
        if (real) out.evidencia_msg_ids[i] = real;
      }
    }
  },

  async postProcesar(sb: SupabaseClient, out, ctx) {
    // En shadow del agente: no escribir.
    if (ctx.agente.shadow) return;

    const p = out.payload as any;
    if (!p.hay_abono) return;            // sin abono → nada que escribir
    const a = p.abono as AbonoOutput;
    if (a.monto == null) return;         // sin monto no podemos crear fila (NOT NULL)

    // Crear abono shadow=true. La RPC aprobar_buzon_atomic lo promueve cuando
    // Jhon valida contra el extracto.
    const { data: ab, error } = await sb.from('abonos').insert({
      cotizacion_id: p.cotizacion_id_sugerido ?? null,
      persona_id: ctx.persona_id,
      monto: a.monto,
      fecha: a.fecha_inferida ?? new Date().toISOString().slice(0, 10),
      metodo: a.metodo,
      referencia: a.referencia,
      cuenta_receptora: a.cuenta_receptora,
      estado_validacion: 'pendiente',
      shadow: true,
      agente_origen: ctx.agente.codigo,
    } as any).select('id').single();
    if (error || !ab) {
      throw new Error(`A5_ABONO insert abono: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'abono', entidad_id: ab.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
