/**
 * A1_ENTIDADES — extractor de entidades objetivas con LLM.
 *
 * Complemento del extractor regex (`agentes/extractor/`):
 *   - El regex ya saca teléfonos/emails/cédulas/montos/medidas/fechas literales con $0.
 *   - A1_ENTIDADES agrega lo que regex no puede: nombres de persona, empresa,
 *     conjunto/edificio mencionados sin keyword explícito, fechas contextuales
 *     ("Semana Santa", "fin de mes", "después de la posesión") y relaciones
 *     sociales ("mi esposa", "el administrador").
 *
 * No infiere intención, no concluye nada. Solo extrae lo escrito.
 *
 * Modo shadow:
 *   - Salida va a evento_pg(tipo='dato_extraido', shadow=true) — el runner lo hace.
 *   - postProcesar es no-op: A1 no escribe a personas / inmuebles / etc.
 *     De eso se ocupa A3_IDENTIDAD + A3_INMUEBLE en su capa.
 *
 * Input: cargarContexto trae el mensaje del evento + 5 mensajes previos del chat
 * para que el LLM pueda resolver referencias ("ese señor" → nombre dicho antes).
 *
 * Tope $0.01/invocación (definido en agentes_definicion.costo_limite_usd).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

const TIPOS_ENTIDAD = [
  'persona_nombre',     // "María González", "Don Carlos"
  'persona_alias',      // "el flaco", "Negro" (apodos)
  'empresa',            // "Constructora Bolívar", "Inmobiliaria del Río"
  'conjunto_nombre',    // "Torre del Rey", "Conjunto Los Nogales" (sin keyword explícito)
  'fecha_contextual',   // "Semana Santa", "fin de mes", "para la posesión"
  'rol_relacion',       // "mi esposa", "el administrador", "el vecino"
] as const;

type TipoEntidad = typeof TIPOS_ENTIDAD[number];

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  ts_canal: string;
}

interface DatosA1Entidades {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
}

interface EntidadOutput {
  tipo: TipoEntidad;
  valor: string;
  msg_id: string;
  confianza_individual: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  observacion?: string;
}

const N_CONTEXTO = 5;

export const a1EntidadesHooks: AgenteHooks<DatosA1Entidades> = {
  async cargarContexto(sb, params) {
    // 1. Cargar el evento para resolver el msg_id principal
    const { data: evt, error: eErr } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal, payload, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    if (eErr || !evt) throw new Error(`evento ${params.evento_id} no encontrado: ${eErr?.message}`);

    const evidIds = (evt.evidencia_ids as any)?.msg_ids ?? [];
    const msgIdPrincipal: string | null = evidIds[0] ?? evt.canal_msg_id ?? null;

    // 2. Localizar mensaje principal (por canal_msg_id si lo tenemos; fallback al último
    //    mensaje del chat <= ts_canal del evento)
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
        .lte('ts_canal', evt.ts_canal ?? new Date().toISOString())
        .order('ts_canal', { ascending: false })
        .limit(1);
      const m = msgs?.[0];
      if (!m?.texto) throw new Error(`evento ${params.evento_id} no tiene mensaje con texto asociado`);
      mensajeActual = { canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto, ts_canal: m.ts_canal };
    }

    // 3. N mensajes anteriores del mismo chat (para resolver referencias)
    const { data: ctxMsgs } = await sb.from('mensajes')
      .select('canal_msg_id, direccion, texto, ts_canal')
      .eq('chat_id', params.chat_id)
      .is('deleted_at', null)
      .not('texto', 'is', null)
      .lt('ts_canal', mensajeActual.ts_canal)
      .order('ts_canal', { ascending: false })
      .limit(N_CONTEXTO);

    const contexto: MensajeCtx[] = (ctxMsgs ?? [])
      .reverse() // cronológico ascendente
      .filter(m => m.texto && m.texto.trim().length > 0)
      .map(m => ({
        canal_msg_id: m.canal_msg_id,
        direccion: m.direccion as any,
        texto: m.texto!,
        ts_canal: m.ts_canal,
      }));

    return { mensaje_actual: mensajeActual, mensajes_contexto: contexto };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[msg_id=${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 280)}`
        ).join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A1_ENTIDADES. Extraés entidades objetivas que aparecen literalmente o son
referidas en el mensaje analizado. NO inferís intención ni objetivos.
NO repetís entidades que YA detectó el extractor regex
(teléfonos, emails, cédulas, NIT, direcciones formales con Cra/Cl, montos en COP, medidas en m/cm, fechas dd/mm/aaaa).

Tu trabajo se enfoca en lo que regex NO puede:

Tipos de entidad permitidos:
  - persona_nombre      → nombre propio de persona ("María González", "Don Carlos")
  - persona_alias       → apodo o trato familiar ("el flaco", "Negro")
  - empresa             → empresa/comercio/constructora ("Constructora Bolívar")
  - conjunto_nombre     → nombre de conjunto/edificio/torre dicho SIN keyword explícito
                          ("vivo en Torres del Norte" → "Torres del Norte").
                          Si el cliente dice "conjunto X" → IGNORALO (lo agarra el regex).
  - fecha_contextual    → referencia temporal NO literal ("Semana Santa", "fin de mes",
                          "para la posesión", "después de Navidad").
                          Fechas tipo 15/03 NO van acá (las agarra el regex).
  - rol_relacion        → vínculo social mencionado ("mi esposa", "el administrador",
                          "el vecino de al lado", "mi hermano").

Reglas duras:
  R-001 anti-alucinación: TODA entidad debe tener msg_id donde se la menciona.
                          NO inventes entidades que no aparecen literalmente o por
                          referencia clara en el texto.
  Anti-contaminación:    NO uses nombres de OTROS clientes que recuerdes de tu
                          entrenamiento. Solo lo que está en estos mensajes.
  Si dudás:               confianza_individual = "DUDOSO" y observación corta.
  Si no hay entidades:    devolvé entidades: [].

CÁLCULO MECÁNICO DE confianza (NO es una opinión, es un cálculo):
  PASO 1: Contá las entidades extraídas.
  PASO 2:
    - 0 entidades  → confianza = "CONFIRMADO"  (siempre, sin excepción)
    - ≥1 entidad   → confianza = "INFERIDO"    (default)
    - ≥1 entidad MUY ambigua (apenas se entiende) → confianza = "DUDOSO"

PROHIBIDO ABSOLUTO:
  ✗ entidades=[] con confianza="DUDOSO"      → ERROR mecánico (rechazado)
  ✗ entidades=[] con confianza="INFERIDO"    → ERROR mecánico (rechazado)
  ✗ entidades=[{...}] con confianza="CONFIRMADO" → ERROR mecánico (rechazado)

LEÉ ESTO DOS VECES:
  "CONFIRMADO" con entidades=[] NO significa "estoy seguro de las entidades".
  Significa "estoy seguro de que NO hay nada que extraer en este mensaje".
  Es el caso normal, no implica error ni baja calidad.

Devolvés JSON EXACTO con la forma de los ejemplos siguientes.

EJEMPLO 1 — mensaje sin entidades extraíbles ("hola, gracias"):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": { "entidades": [], "resumen": "No se extrajeron entidades del mensaje" },
  "evidencia_msg_ids": ["ID_DEL_MENSAJE_ANALIZADO"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 2 — mensaje con 1 nombre ("habla con María González"):
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "entidades": [
      { "tipo": "persona_nombre", "valor": "María González",
        "msg_id": "XYZ123", "confianza_individual": "CONFIRMADO" }
    ],
    "resumen": "1 nombre de persona extraído"
  },
  "evidencia_msg_ids": ["XYZ123"],
  "reglas_aplicadas": ["R-001"]
}

evidencia_msg_ids debe incluir TODOS los msg_id citados en entidades.
Si entidades=[] igual incluí el msg_id del mensaje actual en evidencia_msg_ids
(para que el output sea válido).`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO RECIENTE DEL CHAT ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[msg_id=${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}):
${datos.mensaje_actual.texto}

Extraé entidades del MENSAJE A ANALIZAR. El contexto solo está para resolver
referencias ("ese señor" → nombre dicho antes). Si una entidad aparece SOLO en
el contexto y no en el mensaje analizado, NO la incluyas.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const ent = (out.payload as any)?.entidades;
    if (!Array.isArray(ent)) throw new Error('payload.entidades debe ser array');

    // Coherencia entidades ↔ confianza global (regla de buzón):
    //   entidades=[]      ⇒ confianza='CONFIRMADO' (no hay nada que revisar)
    //   entidades.length>0 ⇒ confianza ∈ {INFERIDO, DUDOSO} (Jhon revisa)
    if (ent.length === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a1',
        `entidades=[] requiere confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (ent.length > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a1',
        `entidades.length=${ent.length} requiere confianza='INFERIDO' o 'DUDOSO', no 'CONFIRMADO'`);
    }

    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);

    for (const e of ent as EntidadOutput[]) {
      if (typeof e?.tipo !== 'string' || !TIPOS_ENTIDAD.includes(e.tipo)) {
        throw new ValidacionError('schema', `entidad con tipo inválido: ${JSON.stringify(e?.tipo)}`);
      }
      if (typeof e?.valor !== 'string' || e.valor.trim().length === 0) {
        throw new ValidacionError('schema', `entidad sin valor: ${JSON.stringify(e)}`);
      }
      if (typeof e?.msg_id !== 'string') {
        throw new ValidacionError('schema', `entidad sin msg_id: ${JSON.stringify(e)}`);
      }
      const realMsgId = resolverMsgId(e.msg_id, msgIdsValidos);
      if (!realMsgId) {
        throw new ValidacionError('R-anti-alucinacion',
          `entidad cita msg_id '${e.msg_id}' que no está ni en el mensaje analizado ni en el contexto`);
      }
      e.msg_id = realMsgId;  // sustitución in-place (persistir el id real)
      if (e.confianza_individual && !['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(e.confianza_individual)) {
        throw new ValidacionError('schema', `confianza_individual inválida: ${e.confianza_individual}`);
      }
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // L1 extracción: cero side-effects en tablas de negocio.
    // Las entidades quedan en evento_pg.payload.entidades (lo escribe el runner).
    // L3_IDENTIDAD / L3_INMUEBLE deciden si crear/matchear personas/conjuntos.
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
