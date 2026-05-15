/**
 * A3_GEO — matchea menciones geográficas del cliente contra zonas_instalacion.
 *
 * El cliente puede decir "vivo en Girardot Norte", "es para Melgar", "necesito
 * en Fusagasugá" → A3_GEO mapea a la zona del catálogo + indica si el traslado
 * está incluido o requiere cotización especial.
 *
 * Complementa a A3_INMUEBLE:
 *   - A3_INMUEBLE ya resuelve la zona vía `conjuntos.zona_codigo` cuando el
 *     conjunto está en catálogo.
 *   - A3_GEO funciona cuando:
 *       · El cliente no menciona conjunto (solo "es para Bogotá")
 *       · El conjunto mencionado no está en catálogo
 *       · El cliente menciona explícitamente una zona distinta del conjunto
 *
 * El valor real está en `costo_traslado_incluido`: A4_COTIZ usa este dato para
 * decidir si la cotización debe agregar costo extra de traslado.
 *
 * Tope $0.01/invocación.
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

interface ZonaCatalogo {
  codigo: string;
  nombre: string;
  costo_traslado_incluido: boolean;
  notas: string | null;
}

interface DatosA3Geo {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  catalogo_zonas: ZonaCatalogo[];
  zona_actual_proyecto: string | null;     // zona del inmueble si ya está
}

interface MencionGeoOutput {
  texto_mencionado: string;
  match_zona_codigo: string | null;
  match_zona_nombre: string | null;
  costo_traslado_incluido: boolean | null;
  confianza_match: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  msg_id: string;
  observacion?: string;
}

const N_CONTEXTO = 3;

export const a3GeoHooks: AgenteHooks<DatosA3Geo> = {
  async cargarContexto(sb, params) {
    const { data: zonas, error: zErr } = await sb.from('zonas_instalacion')
      .select('codigo, nombre, costo_traslado_incluido, notas')
      .order('orden', { ascending: true });
    if (zErr) throw new Error(`error cargando zonas: ${zErr.message}`);

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

    // Zona actual del inmueble (heredada del conjunto si lo tiene)
    let zonaActual: string | null = null;
    if (params.proyecto_id) {
      const { data: inm } = await sb.from('inmuebles')
        .select('conjunto_id, conjuntos(zona_codigo)')
        .eq('proyecto_id', params.proyecto_id)
        .is('deleted_at', null)
        .maybeSingle();
      zonaActual = (inm as any)?.conjuntos?.zona_codigo ?? null;
    }

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      catalogo_zonas: (zonas ?? []) as ZonaCatalogo[],
      zona_actual_proyecto: zonaActual,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 180)}`
        ).join('\n');

    const zonasStr = datos.catalogo_zonas
      .map(z => `${z.codigo}|${z.nombre}|traslado_incluido=${z.costo_traslado_incluido}|${z.notas ?? ''}`)
      .join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A3_GEO. Detectás menciones GEOGRÁFICAS (ciudad, sector, vía, barrio) en el
mensaje y matcheás contra el catálogo de zonas_instalacion.

Tu trabajo:
1. Identificar menciones a lugares físicos.
2. Matchear cada una contra el catálogo (codigo|nombre|notas).
3. Indicar si el costo de traslado está incluido.

Reglas de matching:
  - "Girardot norte"          → girardot_norte    CONFIRMADO
  - "Norte de Girardot"       → girardot_norte    CONFIRMADO
  - "centro de Girardot"      → girardot_urbano   INFERIDO
  - "vía Melgar"              → ricaurte_via_melgar INFERIDO
  - "Peñalisa" (sin contexto) → ricaurte_penalisa CONFIRMADO (es zona conocida)
  - "Melgar"                  → melgar            CONFIRMADO
  - "Bogotá / Fusagasugá / Flandes" → respectiva zona
  - "una zona como por San Marcos" → nilo_san_marcos INFERIDO
  - "es para Cali / Cartagena" → match_zona_codigo="otros" (otras zonas) INFERIDO
  - "vivo en mi casa" (sin lugar) → menciones=[]

Reglas duras:
  - R-001 anti-alucinación: match_zona_codigo, si no null, DEBE estar en el
    catálogo. NO inventes códigos.
  - Si NO hay menciones geográficas → menciones=[] + evidencia=[msg_id_actual].
  - costo_traslado_incluido se TOMA del catálogo (no lo decidas tú); copialo del
    match. Si no hay match, dejalo null.

CATÁLOGO DE ZONAS:
${zonasStr}

Salida JSON EXACTA:
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "menciones": [
      {
        "texto_mencionado": "Girardot Norte",
        "match_zona_codigo": "girardot_norte",
        "match_zona_nombre": "Girardot - Norte",
        "costo_traslado_incluido": true,
        "confianza_match": "CONFIRMADO",
        "msg_id": "XYZ"
      }
    ],
    "zona_principal_codigo": "girardot_norte",
    "costo_traslado_principal_incluido": true,
    "resumen": "Cliente en Girardot Norte, traslado incluido"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — menciones=[] (sin lugares mencionados):
    out.confianza = "CONFIRMADO"  (no buzón)
    zona_principal_codigo=null, costo_traslado_principal_incluido=null

  caso B — menciones.length ≥ 1:
    out.confianza = "INFERIDO"   (al buzón, Jhon revisa matches geográficos)

PROHIBIDO ABSOLUTO:
  ✗ menciones=[] con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ menciones ≥ 1 con out.confianza = "CONFIRMADO" → ERROR

Si menciones=[] (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "menciones": [],
    "zona_principal_codigo": null,
    "costo_traslado_principal_incluido": null,
    "resumen": "No se detectaron menciones geográficas en el mensaje"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const zonaStr = datos.zona_actual_proyecto
      ? `El proyecto YA tiene zona asignada via inmueble/conjunto: ${datos.zona_actual_proyecto}. Si tu match coincide → confirma. Si difiere → observación.`
      : `El proyecto NO tiene zona asignada todavía.`;

    const user: ChatMessage = {
      role: 'user',
      content: `${zonaStr}

=== CONTEXTO RECIENTE ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${datos.mensaje_actual.texto}

Detectá menciones geográficas en el MENSAJE A ANALIZAR.
Si una mención aparece SOLO en contexto y no en el mensaje analizado, NO la incluyas.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!Array.isArray(p?.menciones)) {
      throw new ValidacionError('schema', 'payload.menciones debe ser array');
    }
    const codigosValidos = new Set<string>(datos.catalogo_zonas.map(z => z.codigo));
    const msgIdsValidos = new Set<string>([
      datos.mensaje_actual.canal_msg_id,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);

    for (const m of p.menciones as MencionGeoOutput[]) {
      if (typeof m.texto_mencionado !== 'string' || m.texto_mencionado.trim().length === 0) {
        throw new ValidacionError('schema', `mención sin texto_mencionado: ${JSON.stringify(m)}`);
      }
      if (m.match_zona_codigo !== null && m.match_zona_codigo !== undefined) {
        if (typeof m.match_zona_codigo !== 'string' || !codigosValidos.has(m.match_zona_codigo)) {
          throw new ValidacionError('coherencia-a3g',
            `match_zona_codigo='${m.match_zona_codigo}' no existe en el catálogo`);
        }
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
    if (p.zona_principal_codigo !== null && p.zona_principal_codigo !== undefined) {
      if (!codigosValidos.has(p.zona_principal_codigo)) {
        throw new ValidacionError('coherencia-a3g',
          `zona_principal_codigo='${p.zona_principal_codigo}' no existe en el catálogo`);
      }
    }

    // Coherencia mecánica out.confianza ↔ menciones
    if (p.menciones.length === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a3g',
        `menciones=[] requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.menciones.length > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a3g',
        `menciones ≥ 1 requiere out.confianza='INFERIDO' (Jhon revisa zona)`);
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
    // A3_GEO no escribe a tabla. Los matches CONFIRMADO van al buzón; Jhon
    // decide asignar zona al inmueble desde UI (M1.2 Inmueble) si hace falta.
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
