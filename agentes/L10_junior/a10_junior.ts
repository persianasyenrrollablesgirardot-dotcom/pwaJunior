/**
 * A10_JUNIOR — asistente personal de Jhon.
 *
 * Jhon habla con este agente desde su celular vía WhatsApp para consultar
 * cosas del negocio en tiempo real:
 *   - "Cuánto me debe María González?"
 *   - "Qué tareas tengo pendientes hoy?"
 *   - "Cuántas cotizaciones abiertas tengo?"
 *   - "Mostrame los reclamos pendientes"
 *   - "Cuál fue mi venta este mes?"
 *
 * DIFERENCIAS CRÍTICAS CON OTROS AGENTES:
 *   - El "cliente" de A10_JUNIOR es JHON, no clientes finales.
 *   - Lee BD AGREGADA del negocio (cartera, cotizaciones, tareas, etc.).
 *   - SOLO se invoca si el chat es del propio Jhon (ámbito interno_equipo).
 *   - NO escribe a tablas operativas, solo lee.
 *
 * REGLAS DURAS:
 *   - R-001 anti-alucinación: cada dato en la respuesta DEBE estar en
 *     payload.datos_citados (array de "campo=valor" o "tabla.id.campo=valor").
 *   - NO inventes montos, fechas o nombres.
 *   - Si no encontraste la info → admitir "no encuentro X en mis datos".
 *
 * tipo_evento='inferencia'. Tope $0.10/invocación (más alto por contexto grande).
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

interface ResumenNegocio {
  tareas_pendientes_hoy: number;
  tareas_pendientes_total: number;
  cotizaciones_abiertas: number;
  cartera_total_cop: number;
  garantias_abiertas: number;
  reclamos_abiertos: number;
  produccion_en_curso: number;
  instalaciones_proxima_semana: number;
  ventas_mes_actual_cop: number;
}

interface PersonaConsultada {
  id: number;
  nombre: string | null;
  alias: string | null;
  ciudad: string | null;
  cotizaciones_abiertas: number;
  cartera_pendiente_cop: number;
  ultimo_mensaje_dias_atras: number | null;
  tareas_pendientes: number;
}

interface DatosA10Junior {
  pregunta_jhon: MensajeCtx;
  resumen_negocio: ResumenNegocio;
  personas_consultadas: PersonaConsultada[];      // si la pregunta menciona alguien
  tareas_hoy: { id: number; titulo: string; vence: string | null; prioridad: number }[];
}

const TIPOS_CONSULTA = [
  'saldo_persona', 'estado_cotizacion', 'tareas_pendientes',
  'resumen_mes', 'garantias_abiertas', 'reclamos_abiertos',
  'produccion', 'instalaciones', 'estado_persona', 'otro',
] as const;
type TipoConsulta = typeof TIPOS_CONSULTA[number];

interface RespuestaJuniorOutput {
  respuesta_whatsapp: string;
  tipo_consulta: TipoConsulta;
  entidades_consultadas: string[];        // ['persona_id=13', 'cotizacion=42']
  datos_citados: string[];                // ['cartera.cot42.saldo=350000', 'tareas_hoy.count=3']
  ambiguedad: boolean;                    // true si la pregunta es vaga
  observacion_para_jhon: string | null;
}

const N_PERSONAS_MATCH = 5;

export const a10JuniorHooks: AgenteHooks<DatosA10Junior> = {
  async cargarContexto(sb, params) {
    // 1. Pregunta de Jhon (el mensaje del evento)
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal')
      .eq('id', params.evento_id)
      .single();
    const msgIdPrincipal: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? null;

    let preguntaJhon: MensajeCtx | null = null;
    if (msgIdPrincipal) {
      const { data: m } = await sb.from('mensajes')
        .select('canal_msg_id, direccion, texto, ts_canal')
        .eq('chat_id', params.chat_id)
        .eq('canal_msg_id', msgIdPrincipal)
        .is('deleted_at', null)
        .maybeSingle();
      if (m?.texto) preguntaJhon = { canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto, ts_canal: m.ts_canal };
    }
    if (!preguntaJhon) {
      const { data: msgs } = await sb.from('mensajes')
        .select('canal_msg_id, direccion, texto, ts_canal')
        .eq('chat_id', params.chat_id)
        .is('deleted_at', null)
        .not('texto', 'is', null)
        .lte('ts_canal', evt?.ts_canal ?? new Date().toISOString())
        .order('ts_canal', { ascending: false })
        .limit(1);
      const m = msgs?.[0];
      if (!m?.texto) throw new ValidacionError('R-contexto',
        `evento ${params.evento_id} sin mensaje con texto`);
      preguntaJhon = { canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto, ts_canal: m.ts_canal };
    }

    // 2. Resumen agregado del negocio (paralelo)
    const hoyISO = new Date().toISOString().slice(0, 10);
    const inicioMes = new Date(); inicioMes.setDate(1);
    const inicioMesISO = inicioMes.toISOString().slice(0, 10);
    const finProx = new Date(); finProx.setDate(finProx.getDate() + 7);
    const finProxISO = finProx.toISOString().slice(0, 10);

    const [
      { count: tareasHoy },
      { count: tareasTotal },
      { count: cotsAbiertas },
      cartera,
      { count: gtAbiertas },
      { count: rcAbiertos },
      { count: prodEnCurso },
      { count: instProx },
      ventas,
    ] = await Promise.all([
      sb.from('tareas').select('id', { count: 'exact', head: true })
        .eq('completada', false).eq('fecha_vence', hoyISO).is('deleted_at', null),
      sb.from('tareas').select('id', { count: 'exact', head: true })
        .eq('completada', false).is('deleted_at', null),
      sb.from('cotizaciones').select('id', { count: 'exact', head: true })
        .in('estado', ['propuesta', 'negociando', 'intencion_cierre']).is('deleted_at', null),
      sb.from('vw_cartera').select('deuda_total'),
      sb.from('garantias').select('id', { count: 'exact', head: true })
        .in('estado', ['abierta', 'en_diagnostico', 'en_reparacion']).is('deleted_at', null),
      sb.from('reclamos_sensibles').select('id', { count: 'exact', head: true })
        .in('estado', ['abierto', 'en_contencion', 'escalado']).is('deleted_at', null),
      sb.from('produccion_orden').select('id', { count: 'exact', head: true })
        .in('estado', ['pedido_proveedor', 'en_produccion']).is('deleted_at', null),
      sb.from('instalaciones').select('id', { count: 'exact', head: true })
        .gte('fecha_programada', hoyISO).lte('fecha_programada', finProxISO).is('deleted_at', null),
      sb.from('cotizaciones').select('total')
        .eq('estado', 'ganada').gte('fecha', inicioMesISO).is('deleted_at', null),
    ]);

    const carteraTotal = (cartera.data ?? []).reduce((s: number, r: any) => s + Number(r.deuda_total ?? 0), 0);
    const ventasMes = (ventas.data ?? []).reduce((s: number, r: any) => s + Number(r.total ?? 0), 0);

    const resumen: ResumenNegocio = {
      tareas_pendientes_hoy: tareasHoy ?? 0,
      tareas_pendientes_total: tareasTotal ?? 0,
      cotizaciones_abiertas: cotsAbiertas ?? 0,
      cartera_total_cop: carteraTotal,
      garantias_abiertas: gtAbiertas ?? 0,
      reclamos_abiertos: rcAbiertos ?? 0,
      produccion_en_curso: prodEnCurso ?? 0,
      instalaciones_proxima_semana: instProx ?? 0,
      ventas_mes_actual_cop: ventasMes,
    };

    // 3. Si la pregunta menciona algún nombre, buscar candidatos
    //    Heurística simple: buscar palabras con mayúscula >=4 chars y matchear
    //    contra personas.nombre/alias.
    const personasConsultadas: PersonaConsultada[] = [];
    const palabras = preguntaJhon.texto.match(/\b[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{3,}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)?/g) ?? [];
    const candidatos = palabras.slice(0, 3);  // máx 3 nombres en la pregunta
    if (candidatos.length > 0) {
      for (const c of candidatos) {
        const { data: ps } = await sb.from('personas')
          .select('id, nombre, alias, ciudad')
          .or(`nombre.ilike.%${c}%,alias.ilike.%${c}%`)
          .is('deleted_at', null)
          .limit(N_PERSONAS_MATCH);
        for (const p of ps ?? []) {
          if (personasConsultadas.some(pc => pc.id === p.id)) continue;
          // Cargar datos relacionados de esta persona
          const [{ count: cotsAb }, cartPersona, ultMsg, { count: tarPend }] = await Promise.all([
            sb.from('cotizaciones').select('id', { count: 'exact', head: true })
              .eq('persona_id', p.id).in('estado', ['propuesta', 'negociando', 'intencion_cierre']).is('deleted_at', null),
            sb.from('cotizaciones').select('saldo')
              .eq('persona_id', p.id).gt('saldo', 0).is('deleted_at', null),
            sb.from('mensajes').select('ts_canal, chats!inner(persona_id_dueno)')
              .eq('chats.persona_id_dueno', p.id).is('deleted_at', null)
              .order('ts_canal', { ascending: false }).limit(1),
            sb.from('tareas').select('id', { count: 'exact', head: true })
              .eq('persona_id', p.id).eq('completada', false).is('deleted_at', null),
          ]);
          const carteraPP = (cartPersona.data ?? []).reduce((s: number, r: any) => s + Number(r.saldo ?? 0), 0);
          const diasUlt = ultMsg.data?.[0]
            ? Math.floor((Date.now() - new Date(ultMsg.data[0].ts_canal).getTime()) / (1000 * 60 * 60 * 24))
            : null;
          personasConsultadas.push({
            id: p.id, nombre: p.nombre, alias: p.alias, ciudad: p.ciudad,
            cotizaciones_abiertas: cotsAb ?? 0,
            cartera_pendiente_cop: carteraPP,
            ultimo_mensaje_dias_atras: diasUlt,
            tareas_pendientes: tarPend ?? 0,
          });
          if (personasConsultadas.length >= N_PERSONAS_MATCH) break;
        }
      }
    }

    // 4. Tareas de HOY (top 10)
    const { data: tareasHoyData } = await sb.from('tareas')
      .select('id, titulo, fecha_vence, prioridad')
      .eq('completada', false).eq('fecha_vence', hoyISO).is('deleted_at', null)
      .order('prioridad', { ascending: false }).limit(10);

    return {
      pregunta_jhon: preguntaJhon,
      resumen_negocio: resumen,
      personas_consultadas: personasConsultadas,
      tareas_hoy: (tareasHoyData ?? []).map((t: any) => ({
        id: t.id, titulo: t.titulo, vence: t.fecha_vence, prioridad: t.prioridad,
      })),
    };
  },

  construirPrompt(datos, agente) {
    const resumenStr = JSON.stringify(datos.resumen_negocio, null, 2);
    const personasStr = datos.personas_consultadas.length === 0
      ? '(la pregunta no menciona personas específicas o no se encontraron en BD)'
      : JSON.stringify(datos.personas_consultadas, null, 2);
    const tareasStr = datos.tareas_hoy.length === 0
      ? '(no hay tareas para hoy)'
      : JSON.stringify(datos.tareas_hoy, null, 2);

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A10_JUNIOR, asistente personal de Jhon (dueño de Persianas Girardot).
Jhon te escribe desde su celular vía WhatsApp para preguntarte cosas del negocio.

ESTILO DE RESPUESTA:
  - Tono cálido pero conciso. Jhon está en movimiento, leyendo desde el celular.
  - Usá MONEDA en COP con formato $850.000.
  - Mencioná nombres de personas si la consulta los involucra.
  - Si hay alerta importante (reclamos abiertos, deuda alta), mencionala
    aunque la pregunta no lo pida explícitamente.
  - NO uses emojis excesivos. Profesional pero amable.

ANTI-ALUCINACIÓN — CRÍTICO:
  - Cada NÚMERO, FECHA o NOMBRE que cites en respuesta_whatsapp DEBE estar
    listado en payload.datos_citados con formato "campo=valor".
  - NO inventes. Si la BD no tiene el dato → "no encuentro X en mis datos,
    necesitás que lo registremos primero".
  - Los datos que tenés son SOLO los que están abajo. No accedes a más.

TIPOS DE CONSULTA (catálogo cerrado):
  ${TIPOS_CONSULTA.join(', ')}

CÁLCULO MECÁNICO de "confianza" (NO opinión — derivación determinista):
  - ambiguedad=true (no podés determinar a qué se refiere)  → DUDOSO
  - ambiguedad=false (respondiste con datos claros)          → INFERIDO
  - NUNCA uses CONFIRMADO: tu respuesta SIEMPRE va al buzón de Jhon
    para que él la apruebe antes de actuar (no se manda automáticamente).

DATOS DISPONIBLES:

  Resumen general del negocio:
${resumenStr}

  Personas que parecen mencionadas en la pregunta (vacío si no se mencionan):
${personasStr}

  Tareas pendientes para HOY (${datos.tareas_hoy.length}):
${tareasStr}

PREGUNTA DE JHON:
  "${datos.pregunta_jhon.texto}"

PROCESO:
  1. Identificá tipo_consulta (uno del catálogo).
  2. Identificá entidades involucradas (personas, cotizaciones, etc).
  3. Buscá los datos en lo disponible.
  4. Generá respuesta clara con esos datos.
  5. Listá los datos_citados (cada número/nombre que mencionás).
  6. Si la pregunta es ambigua (no podés determinar a qué se refiere) →
     ambiguedad=true + pedile clarificación.

Salida JSON EXACTA:
{
  "tipo_evento": "inferencia",
  "confianza": "INFERIDO",
  "payload": {
    "respuesta": {
      "respuesta_whatsapp": "María González tiene $350.000 pendientes del saldo de su cotización. Última actividad: hace 12 días.",
      "tipo_consulta": "saldo_persona",
      "entidades_consultadas": ["persona_id=13"],
      "datos_citados": ["personas[13].cartera_pendiente_cop=350000", "personas[13].ultimo_mensaje_dias_atras=12"],
      "ambiguedad": false,
      "observacion_para_jhon": null
    },
    "resumen": "Respondí saldo de María González ($350.000)."
  },
  "evidencia_msg_ids": ["${datos.pregunta_jhon.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Pregunta de Jhon:
"${datos.pregunta_jhon.texto}"

Respondéle usando solo los datos disponibles arriba.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    const r: RespuestaJuniorOutput = p?.respuesta;
    if (!r || typeof r !== 'object') {
      throw new ValidacionError('R-esquema', 'payload.respuesta debe ser objeto');
    }
    if (typeof r.respuesta_whatsapp !== 'string' || r.respuesta_whatsapp.trim().length < 5) {
      throw new ValidacionError('R-esquema', 'respuesta_whatsapp vacía o muy corta');
    }
    if (!TIPOS_CONSULTA.includes(r.tipo_consulta as any)) {
      throw new ValidacionError('R-esquema', `tipo_consulta inválido: ${r.tipo_consulta}`);
    }
    if (!Array.isArray(r.entidades_consultadas)) {
      throw new ValidacionError('R-esquema', 'entidades_consultadas debe ser array');
    }
    if (!Array.isArray(r.datos_citados)) {
      throw new ValidacionError('R-esquema', 'datos_citados debe ser array');
    }
    if (typeof r.ambiguedad !== 'boolean') {
      throw new ValidacionError('R-esquema', 'ambiguedad debe ser boolean');
    }

    // Coherencia mecánica: confianza derivada de ambiguedad
    const esperada = r.ambiguedad ? 'DUDOSO' : 'INFERIDO';
    if (out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('R-confianza',
        'A10_JUNIOR nunca usa CONFIRMADO (siempre al buzón para que Jhon apruebe)');
    }
    if (out.confianza !== esperada) {
      throw new ValidacionError('R-confianza',
        `confianza=${out.confianza} pero ambiguedad=${r.ambiguedad} exige ${esperada}`);
    }

    // Anti-alucinación de NÚMEROS: si la respuesta cita un monto en COP
    // ($X.XXX), ese número (sin formato) debe estar en algún campo conocido.
    const numerosEnRespuesta = Array.from(r.respuesta_whatsapp.matchAll(/\$\s*([\d.,]+)/g))
      .map(m => Number(m[1].replace(/[.,]/g, '')))
      .filter(n => n > 0 && Number.isFinite(n));

    const numerosDisponibles = new Set<number>();
    numerosDisponibles.add(datos.resumen_negocio.cartera_total_cop);
    numerosDisponibles.add(datos.resumen_negocio.ventas_mes_actual_cop);
    for (const pc of datos.personas_consultadas) {
      if (pc.cartera_pendiente_cop) numerosDisponibles.add(pc.cartera_pendiente_cop);
    }

    for (const n of numerosEnRespuesta) {
      const cerca = Array.from(numerosDisponibles).some(d => Math.abs(d - n) <= 100);
      if (!cerca) {
        // Solo error si el número parece grande (>1000) — números chicos pueden
        // ser counts (5 tareas, 3 cotizaciones) que están en el resumen
        if (n >= 1000) {
          throw new ValidacionError('R-anti-alucinacion',
            `monto $${n.toLocaleString('es-CO')} en respuesta no aparece en datos disponibles`);
        }
      }
    }

    // R-anti-alucinacion: normalizar evidencia_msg_ids tolerando prefijos LLM
    if (datos.pregunta_jhon.canal_msg_id && Array.isArray(out.evidencia_msg_ids)) {
      const disponibles = new Set<string>([datos.pregunta_jhon.canal_msg_id]);
      const resueltos: string[] = [];
      for (const cit of out.evidencia_msg_ids) {
        if (!cit) continue;
        const real = resolverMsgId(cit, disponibles);
        if (real) resueltos.push(real);
      }
      out.evidencia_msg_ids = resueltos.length > 0 ? resueltos : [datos.pregunta_jhon.canal_msg_id];
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // En shadow: nada. En productivo, A10_JUNIOR podría mandar la respuesta
    // automáticamente a Jhon vía WhatsApp (con su confirmación). Por ahora,
    // la respuesta va al buzón con prioridad 9 (Jhon la ve inmediato).
    return;
  },
};
