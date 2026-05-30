/**
 * A3_INMUEBLE — matchea menciones del cliente contra el catálogo de conjuntos.
 *
 * El cliente dice "vivo en Torre del Rey" o "es para el conjunto Las Palmas
 * Cariota" → A3_INMUEBLE busca en la tabla `conjuntos` (324 sincronizados
 * desde Gestor_Prospectos) el match más probable.
 *
 * Tres outputs por mención:
 *   CONFIRMADO  → nombre exacto o casi-exacto (score ≥ 0.9)
 *   INFERIDO    → nombre similar (score 0.7-0.9), pero el cliente puede haber
 *                 abreviado o equivocado el nombre
 *   DUDOSO      → mencionó algo tipo "lugar" pero sin match claro
 *
 * postProcesar (shadow=true): no muta.
 * postProcesar productivo (futuro): si CONFIRMADO + proyecto sin inmueble_id,
 *   propone vincular el conjunto al inmueble del proyecto via buzón.
 *
 * Tope $0.02/invocación. Costo real esperado: ~$0.0005-0.001 (~3.5K tokens
 * de catálogo, pero cacheable entre invocaciones).
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

interface ConjuntoCatalogo {
  id: number;
  nombre: string;
  sector: string;
  ciudad: string | null;
}

interface DatosA3Inmueble {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  catalogo_conjuntos: ConjuntoCatalogo[];
  inmueble_actual_conjunto_id: number | null;
}

interface MencionOutput {
  texto_mencionado: string;
  match_conjunto_id: number | null;
  match_nombre: string | null;
  match_sector: string | null;
  match_ciudad: string | null;
  score_fuzzy: number;          // 0-1, donde 1 = match exacto
  confianza_match: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  msg_id: string;
  observacion?: string;
}

const N_CONTEXTO = 3;

export const a3InmuebleHooks: AgenteHooks<DatosA3Inmueble> = {
  async cargarContexto(sb, params) {
    // 1. Catálogo de conjuntos (cabe en contexto, ~10KB)
    const { data: conjuntos, error: kErr } = await sb.from('conjuntos')
      .select('id, nombre, sector, ciudad')
      .order('id', { ascending: true });
    if (kErr) throw new Error(`error cargando conjuntos: ${kErr.message}`);

    // 2. Mensaje del evento + contexto
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
        canal_msg_id: m.canal_msg_id,
        direccion: m.direccion as any,
        texto: m.texto!,
        ts_canal: m.ts_canal,
      }));

    // 3. Inmueble actual del proyecto (si existe)
    let inmuebleConjuntoId: number | null = null;
    if (params.proyecto_id) {
      const { data: inm } = await sb.from('inmuebles')
        .select('conjunto_id')
        .eq('proyecto_id', params.proyecto_id)
        .is('deleted_at', null)
        .maybeSingle();
      inmuebleConjuntoId = inm?.conjunto_id ?? null;
    }

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      catalogo_conjuntos: (conjuntos ?? []) as ConjuntoCatalogo[],
      inmueble_actual_conjunto_id: inmuebleConjuntoId,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 180)}`
        ).join('\n');

    // Catálogo compacto: "id|nombre|sector|ciudad"
    const catalogoStr = datos.catalogo_conjuntos
      .map(c => `${c.id}|${c.nombre}|${c.sector}|${c.ciudad ?? ''}`)
      .join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A3_INMUEBLE. Detectás menciones de conjuntos/edificios/torres en el mensaje
y matcheás contra el catálogo de 324 conjuntos de la zona Girardot–Ricaurte–Melgar.

Tu trabajo:
1. Identificar todas las menciones a lugares específicos en el mensaje
   (conjunto, edificio, torre, urbanización, hacienda, condominio, casa).
2. Para cada mención, buscar el conjunto más probable en el catálogo.
3. Calcular score_fuzzy (0-1) del match.
4. Devolver confianza según el score:
     score ≥ 0.9        → CONFIRMADO   (match exacto o casi)
     score 0.7-0.9      → INFERIDO     (similar, posible match)
     score < 0.7        → DUDOSO       (mención sin match claro)
     sin match alguno   → match_conjunto_id=null + DUDOSO

Reglas de matching:
  - "Las Palmas Cariota" === "Las Palmas Cariota" → 1.0 CONFIRMADO
  - "torre del rey" vs "Torre del Rey" → 0.95 CONFIRMADO (case insensitive)
  - "conjunto Las Palmas" vs "Malta - Las Palmas" → 0.7 INFERIDO (parcial)
  - "torres de no sé qué" sin nombre específico → DUDOSO + sin match
  - El cliente puede abreviar: "Peñalisa" puede matchear cualquier "Hacienda Peñalisa X"

Reglas duras:
  - R-001 anti-alucinación: TODA mención cita el msg_id donde aparece.
    match_conjunto_id, si NO null, DEBE ser un id real del catálogo (NO inventes).
  - Si el mensaje NO menciona lugares → menciones=[] + evidencia_msg_ids=[msg_id_actual].
  - Anti-contaminación: NO uses conjuntos que recuerdes de otros clientes que no
    están en el catálogo.

CATÁLOGO DE CONJUNTOS (formato: id|nombre|sector|ciudad):
${catalogoStr}

Salida JSON EXACTA:
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "menciones": [
      {
        "texto_mencionado": "Torre del Rey",
        "match_conjunto_id": 42,
        "match_nombre": "Torre del Rey",
        "match_sector": "Girardot - Norte",
        "match_ciudad": "Girardot",
        "score_fuzzy": 0.95,
        "confianza_match": "CONFIRMADO",
        "msg_id": "XYZ"
      }
    ],
    "resumen": "1 conjunto detectado: Torre del Rey (CONFIRMADO)"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — menciones=[] (no se mencionó ningún lugar):
    out.confianza = "CONFIRMADO"  (no buzón)

  caso B — menciones.length ≥ 1:
    out.confianza = "INFERIDO"   (al buzón, Jhon revisa los matches)

PROHIBIDO ABSOLUTO:
  ✗ menciones=[] con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ menciones ≥ 1 con out.confianza = "CONFIRMADO" → ERROR (Jhon revisa match)

Si NO hay menciones (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "menciones": [],
    "resumen": "No se mencionaron conjuntos en el mensaje"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const inmuebleStr = datos.inmueble_actual_conjunto_id
      ? `El proyecto YA tiene un inmueble asociado al conjunto_id=${datos.inmueble_actual_conjunto_id}. Si tu match coincide → confirma. Si tu match difiere → DUDOSO + observación.`
      : `El proyecto NO tiene inmueble asociado todavía.`;

    const user: ChatMessage = {
      role: 'user',
      content: `${inmuebleStr}

=== CONTEXTO RECIENTE DEL CHAT ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${datos.mensaje_actual.texto}

Encontrá las menciones a conjuntos en el MENSAJE A ANALIZAR y matchealas contra
el catálogo. NO inventes conjunto_id — DEBE estar en el catálogo o ser null.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!Array.isArray(p?.menciones)) {
      throw new ValidacionError('schema', 'payload.menciones debe ser array');
    }
    const idsValidos = new Set<number>(datos.catalogo_conjuntos.map(c => c.id));
    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);

    for (const m of p.menciones as MencionOutput[]) {
      if (typeof m.texto_mencionado !== 'string' || m.texto_mencionado.trim().length === 0) {
        throw new ValidacionError('schema', `mención sin texto_mencionado: ${JSON.stringify(m)}`);
      }
      if (m.match_conjunto_id !== null && m.match_conjunto_id !== undefined) {
        if (!Number.isInteger(m.match_conjunto_id) || !idsValidos.has(m.match_conjunto_id)) {
          throw new ValidacionError('coherencia-a3in',
            `match_conjunto_id=${m.match_conjunto_id} no existe en el catálogo`);
        }
      }
      if (typeof m.score_fuzzy !== 'number' || m.score_fuzzy < 0 || m.score_fuzzy > 1) {
        throw new ValidacionError('schema', `score_fuzzy fuera de [0,1]: ${m.score_fuzzy}`);
      }
      if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(m.confianza_match)) {
        throw new ValidacionError('schema', `confianza_match inválida: ${m.confianza_match}`);
      }
      const realMsgId = resolverMsgId(m.msg_id, msgIdsValidos);
      if (!realMsgId) {
        throw new ValidacionError('R-anti-alucinacion',
          `mención cita msg_id '${m.msg_id}' que no está en mensaje o contexto`);
      }
      m.msg_id = realMsgId;
    }

    // Coherencia mecánica out.confianza ↔ menciones
    if (p.menciones.length === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a3in',
        `menciones=[] requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.menciones.length > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a3in',
        `menciones ≥ 1 requiere out.confianza='INFERIDO' (Jhon revisa matches)`);
    }

    // Resolver evidencia_msg_ids con tolerancia
    if (Array.isArray(out.evidencia_msg_ids)) {
      for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
        const real = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
        if (real) out.evidencia_msg_ids[i] = real;
      }
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // A3_INMUEBLE no escribe a tabla. Las menciones con match CONFIRMADO van al
    // buzón; Jhon decide vincular el conjunto al inmueble del proyecto desde
    // la UI (M1.2 Inmueble).
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
