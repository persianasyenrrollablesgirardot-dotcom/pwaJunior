/**
 * A5_RENTAB — calculador de rentabilidad real por cotización.
 *
 * Cuando se registra un costo nuevo o se cierra una cotización, A5_RENTAB
 * calcula el margen real:
 *
 *   margen = total_venta + variaciones_neto - costos_totales
 *   margen_pct = margen / total_venta × 100
 *
 * Alertas:
 *   - margen_pct < 0    → ALERTA CRÍTICA: estamos perdiendo plata
 *   - margen_pct < 10%  → ALERTA WARNING: rentabilidad baja
 *   - margen_pct ≥ 10%  → INFERIDO informativo (no acción requerida)
 *
 * Genera observaciones que indican el problema dominante:
 *   "Costos de visita_extra+retrabajo representan 30% del costo total"
 *   "Variación 'descuento_negociado' de -150k bajó margen a 7%"
 *
 * tipo_evento='costo'. Tope $0.01/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

interface CostoItem {
  id: number;
  tipo: string;
  descripcion: string | null;
  monto: number;
  fecha: string;
  vendor: string | null;
}

interface VariacionItem {
  id: number;
  tipo: string;
  monto_delta: number;
  motivo: string | null;
  responsable: string | null;
}

interface DatosA5Rentab {
  cotizacion_id: number;
  cotizacion_estado: string;
  cotizacion_total: number;
  costos: CostoItem[];
  variaciones: VariacionItem[];
  evento_msg_id: string | null;
}

interface ObservacionOutput {
  texto: string;
  tipo: 'costo_excesivo' | 'variacion_negativa' | 'sin_datos' | 'positivo' | 'otro';
}

const UMBRAL_MARGEN_BAJO_PCT = 10;

export const a5RentabHooks: AgenteHooks<DatosA5Rentab> = {
  async cargarContexto(sb, params) {
    // Identificar cotización: si el evento es de tipo costo o cambio_estado,
    // el payload puede tener cotizacion_id. Si no, tomar la última cotización
    // ganada del proyecto.
    let cotizacionId: number | null = null;

    const { data: evt } = await sb.from('evento_pg')
      .select('payload, evidencia_ids, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    cotizacionId = (evt?.payload as any)?.cotizacion_id ?? null;

    if (!cotizacionId && params.proyecto_id) {
      const { data: c } = await sb.from('cotizaciones')
        .select('id')
        .eq('proyecto_id', params.proyecto_id)
        .eq('estado', 'ganada')
        .is('deleted_at', null)
        .order('fecha', { ascending: false })
        .limit(1)
        .maybeSingle();
      cotizacionId = c?.id ?? null;
    }

    if (!cotizacionId) {
      throw new ValidacionError('R-contexto',
        `no se pudo identificar cotización para evento ${params.evento_id}`);
    }

    const { data: cot, error: cErr } = await sb.from('cotizaciones')
      .select('id, estado, total')
      .eq('id', cotizacionId)
      .is('deleted_at', null)
      .single();
    if (cErr || !cot) throw new ValidacionError('R-contexto',
      `cotización ${cotizacionId} no encontrada`);

    const { data: costos } = await sb.from('costos_proyecto')
      .select('id, tipo, descripcion, monto, fecha, vendor')
      .eq('cotizacion_id', cotizacionId)
      .is('deleted_at', null)
      .order('fecha', { ascending: true });

    const { data: variaciones } = await sb.from('cotizacion_variaciones')
      .select('id, tipo, monto_delta, motivo, responsable')
      .eq('cotizacion_id', cotizacionId)
      .is('deleted_at', null);

    const eventoMsgId: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? evt?.canal_msg_id ?? null;

    return {
      cotizacion_id: cot.id,
      cotizacion_estado: cot.estado,
      cotizacion_total: Number(cot.total ?? 0),
      costos: (costos ?? []).map((c: any) => ({ ...c, monto: Number(c.monto) })) as CostoItem[],
      variaciones: (variaciones ?? []).map((v: any) => ({ ...v, monto_delta: Number(v.monto_delta) })) as VariacionItem[],
      evento_msg_id: eventoMsgId,
    };
  },

  construirPrompt(datos, agente) {
    const venta = datos.cotizacion_total;
    const variacionesNeto = datos.variaciones.reduce((s, v) => s + v.monto_delta, 0);
    const costoTotal = datos.costos.reduce((s, c) => s + c.monto, 0);
    const margen = venta + variacionesNeto - costoTotal;
    const margenPct = venta > 0 ? (margen / venta) * 100 : null;

    const costosResumen: Record<string, number> = {};
    for (const c of datos.costos) {
      costosResumen[c.tipo] = (costosResumen[c.tipo] ?? 0) + c.monto;
    }
    const costosStr = Object.entries(costosResumen)
      .sort((a, b) => b[1] - a[1])
      .map(([t, m]) => `${t}: $${m.toLocaleString('es-CO')}`)
      .join(' | ') || '(sin costos)';

    const variacionesStr = datos.variaciones.length === 0
      ? '(sin variaciones)'
      : datos.variaciones.map(v =>
          `${v.tipo}: ${v.monto_delta >= 0 ? '+' : ''}$${v.monto_delta.toLocaleString('es-CO')} (${v.motivo ?? '?'}, resp=${v.responsable ?? '?'})`
        ).join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A5_RENTAB. Tu trabajo es CALCULAR la rentabilidad real de una cotización
y emitir observaciones útiles para Jhon.

LOS NÚMEROS YA ESTÁN CALCULADOS:
  venta_total      = $${venta.toLocaleString('es-CO')}
  variaciones_neto = ${variacionesNeto >= 0 ? '+' : ''}$${variacionesNeto.toLocaleString('es-CO')}
  costo_total      = $${costoTotal.toLocaleString('es-CO')}
  margen           = ${margen >= 0 ? '+' : ''}$${margen.toLocaleString('es-CO')}
  margen_pct       = ${margenPct === null ? 'N/A' : margenPct.toFixed(2) + '%'}

Tu trabajo: copiar estos números al payload + agregar observaciones útiles
sobre qué está pasando.

CÁLCULO MECÁNICO de "confianza" (NO opinión — derivación determinista del estado):
  - SIN costos registrados (costos.length === 0) → DUDOSO (no se puede juzgar margen)
  - margen < 0 (PÉRDIDA REAL)                    → ALERTA
  - margen ≥ 0 y margen_pct < ${UMBRAL_MARGEN_BAJO_PCT}% (baja rentabilidad)        → ALERTA
  - margen_pct ≥ ${UMBRAL_MARGEN_BAJO_PCT}% (rentabilidad sana)                     → INFERIDO
  - NUNCA uses CONFIRMADO: los cálculos son determinísticos pero el humano
    debería revisar (especialmente alertas).

OBSERVACIONES (al menos 1):
  Cada observación tiene tipo (enum):
    - "costo_excesivo"     → un tipo de costo domina el total
    - "variacion_negativa" → variación que bajó el margen
    - "sin_datos"          → faltan costos para calcular bien
    - "positivo"           → margen sano, buena gestión
    - "otro"               → cualquier otra
  Y texto explicativo corto.

EJEMPLOS DE OBSERVACIONES:
  • "Visita extra de $80.000 representó 11% del costo total; consideralo para
    futuras cotizaciones de medidas tomadas por cliente."
  • "Descuento negociado de -$150.000 dejó margen final en 7%; revisar si vale
    la pena este nivel de descuento."
  • "Margen 35% — excelente, sin retrabajos ni variaciones negativas."

R-001 anti-alucinación:
  - Solo mencionar costos/variaciones que están en los datos provistos.
  - NO inventar montos o tipos que no aparecen.

CONTEXTO:
  Cotización: #${datos.cotizacion_id} (estado: ${datos.cotizacion_estado})
  Costos por tipo: ${costosStr}
  Variaciones: ${variacionesStr}

Salida JSON EXACTA:
{
  "tipo_evento": "costo",
  "confianza": "ALERTA",
  "payload": {
    "cotizacion_id": ${datos.cotizacion_id},
    "venta_total": ${venta},
    "variaciones_neto": ${variacionesNeto},
    "costo_total": ${costoTotal},
    "margen": ${margen},
    "margen_pct": ${margenPct === null ? 'null' : margenPct.toFixed(4)},
    "es_alerta_baja_rentabilidad": ${margenPct !== null && margenPct < UMBRAL_MARGEN_BAJO_PCT && margenPct >= 0},
    "es_alerta_perdida": ${margen < 0},
    "tipos_costo_resumen": ${JSON.stringify(costosResumen)},
    "observaciones": [
      { "tipo": "costo_excesivo", "texto": "Visita extra dominó el costo, 11% del total" }
    ],
    "resumen": "Margen 7% (bajo). Visita extra y descuento negociado bajaron rentabilidad."
  },
  "evidencia_msg_ids": ["${datos.evento_msg_id ?? ''}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Analizá la rentabilidad de cotización #${datos.cotizacion_id} (${datos.cotizacion_estado}).

Los números agregados ya están en el system. Tu trabajo: copiarlos al payload
y agregar observaciones específicas basadas en los costos y variaciones reales
(listados arriba). Si margen_pct < ${UMBRAL_MARGEN_BAJO_PCT}% → confianza=ALERTA.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.cotizacion_id !== 'number' || p.cotizacion_id !== datos.cotizacion_id) {
      throw new ValidacionError('R-esquema',
        `cotizacion_id debe ser ${datos.cotizacion_id}, got ${p?.cotizacion_id}`);
    }

    // Recalcular y verificar coherencia (tolerancia $1 por floats)
    const ventaEsperada = datos.cotizacion_total;
    const variacionesEsperada = datos.variaciones.reduce((s, v) => s + v.monto_delta, 0);
    const costoEsperado = datos.costos.reduce((s, c) => s + c.monto, 0);
    const margenEsperado = ventaEsperada + variacionesEsperada - costoEsperado;

    if (Math.abs(Number(p.venta_total) - ventaEsperada) > 1) {
      throw new ValidacionError('R-coherencia',
        `venta_total=${p.venta_total} difiere de esperado ${ventaEsperada}`);
    }
    if (Math.abs(Number(p.variaciones_neto) - variacionesEsperada) > 1) {
      throw new ValidacionError('R-coherencia',
        `variaciones_neto=${p.variaciones_neto} difiere de esperado ${variacionesEsperada}`);
    }
    if (Math.abs(Number(p.costo_total) - costoEsperado) > 1) {
      throw new ValidacionError('R-coherencia',
        `costo_total=${p.costo_total} difiere de esperado ${costoEsperado}`);
    }
    if (Math.abs(Number(p.margen) - margenEsperado) > 1) {
      throw new ValidacionError('R-coherencia',
        `margen=${p.margen} difiere de esperado ${margenEsperado}`);
    }

    if (typeof p.es_alerta_baja_rentabilidad !== 'boolean') {
      throw new ValidacionError('R-esquema', 'es_alerta_baja_rentabilidad debe ser boolean');
    }
    if (typeof p.es_alerta_perdida !== 'boolean') {
      throw new ValidacionError('R-esquema', 'es_alerta_perdida debe ser boolean');
    }
    if (!Array.isArray(p.observaciones)) {
      throw new ValidacionError('R-esquema', 'observaciones debe ser array');
    }
    for (const o of p.observaciones as ObservacionOutput[]) {
      const tiposValidos = ['costo_excesivo', 'variacion_negativa', 'sin_datos', 'positivo', 'otro'];
      if (!tiposValidos.includes(o.tipo)) {
        throw new ValidacionError('R-esquema', `observacion.tipo inválido: ${o.tipo}`);
      }
      if (typeof o.texto !== 'string' || o.texto.trim().length === 0) {
        throw new ValidacionError('R-esquema', 'observacion.texto vacío');
      }
    }

    // Coherencia mecánica: confianza derivada del estado real
    const sinCostos = datos.costos.length === 0;
    const margenPctReal = ventaEsperada > 0 ? (margenEsperado / ventaEsperada) * 100 : null;
    let esperada: string;
    if (sinCostos) esperada = 'DUDOSO';
    else if (margenEsperado < 0) esperada = 'ALERTA';
    else if (margenPctReal !== null && margenPctReal < UMBRAL_MARGEN_BAJO_PCT) esperada = 'ALERTA';
    else esperada = 'INFERIDO';

    if (out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('R-confianza', 'A5_RENTAB nunca usa CONFIRMADO');
    }
    if (out.confianza !== esperada) {
      throw new ValidacionError('R-confianza',
        `confianza=${out.confianza} pero estado real `
        + `(sinCostos=${sinCostos}, margen=${margenEsperado}, margen_pct=${margenPctReal?.toFixed(2) ?? 'N/A'}) `
        + `exige ${esperada}`);
    }

    // R-anti-alucinacion: si hay evento_msg_id, validar evidencia
    if (datos.evento_msg_id && Array.isArray(out.evidencia_msg_ids)) {
      const disponibles = new Set<string>([datos.evento_msg_id]);
      const resueltos: string[] = [];
      for (const cit of out.evidencia_msg_ids) {
        if (!cit) continue;
        const real = resolverMsgId(cit, disponibles);
        if (real) resueltos.push(real);
      }
      out.evidencia_msg_ids = resueltos.length > 0 ? resueltos : [datos.evento_msg_id];
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // En shadow: nada. En productivo: las alertas van al buzón con prioridad
    // alta (confianza=ALERTA → prioridad 1).
    return;
  },
};
