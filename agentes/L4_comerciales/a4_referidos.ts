/**
 * A4_REFERIDOS — detector bidireccional de relaciones de referido comercial.
 *
 * DOS ESCENARIOS QUE CUBRE:
 *
 *   A) Cliente ACTUAL menciona REFERIDO POTENCIAL:
 *      "Le voy a recomendar a mi vecina Sofía"
 *      "Mi cuñado vio las persianas y quiere cotización"
 *      → propone registrar el referido potencial (sin crear persona) + tarea
 *        de seguimiento para Jhon ("contactar si Sofía escribe").
 *
 *   B) Cliente ACTUAL viene REFERIDO POR otra persona:
 *      "Vengo de parte de María González, ella me los recomendó"
 *      "Me dio su número Don Carlos, mi vecino"
 *      → identifica al referente y, si matchea con persona existente,
 *        propone setear persona_actual.referido_por_persona_id = id.
 *
 * Distinto de A3_GRAFO:
 *   - A3_GRAFO captura TODOS los terceros mencionados (esposa, admin, etc.)
 *   - A4_REFERIDOS se especializa en la relación COMERCIAL de referido:
 *     señales explícitas de recomendación o venir-de-parte-de.
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

interface PersonaCompacta {
  id: number;
  nombre: string | null;
  alias: string | null;
  empresa: string | null;
}

interface DatosA4Referidos {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  persona_actual_id: number;
  persona_actual_nombre: string | null;
  persona_actual_ya_referida: boolean;       // ya tiene referido_por_persona_id seteado
  personas_candidatas: PersonaCompacta[];     // catálogo para matchear referente
}

interface ReferidoPotencialOutput {
  nombre_referido: string;
  rol_relacion: string;             // 'vecino' | 'familiar' | 'amigo' | etc.
  contexto: string;
  confianza_referido: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  msg_id: string;
}

interface ReferenteOutput {
  nombre_referente: string;
  persona_referente_id: number | null;
  contexto: string;
  confianza_referente: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  msg_id: string;
}

interface TareaSeguimientoOutput {
  tipo: 'llamar' | 'enviar_cotizacion' | 'otro';
  titulo: string;
  descripcion: string;
  fecha_vence: string | null;
  prioridad: number;
  asignado_a: string;
}

const N_CONTEXTO = 5;

export const a4ReferidosHooks: AgenteHooks<DatosA4Referidos> = {
  async cargarContexto(sb, params) {
    // Persona actual + flag de si ya tiene referente
    const { data: pAct } = await sb.from('personas')
      .select('id, nombre, referido_por_persona_id')
      .eq('id', params.persona_id)
      .is('deleted_at', null)
      .single();

    // Otras personas (catálogo para matchear referente)
    const { data: otras } = await sb.from('personas')
      .select('id, nombre, alias, empresa')
      .neq('id', params.persona_id)
      .is('deleted_at', null)
      .limit(200);

    // Mensaje + contexto
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
      .filter(m => m.texto && m.texto.trim().length > 0)
      .map(m => ({
        canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto!, ts_canal: m.ts_canal,
      }));

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      persona_actual_id: params.persona_id,
      persona_actual_nombre: pAct?.nombre ?? null,
      persona_actual_ya_referida: !!pAct?.referido_por_persona_id,
      personas_candidatas: (otras ?? []) as PersonaCompacta[],
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 220)}`
        ).join('\n');

    const candidatosStr = datos.personas_candidatas.length === 0
      ? '(no hay otras personas en BD)'
      : datos.personas_candidatas
          .map(p => `${p.id}|${p.nombre ?? ''}|${p.alias ?? ''}|${p.empresa ?? ''}`)
          .join('\n');

    const referidaStr = datos.persona_actual_ya_referida
      ? '⚠ esta persona YA tiene referido_por_persona_id seteado; no propongas otro (a menos que el cliente lo corrija explícitamente).'
      : 'esta persona NO tiene referente registrado todavía.';

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A4_REFERIDOS. Detectás relaciones de REFERIDO COMERCIAL en el mensaje.

DOS DIRECCIONES POSIBLES:

  A) "cliente menciona referido potencial" — el CLIENTE actual recomienda a OTRO
     a Persianas Girardot. Señales:
       "le voy a recomendar a", "le dije a mi vecina/amiga", "mi cuñado quiere",
       "a mi mamá le gustó", "se lo voy a contar a"
     → llená referidos_propuestos[] con cada persona nueva mencionada.

  B) "cliente viene referido" — el CLIENTE actual escribe por primera vez
     diciendo que viene de parte de otra persona. Señales:
       "vengo de parte de", "X me los recomendó", "me dio su número",
       "soy vecino/amigo/conocido de X que tiene persianas suyas"
     → llená referente_propuesto con la persona que lo refirió.
       Si el nombre del referente matchea con alguien en CATÁLOGO de personas,
       incluí persona_referente_id; si no, dejalo null.

REGLAS:
  - SOLO contás como referido si la señal es CLARA (recomendación / venir-de-parte-de).
  - Mención casual de un tercero SIN intención de referido → NO contás
    (ese caso es de A3_GRAFO, no de A4_REFERIDOS).
  - Si el mensaje es del NEGOCIO (saliente) → referidos_propuestos=[] y
    referente_propuesto=null (no aplica a nosotros).
  - persona_referente_id, si no null, DEBE estar en el catálogo (NO inventes id).
  - msg_id en CADA referido / referente DEBE ser el canal_msg_id REAL del
    mensaje analizado (lo te paso abajo), NO la string "undefined" ni vacío.

CATÁLOGO DE PERSONAS (id|nombre|alias|empresa):
${candidatosStr}

Contexto:
  - Persona actual: "${datos.persona_actual_nombre ?? `id ${datos.persona_actual_id}`}"
  - ${referidaStr}

TAREA DE SEGUIMIENTO (opcional):
  Si A) y el referido propuesto es ALTAMENTE probable (confianza CONFIRMADO),
  proponé una tarea para Jhon: "llamar/contactar referido potencial".
  Si B) y el referente fue identificado: NO tarea (el vínculo es directo).
  Si ambos NO aplican o son DUDOSO → tarea_seguimiento=null.

Salida JSON EXACTA:
{
  "tipo_evento": "inferencia",
  "confianza": "INFERIDO",
  "payload": {
    "hay_referidos": true,
    "referidos_propuestos": [
      {
        "nombre_referido": "Sofía",
        "rol_relacion": "vecino",
        "contexto": "le voy a recomendar a mi vecina Sofía",
        "confianza_referido": "CONFIRMADO",
        "msg_id": "XYZ"
      }
    ],
    "referente_propuesto": null,
    "tarea_seguimiento": {
      "tipo": "llamar",
      "titulo": "Seguimiento referido potencial (Sofía vecina de Carlos)",
      "descripcion": "Carlos prometió recomendar a su vecina Sofía. Contactar para confirmar interés.",
      "fecha_vence": "2026-05-22",
      "prioridad": 5,
      "asignado_a": "jhon"
    },
    "resumen": "Cliente refiere a Sofía como vecino potencial"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — hay_referidos=false (sin señales de referido):
    out.confianza = "CONFIRMADO"  (no buzón)

  caso B — hay_referidos=true:
    out.confianza = "INFERIDO"   (al buzón, Jhon revisa vínculo)

PROHIBIDO ABSOLUTO:
  ✗ hay_referidos=false con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ hay_referidos=true con out.confianza = "CONFIRMADO" → ERROR

Si no hay referidos (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "inferencia",
  "confianza": "CONFIRMADO",
  "payload": {
    "hay_referidos": false,
    "referidos_propuestos": [],
    "referente_propuesto": null,
    "tarea_seguimiento": null,
    "resumen": "No se detectaron señales de referido"
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
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${datos.mensaje_actual.texto}

Identificá:
  1. ¿Hay un REFERIDO POTENCIAL (cliente actual menciona alguien a quien recomendará)?
  2. ¿Hay un REFERENTE (cliente actual viene de parte de alguien)?
Si nada de eso pasa, devolvé hay_referidos=false.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.hay_referidos !== 'boolean') {
      throw new ValidacionError('schema', 'hay_referidos debe ser boolean');
    }
    if (!Array.isArray(p?.referidos_propuestos)) {
      throw new ValidacionError('schema', 'referidos_propuestos debe ser array');
    }
    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);
    const idsValidos = new Set<number>(datos.personas_candidatas.map(c => c.id));

    for (const r of p.referidos_propuestos as ReferidoPotencialOutput[]) {
      if (typeof r.nombre_referido !== 'string' || r.nombre_referido.trim().length === 0) {
        throw new ValidacionError('schema', `referido sin nombre_referido: ${JSON.stringify(r)}`);
      }
      if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(r.confianza_referido)) {
        throw new ValidacionError('schema', `confianza_referido inválida: ${r.confianza_referido}`);
      }
      const real = resolverMsgId(r.msg_id, msgIdsValidos);
      if (!real) {
        throw new ValidacionError('R-anti-alucinacion',
          `referido cita msg_id '${r.msg_id}' que no está en mensaje o contexto`);
      }
      r.msg_id = real;
    }

    if (p.referente_propuesto !== null && p.referente_propuesto !== undefined) {
      const ref: ReferenteOutput = p.referente_propuesto;
      if (typeof ref.nombre_referente !== 'string' || ref.nombre_referente.trim().length === 0) {
        throw new ValidacionError('schema', 'referente_propuesto sin nombre_referente');
      }
      if (ref.persona_referente_id !== null && ref.persona_referente_id !== undefined) {
        if (!idsValidos.has(ref.persona_referente_id)) {
          throw new ValidacionError('coherencia-a4rf',
            `persona_referente_id=${ref.persona_referente_id} no está en catálogo`);
        }
        if (ref.persona_referente_id === datos.persona_actual_id) {
          throw new ValidacionError('coherencia-a4rf',
            'persona_referente_id no puede ser igual al cliente actual');
        }
      }
      if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(ref.confianza_referente)) {
        throw new ValidacionError('schema', `confianza_referente inválida: ${ref.confianza_referente}`);
      }
      const real = resolverMsgId(ref.msg_id, msgIdsValidos);
      if (!real) {
        throw new ValidacionError('R-anti-alucinacion',
          `referente cita msg_id '${ref.msg_id}' que no está en mensaje o contexto`);
      }
      ref.msg_id = real;
    }

    if (p.tarea_seguimiento !== null && p.tarea_seguimiento !== undefined) {
      const t: TareaSeguimientoOutput = p.tarea_seguimiento;
      if (!['llamar', 'enviar_cotizacion', 'otro'].includes(t.tipo)) {
        throw new ValidacionError('schema', `tarea.tipo inválido: ${t.tipo}`);
      }
      if (typeof t.titulo !== 'string' || t.titulo.trim().length === 0) {
        throw new ValidacionError('schema', 'tarea.titulo vacío');
      }
      if (t.fecha_vence !== null && t.fecha_vence !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t.fecha_vence)) {
          throw new ValidacionError('schema', `fecha_vence inválida: ${t.fecha_vence}`);
        }
      }
      if (typeof t.prioridad !== 'number' || t.prioridad < 1 || t.prioridad > 10) {
        throw new ValidacionError('schema', `prioridad fuera de [1,10]: ${t.prioridad}`);
      }
    }

    if (p.hay_referidos) {
      const tieneAlguno = (p.referidos_propuestos.length > 0) || (p.referente_propuesto != null);
      if (!tieneAlguno) {
        throw new ValidacionError('coherencia-a4rf',
          'hay_referidos=true pero ni referidos_propuestos[] ni referente_propuesto tienen contenido');
      }
    } else {
      if (p.referidos_propuestos.length > 0 || p.referente_propuesto != null) {
        throw new ValidacionError('coherencia-a4rf',
          'hay_referidos=false pero los campos referidos_propuestos/referente_propuesto tienen contenido');
      }
    }

    // Coherencia mecánica out.confianza ↔ hay_referidos
    if (!p.hay_referidos && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a4rf',
        `hay_referidos=false requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.hay_referidos && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a4rf',
        `hay_referidos=true requiere out.confianza='INFERIDO' (Jhon revisa vínculo)`);
    }

    // Resolver evidencia_msg_ids con tolerancia
    if (Array.isArray(out.evidencia_msg_ids)) {
      for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
        const r = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
        if (r) out.evidencia_msg_ids[i] = r;
      }
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // A4_REFERIDOS no escribe a tabla. A3_GRAFO ya inserta menciones en
    // personas_mencionadas. La propuesta de seteo de referido_por_persona_id
    // queda en el buzón para que Jhon decida desde UI.
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
