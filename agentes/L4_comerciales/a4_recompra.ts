/**
 * A4_RECOMPRA — detector de candidatos a recompra.
 *
 * DIFERENTE A LOS OTROS L4:
 *   - NO responde a un mensaje entrante específico (aunque se invoca con un
 *     evento_id por compatibilidad con el runner).
 *   - Evalúa el HISTORIAL de la persona del evento: ¿tiene cotización ganada
 *     hace ≥6 meses con poca actividad reciente?
 *   - Si sí → propone una tarea de re-contacto con sugerencia de qué ofrecer.
 *
 * Uso esperado:
 *   - Batch periódico (cron) que itera personas con cotización ganada y dispara
 *     un evento sintético tipo='inferencia' para que A4_RECOMPRA evalúe.
 *   - O on-demand desde UI ("Buscar candidatos de recompra" en M2).
 *
 * Output tipo_evento='tarea' (ya en CHECK):
 *   payload.tarea_propuesta = { tipo, titulo, descripcion, fecha_vence,
 *                                prioridad, asignado_a }
 *
 * Confianza:
 *   - CONFIRMADO  → cotización ganada hace ≥6m + sin mensajes en últimos 30 días
 *   - INFERIDO    → cotización ganada hace ≥6m con actividad reciente (igual sugerir)
 *   - DUDOSO      → no aplica (sin ganadas o muy reciente)
 *
 * Tope $0.02/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

interface SistemaCatalogo {
  codigo: string;
  nombre: string;
  categoria: string;
}

interface CotizacionGanada {
  id: number;
  fecha: string;
  total: number;
  items_resumen: string;      // descripción compacta: "1 blackout 2.40x1.80 sala"
  meses_desde_ganada: number;
}

interface DatosA4Recompra {
  persona_id: number;
  persona_nombre: string | null;
  persona_ciudad: string | null;
  cotizaciones_ganadas: CotizacionGanada[];
  dias_desde_ultimo_mensaje: number | null;    // null = sin mensajes registrados
  sistemas_catalogo: SistemaCatalogo[];
  evento_msg_id: string | null;                // para evidencia
}

interface TareaPropuesta {
  tipo: 'llamar' | 'enviar_cotizacion' | 'pedir_resena' | 'otro';
  titulo: string;
  descripcion: string;
  fecha_vence: string | null;        // ISO date YYYY-MM-DD
  prioridad: number;                 // 1-10
  asignado_a: string;
}

const TIPOS_TAREA = ['llamar', 'enviar_cotizacion', 'confirmar_pago', 'pedir_ficha',
  'agendar_instalacion', 'reclamar_proveedor', 'pedir_resena', 'otro'] as const;
const UMBRAL_MESES_RECOMPRA = 6;

export const a4RecompraHooks: AgenteHooks<DatosA4Recompra> = {
  async cargarContexto(sb, params) {
    // 1. Persona
    const { data: p, error: pErr } = await sb.from('personas')
      .select('id, nombre, ciudad')
      .eq('id', params.persona_id)
      .is('deleted_at', null)
      .single();
    if (pErr || !p) throw new Error(`persona ${params.persona_id} no encontrada: ${pErr?.message}`);

    // 2. Cotizaciones ganadas (con items resumidos)
    const { data: cots } = await sb.from('cotizaciones')
      .select(`id, fecha, total,
               cotizacion_items(sistema_safra_codigo, ambiente, ancho_m, alto_m, cantidad)`)
      .eq('persona_id', params.persona_id)
      .eq('estado', 'ganada')
      .is('deleted_at', null)
      .order('fecha', { ascending: false })
      .limit(10);

    const cotizacionesGanadas: CotizacionGanada[] = (cots ?? []).map((c: any) => {
      const fecha = c.fecha;
      const mesesAtras = Math.floor((Date.now() - new Date(fecha).getTime()) / (1000 * 60 * 60 * 24 * 30));
      const itemsResumen = (c.cotizacion_items ?? [])
        .map((it: any) => `${it.cantidad}× ${it.sistema_safra_codigo}${it.ambiente ? ` ${it.ambiente}` : ''}${it.ancho_m && it.alto_m ? ` ${it.ancho_m}×${it.alto_m}m` : ''}`)
        .join(', ');
      return {
        id: c.id, fecha, total: Number(c.total ?? 0),
        items_resumen: itemsResumen || '(sin items)',
        meses_desde_ganada: mesesAtras,
      };
    });

    // 3. Último mensaje del cliente — para inferir cuán inactivo está
    const { data: ultMsg } = await sb.from('mensajes')
      .select('ts_canal, chat_id, chats!inner(persona_id_dueno)')
      .eq('chats.persona_id_dueno', params.persona_id)
      .is('deleted_at', null)
      .order('ts_canal', { ascending: false })
      .limit(1);
    let diasUltimoMsg: number | null = null;
    if (ultMsg?.[0]) {
      diasUltimoMsg = Math.floor((Date.now() - new Date(ultMsg[0].ts_canal).getTime()) / (1000 * 60 * 60 * 24));
    }

    // 4. Catálogo de sistemas
    const { data: sistemas } = await sb.from('sistemas_safra')
      .select('codigo, nombre, categoria')
      .order('orden');

    // 5. msg_id del evento (para evidencia)
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    const eventoMsgId: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? evt?.canal_msg_id ?? null;

    return {
      persona_id: p.id,
      persona_nombre: p.nombre,
      persona_ciudad: p.ciudad,
      cotizaciones_ganadas: cotizacionesGanadas,
      dias_desde_ultimo_mensaje: diasUltimoMsg,
      sistemas_catalogo: (sistemas ?? []) as SistemaCatalogo[],
      evento_msg_id: eventoMsgId,
    };
  },

  construirPrompt(datos, agente) {
    const cotsStr = datos.cotizaciones_ganadas.length === 0
      ? '(sin cotizaciones ganadas)'
      : datos.cotizaciones_ganadas.map(c =>
          `id=${c.id} · fecha=${c.fecha} (${c.meses_desde_ganada}m atrás) · total=$${c.total.toLocaleString('es-CO')} · ${c.items_resumen}`
        ).join('\n');

    const actividadStr = datos.dias_desde_ultimo_mensaje === null
      ? 'sin mensajes registrados'
      : `${datos.dias_desde_ultimo_mensaje} días desde último mensaje`;

    const sistemasStr = datos.sistemas_catalogo
      .map(s => `${s.codigo} (${s.categoria})`).join(', ');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A4_RECOMPRA. Tu único trabajo: identificar si esta persona es CANDIDATA
A RECOMPRA y, si lo es, proponer una tarea de re-contacto comercial.

CRITERIO DE CANDIDATURA:
  - Tiene ≥1 cotización en estado 'ganada' hace ≥${UMBRAL_MESES_RECOMPRA} meses
  - Idealmente: sin mensaje propio en últimos 30 días (señal de inactividad)
  - Probable necesidad nueva inferible (típicamente recompra para otros ambientes)

SI NO ES CANDIDATA:
  - Sin cotización ganada → es_candidato=false + DUDOSO
  - Cotización ganada < ${UMBRAL_MESES_RECOMPRA} meses → es_candidato=false + DUDOSO
  - Cliente con interacción reciente (<7 días) → es_candidato=false + INFERIDO
    (no molestarlo, ya está conversando)
  Devolvé tarea_propuesta=null en estos casos.

SI ES CANDIDATA:
  - Inferí qué SISTEMAS ya tiene (de items_resumen) y qué ambientes le FALTAN.
    Ejemplo: ya tiene blackout sala → sugerí blackout dormitorios.
  - Construí una tarea_propuesta con:
       tipo: 'llamar' (preferido) o 'enviar_cotizacion'
       titulo: corto y accionable
       descripcion: explica POR QUÉ contactar + qué ofrecer (1-2 párrafos)
       fecha_vence: una fecha plausible (entre hoy+7 días y hoy+14 días)
       prioridad: 4-7 (no urgente, pero importante)
       asignado_a: "jhon"

CATÁLOGO sistemas_safra: ${sistemasStr}

Reglas duras:
  - R-001 anti-alucinación: si NO hay cotizaciones ganadas, NO inventes.
  - tarea_propuesta.tipo debe ser de: ${TIPOS_TAREA.join(', ')}
  - fecha_vence formato YYYY-MM-DD.

Salida JSON EXACTA:
{
  "tipo_evento": "tarea",
  "confianza": "INFERIDO",
  "payload": {
    "es_candidato_recompra": true,
    "meses_inactividad": 8,
    "cotizacion_anterior_id": 42,
    "ambientes_no_cubiertos_sugeridos": ["dormitorio_principal", "cocina"],
    "tarea_propuesta": {
      "tipo": "llamar",
      "titulo": "Recontactar Maria González (recompra 8m)",
      "descripcion": "Cliente compró blackout para sala hace 8 meses ($850.000). Probablemente le falten dormitorios y cocina. Llamar para ofrecer ampliación.",
      "fecha_vence": "2026-05-25",
      "prioridad": 5,
      "asignado_a": "jhon"
    },
    "resumen": "Candidato de recompra: María González (8m, blackout sala)"
  },
  "evidencia_msg_ids": ["${datos.evento_msg_id ?? ''}"],
  "reglas_aplicadas": ["R-001"]
}

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — es_candidato_recompra=false (no aplica):
    out.confianza = "CONFIRMADO"  (no buzón)

  caso B — es_candidato_recompra=true:
    out.confianza = "INFERIDO"   (al buzón con propuesta de tarea)

PROHIBIDO ABSOLUTO:
  ✗ es_candidato=false con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ es_candidato=true con out.confianza = "CONFIRMADO" → ERROR

Si NO es candidato (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "tarea",
  "confianza": "CONFIRMADO",
  "payload": {
    "es_candidato_recompra": false,
    "tarea_propuesta": null,
    "resumen": "No es candidato a recompra"
  },
  "evidencia_msg_ids": ["${datos.evento_msg_id ?? ''}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== PERSONA ===
id=${datos.persona_id} · nombre=${datos.persona_nombre ?? '(sin nombre)'} · ciudad=${datos.persona_ciudad ?? '?'}

=== COTIZACIONES GANADAS ===
${cotsStr}

=== ACTIVIDAD RECIENTE ===
${actividadStr}

Determiná si es candidato a recompra. Si sí, proponé una tarea concreta.
Si no, dejá tarea_propuesta=null y explicá en resumen.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.es_candidato_recompra !== 'boolean') {
      throw new ValidacionError('schema',
        `es_candidato_recompra debe ser boolean: ${JSON.stringify(p?.es_candidato_recompra)}`);
    }
    if (p.es_candidato_recompra) {
      const t: TareaPropuesta = p.tarea_propuesta;
      if (!t || typeof t !== 'object') {
        throw new ValidacionError('schema', 'es_candidato_recompra=true requiere tarea_propuesta');
      }
      if (!TIPOS_TAREA.includes(t.tipo as any)) {
        throw new ValidacionError('schema',
          `tarea.tipo inválido: ${t.tipo} (válidos: ${TIPOS_TAREA.join(',')})`);
      }
      if (typeof t.titulo !== 'string' || t.titulo.trim().length === 0) {
        throw new ValidacionError('schema', 'tarea.titulo vacío');
      }
      if (t.fecha_vence !== null && t.fecha_vence !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t.fecha_vence)) {
          throw new ValidacionError('schema', `fecha_vence formato inválido: ${t.fecha_vence}`);
        }
      }
      if (typeof t.prioridad !== 'number' || t.prioridad < 1 || t.prioridad > 10) {
        throw new ValidacionError('schema', `prioridad fuera de [1,10]: ${t.prioridad}`);
      }
      const idsGanadas = new Set(datos.cotizaciones_ganadas.map(c => c.id));
      if (p.cotizacion_anterior_id !== null && p.cotizacion_anterior_id !== undefined) {
        if (!idsGanadas.has(p.cotizacion_anterior_id)) {
          throw new ValidacionError('coherencia-a4rc',
            `cotizacion_anterior_id=${p.cotizacion_anterior_id} no está entre las ganadas`);
        }
      }
      if (datos.cotizaciones_ganadas.length === 0) {
        throw new ValidacionError('coherencia-a4rc',
          'es_candidato_recompra=true requiere ≥1 cotización ganada');
      }
    } else {
      if (p.tarea_propuesta !== null && p.tarea_propuesta !== undefined) {
        throw new ValidacionError('schema', 'Si es_candidato_recompra=false, tarea_propuesta debe ser null');
      }
    }

    // Coherencia mecánica
    if (!p.es_candidato_recompra && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a4rc',
        `es_candidato=false requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.es_candidato_recompra && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a4rc',
        `es_candidato=true requiere out.confianza='INFERIDO' (Jhon aprueba tarea)`);
    }

    // Resolver msg_ids con tolerancia
    if (datos.evento_msg_id) {
      const msgIdsValidos = new Set<string>([datos.evento_msg_id]);
      if (Array.isArray(out.evidencia_msg_ids)) {
        for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
          const real = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
          if (real) out.evidencia_msg_ids[i] = real;
        }
      }
    }
  },

  async postProcesar(sb: SupabaseClient, out, ctx) {
    if (ctx.agente.shadow) return;
    const p = out.payload as any;
    if (!p.es_candidato_recompra) return;
    const t = p.tarea_propuesta as TareaPropuesta;

    const { data: row, error } = await sb.from('tareas').insert({
      persona_id: ctx.persona_id,
      proyecto_id: ctx.proyecto_id,
      titulo: t.titulo,
      descripcion: t.descripcion,
      tipo: t.tipo,
      fecha_vence: t.fecha_vence,
      asignado_a: t.asignado_a || 'jhon',
      origen: 'agente',
      prioridad: t.prioridad,
      shadow: true,
      agente_origen: ctx.agente.codigo,
    } as any).select('id').single();
    if (error || !row) {
      throw new Error(`A4_RECOMPRA insert tarea: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'tarea', entidad_id: row.id };
  },
};
