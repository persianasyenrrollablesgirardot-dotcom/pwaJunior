/**
 * A8_RECLAMO — detector de reclamos sensibles con escalación urgente.
 *
 * El más sensible de L8. Detecta cuando un cliente está MUY molesto y/o
 * amenaza públicamente. Casos típicos:
 *   - "Voy a poner mala reseña en Google"
 *   - "Llamo a la fiscalía / Sic / Defensoría"
 *   - "Voy a denunciarlos"
 *   - "Esto está en redes sociales"
 *   - "Llevo 2 meses esperando y nadie me responde"
 *
 * Output: tipo_evento='reclamo' con motivo + severidad. Si severidad='critica'
 * → confianza='ALERTA' → buzón con prioridad 1 → Jhon ve INMEDIATO en M9
 * Control y seguridad.
 *
 * Distinto de:
 *   - A4_OBJECIONES: objeción comercial pre-venta (precio, tiempo)
 *   - A8_GARANTIA: reporte de falla técnica → abrir garantía
 *   - A8_RECLAMO: cliente con queja sensible que puede dañar reputación
 *
 * NO confundir intensidad emocional con criticidad real:
 *   "Está caro" enojado = objeción (no reclamo)
 *   "Voy a poner mala reseña en Google" = reclamo CRÍTICO
 *   "Llevo esperando 2 meses sin respuesta" = reclamo ALTA (incumplimiento)
 *
 * tipo_evento='reclamo'. Tope $0.03/invocación.
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

interface DatosA8Reclamo {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  tiene_garantia_abierta: boolean;
  cotizacion_id_sugerida: number | null;
  garantia_id_sugerida: number | null;
  dias_desde_ultima_respuesta_negocio: number | null;
}

const MOTIVOS = [
  'cliente_molesto',
  'garantia_mal_manejada',
  'dano_costoso',
  'publicacion_negativa',
  'mala_resena',
  'incumplimiento',
  'otro',
] as const;
type MotivoReclamo = typeof MOTIVOS[number];

const SEVERIDADES = ['baja', 'media', 'alta', 'critica'] as const;
type SeveridadReclamo = typeof SEVERIDADES[number];

interface ReclamoPropuestaOutput {
  motivo: MotivoReclamo;
  severidad: SeveridadReclamo;
  escalado_a: string;            // 'jhon' | 'gerente' | 'abogado'
  descripcion: string;
  evidencia_texto: string;
  amenaza_publica: boolean;
  acciones_inmediatas_sugeridas: string[];
}

const N_CONTEXTO = 6;

export const a8ReclamoHooks: AgenteHooks<DatosA8Reclamo> = {
  async cargarContexto(sb, params) {
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    const msgIdPrincipal: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? evt?.canal_msg_id ?? null;

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

    // Detectar cuándo respondió por última vez el negocio (incumplimiento si >7d)
    const ultimaSaliente = [...contexto].reverse().find(m => m.direccion === 'saliente');
    let diasDesdeUltimaRespuesta: number | null = null;
    if (ultimaSaliente) {
      diasDesdeUltimaRespuesta = Math.floor(
        (new Date(mensajeActual.ts_canal).getTime() - new Date(ultimaSaliente.ts_canal).getTime()) /
        (1000 * 60 * 60 * 24)
      );
    }

    // Cotización activa + garantía abierta (para contexto del reclamo)
    let cotId: number | null = null;
    let gtId: number | null = null;
    let tieneGtAbierta = false;
    if (params.proyecto_id) {
      const { data: cot } = await sb.from('cotizaciones')
        .select('id')
        .eq('proyecto_id', params.proyecto_id)
        .is('deleted_at', null)
        .order('fecha', { ascending: false })
        .limit(1)
        .maybeSingle();
      cotId = cot?.id ?? null;
    }
    if (params.persona_id) {
      const { data: gts } = await sb.from('garantias')
        .select('id, estado')
        .eq('persona_id', params.persona_id)
        .in('estado', ['abierta', 'en_diagnostico', 'en_reparacion'])
        .is('deleted_at', null)
        .order('fecha_apertura', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (gts) {
        gtId = gts.id;
        tieneGtAbierta = true;
      }
    }

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      tiene_garantia_abierta: tieneGtAbierta,
      cotizacion_id_sugerida: cotId,
      garantia_id_sugerida: gtId,
      dias_desde_ultima_respuesta_negocio: diasDesdeUltimaRespuesta,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 220)}`
        ).join('\n');

    const gtStr = datos.tiene_garantia_abierta
      ? `⚠ El cliente YA tiene garantía abierta #${datos.garantia_id_sugerida}. Reclamo probablemente sobre garantía mal manejada.`
      : 'No hay garantía abierta en BD.';

    const responsiviStr = datos.dias_desde_ultima_respuesta_negocio === null
      ? 'Sin respuesta previa del negocio.'
      : `Última respuesta del negocio: hace ${datos.dias_desde_ultima_respuesta_negocio} días.${datos.dias_desde_ultima_respuesta_negocio > 7 ? ' (INCUMPLIMIENTO posible)' : ''}`;

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A8_RECLAMO. Detectás RECLAMOS SENSIBLES — quejas que pueden dañar
reputación, escalar legalmente o irse a redes sociales. NO objeciones de
precio, NO reportes técnicos simples.

MOTIVOS (catálogo, usá EXACTAMENTE estos codigos):
  - cliente_molesto         → cliente muy enojado pero sin amenaza específica
  - garantia_mal_manejada   → cliente molesto por cómo manejamos garantía previa
  - dano_costoso            → daño material/económico significativo causado por nosotros
  - publicacion_negativa    → "ya publiqué en redes", "voy a contar esto", FB/IG
  - mala_resena             → "voy a poner mala reseña en Google", reseña ya publicada
  - incumplimiento          → "llevo X semanas esperando", deadline vencido
  - otro                    → cualquier otra queja sensible

SEVERIDADES:
  - baja      → molestia leve, sin amenaza ni urgencia
  - media     → molestia clara con queja específica, sin amenaza pública
  - alta      → cliente muy molesto, amenaza implícita o incumplimiento real
  - critica   → AMENAZA PÚBLICA CLARA: "voy a publicar", "voy a denunciar",
                 "llamo a la fiscal", "lo subo a redes". ESCALACIÓN INMEDIATA.

ESCALADO_A:
  - "jhon"     → default, cliente_molesto sin amenaza
  - "gerente"  → severidad alta con riesgo de pérdida grande
  - "abogado"  → mencionan denuncia, fiscalía, SIC, demanda

CRITERIOS:
  - severidad=critica REQUIERE amenaza_publica=true
  - amenaza_publica=true típicamente → severidad alta/critica
  - "molestia genérica" + queja vaga → severidad media máximo
  - Insulto al negocio sin amenaza → severidad alta (no crítica)

NO ES RECLAMO SENSIBLE:
  - Objeción de precio ("está caro") → A4_OBJECIONES
  - Reporte simple de falla ("no sube la persiana") → A8_GARANTIA, no A8_RECLAMO
  - Solicitud de cotización
  - Pregunta de estado
  EXCEPCIÓN: si la queja de falla incluye amenaza pública o "estoy harto",
  TAMBIÉN va a A8_RECLAMO con motivo=garantia_mal_manejada o similar.

REGLAS DURAS:
  - R-001 anti-alucinación: evidencia_texto cita LITERALMENTE la frase del cliente.
  - motivo DEBE estar en catálogo.
  - severidad en ['baja','media','alta','critica'].
  - Si direccion=saliente (negocio) → reclamo=false (no nos reclamamos a nosotros mismos).
  - Si el mensaje no tiene queja sensible → hay_reclamo=false.

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — hay_reclamo=false (no es reclamo sensible):
    out.confianza = "CONFIRMADO"  (no buzón, no aporta revisar)

  caso B — hay_reclamo=true:
    SI severidad="critica"           → out.confianza = "ALERTA"   (prio 1, escalación inmediata)
    SI severidad ∈ {alta, media}     → out.confianza = "INFERIDO" (al buzón)
    SI severidad="baja"               → out.confianza = "DUDOSO"  (al buzón con prio baja)

PROHIBIDO ABSOLUTO:
  ✗ hay_reclamo=true con out.confianza="CONFIRMADO" → ERROR (reclamos siempre revisables)
  ✗ hay_reclamo=false con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ severidad="critica" sin out.confianza="ALERTA" → ERROR

CONTEXTO:
  ${gtStr}
  ${responsiviStr}

ACCIONES INMEDIATAS SUGERIDAS:
  Lista de 1-3 acciones concretas que Jhon debería hacer. Ejemplo:
    ["Llamar al cliente en las próximas 2 horas",
     "Ofrecer compensación (15% descuento o visita gratis)",
     "Preparar respuesta por escrito si publica"]

Salida JSON EXACTA — con reclamo:
{
  "tipo_evento": "reclamo",
  "confianza": "ALERTA",
  "payload": {
    "hay_reclamo": true,
    "reclamo_propuesto": {
      "motivo": "mala_resena",
      "severidad": "critica",
      "escalado_a": "jhon",
      "descripcion": "Cliente amenaza con publicar mala reseña en Google si no respondemos hoy.",
      "evidencia_texto": "voy a poner mala reseña en Google si no me responden HOY",
      "amenaza_publica": true,
      "acciones_inmediatas_sugeridas": [
        "Llamar al cliente en las próximas 2 horas",
        "Ofrecer compensación inmediata (visita técnica gratis)",
        "Documentar la situación por escrito"
      ]
    },
    "cotizacion_id_sugerida": ${datos.cotizacion_id_sugerida ?? 'null'},
    "garantia_id_sugerida": ${datos.garantia_id_sugerida ?? 'null'},
    "resumen": "RECLAMO CRÍTICO: cliente amenaza con mala reseña pública. Escalación inmediata."
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}

Sin reclamo (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "reclamo",
  "confianza": "CONFIRMADO",
  "payload": {
    "hay_reclamo": false,
    "reclamo_propuesto": null,
    "cotizacion_id_sugerida": null,
    "garantia_id_sugerida": null,
    "resumen": "Mensaje no es reclamo sensible"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO DEL CHAT ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion}): ${datos.mensaje_actual.texto}

Determiná si es un reclamo sensible. Si severidad=critica, marcá confianza=ALERTA.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.hay_reclamo !== 'boolean') {
      throw new ValidacionError('schema', 'hay_reclamo debe ser boolean');
    }
    if (p.hay_reclamo) {
      const r: ReclamoPropuestaOutput = p.reclamo_propuesto;
      if (!r || typeof r !== 'object') {
        throw new ValidacionError('schema', 'hay_reclamo=true requiere reclamo_propuesto');
      }
      if (!MOTIVOS.includes(r.motivo as any)) {
        throw new ValidacionError('schema', `motivo='${r.motivo}' no está en catálogo`);
      }
      if (!SEVERIDADES.includes(r.severidad as any)) {
        throw new ValidacionError('schema', `severidad inválida: ${r.severidad}`);
      }
      if (typeof r.amenaza_publica !== 'boolean') {
        throw new ValidacionError('schema', 'amenaza_publica debe ser boolean');
      }
      if (r.severidad === 'critica' && !r.amenaza_publica) {
        throw new ValidacionError('coherencia-a8r', `severidad=critica requiere amenaza_publica=true`);
      }
      if (typeof r.evidencia_texto !== 'string' || r.evidencia_texto.trim().length === 0) {
        throw new ValidacionError('schema', 'evidencia_texto vacía');
      }
      if (!Array.isArray(r.acciones_inmediatas_sugeridas) || r.acciones_inmediatas_sugeridas.length === 0) {
        throw new ValidacionError('schema', 'acciones_inmediatas_sugeridas debe ser array no vacío');
      }
      if (p.cotizacion_id_sugerida !== null && p.cotizacion_id_sugerida !== undefined) {
        if (datos.cotizacion_id_sugerida === null || p.cotizacion_id_sugerida !== datos.cotizacion_id_sugerida) {
          throw new ValidacionError('coherencia-a8r',
            `cotizacion_id_sugerida=${p.cotizacion_id_sugerida} no coincide con la cargada (${datos.cotizacion_id_sugerida})`);
        }
      }
      if (p.garantia_id_sugerida !== null && p.garantia_id_sugerida !== undefined) {
        if (datos.garantia_id_sugerida === null || p.garantia_id_sugerida !== datos.garantia_id_sugerida) {
          throw new ValidacionError('coherencia-a8r',
            `garantia_id_sugerida=${p.garantia_id_sugerida} no coincide con la cargada (${datos.garantia_id_sugerida})`);
        }
      }
    } else {
      if (p.reclamo_propuesto !== null && p.reclamo_propuesto !== undefined) {
        throw new ValidacionError('schema', 'hay_reclamo=false requiere reclamo_propuesto=null');
      }
    }

    // Coherencia mecánica out.confianza ↔ hay_reclamo + severidad
    if (!p.hay_reclamo && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a8r',
        `hay_reclamo=false requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.hay_reclamo && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a8r',
        `hay_reclamo=true no puede tener out.confianza='CONFIRMADO' (reclamos requieren revisión humana)`);
    }
    if (p.hay_reclamo) {
      const r = p.reclamo_propuesto as ReclamoPropuestaOutput;
      if (r.severidad === 'critica' && out.confianza !== 'ALERTA') {
        throw new ValidacionError('coherencia-a8r',
          `severidad=critica requiere out.confianza='ALERTA' (prio 1), recibido '${out.confianza}'`);
      }
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
    if (!p.hay_reclamo) return;
    const r = p.reclamo_propuesto as ReclamoPropuestaOutput;

    const acciones = Array.isArray(r.acciones_inmediatas_sugeridas)
      ? `Acciones sugeridas:\n - ${r.acciones_inmediatas_sugeridas.join('\n - ')}`
      : '';
    const notas = `${r.descripcion}\n\nEvidencia: "${r.evidencia_texto}"\n\n${acciones}`;

    const { data: row, error } = await sb.from('reclamos_sensibles').insert({
      persona_id: ctx.persona_id,
      cotizacion_id: p.cotizacion_id_sugerida ?? null,
      garantia_id: p.garantia_id_sugerida ?? null,
      motivo: r.motivo,
      severidad: r.severidad,
      estado: 'abierto',
      escalado_a: r.escalado_a || 'jhon',
      fecha_apertura: new Date().toISOString().slice(0, 10),
      notas,
      shadow: true,
      agente_origen: ctx.agente.codigo,
    } as any).select('id').single();
    if (error || !row) {
      throw new Error(`A8_RECLAMO insert reclamo: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'reclamo', entidad_id: row.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
