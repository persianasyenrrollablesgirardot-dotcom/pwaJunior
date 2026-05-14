/**
 * A5_CARTERA — detector de cobros pendientes con recordatorio sugerido.
 *
 * BATCH-ORIENTED como A4_RECOMPRA: evalúa la persona del evento y decide si
 * es candidata a un recordatorio de cobro.
 *
 * Criterios de candidatura:
 *   - Tiene ≥1 cotización con saldo > 0
 *   - La última actividad del cliente (mensaje) es ≥ 7 días atrás
 *     (si está conversando ahora mismo, no es necesario recordatorio)
 *   - La deuda es razonable (>5000 COP, evitar fugitivos chiquitos)
 *
 * Output:
 *   tipo_evento='tarea' con tarea_propuesta (tipo='llamar') Y plantilla_mensaje
 *   sugerida para mandar por WhatsApp.
 *
 * Confianza:
 *   - INFERIDO    → datos claros, deuda > 0 + sin actividad reciente
 *   - DUDOSO      → no aplica (sin saldo, o conversación activa)
 *   - CONFIRMADO  → no usado (humano decide enviar)
 *
 * Tope $0.02/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

interface CotizacionConSaldo {
  id: number;
  fecha: string;
  total: number;
  abono_acumulado: number;
  saldo: number;
  dias_desde_creacion: number;
}

interface DatosA5Cartera {
  persona_id: number;
  persona_nombre: string | null;
  persona_telefono: string | null;
  cotizaciones_con_saldo: CotizacionConSaldo[];
  deuda_total: number;
  dias_desde_ultimo_mensaje: number | null;
  evento_msg_id: string | null;
}

interface TareaCobroOutput {
  tipo: 'llamar' | 'enviar_cotizacion' | 'otro';
  titulo: string;
  descripcion: string;
  plantilla_mensaje_sugerido: string;
  fecha_vence: string | null;
  prioridad: number;
  asignado_a: string;
}

const UMBRAL_DIAS_CARTERA = 7;
const MIN_DEUDA_COP = 5_000;
const TIPOS_TAREA = ['llamar', 'enviar_cotizacion', 'confirmar_pago', 'pedir_ficha',
  'agendar_instalacion', 'reclamar_proveedor', 'pedir_resena', 'otro'] as const;

export const a5CarteraHooks: AgenteHooks<DatosA5Cartera> = {
  async cargarContexto(sb, params) {
    const { data: p, error: pErr } = await sb.from('personas')
      .select('id, nombre, telefono_e164')
      .eq('id', params.persona_id)
      .is('deleted_at', null)
      .single();
    if (pErr || !p) throw new Error(`persona ${params.persona_id} no encontrada: ${pErr?.message}`);

    // Cotizaciones con saldo > 0 (cartera real)
    const { data: cots } = await sb.from('cotizaciones')
      .select('id, fecha, total, abono_monto, saldo')
      .eq('persona_id', params.persona_id)
      .gt('saldo', 0)
      .is('deleted_at', null)
      .order('fecha', { ascending: true })
      .limit(10);

    const cotsConSaldo: CotizacionConSaldo[] = (cots ?? []).map((c: any) => ({
      id: c.id, fecha: c.fecha,
      total: Number(c.total ?? 0),
      abono_acumulado: Number(c.abono_monto ?? 0),
      saldo: Number(c.saldo ?? 0),
      dias_desde_creacion: Math.floor((Date.now() - new Date(c.fecha).getTime()) / (1000 * 60 * 60 * 24)),
    }));

    const deudaTotal = cotsConSaldo.reduce((s, c) => s + c.saldo, 0);

    // Último mensaje del cliente
    const { data: ultMsg } = await sb.from('mensajes')
      .select('ts_canal, chat_id, chats!inner(persona_id_dueno)')
      .eq('chats.persona_id_dueno', params.persona_id)
      .is('deleted_at', null)
      .order('ts_canal', { ascending: false })
      .limit(1);
    let diasUlt: number | null = null;
    if (ultMsg?.[0]) {
      diasUlt = Math.floor((Date.now() - new Date(ultMsg[0].ts_canal).getTime()) / (1000 * 60 * 60 * 24));
    }

    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids')
      .eq('id', params.evento_id)
      .single();
    const eventoMsgId: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? null;

    return {
      persona_id: p.id,
      persona_nombre: p.nombre,
      persona_telefono: p.telefono_e164,
      cotizaciones_con_saldo: cotsConSaldo,
      deuda_total: deudaTotal,
      dias_desde_ultimo_mensaje: diasUlt,
      evento_msg_id: eventoMsgId,
    };
  },

  construirPrompt(datos, agente) {
    const cotsStr = datos.cotizaciones_con_saldo.length === 0
      ? '(sin cotizaciones con saldo > 0)'
      : datos.cotizaciones_con_saldo.map(c =>
          `id=${c.id} · fecha=${c.fecha} (${c.dias_desde_creacion}d atrás) · total=$${c.total.toLocaleString('es-CO')} · abonado=$${c.abono_acumulado.toLocaleString('es-CO')} · saldo=$${c.saldo.toLocaleString('es-CO')}`
        ).join('\n');

    const actividadStr = datos.dias_desde_ultimo_mensaje === null
      ? 'sin mensajes registrados'
      : `${datos.dias_desde_ultimo_mensaje} días desde último mensaje del cliente`;

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A5_CARTERA. Detectás si esta persona necesita un RECORDATORIO de COBRO.

CRITERIOS DE CANDIDATURA (deben cumplirse TODOS):
  1. Tiene ≥1 cotización con saldo > 0 (deuda real)
  2. Deuda total ≥ $${MIN_DEUDA_COP.toLocaleString('es-CO')} COP
  3. Última actividad del cliente (mensaje) hace ≥ ${UMBRAL_DIAS_CARTERA} días
     (si conversa activamente, no hace falta recordatorio)

SI NO ES CANDIDATA:
  - Sin saldo pendiente → es_candidato_recordatorio=false + DUDOSO
  - Conversando activamente (<7 días) → es_candidato=false + INFERIDO
    ("no molestar, está conversando")
  - Deuda muy chica (<$5.000) → es_candidato=false + DUDOSO
  Devolvé tarea_propuesta=null en estos casos.

SI ES CANDIDATA:
  - Construí tarea_propuesta:
       tipo: "llamar" (preferido) o "otro"
       titulo: "Cobro saldo {nombre} (${'$'}{deuda})"
       descripcion: detalles (cotización antigua, días sin actividad, riesgo)
       plantilla_mensaje_sugerido: TEXTO LISTO PARA COPIAR Y PEGAR EN WHATSAPP.
         Tono: amable pero claro. Incluí:
            - saludo personalizado
            - referencia a la cotización
            - monto exacto del saldo
            - 1-2 opciones de pago (transferencia, etc.)
            - cierre suave
         NO uses emojis excesivos. Profesional pero cálido.
       fecha_vence: hoy + 3 a 7 días
       prioridad: 6 (si deuda < 500k) o 7-8 (si deuda alta o muy vieja)
       asignado_a: "jhon"

REGLAS DURAS:
  - R-001 anti-alucinación: si no hay cotizaciones con saldo → NO inventes deuda.
  - tarea_propuesta.tipo en: ${TIPOS_TAREA.join(', ')}
  - fecha_vence formato YYYY-MM-DD.
  - prioridad ∈ [1,10].

CÁLCULO MECÁNICO de "confianza" (NO opinión — derivación determinista del estado):
  - SIN cotizaciones con saldo → es_candidato=false + confianza=DUDOSO
  - Conversando activamente (<${UMBRAL_DIAS_CARTERA}d) → es_candidato=false + confianza=INFERIDO
  - Deuda total <$${MIN_DEUDA_COP.toLocaleString('es-CO')} → es_candidato=false + confianza=DUDOSO
  - Candidata válida (deuda≥$${MIN_DEUDA_COP.toLocaleString('es-CO')} + ≥${UMBRAL_DIAS_CARTERA}d sin actividad) → es_candidato=true + confianza=INFERIDO
  - NUNCA uses CONFIRMADO: la decisión final de enviar el recordatorio la toma el humano desde el buzón.

Salida JSON EXACTA:
{
  "tipo_evento": "tarea",
  "confianza": "INFERIDO",
  "payload": {
    "es_candidato_recordatorio": true,
    "deuda_total": 350000,
    "dias_desde_ultima_actividad": 12,
    "cotizaciones_con_saldo_ids": [42],
    "tarea_propuesta": {
      "tipo": "llamar",
      "titulo": "Cobro saldo María González ($350.000)",
      "descripcion": "Cotización #42 con saldo de $350.000, 12 días sin actividad del cliente.",
      "plantilla_mensaje_sugerido": "Hola María, qué tal. Te recuerdo que en la cotización #42 nos queda un saldo de $350.000. ¿Te parece si coordinamos el pago esta semana? Puedo enviarte los datos de Bancolombia o si prefieres efectivo, pasamos a recogerlo. Gracias!",
      "fecha_vence": "2026-05-18",
      "prioridad": 6,
      "asignado_a": "jhon"
    },
    "resumen": "Cobro pendiente: María González, $350.000, 12d inactividad"
  },
  "evidencia_msg_ids": ["${datos.evento_msg_id ?? ''}"],
  "reglas_aplicadas": ["R-001"]
}

Si NO es candidata: tarea_propuesta=null + es_candidato=false + explicación en resumen.`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== PERSONA ===
id=${datos.persona_id} · nombre=${datos.persona_nombre ?? '(sin nombre)'} · tel=${datos.persona_telefono ?? '(sin tel)'}
deuda_total=$${datos.deuda_total.toLocaleString('es-CO')}

=== COTIZACIONES CON SALDO ===
${cotsStr}

=== ACTIVIDAD ===
${actividadStr}

Evaluá si es candidata a recordatorio de cobro. Si sí, generá la plantilla
de mensaje WhatsApp lista para Jhon.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.es_candidato_recordatorio !== 'boolean') {
      throw new ValidacionError('R-esquema', 'es_candidato_recordatorio debe ser boolean');
    }

    // Coherencia mecánica: confianza derivada del estado real
    const sinSaldo = datos.cotizaciones_con_saldo.length === 0;
    const deudaInsuficiente = datos.deuda_total < MIN_DEUDA_COP;
    const conversaActiva = datos.dias_desde_ultimo_mensaje !== null
      && datos.dias_desde_ultimo_mensaje < UMBRAL_DIAS_CARTERA;
    const deberiaSerCandidato = !sinSaldo && !deudaInsuficiente && !conversaActiva;

    if (p.es_candidato_recordatorio !== deberiaSerCandidato) {
      throw new ValidacionError('R-coherencia',
        `es_candidato=${p.es_candidato_recordatorio} pero estado real `
        + `(sinSaldo=${sinSaldo}, deudaInsuf=${deudaInsuficiente}, conversaActiva=${conversaActiva}) `
        + `implica ${deberiaSerCandidato}`
      );
    }

    if (out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('R-confianza', 'A5_CARTERA nunca usa CONFIRMADO (humano decide)');
    }
    if (deberiaSerCandidato && out.confianza !== 'INFERIDO') {
      throw new ValidacionError('R-confianza', `candidata válida exige INFERIDO, recibido ${out.confianza}`);
    }

    if (p.es_candidato_recordatorio) {
      const t: TareaCobroOutput = p.tarea_propuesta;
      if (!t || typeof t !== 'object') {
        throw new ValidacionError('R-esquema', 'es_candidato=true requiere tarea_propuesta');
      }
      if (!TIPOS_TAREA.includes(t.tipo as any)) {
        throw new ValidacionError('R-esquema', `tarea.tipo inválido: ${t.tipo}`);
      }
      if (typeof t.titulo !== 'string' || t.titulo.trim().length === 0) {
        throw new ValidacionError('R-esquema', 'tarea.titulo vacío');
      }
      if (typeof t.plantilla_mensaje_sugerido !== 'string' || t.plantilla_mensaje_sugerido.trim().length < 20) {
        throw new ValidacionError('R-esquema', 'plantilla_mensaje_sugerido vacío o muy corto (debe ser texto completo para WA)');
      }
      if (t.fecha_vence !== null && t.fecha_vence !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t.fecha_vence)) {
          throw new ValidacionError('R-esquema', `fecha_vence formato inválido: ${t.fecha_vence}`);
        }
      }
      if (typeof t.prioridad !== 'number' || t.prioridad < 1 || t.prioridad > 10) {
        throw new ValidacionError('R-esquema', `prioridad fuera de [1,10]: ${t.prioridad}`);
      }
      // cotizaciones_con_saldo_ids deben existir en la lista cargada
      if (Array.isArray(p.cotizaciones_con_saldo_ids)) {
        const idsValidos = new Set<number>(datos.cotizaciones_con_saldo.map(c => c.id));
        for (const id of p.cotizaciones_con_saldo_ids) {
          if (!idsValidos.has(id)) {
            throw new ValidacionError('R-anti-alucinacion',
              `cotizaciones_con_saldo_ids[i]=${id} no está entre las cargadas`);
          }
        }
      }
    } else {
      if (p.tarea_propuesta !== null && p.tarea_propuesta !== undefined) {
        throw new ValidacionError('R-esquema', 'es_candidato=false requiere tarea_propuesta=null');
      }
    }

    // R-anti-alucinacion: si hay evento_msg_id, validar que evidencia lo refleje
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
    // En shadow: nada. En productivo: la tarea + plantilla pasan al buzón.
    // Cuando Jhon aprueba, se crea la fila en tareas con el texto sugerido.
    return;
  },
};
