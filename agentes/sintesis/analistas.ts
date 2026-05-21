/**
 * Analistas de síntesis — la capa que SINTETIZA (sobre la capa que extrae).
 *
 * Los 31 agentes extractores sacan datos crudos mensaje por mensaje. Estos 7
 * analistas leen TODO lo de un cliente y producen:
 *   - una conclusión redactada por módulo (M1..M7) → tabla `modulo_sintesis`
 *   - los registros estructurados de su dominio → tablas de negocio
 *     (cotizaciones, abonos, medidas, tareas, garantías, reclamos)
 *
 * Así el panel de análisis y las sub-tabs de detalle salen de la MISMA fuente
 * (el analista que leyó toda la conversación) y siempre coinciden.
 *
 * Se ejecutan por CLIENTE (no por mensaje): el worker llama `sintetizarPersona`
 * al final de un ciclo de pipeline, para cada cliente con actividad nueva.
 *
 * M1 y M7 son textuales (no pueblan tabla). M2-M6 son estructurados.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat } from '../lib/llm.js';

// ── Catálogos de validación (evitan romper FKs / CHECKs al poblar) ──────────
const SISTEMAS_SAFRA = new Set([
  'blackout', 'screen_solar', 'sheer_elegance', 'panel_japones', 'enrollables',
  'verticales', 'peliculas_solares', 'toldos', 'motores', 'domotica', 'rieles', 'cadenillas',
]);
const CAUSAS_GARANTIA = new Set(['producto', 'instalacion', 'cliente', 'ambiente', 'tercero', 'construccion']);
const METODOS_PAGO = new Set(['bancolombia', 'nequi', 'daviplata', 'efectivo', 'transferencia', 'tarjeta', 'consignacion']);
const TIPOS_TAREA = new Set(['llamar', 'enviar_cotizacion', 'confirmar_pago', 'pedir_ficha', 'agendar_instalacion', 'reclamar_proveedor', 'pedir_resena', 'otro']);
const MOTIVOS_RECLAMO = new Set(['cliente_molesto', 'garantia_mal_manejada', 'dano_costoso', 'publicacion_negativa', 'mala_resena', 'incumplimiento', 'otro']);
const ESTADOS_RECLAMO = new Set(['abierto', 'en_contencion', 'escalado', 'resuelto', 'cerrado_negativo']);

const FORMATO = `

Devolvé EXACTAMENTE este formato, una sección por línea:

SÍNTESIS: (2-3 frases concretas)
ESTADO: (emoji semáforo 🟢 o 🟡 o 🔴 + frase corta de estado)
PRÓXIMO PASO: (1 acción concreta que Jhon debe hacer)
ALERTA: (SOLO si hay algo urgente o contradictorio; si no hay nada, escribí exactamente "ninguna")

Moneda: pesos colombianos (COP). Hablás directo a Jhon, como su asistente. NO listas de datos crudos, una conclusión.`;

// Arma un prompt JSON: estructura común (síntesis) + un array estructurado del dominio.
function jsonPrompt(rol: string, arrayKey: string, arraySchema: string, reglas: string): string {
  return `${rol}

Devolvé EXCLUSIVAMENTE un objeto JSON con esta forma (nada de texto fuera del JSON):
{
  "sintesis": "2-3 frases concretas",
  "estado": "🟢 o 🟡 o 🔴 + frase corta de estado",
  "proximo_paso": "1 acción concreta para Jhon",
  "alerta": "texto si hay algo urgente o contradictorio, o null",
  "${arrayKey}": [
${arraySchema}
  ]
}

${reglas}
Moneda: pesos colombianos (COP), enteros sin puntos ni símbolos. Si no hay datos claros, devolvé el array vacío.`;
}

type PoblarFn = (sb: SupabaseClient, personaId: number, data: any) => Promise<void>;
interface Analista { titulo: string; system: string; poblar?: PoblarFn }

export const ANALISTAS: Record<string, Analista> = {
  m1: { titulo: 'Análisis del Cliente', system:
`Sos el ANALISTA DE CLIENTE de Fábrica de Cortinas Girardot. Resumí QUIÉN es este cliente:
cómo se llama, cómo contactarlo, qué inmueble/conjunto tiene, de qué zona es, y su historia
con el negocio. Una ficha viva: lo esencial para saber con quién estamos tratando.` + FORMATO },

  m2: { titulo: 'Análisis Comercial', poblar: poblarCotizaciones, system:
jsonPrompt(
`Sos el ANALISTA COMERCIAL de Fábrica de Cortinas Girardot (persianas Safra). Analizá la
situación comercial Y estructurá las cotizaciones del cliente.`,
  'cotizaciones',
`    {
      "descripcion": "qué cotiza, corto (ej: Tapaluces blackout sala-comedor)",
      "estado": "propuesta|negociando|intencion_cierre|ganada|perdida|vencida|cancelada",
      "fecha": "YYYY-MM-DD o null",
      "total": número entero COP o null,
      "items": [
        { "sistema": "blackout|screen_solar|sheer_elegance|panel_japones|enrollables|verticales|peliculas_solares|toldos|motores|domotica|rieles|cadenillas",
          "ambiente": "sala, cocina, habitacion... o null",
          "ancho_m": número o null, "alto_m": número o null,
          "cantidad": entero, "color": "texto o null" }
      ]
    }`,
`CONSOLIDÁ: si el cliente pidió una cotización con varias ventanas, es UNA entrada con varios
items. NO crees una cotización por cada mensaje. Solo cotizaciones REALES (montos o pedidos
concretos), no saludos.`) },

  m3: { titulo: 'Análisis Financiero', poblar: poblarAbonos, system:
jsonPrompt(
`Sos el ANALISTA FINANCIERO de Fábrica de Cortinas Girardot. Analizá la plata del cliente
(cuánto cotizó, cuánto pagó, cuánto debe) Y estructurá los abonos / pagos recibidos.`,
  'abonos',
`    {
      "monto": número entero COP,
      "fecha": "YYYY-MM-DD o null",
      "metodo": "bancolombia|nequi|daviplata|efectivo|transferencia|tarjeta|consignacion",
      "referencia": "número de comprobante o null",
      "notas": "texto o null"
    }`,
`Incluí solo pagos REALES y confirmados (comprobantes, "ya transferí", "recibido"). NO incluyas
promesas de pago futuras.`) },

  m4: { titulo: 'Análisis Técnico', poblar: poblarMedidas, system:
jsonPrompt(
`Sos el ANALISTA TÉCNICO de Fábrica de Cortinas Girardot (persianas Safra). Analizá lo técnico
(sistema, riesgos, compatibilidades) Y estructurá las medidas mencionadas.`,
  'medidas',
`    {
      "ambiente": "sala, habitacion, cocina... o null",
      "ancho_m": número o null,
      "alto_m": número o null,
      "quien_midio": "cliente|tecnico|familiar o null",
      "notas": "texto o null"
    }`,
`Incluí solo medidas EXPLÍCITAS en la conversación (ej: "2.40 x 1.80"). NO inventes dimensiones.
Rango razonable: 0.3m a 8m.`) },

  m5: { titulo: 'Análisis Operativo', poblar: poblarTareas, system:
jsonPrompt(
`Sos el ANALISTA OPERATIVO de Fábrica de Cortinas Girardot. Analizá qué hay que HACER y CUÁNDO
Y estructurá las tareas pendientes del cliente.`,
  'tareas',
`    {
      "titulo": "qué hacer, corto (ej: Agendar instalación)",
      "descripcion": "detalle o null",
      "tipo": "llamar|enviar_cotizacion|confirmar_pago|pedir_ficha|agendar_instalacion|reclamar_proveedor|pedir_resena|otro",
      "fecha_vence": "YYYY-MM-DD o null",
      "prioridad": número entero 1 (baja) a 10 (urgente)
    }`,
`Incluí solo tareas REALES y accionables. NO dupliques la misma tarea. Consolidá.`) },

  m6: { titulo: 'Análisis de Postventa', poblar: poblarPostventa, system:
jsonPrompt(
`Sos el ANALISTA DE POSTVENTA de Fábrica de Cortinas Girardot. Analizá cómo quedó el cliente
después de la venta Y estructurá garantías y reclamos.`,
  'garantias',
`    {
      "descripcion": "qué falló o qué se reclama por garantía",
      "causa": "producto|instalacion|cliente|ambiente|tercero|construccion",
      "estado": "abierta|cerrada",
      "sistema": "código de sistema Safra o null"
    }`,
`Además del array "garantias", incluí un array "reclamos" con la forma:
  { "motivo": "cliente_molesto|garantia_mal_manejada|dano_costoso|publicacion_negativa|mala_resena|incumplimiento|otro",
    "severidad": "baja|media|alta|critica",
    "estado": "abierto|en_contencion|escalado|resuelto|cerrado_negativo",
    "detalle": "qué pasó, texto libre" }
Incluí solo garantías y reclamos REALES (fallas reportadas, quejas serias). Si no hay, arrays vacíos.`) },

  m7: { titulo: 'Análisis de Evidencias', system:
`Sos el ANALISTA DE EVIDENCIAS de Fábrica de Cortinas Girardot. Analizá qué evidencia documental
hay del cliente: fotos, comprobantes de pago, audios transcritos, documentos — y qué respalda cada cosa.` + FORMATO },
};

interface SintesisParseada {
  sintesis: string | null;
  estado: string | null;
  estado_semaforo: 'verde' | 'amarillo' | 'rojo';
  proximo_paso: string | null;
  alerta: string | null;
}

function parsear(texto: string): SintesisParseada {
  const get = (label: string, next: string): string | null => {
    const re = new RegExp(label + '\\s*:?\\s*([\\s\\S]*?)(?=' + next + ')', 'i');
    const m = texto.match(re);
    return m ? m[1].trim() : null;
  };
  // \\S* en vez del carácter acentuado: inmune a problemas de encoding del acento.
  const sintesis     = get('S\\S*NTESIS', 'ESTADO\\s*:');
  const estado       = get('ESTADO', 'PR\\S*XIMO\\s+PASO\\s*:');
  const proximo_paso = get('PR\\S*XIMO\\s+PASO', 'ALERTA\\s*:');
  let alerta         = get('ALERTA', '$');
  if (alerta && /^ningun/i.test(alerta.trim())) alerta = null;
  let semaforo: 'verde' | 'amarillo' | 'rojo' = 'verde';
  if (estado?.includes('🔴')) semaforo = 'rojo';
  else if (estado?.includes('🟡')) semaforo = 'amarillo';
  return {
    sintesis, proximo_paso, alerta, estado_semaforo: semaforo,
    estado: estado ? estado.replace(/[🟢🟡🔴]/g, '').trim() : null,
  };
}

/**
 * Genera las 7 síntesis de un cliente + la visión global de Junior, y las
 * guarda en `modulo_sintesis`. Los analistas estructurados además pueblan
 * sus tablas de negocio. Devuelve costo total y módulos OK.
 */
export async function sintetizarPersona(
  sb: SupabaseClient,
  personaId: number,
): Promise<{ ok: number; fallidos: number; costo_usd: number }> {
  const persona = (await sb.from('personas').select('nombre').eq('id', personaId).maybeSingle()).data;
  if (!persona) return { ok: 0, fallidos: 0, costo_usd: 0 };

  const proys = (await sb.from('proyectos').select('id').eq('persona_id', personaId)).data ?? [];
  const chats = proys.length
    ? (await sb.from('chats').select('id').in('proyecto_id', proys.map(p => p.id))).data ?? []
    : [];
  const chatIds = chats.map(c => c.id);
  const msgs = chatIds.length
    ? (await sb.from('mensajes')
        .select('direccion,tipo,texto,metadata,ts_canal')
        .in('chat_id', chatIds).is('deleted_at', null).order('ts_canal')).data ?? []
    : [];

  if (msgs.length === 0) return { ok: 0, fallidos: 0, costo_usd: 0 };

  const conversacion = msgs.map(m => {
    const quien = m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE';
    const t = m.texto || (m.metadata as any)?.ai_text || `[${m.tipo} sin texto]`;
    return `${quien}: ${String(t).replace(/\n/g, ' ').trim()}`;
  }).join('\n');

  const evts = (await sb.from('evento_pg')
    .select('agente_origen,confianza,payload')
    .eq('persona_id', personaId).not('agente_origen', 'is', null)).data ?? [];
  const utiles = evts.filter(e => {
    const r = ((e.payload as any)?.resumen ?? '').toLowerCase();
    return r && !/^0 |sin |no se |no extra|0 medidas|0 montos|^no /.test(r) && e.confianza !== 'RECHAZADO';
  });
  const datosAgentes = [...new Set(utiles.map(e => `[${e.agente_origen}] ${(e.payload as any)?.resumen}`))].join('\n');

  // Correcciones de Jhon — verdad prioritaria. El humano manda sobre el agente.
  const { data: correcciones } = await sb.from('correcciones_humanas')
    .select('modulo,hecho').eq('persona_id', personaId).eq('vigente', true)
    .order('created_at', { ascending: true });
  const bloqueCorrecciones = (correcciones && correcciones.length > 0)
    ? correcciones.map((c: any) => `- [${c.modulo ?? 'general'}] ${c.hecho}`).join('\n')
    : '(ninguno)';

  // Fecha de Colombia (America/Bogota), no UTC.
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const ctxComun = `HOY ES: ${hoy} — usá esta fecha SOLO para razonar internamente (qué venció,
qué falta). Toda fecha anterior a hoy ya VENCIÓ: si una instalación, tarea, pago o compromiso
tiene fecha pasada, tratalo como vencido/atrasado, NUNCA como pendiente futuro. Para los
eventos usá fechas absolutas (dd/mm/aaaa), nunca "el jueves" ni "esta semana".
PROHIBIDO escribir "hoy es...", "hoy ${hoy}" o la fecha de hoy dentro de tu síntesis — la
síntesis describe el ESTADO del cliente, no la fecha en que la generaste.

=== HECHOS CONFIRMADOS POR JHON (VERDAD PRIORITARIA — manda sobre todo lo demás) ===
${bloqueCorrecciones}

=== CONVERSACIÓN WHATSAPP ===
${conversacion}

=== LO QUE DETECTARON LOS AGENTES ===
${datosAgentes || '(nada relevante)'}`;

  let ok = 0, fallidos = 0, costo_usd = 0;

  for (const [modulo, cfg] of Object.entries(ANALISTAS)) {
    // Analistas estructurados (M2-M6): JSON + pueblan su tabla de dominio.
    if (cfg.poblar) {
      try {
        const r = await sintetizarEstructurado(sb, personaId, persona.nombre as string, ctxComun, modulo, cfg);
        costo_usd += r.costo_usd;
        if (r.ok) ok++; else fallidos++;
      } catch (e: any) { fallidos++; console.error(`[A_SINTESIS_${modulo}] ${e.message}`); }
      continue;
    }
    // Analistas textuales (M1, M7): solo conclusión redactada.
    try {
      const res = await deepseekChat({
        agente: `A_SINTESIS_${modulo.toUpperCase()}`,
        temperature: 0.3,
        messages: [
          { role: 'system', content: cfg.system },
          { role: 'user', content: `CLIENTE: ${persona.nombre}\n\n${ctxComun}\n\nGenerá tu análisis de este cliente.` },
        ],
      });
      costo_usd += res.costo_usd;
      const campos = parsear(res.contenido);
      const { error } = await sb.from('modulo_sintesis').upsert({
        persona_id: personaId, modulo,
        sintesis: campos.sintesis, estado: campos.estado, estado_semaforo: campos.estado_semaforo,
        proximo_paso: campos.proximo_paso, alerta: campos.alerta,
        generado_por: `A_SINTESIS_${modulo.toUpperCase()}`, modelo: res.modelo,
        tokens_in: res.tokens_in, tokens_out: res.tokens_out, costo_usd: res.costo_usd,
        generado_at: new Date().toISOString(),
      } as any, { onConflict: 'persona_id,modulo' });
      if (error) { fallidos++; console.error(`[A_SINTESIS_${modulo}] upsert: ${error.message}`); }
      else ok++;
    } catch (e: any) {
      fallidos++;
      console.error(`[A_SINTESIS_${modulo}] ${e.message}`);
    }
  }

  // Junior cierra: lee las 7 síntesis recién generadas y da la visión global.
  try {
    const j = await sintetizarJunior(sb, personaId);
    costo_usd += j.costo_usd;
    if (j.ok) ok++; else fallidos++;
  } catch (e: any) {
    fallidos++;
    console.error(`[A10_JUNIOR] ${e.message}`);
  }

  return { ok, fallidos, costo_usd };
}

/**
 * Analista estructurado: pide JSON al LLM, guarda la síntesis en
 * `modulo_sintesis` y delega el poblado de la tabla de dominio a `cfg.poblar`.
 */
async function sintetizarEstructurado(
  sb: SupabaseClient,
  personaId: number,
  nombre: string,
  ctxComun: string,
  modulo: string,
  cfg: Analista,
): Promise<{ ok: boolean; costo_usd: number }> {
  const tag = `A_SINTESIS_${modulo.toUpperCase()}`;
  const res = await deepseekChat({
    agente: tag,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: cfg.system },
      { role: 'user', content: `CLIENTE: ${nombre}\n\n${ctxComun}\n\nDevolvé el objeto JSON.` },
    ],
  });

  let data: any;
  try { data = JSON.parse(res.contenido); }
  catch { console.error(`[${tag}] JSON inválido del LLM`); return { ok: false, costo_usd: res.costo_usd }; }

  const estadoRaw: string = data.estado ?? '';
  let semaforo: 'verde' | 'amarillo' | 'rojo' = 'verde';
  if (estadoRaw.includes('🔴')) semaforo = 'rojo';
  else if (estadoRaw.includes('🟡')) semaforo = 'amarillo';
  const alerta = data.alerta && !/^ningun/i.test(String(data.alerta)) ? String(data.alerta) : null;

  const { error } = await sb.from('modulo_sintesis').upsert({
    persona_id: personaId, modulo,
    sintesis: data.sintesis ?? null,
    estado: estadoRaw.replace(/[🟢🟡🔴]/g, '').trim() || null,
    estado_semaforo: semaforo,
    proximo_paso: data.proximo_paso ?? null,
    alerta,
    generado_por: tag, modelo: res.modelo,
    tokens_in: res.tokens_in, tokens_out: res.tokens_out, costo_usd: res.costo_usd,
    generado_at: new Date().toISOString(),
  } as any, { onConflict: 'persona_id,modulo' });
  if (error) { console.error(`[${tag}] upsert sintesis: ${error.message}`); return { ok: false, costo_usd: res.costo_usd }; }

  if (cfg.poblar) {
    try { await cfg.poblar(sb, personaId, data); }
    catch (e: any) { console.error(`[${tag}] poblar: ${e.message}`); }
  }
  return { ok: true, costo_usd: res.costo_usd };
}

// ── Funciones de poblado: reemplazan los registros de agente del cliente ────
// con los que estructuró el analista. Los registros hechos a mano por Jhon
// (agente_origen NULL) nunca se tocan.

async function borrarDeAgente(sb: SupabaseClient, tabla: string, personaId: number, conItems?: string): Promise<void> {
  const viejos = (await sb.from(tabla).select('id').eq('persona_id', personaId).not('agente_origen', 'is', null)).data ?? [];
  if (viejos.length === 0) return;
  const ids = viejos.map((v: any) => v.id);
  if (conItems) await sb.from(conItems).delete().in('cotizacion_id', ids);
  await sb.from(tabla).delete().in('id', ids);
}

async function poblarCotizaciones(sb: SupabaseClient, personaId: number, data: any): Promise<void> {
  const cots = Array.isArray(data.cotizaciones) ? data.cotizaciones : [];
  const proy = (await sb.from('proyectos').select('id,ambito').eq('persona_id', personaId).limit(1)).data?.[0];
  await borrarDeAgente(sb, 'cotizaciones', personaId, 'cotizacion_items');

  const hoy = new Date().toISOString().slice(0, 10);
  for (const c of cots) {
    const total = typeof c.total === 'number' ? c.total : 0;
    const { data: row, error } = await sb.from('cotizaciones').insert({
      proyecto_id: proy?.id ?? null, persona_id: personaId, ambito: proy?.ambito ?? 'comercial',
      estado: c.estado ?? 'propuesta', fecha: c.fecha ?? hoy,
      subtotal: total, total,
      notas: c.descripcion ?? null,
      agente_origen: 'A_SINTESIS_M2', shadow: false,
    } as any).select('id').single();
    if (error || !row) { console.error(`[A_SINTESIS_M2] insert cotizacion: ${error?.message ?? 'sin data'}`); continue; }

    const items = Array.isArray(c.items) ? c.items : [];
    if (items.length > 0) {
      const rows = items.map((it: any, idx: number) => ({
        cotizacion_id: row.id,
        sistema_safra_codigo: SISTEMAS_SAFRA.has(it.sistema) ? it.sistema : null,
        ambiente: it.ambiente ?? null,
        ancho_m: typeof it.ancho_m === 'number' ? it.ancho_m : null,
        alto_m: typeof it.alto_m === 'number' ? it.alto_m : null,
        cantidad: typeof it.cantidad === 'number' ? it.cantidad : 1,
        color: it.color ?? null, orden: idx,
        agente_origen: 'A_SINTESIS_M2', shadow: false,
      }));
      const { error: ei } = await sb.from('cotizacion_items').insert(rows as any);
      if (ei) console.error(`[A_SINTESIS_M2] insert items: ${ei.message}`);
    }
  }
}

async function poblarAbonos(sb: SupabaseClient, personaId: number, data: any): Promise<void> {
  const abonos = Array.isArray(data.abonos) ? data.abonos : [];
  await borrarDeAgente(sb, 'abonos', personaId);
  const hoy = new Date().toISOString().slice(0, 10);
  for (const a of abonos) {
    if (typeof a.monto !== 'number' || a.monto <= 0) continue;
    const { error } = await sb.from('abonos').insert({
      persona_id: personaId, monto: a.monto, fecha: a.fecha ?? hoy,
      metodo: METODOS_PAGO.has(a.metodo) ? a.metodo : 'transferencia',
      referencia: a.referencia ?? null, notas: a.notas ?? null,
      estado_validacion: 'pendiente', agente_origen: 'A_SINTESIS_M3', shadow: false,
    } as any);
    if (error) console.error(`[A_SINTESIS_M3] insert abono: ${error.message}`);
  }
}

async function poblarMedidas(sb: SupabaseClient, personaId: number, data: any): Promise<void> {
  const medidas = Array.isArray(data.medidas) ? data.medidas : [];
  await borrarDeAgente(sb, 'medidas', personaId);
  for (const m of medidas) {
    if (typeof m.ancho_m !== 'number' && typeof m.alto_m !== 'number') continue;
    const { error } = await sb.from('medidas').insert({
      persona_id: personaId, etapa: 'cliente',
      ancho_m: typeof m.ancho_m === 'number' ? m.ancho_m : null,
      alto_m: typeof m.alto_m === 'number' ? m.alto_m : null,
      quien_midio: m.quien_midio ?? null,
      notas: [m.ambiente, m.notas].filter(Boolean).join(' · ') || null,
      agente_origen: 'A_SINTESIS_M4', shadow: false,
    } as any);
    if (error) console.error(`[A_SINTESIS_M4] insert medida: ${error.message}`);
  }
}

async function poblarTareas(sb: SupabaseClient, personaId: number, data: any): Promise<void> {
  const tareas = Array.isArray(data.tareas) ? data.tareas : [];
  const proy = (await sb.from('proyectos').select('id').eq('persona_id', personaId).limit(1)).data?.[0];
  await borrarDeAgente(sb, 'tareas', personaId);
  for (const t of tareas) {
    if (!t.titulo) continue;
    const prioridad = typeof t.prioridad === 'number'
      ? Math.max(1, Math.min(10, Math.round(t.prioridad))) : 5;
    const { error } = await sb.from('tareas').insert({
      persona_id: personaId, proyecto_id: proy?.id ?? null,
      titulo: String(t.titulo), descripcion: t.descripcion ?? null,
      tipo: TIPOS_TAREA.has(t.tipo) ? t.tipo : 'otro', fecha_vence: t.fecha_vence ?? null,
      prioridad, asignado_a: 'jhon', origen: 'agente',
      agente_origen: 'A_SINTESIS_M5', shadow: false,
    } as any);
    if (error) console.error(`[A_SINTESIS_M5] insert tarea: ${error.message}`);
  }
}

async function poblarPostventa(sb: SupabaseClient, personaId: number, data: any): Promise<void> {
  const garantias = Array.isArray(data.garantias) ? data.garantias : [];
  const reclamos = Array.isArray(data.reclamos) ? data.reclamos : [];

  await borrarDeAgente(sb, 'garantias', personaId);
  for (const g of garantias) {
    if (!g.descripcion) continue;
    const { error } = await sb.from('garantias').insert({
      persona_id: personaId,
      causa_codigo: CAUSAS_GARANTIA.has(g.causa) ? g.causa : 'producto',
      estado: g.estado === 'cerrada' ? 'cerrada' : 'abierta',
      sistema_safra_codigo: SISTEMAS_SAFRA.has(g.sistema) ? g.sistema : null,
      notas: g.descripcion ?? null,
      agente_origen: 'A_SINTESIS_M6', shadow: false,
    } as any);
    if (error) console.error(`[A_SINTESIS_M6] insert garantia: ${error.message}`);
  }

  await borrarDeAgente(sb, 'reclamos_sensibles', personaId);
  for (const r of reclamos) {
    if (!r.motivo && !r.detalle) continue;
    const { error } = await sb.from('reclamos_sensibles').insert({
      persona_id: personaId,
      motivo: MOTIVOS_RECLAMO.has(r.motivo) ? r.motivo : 'otro',
      severidad: ['baja', 'media', 'alta', 'critica'].includes(r.severidad) ? r.severidad : 'media',
      estado: ESTADOS_RECLAMO.has(r.estado) ? r.estado : 'abierto',
      notas: r.detalle ?? r.notas ?? null,
      agente_origen: 'A_SINTESIS_M6', shadow: false,
    } as any);
    if (error) console.error(`[A_SINTESIS_M6] insert reclamo: ${error.message}`);
  }
}

const JUNIOR_SYSTEM =
`Sos JUNIOR, el asistente personal de Jhon, dueño de Fábrica de Cortinas Girardot.
Te paso los 7 análisis de un cliente — uno por área (Cliente, Comercial, Financiero,
Técnico, Operativo, Postventa, Evidencias). Tu trabajo es darle a Jhon la VISIÓN GLOBAL:
la foto completa del cliente en pocas frases. Qué es lo más importante AHORA, qué priorizar.
NO repitas los 7 análisis uno por uno — integralos en una conclusión de alto nivel.

El ESTADO global debe reflejar lo PEOR que esté pasando: si hay áreas en rojo, la visión
global NO puede ser verde. Verde solo si todo marcha bien.` + FORMATO;

/**
 * Junior — lee las 7 síntesis de módulo de un cliente y produce la visión global.
 * Se guarda en modulo_sintesis con modulo='junior'. Corre después de los 7 analistas.
 */
export async function sintetizarJunior(
  sb: SupabaseClient,
  personaId: number,
): Promise<{ ok: boolean; costo_usd: number }> {
  const persona = (await sb.from('personas').select('nombre').eq('id', personaId).maybeSingle()).data;
  if (!persona) return { ok: false, costo_usd: 0 };

  const { data: sints } = await sb.from('modulo_sintesis')
    .select('modulo,sintesis,estado,proximo_paso,alerta')
    .eq('persona_id', personaId)
    .in('modulo', ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  if (!sints || sints.length === 0) return { ok: false, costo_usd: 0 };

  const NOMBRE: Record<string, string> = {
    m1: 'CLIENTE', m2: 'COMERCIAL', m3: 'FINANCIERO', m4: 'TÉCNICO',
    m5: 'OPERATIVO', m6: 'POSTVENTA', m7: 'EVIDENCIAS',
  };
  const bloques = sints
    .sort((a, b) => a.modulo.localeCompare(b.modulo))
    .map(s => `### ${NOMBRE[s.modulo] ?? s.modulo}
${s.sintesis ?? '(sin síntesis)'}
Estado: ${s.estado ?? '—'}${s.proximo_paso ? `\nPróximo paso: ${s.proximo_paso}` : ''}${s.alerta ? `\n⚠ Alerta: ${s.alerta}` : ''}`)
    .join('\n\n');

  const res = await deepseekChat({
    agente: 'A10_JUNIOR',
    temperature: 0.3,
    messages: [
      { role: 'system', content: JUNIOR_SYSTEM },
      { role: 'user', content: `CLIENTE: ${persona.nombre}\n\n=== LOS 7 ANÁLISIS DE ÁREA ===\n${bloques}\n\nDame la visión global de este cliente.` },
    ],
  });
  const campos = parsear(res.contenido);
  const { error } = await sb.from('modulo_sintesis').upsert({
    persona_id: personaId, modulo: 'junior',
    sintesis: campos.sintesis, estado: campos.estado, estado_semaforo: campos.estado_semaforo,
    proximo_paso: campos.proximo_paso, alerta: campos.alerta,
    generado_por: 'A10_JUNIOR', modelo: res.modelo,
    tokens_in: res.tokens_in, tokens_out: res.tokens_out, costo_usd: res.costo_usd,
    generado_at: new Date().toISOString(),
  } as any, { onConflict: 'persona_id,modulo' });
  if (error) { console.error(`[A10_JUNIOR] upsert: ${error.message}`); return { ok: false, costo_usd: res.costo_usd }; }
  return { ok: true, costo_usd: res.costo_usd };
}
