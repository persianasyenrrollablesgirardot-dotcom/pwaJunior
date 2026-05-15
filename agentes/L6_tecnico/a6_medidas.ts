/**
 * A6_MEDIDAS — validador técnico de medidas (aplica R-013#1).
 *
 * Distinto a A1_MEDIDAS:
 *   - A1_MEDIDAS extrae las medidas crudas del mensaje (dimensiones + quien midió)
 *   - A6_MEDIDAS VALIDA esas medidas y aplica reglas duras técnicas:
 *       * R-013#1: medida tomada por cliente o familiar → bandera_riesgo
 *       * Ratio invertido (alto > 3×ancho) → posible ancho/alto invertido
 *       * Fuera de rango operacional (0.3m–8m)
 *       * Medida incompleta (solo ancho XOR solo alto)
 *
 * Estructura del payload (singular top-level para que validador R-013#1 lo capte):
 *   payload.ancho_m, payload.alto_m, payload.quien_midio, payload.bandera_riesgo
 *
 * Si el mensaje tiene MÚLTIPLES medidas, A6_MEDIDAS toma la PRIMERA como
 * principal (top-level) y lista las demás en `medidas_adicionales`. Eso permite
 * que el validador R-013#1 funcione sobre la principal.
 *
 * tipo_evento='medida'. Tope $0.01/invocación.
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

interface MedidaPrevia {
  ancho_m: number | null;
  alto_m: number | null;
  ambiente: string | null;
  quien_midio: 'tecnico' | 'cliente' | 'familiar' | 'otro' | 'no_dicho';
  msg_id: string;
}

interface DatosA6Medidas {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  medidas_de_l1: MedidaPrevia[];   // las que A1_MEDIDAS dejó en eventos shadow recientes
}

interface AlertaTecnicaOutput {
  // Códigos:
  //   ratio_invertido     → alto > 3×ancho
  //   fuera_rango         → ancho o alto fuera de [0.3, 8] m
  //   medida_incompleta   → solo ancho XOR solo alto
  //   medida_por_no_tecnico → cliente o familiar tomó la medida (R-013#1)
  //   otro                → cualquier otra alerta técnica
  codigo: 'ratio_invertido' | 'fuera_rango' | 'medida_incompleta' | 'medida_por_no_tecnico' | 'otro';
  texto: string;
}

const N_CONTEXTO = 3;
const MIN_M = 0.30;
const MAX_M = 8.00;
const RATIO_INVERTIDO_LIMITE = 3.0;
const QUIEN_MIDIO_RIESGO = ['cliente', 'familiar'];

export const a6MedidasHooks: AgenteHooks<DatosA6Medidas> = {
  async cargarContexto(sb, params) {
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal, payload, canal_msg_id')
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
      .map(m => ({
        canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto!, ts_canal: m.ts_canal,
      }));

    // Medidas previas de A1_MEDIDAS shadow events sobre este evento padre
    const { data: shadowEventos } = await sb.from('evento_pg')
      .select('payload, canal_msg_id')
      .eq('evento_padre_id', params.evento_id)
      .eq('agente_origen', 'A1_MEDIDAS')
      .eq('shadow', true)
      .limit(5);
    const medidasDeL1: MedidaPrevia[] = [];
    for (const e of shadowEventos ?? []) {
      const meds = (e.payload as any)?.medidas ?? [];
      for (const m of meds) {
        medidasDeL1.push({
          ancho_m: m.ancho_m ?? null,
          alto_m: m.alto_m ?? null,
          ambiente: m.ambiente ?? null,
          quien_midio: m.quien_midio ?? 'no_dicho',
          msg_id: m.msg_id,
        });
      }
    }

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      medidas_de_l1: medidasDeL1,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 200)}`
        ).join('\n');

    const medidasPrevias = datos.medidas_de_l1.length === 0
      ? '(A1_MEDIDAS aún no extrajo medidas para este evento)'
      : JSON.stringify(datos.medidas_de_l1, null, 2);

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A6_MEDIDAS. Validás medidas y aplicás reglas técnicas duras.

REGLAS DURAS:
  R-013#1  Medida tomada por cliente/familiar → bandera_riesgo='RIESGO_MEDICION_CLIENTE'.
           El sistema enforce esto a nivel validador (si quien_midio=cliente/familiar
           y NO ponés bandera_riesgo correcto, el evento se RECHAZA).

VALIDACIONES TÉCNICAS:
  • ratio_invertido: si alto > ${RATIO_INVERTIDO_LIMITE} × ancho → probable ancho/alto invertido.
    (Ventanas residenciales normales: alto ≤ 2× ancho.)
  • fuera_rango: ancho o alto fuera de [${MIN_M}m, ${MAX_M}m].
  • medida_incompleta: solo ancho o solo alto (falta una dimensión).
  • medida_por_no_tecnico: cliente o familiar tomó la medida → triggerea R-013#1.

CÓDIGOS DE ALERTA (usar EXACTAMENTE estos):
  - "ratio_invertido"
  - "fuera_rango"
  - "medida_incompleta"
  - "medida_por_no_tecnico"   ← cubre tanto cliente como familiar
  - "otro"

ESTRUCTURA DEL PAYLOAD (CRÍTICO):
  Los campos ancho_m / alto_m / quien_midio / bandera_riesgo van TOP-LEVEL en
  payload (no en un sub-objeto). Eso permite que el validador R-013#1 los
  detecte automáticamente.

  Si hay MÚLTIPLES medidas, la PRINCIPAL va top-level y las demás en
  payload.medidas_adicionales[].

INPUT — MEDIDAS PREVIAS EXTRAÍDAS POR A1_MEDIDAS:
${medidasPrevias}

🔒 REGLA CRÍTICA — NO MODIFICAR LOS DATOS DE A1_MEDIDAS:
  Si arriba hay medidas listadas, COPIÁ EXACTAMENTE los campos:
    ancho_m  ← el valor que viene de A1_MEDIDAS
    alto_m   ← el valor que viene de A1_MEDIDAS
    ambiente ← el valor que viene de A1_MEDIDAS
    quien_midio ← el valor que viene de A1_MEDIDAS  ⚠ NO REINTERPRETAR

  A6_MEDIDAS NO RE-EXTRAE ni RE-CLASIFICA — solo VALIDA y agrega alertas.
  Si A1_MEDIDAS dijo quien_midio='tecnico', vos también ponés 'tecnico'.
  Si A1_MEDIDAS dijo 'cliente', vos también ponés 'cliente'.
  El validador del sistema RECHAZARÁ tu output si cambiás quien_midio.

Si NO hay medidas previas listadas, intentá detectar medidas en el mensaje.

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — sin medida (ancho_m=null Y alto_m=null, mensaje sin dimensiones):
    out.confianza = "CONFIRMADO"  (estoy seguro de que no hay medida, no buzón)

  caso B — con medida:
    SI quien_midio ∈ {cliente, familiar} → out.confianza = "ALERTA"  (R-013#1)
    SI hay alertas técnicas (fuera_rango, ratio_invertido, etc.) → "ALERTA"
    SI medida válida sin alertas (quien_midio=tecnico) → "INFERIDO"

PROHIBIDO ABSOLUTO:
  ✗ sin medida con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ con medida y out.confianza = "CONFIRMADO" → ERROR (medidas requieren revisión)
  ✗ quien_midio=cliente/familiar sin out.confianza="ALERTA" → ERROR (R-013#1)

R-001 anti-alucinación:
  - SOLO usar las medidas que están en el INPUT (medidas previas) o
    explícitas en el mensaje. NO inventes dimensiones.

Salida JSON EXACTA — con medida:
{
  "tipo_evento": "medida",
  "confianza": "ALERTA",
  "payload": {
    "ancho_m": 2.40,
    "alto_m": 1.80,
    "ambiente": "sala",
    "quien_midio": "cliente",
    "bandera_riesgo": "RIESGO_MEDICION_CLIENTE",
    "alertas_tecnicas": [
      { "codigo": "medida_por_no_tecnico",
        "texto": "Medida tomada por el cliente. R-013#1: requiere visita técnica para confirmar antes de fabricar." }
    ],
    "medidas_adicionales": [],
    "resumen": "Medida 2.40×1.80 sala. R-013#1: tomada por cliente, requiere validación técnica."
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-013#1"]
}

Sin medidas detectables (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "medida",
  "confianza": "CONFIRMADO",
  "payload": {
    "ancho_m": null,
    "alto_m": null,
    "ambiente": null,
    "quien_midio": "no_dicho",
    "bandera_riesgo": null,
    "alertas_tecnicas": [],
    "medidas_adicionales": [],
    "resumen": "No se detectaron medidas en el mensaje"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": []
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion}): ${datos.mensaje_actual.texto}

Validá las medidas. Recordá: ancho_m/alto_m/quien_midio/bandera_riesgo TOP-LEVEL.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;

    const tipos_quien_midio = ['tecnico', 'cliente', 'familiar', 'otro', 'no_dicho'];
    if (!tipos_quien_midio.includes(p.quien_midio)) {
      throw new ValidacionError('schema', `quien_midio inválido: ${p.quien_midio}`);
    }

    if (p.ancho_m !== null && p.ancho_m !== undefined) {
      if (typeof p.ancho_m !== 'number' || p.ancho_m < MIN_M || p.ancho_m > MAX_M) {
        const tieneAlerta = (p.alertas_tecnicas ?? []).some((a: any) => a.codigo === 'fuera_rango');
        if (!tieneAlerta) {
          throw new ValidacionError('schema',
            `ancho_m=${p.ancho_m} fuera de rango [${MIN_M},${MAX_M}] requiere alerta_tecnica 'fuera_rango'`);
        }
      }
    }
    if (p.alto_m !== null && p.alto_m !== undefined) {
      if (typeof p.alto_m !== 'number' || p.alto_m < MIN_M || p.alto_m > MAX_M) {
        const tieneAlerta = (p.alertas_tecnicas ?? []).some((a: any) => a.codigo === 'fuera_rango');
        if (!tieneAlerta) {
          throw new ValidacionError('schema',
            `alto_m=${p.alto_m} fuera de rango requiere alerta 'fuera_rango'`);
        }
      }
    }

    if (QUIEN_MIDIO_RIESGO.includes(p.quien_midio)) {
      if (p.bandera_riesgo !== 'RIESGO_MEDICION_CLIENTE') {
        throw new ValidacionError('R-013#1',
          `quien_midio='${p.quien_midio}' requiere bandera_riesgo='RIESGO_MEDICION_CLIENTE'`);
      }
    }

    if (datos.medidas_de_l1.length > 0) {
      const principal = datos.medidas_de_l1[0];
      if (p.quien_midio !== principal.quien_midio) {
        throw new ValidacionError('coherencia-a6m',
          `quien_midio='${p.quien_midio}' difiere del extraído por A1_MEDIDAS ('${principal.quien_midio}')`);
      }
    }

    if (!Array.isArray(p.alertas_tecnicas)) {
      throw new ValidacionError('schema', 'alertas_tecnicas debe ser array');
    }
    const tiposAlertaValidos = ['ratio_invertido', 'fuera_rango', 'medida_incompleta', 'medida_por_no_tecnico', 'otro'];
    for (const a of p.alertas_tecnicas as AlertaTecnicaOutput[]) {
      if (!tiposAlertaValidos.includes(a.codigo)) {
        throw new ValidacionError('schema', `alerta.codigo inválido: ${a.codigo}`);
      }
      if (typeof a.texto !== 'string' || a.texto.trim().length === 0) {
        throw new ValidacionError('schema', 'alerta.texto vacío');
      }
    }

    if (QUIEN_MIDIO_RIESGO.includes(p.quien_midio) &&
        !(p.alertas_tecnicas as AlertaTecnicaOutput[]).some(a => a.codigo === 'medida_por_no_tecnico')) {
      throw new ValidacionError('R-013#1',
        `quien_midio='${p.quien_midio}' requiere alerta 'medida_por_no_tecnico'`);
    }

    if (!Array.isArray(p.medidas_adicionales)) {
      throw new ValidacionError('schema', 'medidas_adicionales debe ser array');
    }

    // Coherencia mecánica out.confianza ↔ medida
    const hayMedida = (p.ancho_m != null) || (p.alto_m != null);
    if (!hayMedida && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a6m',
        `sin medida requiere out.confianza='CONFIRMADO' (no buzón), recibido '${out.confianza}'`);
    }
    if (hayMedida && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a6m',
        `con medida requiere out.confianza='INFERIDO' o 'ALERTA' (revisión humana), no 'CONFIRMADO'`);
    }
    if (hayMedida && QUIEN_MIDIO_RIESGO.includes(p.quien_midio) && out.confianza !== 'ALERTA') {
      throw new ValidacionError('R-013#1',
        `quien_midio='${p.quien_midio}' con medida requiere out.confianza='ALERTA', recibido '${out.confianza}'`);
    }
    if (hayMedida && (p.alertas_tecnicas as AlertaTecnicaOutput[]).length > 0 && out.confianza !== 'ALERTA') {
      throw new ValidacionError('coherencia-a6m',
        `hay alertas técnicas + medida válida pero confianza='${out.confianza}' (debería ser ALERTA)`);
    }

    // Resolver msg_ids con tolerancia prefijo
    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);
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
    const hayMedida = (p.ancho_m != null) || (p.alto_m != null);
    if (!hayMedida) return;

    // etapa: 'cliente' si midió cliente/familiar, 'empresa' si midió técnico
    const etapa = QUIEN_MIDIO_RIESGO.includes(p.quien_midio) ? 'cliente' :
                  (p.quien_midio === 'tecnico' ? 'empresa' : 'cliente');
    const riesgo_medicion = p.bandera_riesgo === 'RIESGO_MEDICION_CLIENTE';

    const { data: row, error } = await sb.from('medidas').insert({
      persona_id: ctx.persona_id,
      etapa,
      ancho_m: p.ancho_m,
      alto_m: p.alto_m,
      quien_midio: p.quien_midio,
      fecha: new Date().toISOString().slice(0, 10),
      notas: p.resumen ?? null,
      riesgo_medicion,
      shadow: true,
      agente_origen: ctx.agente.codigo,
    } as any).select('id').single();
    if (error || !row) {
      throw new Error(`A6_MEDIDAS insert medida: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'medida', entidad_id: row.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
