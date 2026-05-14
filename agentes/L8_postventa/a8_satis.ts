/**
 * A8_SATIS — detector de sentimiento del cliente post-instalación.
 *
 * Cuando un cliente con instalación reciente (≤30 días) escribe, A8_SATIS
 * clasifica su estado emocional respecto al trabajo entregado:
 *
 *   - feliz             → "quedó hermoso", "mil gracias", "perfecto"
 *   - confundido        → preguntas técnicas ("cómo se usa?"), no entiende motor
 *   - molesto           → queja sobre el trabajo, sin amenaza pública
 *   - sin_respuesta     → no aplicable (no expresa nada)
 *   - pendiente_ajuste  → "falta el remate", "quedó algo por terminar"
 *
 * Distinto de:
 *   - A8_RECLAMO: cliente muy molesto + amenaza pública → reclamo sensible
 *   - A8_GARANTIA: reporte de FALLA técnica → abrir garantía
 *   - A8_SATIS: registro EMOCIONAL post-instalación
 *
 * Requiere instalación reciente. Si no hay → confianza=DUDOSO + no_aplica=true.
 *
 * Output: tipo_evento='inferencia' con propuesta para tabla satisfaccion_postventa.
 *
 * Tope $0.01/invocación.
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

interface InstalacionReciente {
  id: number;
  cotizacion_id: number;
  fecha_real: string | null;
  fecha_programada: string;
  dias_atras: number;
  resultado: string | null;
}

interface DatosA8Satis {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  instalaciones_recientes: InstalacionReciente[];
}

const ESTADOS_CLIENTE = ['feliz', 'confundido', 'molesto', 'sin_respuesta', 'pendiente_ajuste'] as const;
type EstadoCliente = typeof ESTADOS_CLIENTE[number];

interface SatisfaccionPropuestaOutput {
  estado_cliente: EstadoCliente;
  instalacion_id_sugerida: number | null;
  cotizacion_id_sugerida: number | null;
  evidencia_texto: string;
  fuente: 'whatsapp' | 'llamada' | 'visita' | 'inferido';
  notas_para_jhon: string;
}

const UMBRAL_DIAS_POSTVENTA = 30;
const N_CONTEXTO = 4;

export const a8SatisHooks: AgenteHooks<DatosA8Satis> = {
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
      .map(m => ({
        canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto!, ts_canal: m.ts_canal,
      }));

    // Instalaciones del cliente con resultado, en últimos N días
    const instReciente: InstalacionReciente[] = [];
    if (params.persona_id) {
      const { data: inst } = await sb.from('instalaciones')
        .select('id, cotizacion_id, fecha_real, fecha_programada, resultado')
        .eq('persona_id', params.persona_id)
        .is('deleted_at', null)
        .order('fecha_programada', { ascending: false })
        .limit(5);
      const hoy = Date.now();
      for (const i of inst ?? []) {
        const refDate = i.fecha_real ?? i.fecha_programada;
        const diasAtras = Math.floor((hoy - new Date(refDate).getTime()) / (1000 * 60 * 60 * 24));
        if (diasAtras >= 0 && diasAtras <= UMBRAL_DIAS_POSTVENTA) {
          instReciente.push({
            id: i.id, cotizacion_id: i.cotizacion_id,
            fecha_real: i.fecha_real, fecha_programada: i.fecha_programada,
            dias_atras: diasAtras, resultado: i.resultado,
          });
        }
      }
    }

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      instalaciones_recientes: instReciente,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 220)}`
        ).join('\n');

    const instStr = datos.instalaciones_recientes.length === 0
      ? '(SIN instalaciones recientes en últimos 30 días → no aplica A8_SATIS)'
      : JSON.stringify(datos.instalaciones_recientes, null, 2);

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A8_SATIS. Detectás el SENTIMIENTO del cliente respecto a una instalación
reciente. Solo aplicás si hubo instalación en últimos ${UMBRAL_DIAS_POSTVENTA} días.

ESTADOS POSIBLES (catálogo cerrado):
  - feliz             → expresiones claras de satisfacción
                         "quedó hermoso", "mil gracias", "perfecto, excelente"
                         "los recomiendo", "buen trabajo", "muy contentos"
  - confundido        → preguntas sobre uso, no entiende algo del producto
                         "cómo funciona el motor?", "cómo se limpia?",
                         "no sé cómo abrir esto"
  - molesto           → queja sobre el resultado SIN amenaza pública
                         "no me convence", "esperaba más", "no es lo que pedí",
                         "está mal pero no quiero hacer drama"
                         OJO: si hay amenaza pública → A8_RECLAMO (no este)
  - sin_respuesta     → mensaje no expresa sentimiento sobre instalación
                         (cobranza, otra cotización, saludo aislado, etc.)
  - pendiente_ajuste  → cliente reporta algo menor pendiente
                         "falta el remate del lado izquierdo", "ajustar nivel",
                         "se quedó por terminar el sello"
                         OJO: si es falla CRÍTICA (motor no funciona) → A8_GARANTIA

NO APLICAR A8_SATIS SI:
  - No hay instalación reciente en últimos 30 días → aplica=false SIEMPRE,
    sin excepción. Incluso si el mensaje suena positivo ("mil gracias"),
    sin contexto de instalación reciente registrada no podés inferir post-venta.
  - El mensaje es del NEGOCIO (saliente)
  - El mensaje es una cotización nueva ("cuánto cuesta para otro espacio")
  - El mensaje es claramente A8_RECLAMO (amenaza pública)
  - El mensaje es claramente A8_GARANTIA (falla grave del producto)

⚠ Si instalaciones_recientes está VACÍO en los datos provistos → aplica=false.

REGLAS DURAS:
  - estado_cliente DEBE estar en el enum ${ESTADOS_CLIENTE.join(', ')}.
  - evidencia_texto cita la frase exacta del cliente.
  - fuente: "whatsapp" (este caso) o "inferido" si dudás.
  - instalacion_id_sugerida (si no null) DEBE estar en instalaciones_recientes.
  - Si no_aplica=true → estado_cliente=sin_respuesta, sin propuesta.

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — aplica=false (sin instalación reciente o mensaje no relacionado):
    out.confianza = "CONFIRMADO"  (no buzón, no aporta registrar)

  caso B — aplica=true (sentimiento detectado):
    out.confianza = "INFERIDO"   (al buzón, Jhon valida y registra)

PROHIBIDO ABSOLUTO:
  ✗ aplica=false con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ aplica=true con out.confianza = "CONFIRMADO" → ERROR

CONTEXTO:
  Instalaciones recientes del cliente (≤30d):
${instStr}

Mensaje del cliente:
  "${datos.mensaje_actual.texto}"

Salida JSON EXACTA — con sentimiento detectado:
{
  "tipo_evento": "inferencia",
  "confianza": "INFERIDO",
  "payload": {
    "aplica": true,
    "satisfaccion_propuesta": {
      "estado_cliente": "feliz",
      "instalacion_id_sugerida": ${datos.instalaciones_recientes[0]?.id ?? 'null'},
      "cotizacion_id_sugerida": ${datos.instalaciones_recientes[0]?.cotizacion_id ?? 'null'},
      "evidencia_texto": "mil gracias, quedó hermoso, los recomiendo",
      "fuente": "whatsapp",
      "notas_para_jhon": "Cliente muy contento post-instalación. Apto para pedir reseña Google."
    },
    "resumen": "Cliente feliz post-instalación (3 días)."
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}

Si no aplica (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "inferencia",
  "confianza": "CONFIRMADO",
  "payload": {
    "aplica": false,
    "satisfaccion_propuesta": null,
    "resumen": "No aplica (sin instalación reciente o mensaje no relacionado)"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO RECIENTE ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion}): ${datos.mensaje_actual.texto}

Determiná si aplica registro de satisfacción y el estado_cliente.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.aplica !== 'boolean') {
      throw new ValidacionError('schema', 'aplica debe ser boolean');
    }
    if (p.aplica) {
      const s: SatisfaccionPropuestaOutput = p.satisfaccion_propuesta;
      if (!s || typeof s !== 'object') {
        throw new ValidacionError('schema', 'aplica=true requiere satisfaccion_propuesta');
      }
      if (!ESTADOS_CLIENTE.includes(s.estado_cliente as any)) {
        throw new ValidacionError('schema', `estado_cliente inválido: ${s.estado_cliente}`);
      }
      if (typeof s.evidencia_texto !== 'string' || s.evidencia_texto.trim().length === 0) {
        throw new ValidacionError('schema', 'evidencia_texto vacía');
      }
      if (!['whatsapp', 'llamada', 'visita', 'inferido'].includes(s.fuente)) {
        throw new ValidacionError('schema', `fuente inválida: ${s.fuente}`);
      }
      const instIds = new Set<number>(datos.instalaciones_recientes.map(i => i.id));
      const cotIds = new Set<number>(datos.instalaciones_recientes.map(i => i.cotizacion_id));
      if (s.instalacion_id_sugerida !== null && s.instalacion_id_sugerida !== undefined) {
        if (!instIds.has(s.instalacion_id_sugerida)) {
          throw new ValidacionError('coherencia-a8s',
            `instalacion_id_sugerida=${s.instalacion_id_sugerida} no está en instalaciones recientes`);
        }
      }
      if (s.cotizacion_id_sugerida !== null && s.cotizacion_id_sugerida !== undefined) {
        if (!cotIds.has(s.cotizacion_id_sugerida)) {
          throw new ValidacionError('coherencia-a8s',
            `cotizacion_id_sugerida=${s.cotizacion_id_sugerida} no está en cotizaciones de instalaciones recientes`);
        }
      }
      if (datos.instalaciones_recientes.length === 0) {
        throw new ValidacionError('coherencia-a8s',
          'aplica=true pero no hay instalaciones recientes en los datos');
      }
    } else {
      if (p.satisfaccion_propuesta !== null && p.satisfaccion_propuesta !== undefined) {
        throw new ValidacionError('schema', 'aplica=false requiere satisfaccion_propuesta=null');
      }
    }

    // Coherencia mecánica out.confianza ↔ aplica
    if (!p.aplica && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a8s',
        `aplica=false requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.aplica && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a8s',
        `aplica=true no puede tener out.confianza='CONFIRMADO' (requiere registro)`);
    }

    // Resolver msg_ids con tolerancia prefijo
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
    if (ctx.agente.shadow) return;
    const p = out.payload as any;
    if (!p.aplica) return;
    const s = p.satisfaccion_propuesta as SatisfaccionPropuestaOutput;

    const { data: row, error } = await sb.from('satisfaccion_postventa').insert({
      instalacion_id: s.instalacion_id_sugerida ?? null,
      cotizacion_id: s.cotizacion_id_sugerida ?? null,
      persona_id: ctx.persona_id,
      estado_cliente: s.estado_cliente,
      fecha_check: new Date().toISOString().slice(0, 10),
      fuente: s.fuente,
      notas: `${s.notas_para_jhon}\n\nEvidencia: "${s.evidencia_texto}"`,
      shadow: true,
      agente_origen: ctx.agente.codigo,
    } as any).select('id').single();
    if (error || !row) {
      throw new Error(`A8_SATIS insert satisfaccion: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'satisfaccion', entidad_id: row.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
