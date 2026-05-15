/**
 * A4_OBJECIONES — detector de objeciones del cliente.
 *
 * Cuando el cliente responde con dudas / críticas / comparaciones a una
 * cotización propuesta, A4_OBJECIONES extrae cada objeción + tipo + frase
 * exacta. Soporta MÚLTIPLES objeciones en un mismo mensaje
 * ("está caro Y además tarda mucho" → 2 objeciones).
 *
 * Tipos de objeción (catálogo tipos_objecion, 12 entradas):
 *   precio, calidad, garantia, tiempo, competencia, color, diseño,
 *   instalacion, desconfianza, comparacion_referido,
 *   comparacion_homecenter, comparacion_otro_proveedor
 *
 * Output tipo_evento='cotizacion_objecion' → buzón mapea a
 * 'cotizacion_objecion_propuesta'. Jhon revisa y decide qué responder.
 *
 * Si hay cotización activa para el proyecto, vinculamos la objeción a ella
 * en el payload (cotizacion_id_sugerido). Si no, va sin vincular.
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

interface TipoObjecionCatalogo {
  codigo: string;
  nombre: string;
}

interface DatosA4Objeciones {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  tipos_objecion_catalogo: TipoObjecionCatalogo[];
  cotizacion_activa_id: number | null;
}

interface ObjecionOutput {
  tipo_objecion_codigo: string;
  texto_cliente: string;            // la frase exacta del mensaje
  intensidad: 'leve' | 'media' | 'fuerte';
  confianza_objecion: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  msg_id: string;
  observacion?: string;
}

const N_CONTEXTO = 6;
const INTENSIDADES = ['leve', 'media', 'fuerte'] as const;

export const a4ObjecionesHooks: AgenteHooks<DatosA4Objeciones> = {
  async cargarContexto(sb, params) {
    const { data: tipos } = await sb.from('tipos_objecion')
      .select('codigo, nombre');

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
      .filter(m => m.texto && m.texto.trim().length > 0)
      .map(m => ({
        canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto!, ts_canal: m.ts_canal,
      }));

    // Cotización activa del proyecto (para vincular objeción)
    let cotizacionActivaId: number | null = null;
    if (params.proyecto_id) {
      const { data: cot } = await sb.from('cotizaciones')
        .select('id')
        .eq('proyecto_id', params.proyecto_id)
        .is('deleted_at', null)
        .in('estado', ['propuesta', 'negociando', 'intencion_cierre'])
        .order('fecha', { ascending: false })
        .limit(1)
        .maybeSingle();
      cotizacionActivaId = cot?.id ?? null;
    }

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      tipos_objecion_catalogo: (tipos ?? []) as TipoObjecionCatalogo[],
      cotizacion_activa_id: cotizacionActivaId,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 220)}`
        ).join('\n');

    const tiposStr = datos.tipos_objecion_catalogo
      .map(t => `  ${t.codigo.padEnd(30)} — ${t.nombre}`).join('\n');

    const cotStr = datos.cotizacion_activa_id
      ? `Cotización activa del proyecto: #${datos.cotizacion_activa_id} (vinculá las objeciones a ésta).`
      : 'No hay cotización activa en el proyecto (objeción quedará sin vínculo).';

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A4_OBJECIONES. Detectás objeciones del cliente en el mensaje y las clasificás.

Una objeción es CUALQUIER expresión del cliente que sugiera duda, crítica,
comparación con competencia, preocupación de precio/calidad/tiempo/garantía,
o resistencia a cerrar la compra.

Múltiples objeciones en un mismo mensaje son posibles. Listalas todas.

CATÁLOGO de tipos_objecion (usá EXACTAMENTE estos codigos):
${tiposStr}

Heurísticas por tipo:
  precio                      → "muy caro", "se me sale del presupuesto", "no me alcanza", "podés mejorar?"
  calidad                     → "duda si es duradero", "qué material", "cuánto dura"
  garantia                    → "y si se daña?", "qué garantía dan", "qué pasa si falla"
  tiempo                      → "es para X fecha", "no puedo esperar", "muy lejos"
  competencia                 → "voy a comparar", "estoy mirando otros"
  color                       → "no me gusta el gris", "no tienen en blanco?"
  diseño                      → "no es el estilo que busco"
  instalacion                 → "quién instala?", "me cobran extra?"
  desconfianza                → "no los conozco", "me da miedo dar mis datos"
  comparacion_referido        → "a mi cuñado le hicieron por menos", "mi vecina pagó la mitad"
  comparacion_homecenter      → "en Homecenter está a X", "en Sodimac vi"
  comparacion_otro_proveedor  → "otra empresa me dio X", "vi por internet a menos"

Intensidad:
  leve   → menciona objeción casual ("lo voy a pensar")
  media  → preocupación clara ("está un poco caro")
  fuerte → bloquea cierre ("está MUY caro, no puedo pagar eso")

texto_cliente: cita la frase EXACTA del mensaje (extraída directamente, no parafraseada).

Reglas duras:
  - R-001 anti-alucinación: cada objeción cita msg_id donde aparece.
  - tipo_objecion_codigo DEBE estar en el catálogo. NO inventes.
  - Solo del CLIENTE (direccion=entrante). Si el mensaje es del negocio,
    objeciones=[].

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — objeciones=[] (mensaje sin objeción real):
    out.confianza = "CONFIRMADO" (estoy seguro de que NO hay objeción, no buzón)

  caso B — objeciones.length ≥ 1:
    out.confianza = "INFERIDO" (al buzón para que Jhon prepare respuesta)

PROHIBIDO ABSOLUTO:
  ✗ objeciones=[] con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ objeciones.length ≥ 1 con out.confianza = "CONFIRMADO" → ERROR

${cotStr}

Devolvés JSON EXACTO con la forma de los ejemplos siguientes.

EJEMPLO 1 — mensaje con objeción (INFERIDO → buzón):
{
  "tipo_evento": "cotizacion_objecion",
  "confianza": "INFERIDO",
  "payload": {
    "objeciones": [
      {
        "tipo_objecion_codigo": "precio",
        "texto_cliente": "está muy caro, no puedo pagar tanto",
        "intensidad": "fuerte",
        "confianza_objecion": "CONFIRMADO",
        "msg_id": "XYZ"
      }
    ],
    "cotizacion_id_sugerido": 42,
    "resumen": "1 objeción: precio (fuerte)"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 2 — mensaje sin objeción (CONFIRMADO → NO al buzón):
{
  "tipo_evento": "cotizacion_objecion",
  "confianza": "CONFIRMADO",
  "payload": {
    "objeciones": [],
    "cotizacion_id_sugerido": null,
    "resumen": "Sin objeciones del cliente"
  },
  "evidencia_msg_ids": ["MSG_ID_ACTUAL"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO DEL CHAT ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${datos.mensaje_actual.texto}

Detectá las objeciones del cliente en el MENSAJE A ANALIZAR. Si el mensaje no
tiene objeciones (es saludo, pregunta normal, agradecimiento, etc.) →
objeciones=[].`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!Array.isArray(p?.objeciones)) {
      throw new ValidacionError('schema', 'payload.objeciones debe ser array');
    }
    const tiposValidos = new Set<string>(datos.tipos_objecion_catalogo.map(t => t.codigo));
    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);
    for (const o of p.objeciones as ObjecionOutput[]) {
      if (!tiposValidos.has(o.tipo_objecion_codigo)) {
        throw new ValidacionError('schema',
          `tipo_objecion_codigo='${o.tipo_objecion_codigo}' no está en catálogo`);
      }
      if (typeof o.texto_cliente !== 'string' || o.texto_cliente.trim().length === 0) {
        throw new ValidacionError('schema', `objeción sin texto_cliente: ${JSON.stringify(o)}`);
      }
      if (!INTENSIDADES.includes(o.intensidad)) {
        throw new ValidacionError('schema', `intensidad inválida: ${o.intensidad}`);
      }
      if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(o.confianza_objecion)) {
        throw new ValidacionError('schema', `confianza_objecion inválida: ${o.confianza_objecion}`);
      }
      const realMsgId = resolverMsgId(o.msg_id, msgIdsValidos);
      if (!realMsgId) {
        throw new ValidacionError('R-anti-alucinacion',
          `objeción cita msg_id '${o.msg_id}' que no está en mensaje o contexto`);
      }
      o.msg_id = realMsgId;
    }
    if (p.cotizacion_id_sugerido !== null && p.cotizacion_id_sugerido !== undefined) {
      if (datos.cotizacion_activa_id === null) {
        throw new ValidacionError('coherencia-a4o',
          `cotizacion_id_sugerido=${p.cotizacion_id_sugerido} pero no hay cotización activa en el proyecto`);
      }
      if (p.cotizacion_id_sugerido !== datos.cotizacion_activa_id) {
        throw new ValidacionError('coherencia-a4o',
          `cotizacion_id_sugerido=${p.cotizacion_id_sugerido} no coincide con la activa del proyecto (${datos.cotizacion_activa_id})`);
      }
    }

    // Coherencia mecánica out.confianza ↔ N objeciones
    if (p.objeciones.length === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a4o',
        `objeciones=[] requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.objeciones.length > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a4o',
        `objeciones.length=${p.objeciones.length} requiere out.confianza='INFERIDO' (Jhon prepara respuesta), no CONFIRMADO`);
    }

    // evidencia_msg_ids con tolerancia prefijo
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
    const objeciones = Array.isArray(p.objeciones) ? p.objeciones as ObjecionOutput[] : [];
    if (objeciones.length === 0) return;
    // cotizacion_id es NOT NULL en cotizacion_objeciones → si no hay cotización
    // activa, el ítem va al buzón sin entidad polimórfica.
    if (!p.cotizacion_id_sugerido) return;

    // Insertar la PRIMERA objeción como shadow=true (1 fila → 1 ítem buzón).
    // Si hay más objeciones, todas quedan visibles en el detalle JSON del buzón
    // y Jhon puede crearlas manualmente desde el modal de cotización si las quiere.
    const o = objeciones[0];
    const { data: row, error } = await sb.from('cotizacion_objeciones').insert({
      cotizacion_id: p.cotizacion_id_sugerido,
      persona_id: ctx.persona_id,
      tipo_objecion_codigo: o.tipo_objecion_codigo,
      texto_cliente: o.texto_cliente,
      notas: objeciones.length > 1
        ? `Detectadas ${objeciones.length} objeciones — esta es la primera. Ver detalle del ítem del buzón.`
        : null,
      shadow: true,
      agente_origen: ctx.agente.codigo,
      confianza: o.confianza_objecion,
      evento_origen_id: ctx.evento_id,
    } as any).select('id').single();
    if (error || !row) {
      throw new Error(`A4_OBJECIONES insert objecion: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'cotizacion_objecion', entidad_id: row.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
