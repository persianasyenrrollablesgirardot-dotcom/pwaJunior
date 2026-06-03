/**
 * A8_REPUT — identifica clientes aptos para pedir reseña Google.
 *
 * Pareja natural de A8_SATIS: si A8_SATIS marcó estado_cliente='feliz'
 * CONFIRMADO, A8_REPUT decide si es momento de pedirle reseña + genera el
 * mensaje WhatsApp listo con link.
 *
 * FILOSOFÍA CONSERVADORA:
 *   - Solo marcar apto si:
 *     1. estado_cliente='feliz' registrado en satisfaccion_postventa
 *     2. sin reclamos sensibles abiertos
 *     3. sin garantías en estado abierta/en_diagnostico/en_reparacion
 *     4. instalación entre 3-30 días atrás (tiempo de "embolat")
 *     5. NO se le pidió reseña antes en esta cotización
 *   - Si dudás → apto=false. Mejor no molestar que pedir mala reseña.
 *
 * Output: tipo_evento='review' con propuesta para google_reviews
 * (apto_para_resena=true) + plantilla WhatsApp con link.
 *
 * Tope $0.01/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

interface SatisfaccionRegistrada {
  id: number;
  estado_cliente: string;
  fecha_check: string;
  dias_atras: number;
}

interface InstalacionInfo {
  id: number;
  cotizacion_id: number;
  fecha_real: string | null;
  fecha_programada: string;
  dias_atras: number;
}

interface DatosA8Reput {
  persona_id: number;
  persona_nombre: string | null;
  satisfacciones: SatisfaccionRegistrada[];
  instalaciones: InstalacionInfo[];
  tiene_reclamos_abiertos: boolean;
  tiene_garantias_activas: boolean;
  ya_solicitado_review: boolean;
  google_url: string;
  evento_msg_id: string | null;
}

interface RecomendacionOutput {
  apto_para_resena: boolean;
  cotizacion_id_sugerida: number | null;
  motivo: string;
  satisfaccion_id_usada: number | null;
  plantilla_mensaje_sugerido: string | null;
  fecha_envio_sugerida: string | null;
}

const MIN_DIAS_INSTALACION = 3;
const MAX_DIAS_INSTALACION = 30;
const GOOGLE_REVIEW_URL_DEFAULT = 'https://g.page/r/persianas-girardot/review';  // editable por Jhon

export const a8ReputHooks: AgenteHooks<DatosA8Reput> = {
  async cargarContexto(sb, params) {
    const { data: p } = await sb.from('personas')
      .select('id, nombre')
      .eq('id', params.persona_id)
      .is('deleted_at', null)
      .single();
    if (!p) throw new Error(`persona ${params.persona_id} no encontrada`);

    // Satisfacciones registradas (no shadow)
    const { data: sats } = await sb.from('satisfaccion_postventa')
      .select('id, estado_cliente, fecha_check')
      .eq('persona_id', params.persona_id)
      .eq('shadow', false)
      .is('deleted_at', null)
      .order('fecha_check', { ascending: false })
      .limit(5);
    const hoy = Date.now();
    const satisfacciones: SatisfaccionRegistrada[] = (sats ?? []).map((s: any) => ({
      id: s.id,
      estado_cliente: s.estado_cliente,
      fecha_check: s.fecha_check,
      dias_atras: Math.floor((hoy - new Date(s.fecha_check).getTime()) / (1000 * 60 * 60 * 24)),
    }));

    // Instalaciones reales
    const { data: inst } = await sb.from('instalaciones')
      .select('id, cotizacion_id, fecha_real, fecha_programada')
      .eq('persona_id', params.persona_id)
      .is('deleted_at', null)
      .order('fecha_programada', { ascending: false })
      .limit(5);
    const instalaciones: InstalacionInfo[] = (inst ?? []).map((i: any) => {
      const ref = i.fecha_real ?? i.fecha_programada;
      return {
        id: i.id, cotizacion_id: i.cotizacion_id,
        fecha_real: i.fecha_real, fecha_programada: i.fecha_programada,
        dias_atras: Math.floor((hoy - new Date(ref).getTime()) / (1000 * 60 * 60 * 24)),
      };
    });

    // Reclamos abiertos
    const { data: reclamos } = await sb.from('reclamos_sensibles')
      .select('id')
      .eq('persona_id', params.persona_id)
      .in('estado', ['abierto', 'en_contencion', 'escalado'])
      .is('deleted_at', null)
      .limit(1);
    const tieneReclamos = (reclamos?.length ?? 0) > 0;

    // Garantías activas
    const { data: gts } = await sb.from('garantias')
      .select('id')
      .eq('persona_id', params.persona_id)
      .in('estado', ['abierta', 'en_diagnostico', 'en_reparacion'])
      .is('deleted_at', null)
      .limit(1);
    const tieneGarantias = (gts?.length ?? 0) > 0;

    // Ya se le pidió reseña?
    const { data: gr } = await sb.from('google_reviews')
      .select('id, solicitud_enviada_at, estado')
      .eq('persona_id', params.persona_id)
      .is('deleted_at', null)
      .limit(5);
    const yaSolicitado = (gr ?? []).some((r: any) =>
      r.solicitud_enviada_at !== null || ['solicitada', 'recibida', 'rechazada_cliente'].includes(r.estado)
    );

    // URL de reseña (configurable en BD, default fallback)
    let url = GOOGLE_REVIEW_URL_DEFAULT;
    const { data: cfg } = await sb.from('configuracion_sistema')
      .select('valor')
      .eq('clave', 'google_review_url')
      .maybeSingle();
    if (cfg?.valor && typeof cfg.valor === 'string') url = cfg.valor;
    if (cfg?.valor && typeof cfg.valor === 'object' && 'url' in (cfg.valor as any)) url = (cfg.valor as any).url;

    // msg_id del evento para evidencia. Fallback: último mensaje del chat
    // (A8_REPUT puede correr sin un msg específico — es decisión sobre el cliente,
    //  no sobre un mensaje, pero el validador estándar requiere ≥1 msg_id).
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    let eventoMsgId: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? evt?.canal_msg_id ?? null;
    if (!eventoMsgId) {
      const { data: m } = await sb.from('mensajes')
        .select('canal_msg_id')
        .eq('chat_id', params.chat_id)
        .is('deleted_at', null)
        .order('ts_canal', { ascending: false })
        .limit(1)
        .maybeSingle();
      eventoMsgId = m?.canal_msg_id ?? null;
    }

    return {
      persona_id: p.id,
      persona_nombre: p.nombre,
      satisfacciones,
      instalaciones,
      tiene_reclamos_abiertos: tieneReclamos,
      tiene_garantias_activas: tieneGarantias,
      ya_solicitado_review: yaSolicitado,
      google_url: url,
      evento_msg_id: eventoMsgId,
    };
  },

  construirPrompt(datos, agente) {
    const satStr = datos.satisfacciones.length === 0
      ? '(sin satisfacciones registradas)'
      : JSON.stringify(datos.satisfacciones, null, 2);
    const instStr = datos.instalaciones.length === 0
      ? '(sin instalaciones)'
      : JSON.stringify(datos.instalaciones, null, 2);

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A8_REPUT. Decidís si un cliente es APTO para pedirle reseña en Google.
EXTREMADAMENTE CONSERVADOR — si pedimos reseña al cliente equivocado,
podemos terminar con UNA MALA. Mejor no pedir que pedir mal.

CRITERIOS PARA apto=true (TODOS deben cumplirse):
  1. Hay ≥1 satisfaccion_postventa con estado_cliente='feliz'
  2. NO hay reclamos sensibles abiertos
  3. NO hay garantías activas (abierta/en_diagnostico/en_reparacion)
  4. La instalación más reciente está entre ${MIN_DIAS_INSTALACION}–${MAX_DIAS_INSTALACION} días atrás
     (tiempo dulce: ni muy fresco para distraer, ni muy viejo para olvidar)
  5. NO se le pidió reseña antes (ya_solicitado=false)

SI CUALQUIERA FALLA → apto=false + motivo claro.

Datos del cliente:
  persona: "${datos.persona_nombre ?? `id ${datos.persona_id}`}"
  satisfacciones:
${satStr}
  instalaciones:
${instStr}
  tiene_reclamos_abiertos: ${datos.tiene_reclamos_abiertos}
  tiene_garantias_activas: ${datos.tiene_garantias_activas}
  ya_solicitado_review: ${datos.ya_solicitado_review}

PLANTILLA WHATSAPP (si apto=true):
  Tono cálido, breve, agradecido. Estructura:
    1. Saludo personalizado con nombre
    2. Mencionar que quedaste contento con la instalación
    3. Pedir favor concreto: dejar reseña Google
    4. Link directo: ${datos.google_url}
    5. Cierre simple

  Ejemplo:
  "Hola {nombre}! Quería contarte que nos alegra mucho que te haya gustado el trabajo.
   Si tenés un minutito, ¿podrías dejarnos una reseña en Google? Nos ayuda muchísimo a llegar
   a más familias. Acá te dejo el link: ${datos.google_url}
   ¡Gracias!"

FECHA DE ENVIO SUGERIDA:
  - Si la instalación es de hace 3-7 días → mañana o pasado mañana
  - Si es de 8-20 días → ya enviar (hoy)
  - Si es de 21-30 días → enviar HOY (último momento)

REGLAS DURAS:
  - R-001: NO inventes satisfacciones que no están en los datos.
  - satisfaccion_id_usada DEBE estar en la lista (si no null).
  - cotizacion_id_sugerida DEBE estar en alguna instalación cargada.
  - apto=true REQUIERE plantilla_mensaje_sugerido != null.
  - apto=false REQUIERE plantilla=null + motivo explicando por qué.

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — apto_para_resena=false (no es momento o no califica):
    out.confianza = "DUDOSO"  (no buzón, no molestar). Es una NO-acción sobre el
    cliente, no un dato citable de un mensaje → evidencia_msg_ids DEBE ir vacío: []

  caso B — apto_para_resena=true (todos los criterios cumplidos):
    out.confianza = "INFERIDO"   (al buzón, Jhon edita plantilla y envía).
    Citá en evidencia_msg_ids el msg del evento.

PROHIBIDO ABSOLUTO:
  ✗ apto=false con out.confianza ≠ "DUDOSO" → ERROR
  ✗ apto=true con out.confianza = "CONFIRMADO" → ERROR

Salida JSON EXACTA — APTO:
{
  "tipo_evento": "review",
  "confianza": "INFERIDO",
  "payload": {
    "recomendacion": {
      "apto_para_resena": true,
      "cotizacion_id_sugerida": 42,
      "motivo": "Cliente feliz hace 5 días, sin reclamos ni garantías. Instalación de 6 días atrás.",
      "satisfaccion_id_usada": 100,
      "plantilla_mensaje_sugerido": "Hola María! Nos alegra...",
      "fecha_envio_sugerida": "2026-05-12"
    },
    "resumen": "Apto: María González, feliz post-instalación 6d. Listo para pedir reseña."
  },
  "evidencia_msg_ids": ["${datos.evento_msg_id ?? ''}"],
  "reglas_aplicadas": ["R-001"]
}

Si NO APTO (caso A, DUDOSO → NO al buzón, SIN evidencia):
{
  "tipo_evento": "review",
  "confianza": "DUDOSO",
  "payload": {
    "recomendacion": {
      "apto_para_resena": false,
      "cotizacion_id_sugerida": null,
      "motivo": "Tiene garantía abierta — no es momento de pedir reseña.",
      "satisfaccion_id_usada": null,
      "plantilla_mensaje_sugerido": null,
      "fecha_envio_sugerida": null
    },
    "resumen": "NO apto (garantía activa)"
  },
  "evidencia_msg_ids": [],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Analizá si "${datos.persona_nombre ?? `id ${datos.persona_id}`}" es apto para reseña Google
basado en TODOS los criterios. Sé estricto y conservador.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    const r: RecomendacionOutput = p?.recomendacion;
    if (!r || typeof r !== 'object') {
      throw new ValidacionError('schema', 'payload.recomendacion debe ser objeto');
    }
    if (typeof r.apto_para_resena !== 'boolean') {
      throw new ValidacionError('schema', 'apto_para_resena debe ser boolean');
    }
    if (typeof r.motivo !== 'string' || r.motivo.trim().length === 0) {
      throw new ValidacionError('schema', 'motivo vacío');
    }

    if (r.apto_para_resena) {
      if (typeof r.plantilla_mensaje_sugerido !== 'string' || r.plantilla_mensaje_sugerido.length < 30) {
        throw new ValidacionError('schema', 'apto=true requiere plantilla_mensaje_sugerido (≥30 chars)');
      }
      if (!r.plantilla_mensaje_sugerido.includes(datos.google_url)) {
        throw new ValidacionError('coherencia-a8r',
          `plantilla debe incluir el link de Google (${datos.google_url})`);
      }
      const haFeliz = datos.satisfacciones.some(s => s.estado_cliente === 'feliz');
      if (!haFeliz) throw new ValidacionError('coherencia-a8r', 'apto=true requiere ≥1 satisfaccion con estado_cliente=feliz');
      if (datos.tiene_reclamos_abiertos) throw new ValidacionError('coherencia-a8r', 'apto=true imposible con reclamos abiertos');
      if (datos.tiene_garantias_activas) throw new ValidacionError('coherencia-a8r', 'apto=true imposible con garantías activas');
      if (datos.ya_solicitado_review) throw new ValidacionError('coherencia-a8r', 'apto=true imposible si ya se solicitó reseña');
      const instOK = datos.instalaciones.some(i =>
        i.dias_atras >= MIN_DIAS_INSTALACION && i.dias_atras <= MAX_DIAS_INSTALACION
      );
      if (!instOK) throw new ValidacionError('coherencia-a8r',
        `apto=true requiere instalación entre ${MIN_DIAS_INSTALACION}–${MAX_DIAS_INSTALACION} días`);

      const satIds = new Set<number>(datos.satisfacciones.map(s => s.id));
      if (r.satisfaccion_id_usada !== null && r.satisfaccion_id_usada !== undefined) {
        if (!satIds.has(r.satisfaccion_id_usada)) {
          throw new ValidacionError('coherencia-a8r',
            `satisfaccion_id_usada=${r.satisfaccion_id_usada} no está en datos`);
        }
      }
      const cotIds = new Set<number>(datos.instalaciones.map(i => i.cotizacion_id));
      if (r.cotizacion_id_sugerida !== null && r.cotizacion_id_sugerida !== undefined) {
        if (!cotIds.has(r.cotizacion_id_sugerida)) {
          throw new ValidacionError('coherencia-a8r',
            `cotizacion_id_sugerida=${r.cotizacion_id_sugerida} no está en instalaciones`);
        }
      }
      if (r.fecha_envio_sugerida !== null && r.fecha_envio_sugerida !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(r.fecha_envio_sugerida)) {
          throw new ValidacionError('schema', `fecha_envio_sugerida formato inválido: ${r.fecha_envio_sugerida}`);
        }
      }
    } else {
      if (r.plantilla_mensaje_sugerido !== null && r.plantilla_mensaje_sugerido !== undefined) {
        throw new ValidacionError('schema', 'apto=false requiere plantilla_mensaje_sugerido=null');
      }
      if (r.fecha_envio_sugerida !== null && r.fecha_envio_sugerida !== undefined) {
        throw new ValidacionError('schema', 'apto=false requiere fecha_envio_sugerida=null');
      }
    }

    // Coherencia mecánica out.confianza ↔ apto
    // apto=false → DUDOSO (exento de evidencia: es NO-acción sobre el cliente, no
    // un dato de mensaje). Antes era CONFIRMADO → el guard anti-alucinación lo
    // rechazaba SIEMPRE por falta de msg_id citable (300/300 rechazos).
    if (!r.apto_para_resena && out.confianza !== 'DUDOSO') {
      throw new ValidacionError('coherencia-a8r',
        `apto=false requiere out.confianza='DUDOSO', recibido '${out.confianza}'`);
    }
    if (r.apto_para_resena && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a8r',
        `apto=true no puede tener out.confianza='CONFIRMADO' (requiere aprobación Jhon)`);
    }

    // Resolver msg_ids con tolerancia prefijo
    const msgIdsValidos = new Set<string>(datos.evento_msg_id ? [datos.evento_msg_id] : []);
    if (Array.isArray(out.evidencia_msg_ids) && msgIdsValidos.size > 0) {
      for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
        const real = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
        if (real) out.evidencia_msg_ids[i] = real;
      }
    }
  },

  async postProcesar(sb: SupabaseClient, out, ctx) {
    if (ctx.agente.shadow) return;
    const p = out.payload as any;
    const r = p.recomendacion as RecomendacionOutput;
    if (!r.apto_para_resena) return;

    const { data: row, error } = await sb.from('google_reviews').insert({
      persona_id: ctx.persona_id,
      cotizacion_id: r.cotizacion_id_sugerida ?? null,
      apto_para_resena: true,
      estado: 'apto',
      notas: `${r.motivo}\n\nPlantilla sugerida:\n${r.plantilla_mensaje_sugerido}\n\nEnvío sugerido: ${r.fecha_envio_sugerida ?? 'sin fecha'}`,
      shadow: out.confianza === 'ALERTA',
      agente_origen: ctx.agente.codigo,
    } as any).select('id').single();
    if (error || !row) {
      throw new Error(`A8_REPUT insert google_reviews: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'google_review', entidad_id: row.id };
  },
};
