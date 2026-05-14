/**
 * A3_GRAFO — detector de menciones a TERCEROS para grafo social.
 *
 * Cuando el cliente dice "el administrador Don Manuel", "mi vecino Carlos", "Marik
 * que les recomendó" → A3_GRAFO captura cada tercero con su rol inferido y trata
 * de matchearlo contra personas ya conocidas en BD.
 *
 * Base del grafo social. Usado después por:
 *   - A4_REFERIDOS: si un tercero mencionado por X después escribe pidiendo
 *     cotización, se vincula como referido de X.
 *   - A8_REPUT: identificar quién es apto para pedirle reseña.
 *
 * Distinto de A1_ENTIDADES:
 *   - A1_ENTIDADES extrae todo nombre propio sin distinguir su rol.
 *   - A3_GRAFO específicamente identifica TERCEROS (no el cliente, no el negocio)
 *     y les asigna rol + intenta matchear con personas existentes.
 *
 * Roles válidos del campo `rol_inferido` (sugeridos por schema):
 *   tecnico, vecino, familiar, instalador, admin, referido, desconocido
 *
 * Tope $0.02/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

const ROLES_INFERIDOS = ['tecnico', 'vecino', 'familiar', 'instalador', 'admin', 'referido', 'desconocido'] as const;
type RolInferido = typeof ROLES_INFERIDOS[number];

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

interface DatosA3Grafo {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  persona_actual_id: number;
  persona_actual_nombre: string | null;
  personas_existentes: PersonaCompacta[];
}

interface MencionTerceroOutput {
  nombre_mencionado: string;
  rol_inferido: RolInferido;
  persona_referida_id: number | null;
  contexto: string;                  // frase exacta donde se la menciona
  confianza_mencion: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  msg_id: string;
  observacion?: string;
}

const N_CONTEXTO = 5;
const N_PERSONAS_MAX = 200;

export const a3GrafoHooks: AgenteHooks<DatosA3Grafo> = {
  async cargarContexto(sb, params) {
    // Persona actual (para excluirla y para mostrar su nombre al LLM)
    const { data: pAct } = await sb.from('personas')
      .select('id, nombre, alias')
      .eq('id', params.persona_id)
      .is('deleted_at', null)
      .single();
    const personaActualNombre = pAct?.nombre ?? pAct?.alias ?? null;

    // Otras personas (candidatos a match)
    const { data: otras } = await sb.from('personas')
      .select('id, nombre, alias, empresa')
      .neq('id', params.persona_id)
      .is('deleted_at', null)
      .limit(N_PERSONAS_MAX);

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
        canal_msg_id: m.canal_msg_id,
        direccion: m.direccion as any,
        texto: m.texto!,
        ts_canal: m.ts_canal,
      }));

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      persona_actual_id: params.persona_id,
      persona_actual_nombre: personaActualNombre,
      personas_existentes: (otras ?? []) as PersonaCompacta[],
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 200)}`
        ).join('\n');

    const personasStr = datos.personas_existentes.length === 0
      ? '(no hay otras personas registradas)'
      : datos.personas_existentes
          .map(p => `${p.id}|${p.nombre ?? ''}|${p.alias ?? ''}|${p.empresa ?? ''}`)
          .join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A3_GRAFO. Detectás menciones a TERCEROS en el mensaje del chat.

DEFINICIÓN DE TERCERO:
  - NO es el CLIENTE actual del chat (persona_actual = "${datos.persona_actual_nombre ?? `id ${datos.persona_actual_id}`}").
  - NO es el NEGOCIO (Persianas Girardot).
  - Es otra persona que el cliente menciona: vecino, esposa, técnico externo,
    administrador del conjunto, amigo que les recomendó, etc.

Para cada tercero detectado, devolvés:
  - nombre_mencionado: tal cual aparece ("Don Manuel", "Marik", "mi esposa Marta")
  - rol_inferido (enum cerrado): tecnico, vecino, familiar, instalador, admin,
    referido, desconocido
  - persona_referida_id: SI el nombre matchea con una persona del catálogo de
    personas existentes (lista provista), incluí su id. Si NO matchea o dudás → null.
  - contexto: frase exacta donde se la menciona (extraída del texto)
  - confianza_mencion:
       CONFIRMADO → mención clara con rol explícito ("el administrador Don Manuel")
       INFERIDO   → mención con rol inferible ("Marta, mi esposa, dice...")
       DUDOSO     → nombre suelto sin pistas de rol

Reglas duras:
  - NO incluyas al cliente actual ni al negocio.
  - NO incluyas nombres de empresas/instituciones (esos son entidades, los maneja A1_ENTIDADES).
  - R-001 anti-alucinación: cada mención cita el msg_id donde aparece.
  - Anti-contaminación: NO uses nombres de otros clientes que recuerdes;
    solo personas mencionadas en el mensaje analizado.
  - persona_referida_id, si no null, DEBE estar en la lista de candidatos
    (NO inventes ids).
  - Solo proponer persona_referida_id si el nombre coincide razonablemente
    (CONFIRMADO o INFERIDO con match alto). Si dudás → null.

CATÁLOGO DE PERSONAS EXISTENTES (id|nombre|alias|empresa):
${personasStr}

Salida JSON EXACTA:
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "menciones_terceros": [
      {
        "nombre_mencionado": "Don Manuel",
        "rol_inferido": "admin",
        "persona_referida_id": null,
        "contexto": "el administrador Don Manuel me dijo que sí",
        "confianza_mencion": "CONFIRMADO",
        "msg_id": "XYZ"
      }
    ],
    "resumen": "1 tercero mencionado: Don Manuel (admin)"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — menciones_terceros=[] (sin terceros mencionados):
    out.confianza = "CONFIRMADO"  (no buzón)

  caso B — menciones_terceros.length ≥ 1:
    out.confianza = "INFERIDO"   (al buzón, Jhon revisa terceros del grafo)

PROHIBIDO ABSOLUTO:
  ✗ menciones_terceros=[] con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ menciones_terceros ≥ 1 con out.confianza = "CONFIRMADO" → ERROR

Si NO hay terceros (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "menciones_terceros": [],
    "resumen": "No se mencionan terceros en el mensaje"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO RECIENTE DEL CHAT ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${datos.mensaje_actual.texto}

Detectá las menciones a TERCEROS en el MENSAJE A ANALIZAR. Recordá: NO incluir
al cliente actual ni al negocio. Si una mención aparece SOLO en contexto y no en
el mensaje analizado, NO la incluyas.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!Array.isArray(p?.menciones_terceros)) {
      throw new ValidacionError('schema', 'payload.menciones_terceros debe ser array');
    }
    const idsValidos = new Set<number>(datos.personas_existentes.map(c => c.id));
    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);

    for (const m of p.menciones_terceros as MencionTerceroOutput[]) {
      if (typeof m.nombre_mencionado !== 'string' || m.nombre_mencionado.trim().length === 0) {
        throw new ValidacionError('schema', `mención sin nombre_mencionado: ${JSON.stringify(m)}`);
      }
      if (!ROLES_INFERIDOS.includes(m.rol_inferido)) {
        throw new ValidacionError('schema',
          `rol_inferido inválido: ${JSON.stringify(m.rol_inferido)} (válidos: ${ROLES_INFERIDOS.join(',')})`);
      }
      if (m.persona_referida_id !== null && m.persona_referida_id !== undefined) {
        if (!Number.isInteger(m.persona_referida_id) || !idsValidos.has(m.persona_referida_id)) {
          throw new ValidacionError('coherencia-a3gr',
            `persona_referida_id=${m.persona_referida_id} no está en el catálogo`);
        }
        if (m.persona_referida_id === datos.persona_actual_id) {
          throw new ValidacionError('coherencia-a3gr', 'persona_referida_id no puede ser el cliente actual del chat');
        }
      }
      if (typeof m.contexto !== 'string') {
        throw new ValidacionError('schema', `mención sin contexto: ${JSON.stringify(m)}`);
      }
      if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(m.confianza_mencion)) {
        throw new ValidacionError('schema', `confianza_mencion inválida: ${m.confianza_mencion}`);
      }
      const realMsgId = resolverMsgId(m.msg_id, msgIdsValidos);
      if (!realMsgId) {
        throw new ValidacionError('R-anti-alucinacion',
          `mención cita msg_id '${m.msg_id}' que no está en mensaje o contexto`);
      }
      m.msg_id = realMsgId;
    }

    // Coherencia mecánica out.confianza ↔ menciones
    if (p.menciones_terceros.length === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a3gr',
        `menciones_terceros=[] requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.menciones_terceros.length > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a3gr',
        `menciones_terceros ≥ 1 requiere out.confianza='INFERIDO'`);
    }

    // Resolver evidencia_msg_ids con tolerancia
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
    const menciones = Array.isArray(p.menciones_terceros) ? p.menciones_terceros as MencionTerceroOutput[] : [];
    if (menciones.length === 0) return;

    // Insertar PRIMERA mención shadow=true. Si hay más, agregar nota explicativa.
    const m = menciones[0];
    const contextoNota = menciones.length > 1
      ? `${m.contexto} · (Detectadas ${menciones.length} menciones; esta es la primera. Ver detalle del buzón.)`
      : m.contexto;
    const { data: row, error } = await sb.from('personas_mencionadas').insert({
      persona_id: ctx.persona_id,
      evento_pg_id: ctx.evento_id,
      nombre_mencionado: m.nombre_mencionado,
      rol_inferido: m.rol_inferido,
      persona_referida_id: m.persona_referida_id ?? null,
      contexto: contextoNota,
      agente_origen: ctx.agente.codigo,
      confianza: m.confianza_mencion,
      shadow: true,
    } as any).select('id').single();
    if (error || !row) {
      throw new Error(`A3_GRAFO insert mencion: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'persona_mencionada', entidad_id: row.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
