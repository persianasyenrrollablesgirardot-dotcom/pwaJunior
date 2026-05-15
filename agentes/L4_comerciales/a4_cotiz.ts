/**
 * A4_COTIZ — propone cotización al buzón.
 *
 * Pieza central del enjambre comercial. Cuando A2_INTENCION marca "cotizar"
 * (o cuando el diálogo lo amerita), A4_COTIZ analiza el contexto y propone
 * una ESTRUCTURA de cotización: qué sistemas, en qué ambientes, con qué
 * medidas, color, accesorios, quien_midio.
 *
 * IMPORTANTE — NO calcula precios.
 *   - El catálogo de precios no está estructurado todavía (Jhon mantiene la
 *     decisión final del precio en su cabeza/Excel).
 *   - A4_COTIZ propone la composición de la cotización; Jhon pone los precios
 *     y aprueba en el buzón.
 *
 * Confianza:
 *   - CONFIRMADO  → sistema + medidas + ambiente explícitos
 *                   (raro; cliente típico no da todo de una)
 *   - INFERIDO    → sistema + (medidas OR ambiente) explícitos
 *   - DUDOSO      → solo intención sin specs (cliente pregunta "cuánto cuesta")
 *
 * tipo_evento='cotizacion' (habilitado por migración 025), que el runner mapea
 * a tipo_decision='cotizacion_propuesta' en buzon_validacion.
 *
 * Tope $0.05/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { SISTEMAS_SAFRA, ValidacionError, resolverMsgId } from '../lib/validador.js';

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  ts_canal: string;
}

interface SistemaSafraCatalogo {
  codigo: string;
  nombre: string;
  categoria: string;
}

interface ZonaCatalogo {
  codigo: string;
  nombre: string;
  costo_traslado_incluido: boolean;
}

interface DatosA4Cotiz {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  sistemas_catalogo: SistemaSafraCatalogo[];
  zonas_catalogo: ZonaCatalogo[];
  inmueble_actual_conjunto_id: number | null;
  zona_actual_proyecto: string | null;
  cotizacion_previa?: { id: number; estado: string; total: number } | null;
}

interface ItemCotizacionOutput {
  sistema_safra_codigo: string;
  ambiente: string | null;
  ancho_m: number | null;
  alto_m: number | null;
  cantidad: number;
  color: string | null;
  accesorios: string[];
  quien_midio: 'tecnico' | 'cliente' | 'familiar' | 'otro' | null;
  notas: string | null;
}

const N_CONTEXTO = 8;
const QUIEN_MIDIO_VALIDO = ['tecnico', 'cliente', 'familiar', 'otro'] as const;

export const a4CotizHooks: AgenteHooks<DatosA4Cotiz> = {
  async cargarContexto(sb, params) {
    // Catálogos compactos
    const { data: sistemas } = await sb.from('sistemas_safra')
      .select('codigo, nombre, categoria')
      .order('orden');
    const { data: zonas } = await sb.from('zonas_instalacion')
      .select('codigo, nombre, costo_traslado_incluido')
      .order('orden');

    // Mensaje del evento + contexto amplio (8 mensajes — necesitamos historia para inferir)
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

    // Inmueble + zona del proyecto
    let inmuebleConjuntoId: number | null = null;
    let zonaActual: string | null = null;
    if (params.proyecto_id) {
      const { data: inm } = await sb.from('inmuebles')
        .select('conjunto_id, conjuntos(zona_codigo)')
        .eq('proyecto_id', params.proyecto_id)
        .is('deleted_at', null)
        .maybeSingle();
      inmuebleConjuntoId = inm?.conjunto_id ?? null;
      zonaActual = (inm as any)?.conjuntos?.zona_codigo ?? null;
    }

    // Cotización previa del proyecto (si existe — para detectar si propondríamos un duplicado)
    let cotizacionPrevia: any = null;
    if (params.proyecto_id) {
      const { data: cot } = await sb.from('cotizaciones')
        .select('id, estado, total')
        .eq('proyecto_id', params.proyecto_id)
        .is('deleted_at', null)
        .in('estado', ['propuesta', 'negociando', 'intencion_cierre'])
        .order('fecha', { ascending: false })
        .limit(1)
        .maybeSingle();
      cotizacionPrevia = cot ?? null;
    }

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      sistemas_catalogo: (sistemas ?? []) as SistemaSafraCatalogo[],
      zonas_catalogo: (zonas ?? []) as ZonaCatalogo[],
      inmueble_actual_conjunto_id: inmuebleConjuntoId,
      zona_actual_proyecto: zonaActual,
      cotizacion_previa: cotizacionPrevia,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 220)}`
        ).join('\n');

    const sistemasStr = datos.sistemas_catalogo
      .map(s => `${s.codigo} — ${s.nombre} (${s.categoria})`).join('\n');

    const zonaStr = datos.zona_actual_proyecto
      ? `Zona del proyecto: ${datos.zona_actual_proyecto}`
      : 'Zona del proyecto: SIN DEFINIR';

    const cotPreviaStr = datos.cotizacion_previa
      ? `⚠ Ya existe cotización previa #${datos.cotizacion_previa.id} en estado '${datos.cotizacion_previa.estado}' (total $${datos.cotizacion_previa.total}). Si tu propuesta es para LA MISMA cotización, dejá observación; si es nueva, justificá.`
      : 'No hay cotización previa abierta para este proyecto.';

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A4_COTIZ. Tu trabajo: convertir el diálogo en una PROPUESTA DE COTIZACIÓN
estructurada que Jhon revisa y aprueba en el buzón.

LO QUE HACÉS:
  - Identificás qué sistema(s) Safra pide el cliente (codigo del catálogo).
  - Inferís ambiente (sala / dormitorio / cocina / estudio / oficina / balcón).
  - Si hay medidas en el diálogo: las incluís (ancho_m × alto_m en metros).
  - Si el cliente mencionó color o accesorios (motor, riel, tapaluz): los incluís.
  - quien_midio: si el cliente dijo "yo medí" → "cliente"; si fue técnico → "tecnico";
    familiar → "familiar"; no se dice → null.

LO QUE NO HACÉS:
  - NO calculás precio_unitario ni monto_total (esos los pone Jhon).
  - NO inventás especificaciones que el cliente no dijo (color, accesorios sin pedido).
  - NO incluyas items para los que no tenés sistema_safra_codigo claro.
  - NO mezclás cotizaciones de OTROS clientes (anti-contaminación).

CÁLCULO MECÁNICO de "confianza" global (NO es opinión, es un cálculo):
  REGLA: toda cotización requiere aprobación humana de Jhon SIEMPRE,
         porque implica precio y compromiso comercial. NUNCA va directa.

  caso A — items=[] (mensaje NO es cotización):
    out.confianza = "DUDOSO"  → al buzón con prioridad para que Jhon decida
    completitud = "vacia"

  caso B — items.length ≥ 1 (proponés cotización):
    out.confianza = "INFERIDO"  → al buzón para que Jhon revise/edite/apruebe
    completitud puede ser "minima" | "parcial" | "completa" según specs.

PROHIBIDO ABSOLUTO:
  ✗ out.confianza = "CONFIRMADO" → ERROR mecánico (cotizaciones nunca van sin Jhon)
  ✗ items=[] con completitud ≠ "vacia" → ERROR mecánico
  ✗ items≥1 con completitud = "vacia" → ERROR mecánico

CUÁNDO PROPONER ITEMS:
  Proponé items SOLO si hay intención clara o probable de cotizar.
  Señales de intención: "cuánto cuesta", "precio", "cotización", "valor",
  "necesito X persianas", "me cotizan", "pasame propuesta", "cotízame", etc.

  Si el cliente solo agradece, saluda, manda dirección, o el mensaje no tiene
  NADA que ver con cotización → items=[] + DUDOSO + observación clara.
  EJEMPLOS de mensajes que SÍ son cotización:
    - "Cuánto cuesta una persiana?"   → 1 item placeholder (sistema más probable)
    - "Quiero cotización para 3"      → 1 item placeholder
    - "Pasame precio del blackout"    → 1 item con sistema=blackout
  EJEMPLOS de mensajes que NO son cotización:
    - "Mil gracias!"                   → items=[]
    - "Buenos días, cómo estás?"       → items=[]
    - "Te paso mi dirección: Cra 50"   → items=[]
    - "Listo, ya pagué"                → items=[]
    - "El motor se rompió"             → items=[] (eso es queja, no cotización)

R-013#1 (regla dura): si quien_midio = 'cliente' o 'familiar', el campo
riesgo_medicion se setea automático en BD. Vos solo informás quien_midio bien.

Reglas duras:
  - R-001 anti-alucinación: evidencia_msg_ids debe citar mensajes reales del chat.
  - Cada item debe tener sistema_safra_codigo del catálogo (NO inventes).
  - cantidad ≥ 1.
  - ancho_m / alto_m si presentes: 0.30 - 8.00 metros.

CATÁLOGO sistemas_safra:
${sistemasStr}

${zonaStr}
${cotPreviaStr}

Devolvés JSON EXACTO con la forma de los ejemplos siguientes.

EJEMPLO 1 — cotización con 1 item (caso B, INFERIDO → buzón para Jhon):
{
  "tipo_evento": "cotizacion",
  "confianza": "INFERIDO",
  "payload": {
    "items": [
      {
        "sistema_safra_codigo": "blackout",
        "ambiente": "sala",
        "ancho_m": 2.40,
        "alto_m": 1.80,
        "cantidad": 1,
        "color": null,
        "accesorios": [],
        "quien_midio": "cliente",
        "notas": "Cliente prefiere control manual"
      }
    ],
    "items_total": 1,
    "tiene_medidas": true,
    "completitud": "parcial",
    "observaciones": ["Falta color y confirmación de accesorios"],
    "resumen": "Cliente solicita 1 blackout 2.40×1.80m para sala"
  },
  "evidencia_msg_ids": ["MSG_ID_1", "MSG_ID_2"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 2 — mensaje NO es cotización (caso A, DUDOSO → buzón con prioridad):
{
  "tipo_evento": "cotizacion",
  "confianza": "DUDOSO",
  "payload": {
    "items": [],
    "items_total": 0,
    "tiene_medidas": false,
    "completitud": "vacia",
    "observaciones": ["Mensaje sin intención de cotizar — cliente solo agradece"],
    "resumen": "No es cotización"
  },
  "evidencia_msg_ids": ["MSG_ID"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO DEL CHAT (cronológico) ===
${ctxLineas}

=== MENSAJE DETONANTE (último del cliente) ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${datos.mensaje_actual.texto}

Construí la propuesta de cotización a partir del contexto + mensaje detonante.
Si en algún mensaje se mencionan medidas, productos, ambientes — usalos.
Si el cliente solo dijo "cuánto cuesta una persiana?" sin más specs, proponé
un item placeholder (sistema más probable: blackout) y dejá observación
indicando qué falta.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!Array.isArray(p?.items)) {
      throw new ValidacionError('schema', 'payload.items debe ser array');
    }
    const sistemasValidos = new Set<string>(datos.sistemas_catalogo.map(s => s.codigo));
    const sistemasValidador = new Set<string>(SISTEMAS_SAFRA as readonly string[]);
    const valido = (cod: string) => sistemasValidos.has(cod) || sistemasValidador.has(cod);

    for (const it of p.items as ItemCotizacionOutput[]) {
      if (typeof it.sistema_safra_codigo !== 'string' || !valido(it.sistema_safra_codigo)) {
        throw new ValidacionError('schema',
          `sistema_safra_codigo='${it.sistema_safra_codigo}' no está en catálogo`);
      }
      if (it.ancho_m !== null && it.ancho_m !== undefined) {
        if (typeof it.ancho_m !== 'number' || it.ancho_m < 0.3 || it.ancho_m > 8) {
          throw new ValidacionError('schema', `ancho_m fuera de rango [0.3,8]: ${it.ancho_m}`);
        }
      }
      if (it.alto_m !== null && it.alto_m !== undefined) {
        if (typeof it.alto_m !== 'number' || it.alto_m < 0.3 || it.alto_m > 8) {
          throw new ValidacionError('schema', `alto_m fuera de rango [0.3,8]: ${it.alto_m}`);
        }
      }
      if (typeof it.cantidad !== 'number' || !Number.isInteger(it.cantidad) || it.cantidad < 1) {
        throw new ValidacionError('schema', `cantidad debe ser entero ≥ 1: ${it.cantidad}`);
      }
      if (!Array.isArray(it.accesorios)) {
        throw new ValidacionError('schema', 'item.accesorios debe ser array');
      }
      if (it.quien_midio !== null && it.quien_midio !== undefined) {
        if (!QUIEN_MIDIO_VALIDO.includes(it.quien_midio as any)) {
          throw new ValidacionError('schema', `quien_midio inválido: ${it.quien_midio}`);
        }
      }
    }
    if (typeof p.items_total !== 'number' || p.items_total !== p.items.length) {
      throw new ValidacionError('schema',
        `items_total=${p.items_total} debe coincidir con items.length=${p.items.length}`);
    }
    if (!['vacia', 'minima', 'parcial', 'completa'].includes(p.completitud)) {
      throw new ValidacionError('schema', `completitud inválida: ${p.completitud}`);
    }
    // Coherencia items ↔ completitud
    if (p.items.length === 0 && p.completitud !== 'vacia') {
      throw new ValidacionError('coherencia-a4-cotiz',
        `items=[] requiere completitud='vacia', got '${p.completitud}'`);
    }
    if (p.items.length > 0 && p.completitud === 'vacia') {
      throw new ValidacionError('coherencia-a4-cotiz',
        `completitud='vacia' requiere items=[], got ${p.items.length} items`);
    }
    // Coherencia out.confianza: NUNCA CONFIRMADO (cotizaciones requieren aprobación humana)
    if (out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a4-cotiz',
        `out.confianza='CONFIRMADO' está prohibido en cotizaciones (siempre requieren aprobación humana, usar INFERIDO o DUDOSO)`);
    }
    // Coherencia items ↔ out.confianza
    if (p.items.length === 0 && out.confianza !== 'DUDOSO') {
      throw new ValidacionError('coherencia-a4-cotiz',
        `items=[] requiere out.confianza='DUDOSO', got '${out.confianza}'`);
    }
    if (p.items.length > 0 && out.confianza !== 'INFERIDO' && out.confianza !== 'DUDOSO') {
      throw new ValidacionError('coherencia-a4-cotiz',
        `items.length=${p.items.length} requiere out.confianza='INFERIDO' o 'DUDOSO', got '${out.confianza}'`);
    }
    // Tolerar prefijo true_/false_ en msg_ids
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
    // En shadow del agente: no escribir, dejar todo en JSON del payload.
    if (ctx.agente.shadow) return;

    const p = out.payload as any;
    const items = Array.isArray(p?.items) ? (p.items as ItemCotizacionOutput[]) : [];

    // 1. Crear la cotización SHADOW=true. La RPC aprobar_buzon_atomic la
    //    promueve a shadow=false cuando Jhon aprueba el ítem del buzón.
    const observaciones = Array.isArray(p?.observaciones) ? p.observaciones.join(' · ') : null;
    const { data: cot, error: errCot } = await sb.from('cotizaciones').insert({
      proyecto_id: ctx.proyecto_id,
      persona_id: ctx.persona_id,
      ambito: ctx.ambito,
      estado: 'propuesta',
      fecha: new Date().toISOString().slice(0, 10),
      shadow: true,
      agente_origen: ctx.agente.codigo,
      confianza: out.confianza,
      notas: observaciones,
    } as any).select('id').single();
    if (errCot || !cot) {
      throw new Error(`A4_COTIZ insert cotizacion: ${errCot?.message ?? 'sin data'}`);
    }

    // 2. Crear los items SHADOW=true (la query fetchItemsPorCotizacion no
    //    filtra por shadow → cuando la cotización se promueve, los items ya
    //    aparecen automáticamente).
    if (items.length > 0) {
      const itemsRows = items.map((it, idx) => ({
        cotizacion_id: cot.id,
        sistema_safra_codigo: it.sistema_safra_codigo,
        ambiente: it.ambiente,
        ancho_m: it.ancho_m,
        alto_m: it.alto_m,
        cantidad: it.cantidad,
        color: it.color,
        accesorios: it.accesorios,
        quien_midio: it.quien_midio,
        notas: it.notas,
        orden: idx,
        shadow: true,
        agente_origen: ctx.agente.codigo,
        confianza: out.confianza,
        evento_origen_id: ctx.evento_id,
      }));
      const { error: errItems } = await sb.from('cotizacion_items').insert(itemsRows as any);
      if (errItems) {
        throw new Error(`A4_COTIZ insert items: ${errItems.message}`);
      }
    }

    return { entidad_tipo: 'cotizacion', entidad_id: cot.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
