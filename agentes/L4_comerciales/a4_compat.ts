/**
 * A4_COMPAT — validador de compatibilidad técnica de configuraciones.
 *
 * Cuando el cliente pide una configuración rara (ej. "blackout con tela voile"),
 * A4_COMPAT busca en `reglas_compatibilidad` si esa combinación está soportada
 * y emite alerta si no.
 *
 * Cada regla tiene:
 *   sistema_codigo + componente + valores_ok[] + valores_ko[] + severidad
 *
 * Ejemplo:
 *   Cliente: "Quiero blackout pero con tela voile"
 *   Regla BLACKOUT-TELA: sistema=blackout, componente=tela,
 *                        valores_ok=[poliester, algodón_revestido],
 *                        valores_ko=[voile, sheer], severidad=critico
 *   → A4_COMPAT detecta tela=voile en valores_ko → ALERTA
 *
 * Output:
 *   - confianza global = ALERTA si hay al menos 1 validación crítica incompatible
 *   - confianza global = CONFIRMADO si todas las configs son válidas
 *   - confianza global = DUDOSO si no se pudo detectar configuración
 *
 * tipo_evento='alerta'.
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

interface ReglaCompatibilidad {
  codigo: string;
  sistema_codigo: string;
  componente: string;
  valores_ok: string[];
  valores_ko: string[];
  regla: string;
  severidad: 'info' | 'warning' | 'critico';
}

interface DatosA4Compat {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  reglas_catalogo: ReglaCompatibilidad[];
}

interface ValidacionOutput {
  sistema_safra_codigo: string;
  componente: string;
  valor_pedido: string;
  regla_codigo: string;
  severidad: 'info' | 'warning' | 'critico';
  es_compatible: boolean;
  explicacion: string;
  msg_id: string;
}

const N_CONTEXTO = 5;
const SEVERIDADES = ['info', 'warning', 'critico'] as const;

export const a4CompatHooks: AgenteHooks<DatosA4Compat> = {
  async cargarContexto(sb, params) {
    const { data: reglas } = await sb.from('reglas_compatibilidad')
      .select('codigo, sistema_codigo, componente, valores_ok, valores_ko, regla, severidad')
      .is('deleted_at', null);

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
        canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto!, ts_canal: m.ts_canal,
      }));

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      reglas_catalogo: (reglas ?? []) as ReglaCompatibilidad[],
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 220)}`
        ).join('\n');

    const reglasStr = datos.reglas_catalogo
      .map(r => `${r.codigo}: sistema=${r.sistema_codigo} componente=${r.componente} ok=[${r.valores_ok.join(',')}] ko=[${r.valores_ko.join(',')}] severidad=${r.severidad}\n  └ ${r.regla}`)
      .join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A4_COMPAT. Validás que las configuraciones que el cliente pide para
persianas/cortinas sean técnicamente compatibles.

CONTEXTO TÉCNICO:
  Una "config" es una tripleta: SISTEMA + COMPONENTE + VALOR
    ejemplo: sistema=blackout, componente=tela, valor=voile
  Cada regla del catálogo lista valores OK y valores KO para un componente
  de un sistema. Si el valor pedido está en valores_ko → INCOMPATIBLE.

TU TRABAJO:
  1. Detectar si el cliente menciona configuraciones específicas en el mensaje.
     Mensajes típicos:
       "Quiero blackout pero con tela voile"
       "Necesito screen solar 5%"
       "El toldo con motor interior está bien?"
       "Verticales con cuerda"
  2. Para cada config detectada, buscá la regla correspondiente.
  3. Determiná si es_compatible (valor en valores_ok) o no (valor en valores_ko).
  4. Devolvé explicación clara usando el campo "regla" del catálogo.

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — validaciones=[] (no se detectó configuración técnica):
    out.confianza = "CONFIRMADO"  (no hay nada que validar, no buzón)

  caso B — validaciones.length ≥ 1:
    SI hay ≥1 incompatible con severidad="critico" → out.confianza = "ALERTA"  (prio 1)
    SI hay ≥1 incompatible con severidad="warning" → out.confianza = "INFERIDO" (buzón normal)
    SI todas son compatibles (es_compatible=true)  → out.confianza = "CONFIRMADO" (no buzón)
    SI solo "info" sin incompatibilidad             → out.confianza = "CONFIRMADO"

PROHIBIDO ABSOLUTO:
  ✗ validaciones=[] con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ críticas incompatibles sin out.confianza="ALERTA" → ERROR
  ✗ todas compatibles con out.confianza ≠ "CONFIRMADO" → ERROR

REGLAS DURAS:
  - tipo_evento SIEMPRE = "alerta" (es el único tipo que emite este agente).
    NO uses "info", "warning", "compatibilidad", etc. Solo "alerta".
    Lo que CAMBIA según severidad es el campo "confianza" del output, no tipo_evento.
  - regla_codigo, si se usa, DEBE estar en el catálogo. NO inventes.
  - Si el cliente NO menciona configuración técnica específica → validaciones=[]
    + confianza="DUDOSO" + evidencia=[msg_id_actual] + tipo_evento="alerta".
  - Si el cliente menciona algo pero NO encaja en ninguna regla del catálogo →
    es una mención sin validación (no la incluyas).
  - R-001 anti-alucinación: msg_id de cada validación debe ser real.

CATÁLOGO DE REGLAS:
${reglasStr}

Salida JSON EXACTA:
{
  "tipo_evento": "alerta",
  "confianza": "ALERTA",
  "payload": {
    "validaciones": [
      {
        "sistema_safra_codigo": "blackout",
        "componente": "tela",
        "valor_pedido": "voile",
        "regla_codigo": "BLACKOUT-TELA",
        "severidad": "critico",
        "es_compatible": false,
        "explicacion": "Cliente pide blackout con voile. La regla BLACKOUT-TELA indica que voile NO funciona como blackout (no bloquea luz). Sugerir poliéster o algodón revestido.",
        "msg_id": "XYZ"
      }
    ],
    "tiene_alertas_criticas": true,
    "tiene_warnings": false,
    "resumen": "1 alerta crítica: blackout con voile incompatible"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

Si no se detecta nada técnico (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "alerta",
  "confianza": "CONFIRMADO",
  "payload": {
    "validaciones": [],
    "tiene_alertas_criticas": false,
    "tiene_warnings": false,
    "resumen": "No se detectaron configuraciones técnicas específicas"
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

Detectá configuraciones técnicas (sistema+componente+valor) en el MENSAJE A
ANALIZAR y validá contra las reglas. Si el cliente no menciona nada técnico
específico → validaciones=[].`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!Array.isArray(p?.validaciones)) {
      throw new ValidacionError('schema', 'payload.validaciones debe ser array');
    }
    const reglasMap = new Map<string, ReglaCompatibilidad>(
      datos.reglas_catalogo.map(r => [r.codigo, r])
    );
    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);

    let criticasIncompat = 0;
    let warningsIncompat = 0;
    let totalIncompat = 0;

    for (const v of p.validaciones as ValidacionOutput[]) {
      const regla = reglasMap.get(v.regla_codigo);
      if (!regla) {
        throw new ValidacionError('schema', `regla_codigo='${v.regla_codigo}' no está en catálogo`);
      }
      if (!SEVERIDADES.includes(v.severidad)) {
        throw new ValidacionError('schema', `severidad inválida: ${v.severidad}`);
      }
      if (typeof v.es_compatible !== 'boolean') {
        throw new ValidacionError('schema',
          `es_compatible debe ser boolean: ${JSON.stringify(v.es_compatible)}`);
      }
      if (v.severidad !== regla.severidad) {
        throw new ValidacionError('coherencia-a4c',
          `severidad declarada='${v.severidad}' difiere de la del catálogo='${regla.severidad}' para regla ${v.regla_codigo}`);
      }
      if (v.sistema_safra_codigo !== regla.sistema_codigo) {
        throw new ValidacionError('coherencia-a4c',
          `sistema_safra_codigo='${v.sistema_safra_codigo}' difiere del de la regla='${regla.sistema_codigo}'`);
      }
      if (v.componente !== regla.componente) {
        throw new ValidacionError('coherencia-a4c',
          `componente='${v.componente}' difiere del de la regla='${regla.componente}'`);
      }
      const real = resolverMsgId(v.msg_id, msgIdsValidos);
      if (!real) {
        throw new ValidacionError('R-anti-alucinacion',
          `validación cita msg_id '${v.msg_id}' que no está en mensaje o contexto`);
      }
      v.msg_id = real;
      if (!v.es_compatible) totalIncompat++;
      if (!v.es_compatible && v.severidad === 'critico') criticasIncompat++;
      if (!v.es_compatible && v.severidad === 'warning') warningsIncompat++;
    }

    if (typeof p.tiene_alertas_criticas !== 'boolean') {
      throw new ValidacionError('schema', 'tiene_alertas_criticas debe ser boolean');
    }
    if (p.tiene_alertas_criticas !== (criticasIncompat > 0)) {
      throw new ValidacionError('coherencia-a4c',
        `tiene_alertas_criticas=${p.tiene_alertas_criticas} no coincide con criticasIncompat=${criticasIncompat}`);
    }
    if (typeof p.tiene_warnings !== 'boolean') {
      throw new ValidacionError('schema', 'tiene_warnings debe ser boolean');
    }
    if (p.tiene_warnings !== (warningsIncompat > 0)) {
      throw new ValidacionError('coherencia-a4c',
        `tiene_warnings=${p.tiene_warnings} no coincide con warningsIncompat=${warningsIncompat}`);
    }

    // Coherencia mecánica out.confianza:
    //   - validaciones=[] → CONFIRMADO
    //   - críticas incompat → ALERTA
    //   - warnings incompat sin críticas → INFERIDO
    //   - todas compatibles (sin incompatibles) → CONFIRMADO
    const N = p.validaciones.length;
    if (N === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a4c',
        `validaciones=[] requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (criticasIncompat > 0 && out.confianza !== 'ALERTA') {
      throw new ValidacionError('coherencia-a4c',
        `hay ${criticasIncompat} críticas incompatibles → out.confianza='ALERTA', recibido '${out.confianza}'`);
    }
    if (criticasIncompat === 0 && warningsIncompat > 0 && out.confianza !== 'INFERIDO') {
      throw new ValidacionError('coherencia-a4c',
        `hay ${warningsIncompat} warnings sin críticas → out.confianza='INFERIDO', recibido '${out.confianza}'`);
    }
    if (N > 0 && totalIncompat === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a4c',
        `todas las validaciones son compatibles → out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }

    // Resolver evidencia_msg_ids con tolerancia prefijo
    if (Array.isArray(out.evidencia_msg_ids)) {
      for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
        const r = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
        if (r) out.evidencia_msg_ids[i] = r;
      }
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // A4_COMPAT no escribe a tabla de negocio. Solo emite alertas al buzón
    // cuando hay incompatibilidades. Jhon resuelve respondiendo al cliente
    // (no se persiste la advertencia en una tabla específica).
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
