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
// Números de cuentas del negocio — aparecen en TODAS las cotizaciones como
// medios de pago (Nequi/Daviplata). NO son teléfonos de clientes; si los
// extraemos como tel de un cliente, queda mal asignado (caso reportado: Rocio
// Romero terminó con +573105879410 que es el Nequi de Lorena Morales).
const TELEFONOS_NEGOCIO = new Set([
  '3202381865',  // Daviplata
  '3105879410',  // Nequi (Sandra Lorena Morales)
]);
// Compat: algunos sitios viejos referencian TELEFONO_NEGOCIO singular.
const TELEFONO_NEGOCIO = '3202381865';
// Si un número aparece dentro de una ventana cercana a estos keywords, es un
// número de cuenta/transferencia, NO el tel del cliente. Lo descartamos.
const KEYWORDS_PAGO_CERCA = /\b(nequi|daviplata|bancolombia|davivienda|cuenta\b|transferenc|consign|abonar|pagar\s+a|cta\.?\s+(ahorr|corr)|n[uú]mero\s+de\s+cuenta|medios?\s+de\s+pago)/i;

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
Y estructurá las tareas operativas pendientes del cliente (visitas, instalaciones, mantenimientos,
seguimientos).`,
  'tareas',
`    {
      "titulo": "qué hacer, corto (ej: Agendar instalación)",
      "descripcion": "detalle o null",
      "tipo": "llamar|enviar_cotizacion|confirmar_pago|pedir_ficha|agendar_instalacion|reclamar_proveedor|pedir_resena|otro",
      "fecha_vence": "YYYY-MM-DD o null",
      "prioridad": número entero 1 (baja) a 10 (urgente)
    }`,
`Incluí solo tareas REALES y accionables que surjan de la conversación de WhatsApp o de los
HECHOS CONFIRMADOS por Jhon. NO dupliques tareas obvias (el sistema tiene anti-duplicado por
título, pero igual sé conciso). Si el cliente NO es comercial o el caso está CERRADO ("paz y
salvo", "instalación completada"), devolvé tareas: []. Las tareas que Jhon crea por chat con
Junior (origen='chat') tienen prioridad — no las pisés generando duplicados.`) },

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
  const persona = (await sb.from('personas').select('nombre,notas,ambito_principal').eq('id', personaId).maybeSingle()).data;
  if (!persona) return { ok: 0, fallidos: 0, costo_usd: 0 };

  const proys = (await sb.from('proyectos').select('id').eq('persona_id', personaId)).data ?? [];
  const chats = proys.length
    ? (await sb.from('chats').select('id').in('proyecto_id', proys.map(p => p.id))).data ?? []
    : [];
  const chatIds = chats.map(c => c.id);

  // GATE A2_NOCLIENTE — si A2 ya detectó que este chat NO es cliente real
  // (restaurante/spam/transporte/equivocado, con evidencia clara), NO gastamos
  // los ~8 LLM de síntesis. A2 es conservador (ante la mínima duda → es_cliente=true),
  // así que esto solo frena no-clientes confirmados. Reversible: si llega un mensaje
  // comercial o A2 cambia de opinión, la persona vuelve a sintetizarse.
  // (Cierra el hueco que el propio A2_NOCLIENTE dejó documentado: "suprimir agentes
  //  downstream — se integra al pipeline en versiones futuras".)
  if (chatIds.length > 0) {
    const { data: a2 } = await sb.from('evento_pg')
      .select('payload').eq('agente_origen', 'A2_NOCLIENTE')
      .in('chat_id', chatIds).order('ts_creado', { ascending: false }).limit(1);
    if ((a2?.[0]?.payload as any)?.es_cliente === false) {
      const sub = (a2![0].payload as any)?.subtipo_no_cliente ?? 'no-cliente';
      // colaborador / proveedor: SÍ sintetizar (Jhon necesita contexto; los prompts
      // ambito-aware lo encuadran con los roles invertidos/operativos).
      // restaurante / spam / transporte / encuesta / bot / equivocado / otro: skip.
      if (sub !== 'colaborador' && sub !== 'proveedor') {
        console.log(`[A_SINTESIS] persona ${personaId} saltada — A2_NOCLIENTE la marcó no-cliente (${sub}); no se gastan tokens de síntesis`);
        return { ok: 0, fallidos: 0, costo_usd: 0 };
      }
    }
  }

  const msgs = chatIds.length
    ? (await sb.from('mensajes')
        .select('direccion,tipo,texto,metadata,ts_canal')
        .in('chat_id', chatIds).is('deleted_at', null).order('ts_canal')).data ?? []
    : [];

  // Correcciones de Jhon — verdad prioritaria. El humano manda sobre el agente.
  const { data: correcciones } = await sb.from('correcciones_humanas')
    .select('modulo,hecho').eq('persona_id', personaId).eq('vigente', true)
    .order('created_at', { ascending: true });

  // Notas libres que Jhon escribió sobre este contacto. La UI promete que
  // "los agentes las leen antes de inferir" — acá se cumple. Verdad prioritaria.
  const { data: notasLibres } = await sb.from('notas_libres')
    .select('contenido').eq('persona_id', personaId)
    .is('deleted_at', null).order('ts_creado', { ascending: true });

  // Sin chat de WhatsApp Y sin correcciones Y sin notas → no hay nada para
  // analizar. Un contacto registrado a mano SÍ se sintetiza con lo que dictó Jhon.
  if (msgs.length === 0 && (!correcciones || correcciones.length === 0)
      && (!notasLibres || notasLibres.length === 0) && !persona.notas) {
    return { ok: 0, fallidos: 0, costo_usd: 0 };
  }

  // Extraer el teléfono del cliente de los mensajes / OCR de comprobantes.
  if (msgs.length > 0) await extraerTelefonoCliente(sb, personaId, msgs);

  // Ámbito de la persona → determina cómo etiquetar la conversación y el framing.
  const AMBITO_DESC: Record<string, string> = {
    comercial:        'CLIENTE del negocio (cotiza / compra persianas a Persianas Girardot).',
    proveedor:        'PROVEEDOR — NO es cliente. JHON le COMPRA insumos / productos. Roles invertidos: NEGOCIO=Jhon como comprador, OTRO=vendedor.',
    personal_familia: 'CONTACTO PERSONAL (familia) — NO es cliente. No aplicar flujo comercial.',
    personal_amigos:  'CONTACTO PERSONAL (amigo) — NO es cliente.',
    personal_otros:   'Contacto personal sin clasificar — probablemente NO es cliente.',
    interno_equipo:   'EQUIPO INTERNO (instalador / técnico / contadora del negocio) — NO es cliente. Jhon le ASIGNA tareas / le PAGA por trabajo hecho.',
  };
  const ambitoPersona = (persona.ambito_principal as string) ?? '';
  const ambitoCtx = AMBITO_DESC[ambitoPersona] ?? 'Sin clasificar.';
  // Etiqueta del rol OTRO en la conversación, según el ámbito (no hardcodear "CLIENTE").
  const ROL_OTRO: Record<string, string> = {
    comercial: 'CLIENTE', proveedor: 'PROVEEDOR',
    personal_familia: 'FAMILIA', personal_amigos: 'AMIGO', personal_otros: 'CONTACTO',
    interno_equipo: 'COLABORADOR',
  };
  const rolOtro = ROL_OTRO[ambitoPersona] ?? 'OTRO';

  // Cada mensaje va con SU fecha real de envío (ts_canal). Sin esto el analista
  // no puede resolver "el jueves" / "mañana" ni calcular qué venció — causa raíz
  // de los errores de fecha.
  const fechaMsg = (ts: string | null | undefined) => ts
    ? new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })
    : '????-??-??';
  const conversacion = msgs.length === 0
    ? '(este contacto todavía no tiene chat de WhatsApp — lo registró Jhon a mano; lo que se sabe de él está en los HECHOS CONFIRMADOS de abajo)'
    : msgs.map(m => {
        const quien = m.direccion === 'saliente' ? 'NEGOCIO' : rolOtro;
        const t = m.texto || (m.metadata as any)?.ai_text || `[${m.tipo} sin texto]`;
        return `[${fechaMsg(m.ts_canal)}] ${quien}: ${String(t).replace(/\n/g, ' ').trim()}`;
      }).join('\n');

  const evts = (await sb.from('evento_pg')
    .select('agente_origen,confianza,payload')
    .eq('persona_id', personaId).not('agente_origen', 'is', null)).data ?? [];
  const utiles = evts.filter(e => {
    const r = ((e.payload as any)?.resumen ?? '').toLowerCase();
    return r && !/^0 |sin |no se |no extra|0 medidas|0 montos|^no /.test(r) && e.confianza !== 'RECHAZADO';
  });
  const datosAgentes = [...new Set(utiles.map(e => `[${e.agente_origen}] ${(e.payload as any)?.resumen}`))].join('\n');

  const bloqueCorrecciones = (correcciones && correcciones.length > 0)
    ? correcciones.map((c: any) => `- [${c.modulo ?? 'general'}] ${c.hecho}`).join('\n')
    : '(ninguno)';

  const lineasNotas = [
    persona.notas ? `- ${persona.notas}` : null,
    ...((notasLibres ?? []).map((n: any) => `- ${n.contenido}`)),
  ].filter(Boolean);
  const bloqueNotas = lineasNotas.length > 0 ? lineasNotas.join('\n') : '(ninguna)';

  // Fecha de Colombia (America/Bogota), no UTC.
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const ctxComun = `HOY ES: ${hoy} — usá esta fecha SOLO para razonar internamente (qué venció,
qué falta). Toda fecha anterior a hoy ya VENCIÓ: si una instalación, tarea, pago o compromiso
tiene fecha pasada, tratalo como vencido/atrasado, NUNCA como pendiente futuro. Para los
eventos usá fechas absolutas (dd/mm/aaaa), nunca "el jueves" ni "esta semana".
PROHIBIDO escribir "hoy es...", "hoy ${hoy}" o la fecha de hoy dentro de tu síntesis — la
síntesis describe el ESTADO del cliente, no la fecha en que la generaste.

=== QUÉ ES ESTE CONTACTO (ámbito) ===
${ambitoCtx}

REGLAS DE ATRIBUCIÓN POR DIRECCIÓN DE MENSAJE (críticas — no las violes):
- Cada línea de la conversación tiene un emisor declarado (NEGOCIO o ${rolOtro}). NEGOCIO = Jhon escribiendo;
  ${rolOtro} = el contacto escribiendo. Atribuí cada acción a quien la dijo en su línea, no "al cliente"
  por default. Si NEGOCIO dijo "Donde le consigno", esa intención de pagar es de JHON, no del contacto.
- ❌ PROHIBIDO escribir cosas como "el contacto manifestó intención de pago" si esa frase la dijo NEGOCIO
  (línea saliente). Verificá la dirección antes de atribuir.
${ambitoPersona === 'proveedor' ? `
ROLES INVERTIDOS (este contacto es PROVEEDOR):
- NEGOCIO (Jhon) es el COMPRADOR. ${rolOtro} (el proveedor) es el VENDEDOR.
- Las cotizaciones que aparezcan son cotizaciones que el PROVEEDOR le envía a Jhon — son COSTOS para
  Persianas Girardot, NO ventas. NO las pueblas en la tabla cotizaciones (esa es de ventas del negocio).
- Los pagos van DESDE Jhon HACIA el proveedor. NO los registres como abonos del cliente.
- "Medidas" son las que JHON le especifica AL proveedor para que fabrique. NO las medidas de un cliente final.
- Síntesis correcta tipo: "Jhon le pidió cotización al proveedor X por Y, X cotizó Z, Jhon manifestó intención
  de pagar". NUNCA "el cliente cotizó / manifestó intención de pago".
` : ''}${ambitoPersona === 'interno_equipo' ? `
EQUIPO INTERNO (este contacto trabaja CON Jhon):
- Coordinación operativa: Jhon le asigna trabajo, el ${rolOtro} reporta avance / cobra por trabajo hecho.
- NO hay cotización ni venta entre las partes. Las menciones de plata son pagos de Jhon al colaborador
  por trabajo, o cobros que el colaborador hizo al cliente final EN NOMBRE del negocio.
- Síntesis correcta: "Jhon coordinó X con [nombre], reportó Y", NO "el cliente solicitó Z".
` : ''}Si este contacto NO es un cliente comercial, NO lo analices como comprador de persianas:
no inventes cotizaciones, abonos ni medidas EN LAS TABLAS DEL NEGOCIO. Ajustá tu síntesis a lo que
realmente es y, en los módulos comerciales que no apliquen, decí explícitamente que no corresponde.

=== NOTAS DEL HUMANO SOBRE ESTE CONTACTO (verdad prioritaria — las escribió Jhon a mano) ===
${bloqueNotas}

=== HECHOS CONFIRMADOS POR JHON (VERDAD PRIORITARIA — manda sobre todo lo demás) ===
${bloqueCorrecciones}

=== CONVERSACIÓN WHATSAPP (cada línea: [fecha del mensaje aaaa-mm-dd] QUIÉN: texto) ===
Usá la fecha de cada mensaje para resolver referencias relativas: "el jueves" / "mañana" /
"la próxima semana" son relativas a la fecha DE ESE mensaje. Una vez resuelta la fecha
absoluta del evento, compará contra HOY (${hoy}) para saber si ya venció.
${conversacion}

=== LO QUE DETECTARON LOS AGENTES ===
${datosAgentes || '(nada relevante)'}`;

  let ok = 0, fallidos = 0, costo_usd = 0;
  const propuestas: Record<string, any> = {};

  for (const [modulo, cfg] of Object.entries(ANALISTAS)) {
    // Analistas estructurados (M2-M6): JSON + pueblan su tabla de dominio.
    if (cfg.poblar) {
      try {
        const r = await sintetizarEstructurado(sb, personaId, persona.nombre as string, ctxComun, modulo, cfg);
        costo_usd += r.costo_usd;
        if (r.ok) { ok++; propuestas[modulo] = r.data; } else fallidos++;
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
          { role: 'user', content: `CONTACTO: ${persona.nombre} (${rolOtro})\n\n${ctxComun}\n\nGenerá tu análisis de este contacto según su ámbito.` },
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

  // Pasa las propuestas a Junior Auditor para que apruebe/rechace antes de poblar.
  const propuestasValidas = await auditarPropuestas(sb, personaId, persona.nombre as string, propuestas, bloqueCorrecciones);
  costo_usd += propuestasValidas.costo_usd;

  // Ejecutar poblado SOLO con propuestas válidas
  for (const [modulo, cfg] of Object.entries(ANALISTAS)) {
    if (cfg.poblar && propuestasValidas.data[modulo]) {
      try { await cfg.poblar(sb, personaId, propuestasValidas.data[modulo]); }
      catch (e: any) { console.error(`[A_SINTESIS_${modulo.toUpperCase()}] poblar: ${e.message}`); }
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
): Promise<{ ok: boolean; costo_usd: number; data?: any }> {
  const tag = `A_SINTESIS_${modulo.toUpperCase()}`;
  const res = await deepseekChat({
    agente: tag,
    temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: cfg.system },
      { role: 'user', content: `CONTACTO: ${nombre}\n\n${ctxComun}\n\nDevolvé el objeto JSON.` },
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

  return { ok: true, costo_usd: res.costo_usd, data };
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



/**
 * Pobla tareas del analista M5 — con anti-duplicado contra las tareas del chat.
 *
 * Lógica:
 *   1. Borra solo las tareas previas de M5 (`agente_origen='A_SINTESIS_M5'`) — las
 *      de Junior chat (`origen='chat'`) NO se tocan, son verdad de Jhon.
 *   2. Antes de insertar una propuesta nueva, verifica si ya hay tarea ACTIVA del
 *      chat con título similar (normalizado: lowercase, sin tildes, sin "los/las/
 *      el/la" filler). Si match → skip insert (la tarea del chat gana).
 *   3. Si no hay duplicado de chat, inserta la propuesta de M5.
 *
 * Reactivado en feat: re-habilitar M5→tareas con anti-duplicado (commit posterior a 2d9f130).
 */
function normalizarTitulo(t: string): string {
  return (t || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')      // sin tildes
    .replace(/[^\w\s]/g, ' ')                                 // sin puntuación
    .replace(/\b(el|la|los|las|de|del|al|a|en|para|por|un|una|con)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

async function poblarTareas(sb: SupabaseClient, personaId: number, data: any): Promise<void> {
  const tareas = Array.isArray(data.tareas) ? data.tareas : [];
  const proy = (await sb.from('proyectos').select('id').eq('persona_id', personaId).limit(1)).data?.[0];
  await borrarDeAgente(sb, 'tareas', personaId);

  // CIERRE CONSCIENTE (fix auditoría 2026-06-05): M5 opera por PERSONA y no conoce
  // el cierre por chat. Sin esto, tras la cascada de cierre (que completa las
  // tareas), el siguiente ciclo de síntesis RE-INSERTA tareas leyendo la misma
  // conversación → "caso cerrado con tareas vivas". Si TODOS los chats de la
  // persona están cerrados a mano (`cerrado_manual=true`, la señal autoritativa de
  // cierre en V2), no re-creamos: las viejas de M5 ya se borraron arriba.
  const { data: chks } = await sb.from('chat_checklist')
    .select('cerrado_manual').eq('persona_id', personaId);
  const casoCerrado = (chks?.length ?? 0) > 0 && chks!.every((c: any) => c.cerrado_manual === true);
  if (casoCerrado) {
    if (tareas.length) console.log(`[A_SINTESIS_M5] persona ${personaId}: caso cerrado → no re-creo ${tareas.length} tarea(s)`);
    return;
  }

  // Tareas activas del chat/manuales — NO se tocan, pero usamos sus títulos para
  // evitar que M5 cree duplicados conceptuales.
  const { data: tareasChat } = await sb.from('tareas')
    .select('titulo').eq('persona_id', personaId)
    .eq('completada', false).is('deleted_at', null)
    .not('agente_origen', 'eq', 'A_SINTESIS_M5');
  const titulosChat = new Set((tareasChat ?? []).map(t => normalizarTitulo(t.titulo as string)));

  for (const t of tareas) {
    if (!t.titulo) continue;
    const norm = normalizarTitulo(String(t.titulo));
    // Anti-duplicado: si Jhon ya dictó una tarea con título conceptualmente igual, skip.
    if (titulosChat.has(norm)) {
      console.log(`[A_SINTESIS_M5] skip duplicado "${t.titulo}" (ya existe tarea del chat con título similar)`);
      continue;
    }
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

/**
 * Extrae el teléfono del cliente de sus mensajes y del OCR de comprobantes.
 * Texto plano de la BD — no toca WhatsApp, no se rompe con sus updates.
 * Solo carga si la persona todavía no tiene teléfono (no pisa lo manual).
 */
async function extraerTelefonoCliente(sb: SupabaseClient, personaId: number, msgs: any[]): Promise<void> {
  const p = (await sb.from('personas').select('telefono_e164').eq('id', personaId).maybeSingle()).data;
  if (!p || p.telefono_e164) return;   // ya tiene teléfono → no tocar

  const re = /(?:\+?57[\s-]?)?(3\d{2}[\s-]?\d{3}[\s-]?\d{4})/g;
  const conteo = new Map<string, number>();
  for (const m of msgs) {
    // Solo mensajes ENTRANTES — el cliente reporta SU número, no Jhon. Procesar
    // salientes incluye las cotizaciones que mandamos con Nequi/Daviplata, y de
    // ahí salía el bug: el Nequi del negocio se asignaba como tel del cliente.
    if (m.direccion !== 'entrante') continue;
    const t = (m.texto || '') + ' ' + ((m.metadata as any)?.ai_text || '');
    for (const x of t.matchAll(re)) {
      const num = x[1].replace(/[\s-]/g, '');   // 10 dígitos: 3XXXXXXXXX
      if (num.length !== 10 || TELEFONOS_NEGOCIO.has(num)) continue;
      // Defensa adicional: si el cliente reenvía la cotización (forward del
      // catálogo de Jhon) o copia info de pago, descartar números que estén
      // dentro de una ventana de ±80 chars a keywords de pago (Nequi/cuenta).
      const idx = x.index ?? 0;
      const ventana = t.slice(Math.max(0, idx - 80), Math.min(t.length, idx + x[0].length + 80));
      if (KEYWORDS_PAGO_CERCA.test(ventana)) continue;
      conteo.set(num, (conteo.get(num) ?? 0) + 1);
    }
  }
  if (conteo.size === 0) return;

  const mejor = [...conteo.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const e164 = '+57' + mejor;
  const { error } = await sb.from('personas').update({ telefono_e164: e164 }).eq('id', personaId);
  if (error) console.error(`[telefono] persona ${personaId}: ${error.message}`);
  else console.log(`[telefono] persona ${personaId} → ${e164} (extraído de mensajes entrantes)`);
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


async function auditarPropuestas(
  sb: SupabaseClient,
  personaId: number,
  nombre: string,
  propuestas: Record<string, any>,
  bloqueCorrecciones: string
): Promise<{ costo_usd: number; data: Record<string, any> }> {
  if (Object.keys(propuestas).length === 0) return { costo_usd: 0, data: {} };

  const system = `Sos JUNIOR AUDITOR, el supervisor estricto de Fábrica de Cortinas Girardot.
Tu trabajo es revisar las propuestas generadas por los agentes analistas y FILTRAR todo lo que viole
las reglas de negocio o el sentido común, basándote en las instrucciones explícitas de Jhon.

=== HECHOS CONFIRMADOS POR JHON (VERDAD PRIORITARIA) ===
${bloqueCorrecciones}

REGLAS DE AUDITORÍA:
1. Si una cotización, tarea, medida, abono o garantía contradice la Verdad Prioritaria (ej. Jhon dice que X es proveedor y un analista le hizo una cotización de venta), ELIMÍNALA del JSON de respuesta.
2. Si los datos son imposibles (ej. medida de 15 metros), ELIMÍNALOS del JSON de respuesta.
3. Devuelve estrictamente un JSON con la misma estructura original, pero solo con los elementos APROBADOS.
Si todo un módulo está mal, devuélvelo vacío. Si hay errores críticos, anótalos en una propiedad "alertas_auditoria" (array de strings).`;

  const user = `CLIENTE: ${nombre}\n\nPROPUESTAS DE LOS ANALISTAS:\n${JSON.stringify(propuestas, null, 2)}\n\nDevuelve el JSON filtrado.`;

  const res = await deepseekChat({
    agente: 'JUNIOR_AUDITOR',
    temperature: 0.1,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });

  let data = propuestas;
  try {
    const parsed = JSON.parse(res.contenido);
    if (parsed) data = parsed;
    if (data.alertas_auditoria && Array.isArray(data.alertas_auditoria) && data.alertas_auditoria.length > 0) {
      console.log(`[JUNIOR_AUDITOR] Alertas detectadas para ${nombre}: `, data.alertas_auditoria);
      await sb.from('modulo_sintesis').upsert({
        persona_id: personaId, modulo: 'junior',
        alerta: data.alertas_auditoria.join(' | '),
        generado_por: 'JUNIOR_AUDITOR', modelo: res.modelo,
        generado_at: new Date().toISOString()
      } as any, { onConflict: 'persona_id,modulo' });
    }
  } catch (e) {
    console.error(`[JUNIOR_AUDITOR] Error parseando respuesta: ${e}`);
  }

  return { costo_usd: res.costo_usd, data };
}
