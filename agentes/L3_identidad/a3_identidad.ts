/**
 * A3_IDENTIDAD — detector de duplicados de persona.
 *
 * Asume que IdentidadService (worker_pipeline_v2 ciclo identidad) ya resolvió
 * el jid del mensaje → persona. A3_IDENTIDAD recibe persona_id ya seteado y su
 * trabajo es OTRO: detectar si esta persona es duplicado de alguien más en BD.
 *
 * Razones típicas de duplicado:
 *   - Cliente cambió de WhatsApp (jid nuevo) y la IA creó persona nueva.
 *   - Cliente con dos teléfonos (línea casa + celular).
 *   - Nombre escrito distinto ("Maria González" vs "María Gonzalez").
 *   - Empresa con varios contactos pero misma persona detrás.
 *
 * Filosofía CONSERVADORA:
 *   - Solo propone fusión si match en ≥2 CAMPOS FUERTES (telefono / email / jid)
 *     o si match exacto de nombre + empresa + ciudad.
 *   - Fusionar es destructivo: en producción habrá `personas_merge_log` con
 *     reversible_hasta 30 días, pero igual no queremos proponer fusiones
 *     dudosas y saturar el buzón.
 *
 * Output:
 *   candidatos_fusion = [] si no hay duplicados claros.
 *   confianza=CONFIRMADO solo si ≥2 campos fuertes en match.
 *
 * Tope $0.02/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

interface PersonaCompacta {
  id: number;
  nombre: string | null;
  alias: string | null;
  empresa: string | null;
  rol: string | null;
  telefono_e164: string | null;
  email: string | null;
  jid: string | null;
  cedula: string | null;
  ciudad: string | null;
}

interface DatosA3Identidad {
  persona_actual: PersonaCompacta;
  candidatos_personas: PersonaCompacta[];     // todas las demás personas
  mensaje_actual_id: string;
}

interface CandidatoFusionOutput {
  persona_id_candidata: number;
  campos_match: string[];        // ['telefono_e164', 'nombre', 'email']
  score: number;                 // 0-1
  confianza_fusion: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  razon: string;
}

const N_PERSONAS_MAX = 200;     // si la BD crece, ajustar paginación

export const a3IdentidadHooks: AgenteHooks<DatosA3Identidad> = {
  async cargarContexto(sb, params) {
    // 1. Persona actual con todos los campos identitarios
    const { data: pAct, error: pErr } = await sb.from('personas')
      .select('id, nombre, alias, empresa, rol, telefono_e164, email, jid, cedula, ciudad')
      .eq('id', params.persona_id)
      .is('deleted_at', null)
      .single();
    if (pErr || !pAct) throw new Error(`persona ${params.persona_id} no encontrada: ${pErr?.message}`);

    // 2. Otras personas (excepto la actual y las soft-deleted)
    const { data: otras } = await sb.from('personas')
      .select('id, nombre, alias, empresa, rol, telefono_e164, email, jid, cedula, ciudad')
      .neq('id', params.persona_id)
      .is('deleted_at', null)
      .limit(N_PERSONAS_MAX);

    // 3. msg_id del evento (para evidencia válida). Fallback: último mensaje
    // del chat si el evento no tiene evidencia_ids (P-005).
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    let msgIdPrincipal: string = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? evt?.canal_msg_id ?? '';
    if (!msgIdPrincipal) {
      const { data: m } = await sb.from('mensajes')
        .select('canal_msg_id')
        .eq('chat_id', params.chat_id)
        .is('deleted_at', null)
        .order('ts_canal', { ascending: false })
        .limit(1)
        .maybeSingle();
      msgIdPrincipal = m?.canal_msg_id ?? '';
    }

    return {
      persona_actual: pAct as PersonaCompacta,
      candidatos_personas: (otras ?? []) as PersonaCompacta[],
      mensaje_actual_id: msgIdPrincipal,
    };
  },

  construirPrompt(datos, agente) {
    const p = datos.persona_actual;
    const personaActualStr = JSON.stringify({
      id: p.id, nombre: p.nombre, alias: p.alias, empresa: p.empresa, rol: p.rol,
      telefono: p.telefono_e164, email: p.email, jid: p.jid, cedula: p.cedula, ciudad: p.ciudad,
    }, null, 0);

    const candidatosStr = datos.candidatos_personas.length === 0
      ? '(no hay otras personas en BD)'
      : datos.candidatos_personas
          .map(c => `${c.id}|${c.nombre ?? ''}|${c.alias ?? ''}|${c.empresa ?? ''}|tel=${c.telefono_e164 ?? ''}|email=${c.email ?? ''}|jid=${c.jid ?? ''}|ced=${c.cedula ?? ''}|${c.ciudad ?? ''}`)
          .join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A3_IDENTIDAD. Tu único trabajo: detectar si la PERSONA_ACTUAL es DUPLICADO
de alguna otra persona en la BD (lista de candidatos provista).

Campos a comparar:
  FUERTES (alta confianza):
    - telefono_e164  → mismo número normalizado E.164
    - email          → mismo email exacto (case insensitive)
    - jid            → mismo jid de WhatsApp
    - cedula         → mismo número de cédula
  MEDIOS:
    - nombre + empresa coincidentes
    - nombre similar + misma ciudad
  DÉBILES (por sí solos NO valen):
    - solo nombre (Juan Pérez puede ser cualquier persona)
    - solo ciudad
    - solo empresa

Reglas de score y confianza:
  - score = (#campos fuertes match) × 0.3 + (#campos medios match) × 0.1
  - confianza_fusion:
       CONFIRMADO  → score ≥ 0.6 (≥2 campos fuertes, o ≥1 fuerte + nombre+empresa)
       INFERIDO    → score 0.3-0.6 (1 campo fuerte solo, o muchos medios)
       DUDOSO      → score < 0.3 (señales débiles)
  - Si match es CONFIRMADO en telefono y nombre coincide → muy seguro de duplicado.
  - Si SOLO coincide el nombre → DUDOSO (no es duplicado, es homónimo probable).

Regla CONSERVADORA:
  - Frente a la duda, NO propongas fusión. Es destructivo.
  - Solo emite CONFIRMADO si estás muy seguro.
  - Mejor un duplicado real que un buzón saturado con falsos.

Reglas duras:
  - R-001 anti-alucinación: el persona_id_candidata DEBE estar en la lista
    de candidatos provista. NO inventes IDs.
  - evidencia_msg_ids debe incluir el msg_id del mensaje que disparó este análisis
    (lo dejo abajo).

Salida JSON EXACTA:
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "persona_actual_id": 13,
    "candidatos_fusion": [
      {
        "persona_id_candidata": 42,
        "campos_match": ["telefono_e164", "nombre"],
        "score": 0.7,
        "confianza_fusion": "CONFIRMADO",
        "razon": "Mismo teléfono +57301... y nombre coincide con persona 42 alias 'Maria G.'"
      }
    ],
    "resumen": "1 candidato de fusión detectado"
  },
  "evidencia_msg_ids": ["<MSG_ID>"],
  "reglas_aplicadas": ["R-001"]
}

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — candidatos_fusion=[] (no hay duplicados):
    out.confianza = "CONFIRMADO"  (no buzón)

  caso B — candidatos_fusion ≥ 1:
    out.confianza = "INFERIDO"   (al buzón, Jhon revisa y decide fusionar)

PROHIBIDO ABSOLUTO:
  ✗ candidatos_fusion=[] con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ candidatos_fusion ≥ 1 con out.confianza = "CONFIRMADO" → ERROR (fusión requiere humano)

Si NO hay duplicados (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "persona_actual_id": ${datos.persona_actual.id},
    "candidatos_fusion": [],
    "resumen": "Sin duplicados detectados"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== PERSONA_ACTUAL (la que estamos analizando) ===
${personaActualStr}

=== CANDIDATOS (otras personas en BD: id|nombre|alias|empresa|tel|email|jid|ced|ciudad) ===
${candidatosStr}

msg_id de este análisis (usar en evidencia_msg_ids): "${datos.mensaje_actual_id}"

Determiná si la PERSONA_ACTUAL es duplicado de algún candidato.
NO propongas fusión si solo coincide el nombre (homónimos son frecuentes).`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.persona_actual_id !== 'number' || p.persona_actual_id !== datos.persona_actual.id) {
      throw new ValidacionError('coherencia-a3i',
        `persona_actual_id debe ser ${datos.persona_actual.id}, got ${p?.persona_actual_id}`);
    }
    if (!Array.isArray(p?.candidatos_fusion)) {
      throw new ValidacionError('schema', 'payload.candidatos_fusion debe ser array');
    }
    const idsValidos = new Set<number>(datos.candidatos_personas.map(c => c.id));
    for (const c of p.candidatos_fusion as CandidatoFusionOutput[]) {
      if (!Number.isInteger(c.persona_id_candidata) || !idsValidos.has(c.persona_id_candidata)) {
        throw new ValidacionError('coherencia-a3i',
          `persona_id_candidata=${c.persona_id_candidata} no está en la lista de candidatos`);
      }
      if (c.persona_id_candidata === datos.persona_actual.id) {
        throw new ValidacionError('coherencia-a3i',
          `persona_id_candidata no puede ser igual a persona_actual_id`);
      }
      if (!Array.isArray(c.campos_match) || c.campos_match.length === 0) {
        throw new ValidacionError('schema', `campos_match debe ser array no vacío`);
      }
      if (typeof c.score !== 'number' || c.score < 0 || c.score > 1) {
        throw new ValidacionError('schema', `score fuera de [0,1]: ${c.score}`);
      }
      if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(c.confianza_fusion)) {
        throw new ValidacionError('schema', `confianza_fusion inválida: ${c.confianza_fusion}`);
      }
    }

    // Coherencia mecánica out.confianza ↔ candidatos
    if (p.candidatos_fusion.length === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a3i',
        `candidatos_fusion=[] requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.candidatos_fusion.length > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a3i',
        `candidatos_fusion ≥ 1 requiere out.confianza='INFERIDO' (fusión requiere Jhon)`);
    }

    // Resolver evidencia_msg_ids con tolerancia prefijo (msg actual del fallback)
    if (datos.mensaje_actual_id) {
      const msgIdsValidos = new Set<string>([datos.mensaje_actual_id]);
      if (Array.isArray(out.evidencia_msg_ids)) {
        for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
          const real = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
          if (real) out.evidencia_msg_ids[i] = real;
        }
      }
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // A3_IDENTIDAD no escribe a tabla. Los candidatos de fusión van al buzón;
    // la fusión real la dispara Jhon manualmente desde la UI (M1 Identidad
    // tiene acción "Fusionar personas" con confirmación + log).
    return;
  },
};
