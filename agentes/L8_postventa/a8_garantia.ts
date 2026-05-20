/**
 * A8_GARANTIA — detector de reportes de falla → propone abrir garantía.
 *
 * Cuando el cliente reporta una falla post-instalación, A8_GARANTIA:
 *   1. Detecta el reporte (vs queja general)
 *   2. Infiere la causa probable (producto / instalación / cliente / ambiente / tercero / construccion)
 *   3. Infiere el responsable_default según la causa
 *   4. Asocia con sistema_safra afectado si se infiere
 *   5. Propone abrir garantía al buzón con todos los campos
 *
 * NO confirma la garantía — solo propone. El humano valida diagnóstico y decide
 * (R-006).
 *
 * Distinto de A8_RECLAMO:
 *   - A8_GARANTIA: cliente reporta producto/instalación falla → abrir garantía
 *   - A8_RECLAMO: cliente con urgencia + amenaza pública (queja crítica)
 *
 * tipo_evento='garantia'. Tope $0.03/invocación.
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

interface CausaCatalogo {
  codigo: string;
  nombre: string;
  responsable_default: string | null;
  notas: string | null;
}

interface CotizacionGanada {
  id: number;
  fecha: string;
  sistemas: string[];   // sistemas_safra_codigo de los items
  meses_atras: number;
}

interface DatosA8Garantia {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  causas_catalogo: CausaCatalogo[];
  cotizaciones_ganadas: CotizacionGanada[];
  sistemas_safra_codigos: string[];
}

interface GarantiaPropuestaOutput {
  sistema_safra_codigo: string | null;
  causa_codigo: string;
  responsable: 'empresa' | 'cliente' | 'tercero';
  descripcion_falla: string;
  cotizacion_id_sugerida: number | null;
  evidencia_texto: string;
}

const RESPONSABLES = ['empresa', 'cliente', 'tercero'] as const;
const N_CONTEXTO = 5;

export const a8GarantiaHooks: AgenteHooks<DatosA8Garantia> = {
  async cargarContexto(sb, params) {
    const { data: causas } = await sb.from('causas_garantia')
      .select('codigo, nombre, responsable_default, notas');

    const { data: sistemas } = await sb.from('sistemas_safra')
      .select('codigo');

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

    // Cotizaciones ganadas (para detectar qué producto pudo haber fallado)
    const cotsGanadas: CotizacionGanada[] = [];
    if (params.persona_id) {
      const { data: cots } = await sb.from('cotizaciones')
        .select('id, fecha, cotizacion_items(sistema_safra_codigo)')
        .eq('persona_id', params.persona_id)
        .eq('estado', 'ganada')
        .is('deleted_at', null)
        .order('fecha', { ascending: false })
        .limit(5);
      for (const c of cots ?? []) {
        const sistemas = Array.from(new Set(((c as any).cotizacion_items ?? [])
          .map((it: any) => it.sistema_safra_codigo).filter(Boolean)));
        const mesesAtras = Math.floor((Date.now() - new Date(c.fecha).getTime()) / (1000 * 60 * 60 * 24 * 30));
        cotsGanadas.push({ id: c.id, fecha: c.fecha, sistemas: sistemas as string[], meses_atras: mesesAtras });
      }
    }

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      causas_catalogo: (causas ?? []) as CausaCatalogo[],
      cotizaciones_ganadas: cotsGanadas,
      sistemas_safra_codigos: (sistemas ?? []).map((s: any) => s.codigo),
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 220)}`
        ).join('\n');

    const causasStr = datos.causas_catalogo
      .map(c => `${c.codigo}|${c.nombre}|responsable_default=${c.responsable_default ?? '?'}|${c.notas ?? ''}`)
      .join('\n');

    const cotsStr = datos.cotizaciones_ganadas.length === 0
      ? '(cliente sin cotizaciones ganadas en BD)'
      : JSON.stringify(datos.cotizaciones_ganadas, null, 2);

    const sistemasStr = datos.sistemas_safra_codigos.join(', ');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A8_GARANTIA. Detectás cuando un cliente reporta una FALLA POST-INSTALACIÓN
y proponés abrir garantía con todos los datos inferibles.

QUÉ ES UN REPORTE DE GARANTÍA:
  - "La persiana no sube hace 3 días"
  - "Se rompió el motor"
  - "Quedó mal puesta, está chueca"
  - "La tela se decoloró"
  - "Llueve y se mete agua, mal sellada"
  Frases que indican PRODUCTO/INSTALACIÓN YA ENTREGADO FALLANDO.

QUÉ NO ES:
  - "Cuánto cuesta una persiana?" → cotización
  - "Lo voy a pensar" → objeción
  - "Mañana te pago" → promesa de pago

CAUSAS (catálogo causas_garantia, usá EXACTAMENTE el codigo):
${causasStr}

INFERIR CAUSA:
  - producto      → motor falla, tela rota sola, herrajes defectuosos, fabricación
  - instalacion   → soporte mal puesto, desnivelado, sellado mal, mal anclado
  - cliente       → daño accidental, golpe, mal uso (limpieza fuerte, niños)
  - ambiente      → exposición a humedad extrema, sol intenso prolongado, viento
  - tercero       → otra empresa que tocó el producto, vecinos
  - construccion  → vano se movió, pared agrietada, marco mal hecho desde origen

RESPONSABLE:
  Empezá con el responsable_default de la causa, pero ajustá si la evidencia
  es clara:
   * Si el cliente describe daño accidental ("se me cayó", "le pegué") → cliente
   * Si dice "el viento lo arrancó" en zona conocida → ambiente
   * Si menciona albañiles/construcción → tercero/construccion

SISTEMA AFECTADO (sistema_safra_codigo):
  - Inferir del texto ("la blackout...", "el toldo...", "el motor...")
  - Si NO se menciona pero hay cotización ganada con sistemas claros → usar
    el sistema más probable de esa cotización.
  - Si dudás → null.

COTIZACIÓN ASOCIADA:
  - Si hay cotización ganada y el sistema afectado matchea → cotizacion_id_sugerida
  - Sino → null.

REGLAS DURAS:
  - R-001 anti-alucinación: evidencia_texto cita la frase del cliente.
  - causa_codigo DEBE estar en el catálogo.
  - sistema_safra_codigo (si no null) DEBE estar en sistemas válidos: ${sistemasStr}
  - cotizacion_id_sugerida (si no null) DEBE estar entre las cotizaciones ganadas
    listadas abajo.
  - R-006: no inferir reparación / costo (es decisión del técnico). Solo abrir.

DATOS DEL CLIENTE:
  Cotizaciones ganadas:
${cotsStr}

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  REGLA: garantías requieren validación técnica humana SIEMPRE (R-006).
         NUNCA CONFIRMADO con hay_reporte_falla=true.

  caso A — hay_reporte_falla=false (no es reporte de falla):
    out.confianza = "CONFIRMADO"  (no buzón, no aporta revisar)

  caso B — hay_reporte_falla=true:
    SI falla muy seria + urgencia clara → out.confianza = "ALERTA" (prio 1)
    SI reporte claro con causa razonable → out.confianza = "INFERIDO" (buzón)
    SI reporte ambiguo o sin causa clara → out.confianza = "DUDOSO" (buzón prio)

PROHIBIDO ABSOLUTO:
  ✗ hay_reporte_falla=true con out.confianza="CONFIRMADO" → ERROR (R-006)
  ✗ hay_reporte_falla=false con out.confianza ≠ "CONFIRMADO" → ERROR

Salida JSON EXACTA — con reporte:
{
  "tipo_evento": "garantia",
  "confianza": "INFERIDO",
  "payload": {
    "hay_reporte_falla": true,
    "garantia_propuesta": {
      "sistema_safra_codigo": "blackout",
      "causa_codigo": "producto",
      "responsable": "empresa",
      "descripcion_falla": "Cliente reporta que la persiana blackout de la sala no sube hace 3 días, está varada arriba.",
      "cotizacion_id_sugerida": 42,
      "evidencia_texto": "La persiana de la sala no sube hace 3 días, está varada arriba"
    },
    "resumen": "Reporte de falla: blackout sala, motor probable (3 días sin funcionar)"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001","R-006"]
}

Sin reporte (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "garantia",
  "confianza": "CONFIRMADO",
  "payload": {
    "hay_reporte_falla": false,
    "garantia_propuesta": null,
    "resumen": "Mensaje no reporta falla"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-006"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO RECIENTE ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion}): ${datos.mensaje_actual.texto}

Determiná si el cliente reporta una falla. Si sí, proponé la garantía con
todos los campos.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.hay_reporte_falla !== 'boolean') {
      throw new ValidacionError('schema', 'hay_reporte_falla debe ser boolean');
    }
    if (p.hay_reporte_falla) {
      const g: GarantiaPropuestaOutput = p.garantia_propuesta;
      if (!g || typeof g !== 'object') {
        throw new ValidacionError('schema', 'hay_reporte_falla=true requiere garantia_propuesta');
      }
      const causasValidas = new Set<string>(datos.causas_catalogo.map(c => c.codigo));
      if (!causasValidas.has(g.causa_codigo)) {
        throw new ValidacionError('schema', `causa_codigo='${g.causa_codigo}' no está en catálogo`);
      }
      if (!RESPONSABLES.includes(g.responsable)) {
        throw new ValidacionError('schema', `responsable inválido: ${g.responsable}`);
      }
      if (typeof g.descripcion_falla !== 'string' || g.descripcion_falla.trim().length === 0) {
        throw new ValidacionError('schema', 'descripcion_falla vacía');
      }
      if (typeof g.evidencia_texto !== 'string' || g.evidencia_texto.trim().length === 0) {
        throw new ValidacionError('schema', 'evidencia_texto vacía');
      }
      if (g.sistema_safra_codigo !== null && g.sistema_safra_codigo !== undefined) {
        const sistemasValidos = new Set<string>(datos.sistemas_safra_codigos);
        if (!sistemasValidos.has(g.sistema_safra_codigo)) {
          throw new ValidacionError('schema',
            `sistema_safra_codigo='${g.sistema_safra_codigo}' no está en catálogo`);
        }
      }
      if (g.cotizacion_id_sugerida !== null && g.cotizacion_id_sugerida !== undefined) {
        const idsValidos = new Set<number>(datos.cotizaciones_ganadas.map(c => c.id));
        if (!idsValidos.has(g.cotizacion_id_sugerida)) {
          throw new ValidacionError('coherencia-a8g',
            `cotizacion_id_sugerida=${g.cotizacion_id_sugerida} no está entre las ganadas del cliente`);
        }
      }
    } else {
      if (p.garantia_propuesta !== null && p.garantia_propuesta !== undefined) {
        throw new ValidacionError('schema', 'hay_reporte_falla=false requiere garantia_propuesta=null');
      }
    }

    // Coherencia mecánica out.confianza ↔ hay_reporte_falla
    if (!p.hay_reporte_falla && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a8g',
        `hay_reporte_falla=false requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.hay_reporte_falla && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('R-006',
        `hay_reporte_falla=true no puede tener out.confianza='CONFIRMADO' (R-006: validación técnica humana)`);
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
    if (!p.hay_reporte_falla) return;
    const g = p.garantia_propuesta as GarantiaPropuestaOutput;

    const { data: row, error } = await sb.from('garantias').insert({
      cotizacion_id: g.cotizacion_id_sugerida ?? null,
      persona_id: ctx.persona_id,
      sistema_safra_codigo: g.sistema_safra_codigo,
      fecha_apertura: new Date().toISOString().slice(0, 10),
      causa_codigo: g.causa_codigo,
      responsable: g.responsable,
      estado: 'abierta',
      notas: g.descripcion_falla,
      shadow: out.confianza === 'ALERTA',
      agente_origen: ctx.agente.codigo,
    } as any).select('id').single();
    if (error || !row) {
      throw new Error(`A8_GARANTIA insert garantia: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'garantia', entidad_id: row.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
