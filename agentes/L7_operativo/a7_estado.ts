/**
 * A7_ESTADO — responde consultas de estado del pedido.
 *
 * Cuando A2_INTENCION clasificó el mensaje como 'consulta_estado'
 * ("cuándo me entregan?", "cómo va mi pedido?"), A7_ESTADO consulta producción
 * e instalaciones reales del cliente y arma una respuesta WhatsApp factual.
 *
 * REGLAS DURAS:
 *   - NO inventa fechas. Si BD no tiene fecha_estimada → respuesta dice
 *     "estamos confirmando con el proveedor" + propone tarea para Jhon.
 *   - NO confirma fechas como hechos si estado='pendiente_abono' o 'retenido'.
 *   - Cita los datos REALES de produccion_orden e instalaciones.
 *
 * tipo_evento='inferencia' (no es decisión que mute tablas, es propuesta de
 * respuesta para Jhon).
 *
 * Tope $0.02/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  ts_canal: string;
}

interface OrdenProduccion {
  id: number;
  cotizacion_id: number;
  estado: string;
  fecha_inicio: string | null;
  fecha_estimada_lista: string | null;
  fecha_entrega: string | null;
  vendor: string | null;
  motivo_retencion: string | null;
}

interface InstalacionInfo {
  id: number;
  cotizacion_id: number;
  fecha_programada: string;
  hora_programada: string | null;
  fecha_real: string | null;
  instalador: string | null;
  resultado: string | null;
}

interface DatosA7Estado {
  mensaje_actual: MensajeCtx;
  ordenes_produccion: OrdenProduccion[];
  instalaciones: InstalacionInfo[];
  cotizaciones_ganadas_resumen: { id: number; fecha: string; total: number }[];
}

interface RespuestaPropuestaOutput {
  texto_whatsapp: string;
  estado_actual: string;             // resumen tipo "en_produccion"
  fechas_citadas: string[];
  tiene_datos_suficientes: boolean;
  tarea_seguimiento: {
    tipo: string;
    titulo: string;
    descripcion: string;
    prioridad: number;
  } | null;
}

const N_CONTEXTO = 3;

export const a7EstadoHooks: AgenteHooks<DatosA7Estado> = {
  async cargarContexto(sb, params) {
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal')
      .eq('id', params.evento_id)
      .single();
    const msgIdPrincipal: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? null;

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
        .lte('ts_canal', evt?.ts_canal ?? new Date().toISOString())
        .order('ts_canal', { ascending: false })
        .limit(1);
      const m = msgs?.[0];
      if (!m?.texto) throw new Error(`evento ${params.evento_id} sin mensaje con texto`);
      mensajeActual = { canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto, ts_canal: m.ts_canal };
    }

    // Cotizaciones del cliente (resumen)
    const cotsResumen: { id: number; fecha: string; total: number }[] = [];
    let cotsIds: number[] = [];
    if (params.persona_id) {
      const { data: cots } = await sb.from('cotizaciones')
        .select('id, fecha, total, estado')
        .eq('persona_id', params.persona_id)
        .is('deleted_at', null)
        .in('estado', ['propuesta', 'negociando', 'intencion_cierre', 'ganada'])
        .order('fecha', { ascending: false })
        .limit(5);
      for (const c of cots ?? []) {
        cotsResumen.push({ id: c.id, fecha: c.fecha, total: Number(c.total ?? 0) });
        cotsIds.push(c.id);
      }
    }

    // Órdenes de producción
    let ordenes: OrdenProduccion[] = [];
    if (cotsIds.length > 0) {
      const { data: ords } = await sb.from('produccion_orden')
        .select('id, cotizacion_id, estado, fecha_inicio, fecha_estimada_lista, fecha_entrega, vendor, motivo_retencion')
        .in('cotizacion_id', cotsIds)
        .is('deleted_at', null);
      ordenes = (ords ?? []) as OrdenProduccion[];
    }

    // Instalaciones
    let instalaciones: InstalacionInfo[] = [];
    if (cotsIds.length > 0) {
      const { data: inst } = await sb.from('instalaciones')
        .select('id, cotizacion_id, fecha_programada, hora_programada, fecha_real, instalador, resultado')
        .in('cotizacion_id', cotsIds)
        .is('deleted_at', null);
      instalaciones = (inst ?? []) as InstalacionInfo[];
    }

    return {
      mensaje_actual: mensajeActual,
      ordenes_produccion: ordenes,
      instalaciones,
      cotizaciones_ganadas_resumen: cotsResumen,
    };
  },

  construirPrompt(datos, agente) {
    const cotsStr = datos.cotizaciones_ganadas_resumen.length === 0
      ? '(sin cotizaciones activas)'
      : JSON.stringify(datos.cotizaciones_ganadas_resumen, null, 2);

    const ordenesStr = datos.ordenes_produccion.length === 0
      ? '(sin órdenes de producción registradas)'
      : JSON.stringify(datos.ordenes_produccion, null, 2);

    const instalacionesStr = datos.instalaciones.length === 0
      ? '(sin instalaciones programadas o realizadas)'
      : JSON.stringify(datos.instalaciones, null, 2);

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A7_ESTADO. El cliente preguntó por el estado de su pedido. Tu trabajo:
  1. Mirar las ÓRDENES DE PRODUCCIÓN e INSTALACIONES reales del cliente.
  2. Armar una respuesta WhatsApp clara y factual.
  3. Si la BD NO tiene la info que pide → reconocer que tenés que confirmar
     y proponer una tarea de seguimiento para Jhon.

REGLA CRÍTICA: NUNCA INVENTES FECHAS.
  - Si no hay fecha_estimada_lista → NO digas "te llega el viernes".
  - Si la fecha existe pero el estado='pendiente_abono' o 'retenido', la
    fecha es ESTIMADA, NO compromiso. Acláralo.
  - Si dudás → "estamos confirmando con el proveedor, te aviso hoy".

ESTRUCTURA DE LA RESPUESTA WA:
  - Saludo corto
  - Estado actual (referenciando producción O instalación)
  - Fecha si la hay (con qualifier si está estimada)
  - Próximo paso
  - Cierre cálido

CASOS:
  • estado='pendiente_abono' + sin pago → "Falta tu abono para que arranquemos
    pedido al proveedor. Una vez recibido confirmamos fecha."
  • estado='pedido_proveedor' + fecha_estimada_lista → "Ya pedimos al proveedor,
    estimamos que esté listo el {fecha}. Te confirmamos antes de instalar."
  • estado='en_produccion' → "Está en producción. Estimado lista: {fecha} si la
    hay, sino 'estamos confirmando'."
  • estado='listo_para_instalar' + instalación.fecha_programada → "Tu pedido
    está listo. Te visitamos el {fecha} a las {hora}."
  • estado='instalado' → "Ya instalada el {fecha_real}. Cualquier consulta nos avisás."
  • estado='retenido' + motivo_retencion → "Estamos resolviendo: {motivo}.
    Te confirmamos hoy."

SI NO HAY DATOS REALES:
  - texto_whatsapp: "Hola, estoy revisando tu pedido. Te confirmo hoy mismo."
  - tiene_datos_suficientes: false
  - tarea_seguimiento: { tipo: "otro", titulo: "Confirmar estado pedido {persona}",
    descripcion: "El cliente pregunta estado pero no encuentro orden de
    producción registrada. Verificar y responder.", prioridad: 6 }

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  REGLA: respuestas WhatsApp al cliente requieren aprobación humana SIEMPRE
         antes de enviarse. NUNCA CONFIRMADO directo.

  caso A — tiene_datos_suficientes=true (respuesta factual lista):
    out.confianza = "INFERIDO"  (al buzón, Jhon edita/envía)

  caso B — tiene_datos_suficientes=false (sin datos reales, propone tarea seguimiento):
    out.confianza = "DUDOSO"    (al buzón con prioridad para que Jhon investigue)

PROHIBIDO ABSOLUTO:
  ✗ out.confianza = "CONFIRMADO" → ERROR (respuestas WA requieren Jhon)

R-001 anti-alucinación:
  - fechas_citadas: array de TODAS las fechas (YYYY-MM-DD) usadas en la respuesta.
    Cada una DEBE estar en los datos reales (ordenes_produccion.fecha_estimada_lista,
    instalaciones.fecha_programada, etc.).
  - evidencia_msg_ids: SIEMPRE incluí el msg_id del mensaje del cliente que se
    está respondiendo. No dejes evidencia_msg_ids=[] aunque no haya datos.

CONTEXTO DEL CLIENTE:
  Cotizaciones activas:
${cotsStr}

  Órdenes de producción:
${ordenesStr}

  Instalaciones:
${instalacionesStr}

Mensaje del cliente:
  "${datos.mensaje_actual.texto}"

Salida JSON EXACTA:
{
  "tipo_evento": "inferencia",
  "confianza": "INFERIDO",
  "payload": {
    "respuesta_propuesta": {
      "texto_whatsapp": "Hola! Tu pedido está en producción, estimamos que esté listo para el 20/05. Te confirmamos antes de coordinar instalación. Cualquier cosa me avisás!",
      "estado_actual": "en_produccion",
      "fechas_citadas": ["2026-05-20"],
      "tiene_datos_suficientes": true,
      "tarea_seguimiento": null
    },
    "resumen": "Cliente en producción, fecha estimada 20/05"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}

Si NO hay datos suficientes: tiene_datos_suficientes=false + tarea_seguimiento con propuesta.`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Pregunta del cliente:
"${datos.mensaje_actual.texto}"

Generá la respuesta WhatsApp basada en los datos reales de arriba.
NUNCA inventes fechas. Si no hay datos → tarea de seguimiento.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    const r: RespuestaPropuestaOutput = p?.respuesta_propuesta;
    if (!r || typeof r !== 'object') {
      throw new ValidacionError('schema', 'payload.respuesta_propuesta debe ser objeto');
    }
    if (typeof r.texto_whatsapp !== 'string' || r.texto_whatsapp.trim().length < 15) {
      throw new ValidacionError('schema', 'texto_whatsapp vacío o muy corto');
    }
    if (typeof r.estado_actual !== 'string') {
      throw new ValidacionError('schema', 'estado_actual debe ser string');
    }
    if (!Array.isArray(r.fechas_citadas)) {
      throw new ValidacionError('schema', 'fechas_citadas debe ser array');
    }
    if (typeof r.tiene_datos_suficientes !== 'boolean') {
      throw new ValidacionError('schema', 'tiene_datos_suficientes debe ser boolean');
    }

    const fechasEstructuradas = new Set<string>();
    const textosLibres: string[] = [];
    for (const o of datos.ordenes_produccion) {
      if (o.fecha_inicio) fechasEstructuradas.add(o.fecha_inicio);
      if (o.fecha_estimada_lista) fechasEstructuradas.add(o.fecha_estimada_lista);
      if (o.fecha_entrega) fechasEstructuradas.add(o.fecha_entrega);
      if (o.motivo_retencion) textosLibres.push(o.motivo_retencion);
    }
    for (const i of datos.instalaciones) {
      if (i.fecha_programada) fechasEstructuradas.add(i.fecha_programada);
      if (i.fecha_real) fechasEstructuradas.add(i.fecha_real);
    }
    for (const c of datos.cotizaciones_ganadas_resumen) {
      if (c.fecha) fechasEstructuradas.add(c.fecha);
    }
    for (const fc of r.fechas_citadas) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fc)) {
        throw new ValidacionError('schema', `fecha_citada formato inválido: ${fc}`);
      }
      const enEstructurado = fechasEstructuradas.has(fc);
      const [yyyy, mm, dd] = fc.split('-');
      const variantes = [fc, `${dd}/${mm}`, `${dd}/${mm}/${yyyy}`, `${dd}-${mm}`, `${dd}-${mm}-${yyyy}`, `${Number(dd)}/${Number(mm)}`];
      const enTextoLibre = textosLibres.some(t =>
        variantes.some(v => t.includes(v))
      );
      if (!enEstructurado && !enTextoLibre) {
        throw new ValidacionError('R-anti-alucinacion',
          `fecha_citada '${fc}' no aparece en datos reales`);
      }
    }

    if (!r.tiene_datos_suficientes && (r.tarea_seguimiento === null || r.tarea_seguimiento === undefined)) {
      throw new ValidacionError('coherencia-a7e',
        'tiene_datos_suficientes=false requiere tarea_seguimiento');
    }
    if (r.tarea_seguimiento) {
      if (typeof r.tarea_seguimiento.titulo !== 'string') throw new ValidacionError('schema', 'tarea.titulo inválido');
      if (typeof r.tarea_seguimiento.prioridad !== 'number') throw new ValidacionError('schema', 'tarea.prioridad inválido');
    }

    // Coherencia mecánica out.confianza:
    //   - tiene_datos_suficientes=true  → INFERIDO (al buzón, Jhon edita)
    //   - tiene_datos_suficientes=false → DUDOSO  (al buzón, tarea seguimiento)
    //   - NUNCA CONFIRMADO (Jhon debe aprobar respuesta WA)
    if (out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a7e',
        `out.confianza='CONFIRMADO' prohibido: respuestas WA requieren aprobación humana antes de enviar`);
    }
    if (r.tiene_datos_suficientes && out.confianza !== 'INFERIDO') {
      throw new ValidacionError('coherencia-a7e',
        `tiene_datos_suficientes=true requiere out.confianza='INFERIDO', recibido '${out.confianza}'`);
    }
    if (!r.tiene_datos_suficientes && out.confianza !== 'DUDOSO') {
      throw new ValidacionError('coherencia-a7e',
        `tiene_datos_suficientes=false requiere out.confianza='DUDOSO', recibido '${out.confianza}'`);
    }

    // Resolver msg_ids con tolerancia prefijo
    const msgIdsValidos = new Set<string>([datos.mensaje_actual.canal_msg_id]);
    if (Array.isArray(out.evidencia_msg_ids)) {
      for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
        const real = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
        if (real) out.evidencia_msg_ids[i] = real;
      }
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // A7_ESTADO no escribe a tabla de negocio. La respuesta WA propuesta queda
    // en el buzón; Jhon la edita y envía manualmente al cliente. Si
    // tarea_seguimiento, también queda en el buzón como propuesta (no se inserta
    // automáticamente en tabla tareas — A7_TAREAS es el agente para eso).
    return;
  },
};
