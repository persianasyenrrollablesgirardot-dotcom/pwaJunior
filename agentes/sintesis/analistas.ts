/**
 * Analistas de síntesis — la capa que SINTETIZA (sobre la capa que extrae).
 *
 * Los 31 agentes extractores sacan datos crudos mensaje por mensaje. Estos 7
 * analistas leen TODO lo de un cliente y redactan UNA conclusión por módulo
 * (M1..M7) → tabla `modulo_sintesis`. El Visor muestra esa conclusión arriba
 * de cada módulo, en vez de tablas crudas.
 *
 * Se ejecutan por CLIENTE (no por mensaje): el worker llama `sintetizarPersona`
 * al final de un ciclo de pipeline, para cada cliente con actividad nueva.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { deepseekChat } from '../lib/llm.js';

const FORMATO = `

Devolvé EXACTAMENTE este formato, una sección por línea:

SÍNTESIS: (2-3 frases concretas)
ESTADO: (emoji semáforo 🟢 o 🟡 o 🔴 + frase corta de estado)
PRÓXIMO PASO: (1 acción concreta que Jhon debe hacer)
ALERTA: (SOLO si hay algo urgente o contradictorio; si no hay nada, escribí exactamente "ninguna")

Moneda: pesos colombianos (COP). Hablás directo a Jhon, como su asistente. NO listas de datos crudos, una conclusión.`;

interface Analista { titulo: string; system: string }

export const ANALISTAS: Record<string, Analista> = {
  m1: { titulo: 'Análisis del Cliente', system:
`Sos el ANALISTA DE CLIENTE de Fábrica de Cortinas Girardot. Resumí QUIÉN es este cliente:
cómo se llama, cómo contactarlo, qué inmueble/conjunto tiene, de qué zona es, y su historia
con el negocio. Una ficha viva: lo esencial para saber con quién estamos tratando.` + FORMATO },
  m2: { titulo: 'Análisis Comercial', system:
`Sos el ANALISTA COMERCIAL de Fábrica de Cortinas Girardot. Analizá la situación comercial:
qué pidió el cliente, qué cotizaciones hay, en qué etapa del embudo está, objeciones,
si está cerca de cerrar o se enfrió.` + FORMATO },
  m3: { titulo: 'Análisis Financiero', system:
`Sos el ANALISTA FINANCIERO de Fábrica de Cortinas Girardot. Analizá la plata: qué se cotizó,
cuánto pagó el cliente, cuánto debe, abonos, comprobantes, saldos pendientes. ¿Está al día o debe?` + FORMATO },
  m4: { titulo: 'Análisis Técnico', system:
`Sos el ANALISTA TÉCNICO de Fábrica de Cortinas Girardot (persianas Safra). Analizá lo técnico:
qué sistema/producto quiere, qué medidas hay, riesgos de instalación, compatibilidades, advertencias.` + FORMATO },
  m5: { titulo: 'Análisis Operativo', system:
`Sos el ANALISTA OPERATIVO de Fábrica de Cortinas Girardot. Analizá qué hay que HACER y CUÁNDO:
instalaciones programadas, tareas pendientes, fechas comprometidas, agenda, rutas.` + FORMATO },
  m6: { titulo: 'Análisis de Postventa', system:
`Sos el ANALISTA DE POSTVENTA de Fábrica de Cortinas Girardot. Analizá cómo quedó el cliente
después de la venta: garantías, reclamos, satisfacción, si está apto para pedirle reseña en Google.` + FORMATO },
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
 * Genera las 7 síntesis de un cliente y las guarda en `modulo_sintesis`.
 * Devuelve costo total y cuántos módulos se sintetizaron OK.
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

  const cots   = (await sb.from('cotizaciones').select('estado,fecha,total').eq('persona_id', personaId)).data ?? [];
  const abonos = (await sb.from('abonos').select('monto,fecha,metodo,estado_validacion').eq('persona_id', personaId)).data ?? [];
  const tareas = (await sb.from('tareas').select('titulo,tipo,fecha_vence,prioridad').eq('persona_id', personaId)).data ?? [];

  const ctxComun = `=== CONVERSACIÓN WHATSAPP ===
${conversacion}

=== LO QUE DETECTARON LOS AGENTES ===
${datosAgentes || '(nada relevante)'}

=== REGISTROS EN SISTEMA ===
Cotizaciones: ${cots.length ? JSON.stringify(cots) : 'ninguna'}
Abonos: ${abonos.length ? JSON.stringify(abonos) : 'ninguno'}
Tareas: ${tareas.length ? JSON.stringify(tareas) : 'ninguna'}`;

  let ok = 0, fallidos = 0, costo_usd = 0;

  for (const [modulo, cfg] of Object.entries(ANALISTAS)) {
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

const JUNIOR_SYSTEM =
`Sos JUNIOR, el asistente personal de Jhon, dueño de Fábrica de Cortinas Girardot.
Te paso los 7 análisis de un cliente — uno por área (Cliente, Comercial, Financiero,
Técnico, Operativo, Postventa, Evidencias). Tu trabajo es darle a Jhon la VISIÓN GLOBAL:
la foto completa del cliente en pocas frases. Qué es lo más importante AHORA, qué hay
que priorizar. NO repitas los 7 análisis uno por uno — integralos en una conclusión
de alto nivel, como el gerente que lee los reportes de sus 7 jefes de área.` + FORMATO;

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
