/**
 * A6_RIESGO — detector de riesgos técnicos del proyecto.
 *
 * Cruza varios contextos para identificar configuraciones de riesgo:
 *   - INMUEBLE: tipo (apto/casa), piso (vía apartamento), ascensor, restricciones
 *   - SISTEMA: producto en cotización (toldo / blackout / motor / vertical)
 *   - ZONA: ciudad/sector con clima conocido (Girardot=calor+sol, Melgar=viento, etc.)
 *   - MENSAJE: pistas del cliente ("la ventana da al sol", "es exterior")
 *
 * Tipos de riesgo detectables:
 *   - vano_alto         (>3m, requiere andamio)
 *   - vano_irregular    (no es rectángulo estándar)
 *   - viento_fuerte     (toldo/exterior en zona ventosa)
 *   - sol_directo       (cliente menciona sol directo → tela específica)
 *   - humedad           (baño/terraza/exterior → materiales anti-óxido)
 *   - acceso_dificil    (piso alto sin ascensor + producto grande)
 *   - exterior_no_certificado (sistema interior pedido para uso exterior)
 *   - otro
 *
 * Severidades:
 *   - alta   → puede causar falla / garantía rota / problema mayor de instalación
 *   - media  → requiere atención, ajuste de cotización o material
 *   - baja   → mención informativa
 *
 * tipo_evento='alerta'. Tope $0.02/invocación.
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

interface InmuebleContexto {
  tipo: string | null;
  ciudad: string | null;
  conjunto: string | null;
  torre: string | null;
  apartamento: string | null;
  ascensor: boolean | null;
  zona_codigo: string | null;
  notas: string | null;
}

interface DatosA6Riesgo {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  inmueble: InmuebleContexto | null;
  sistemas_pedidos: string[];      // de cotizacion_items o de A4_COTIZ
  zona_nombre: string | null;
}

interface RiesgoOutput {
  tipo: 'vano_alto' | 'vano_irregular' | 'viento_fuerte' | 'sol_directo' |
        'humedad' | 'acceso_dificil' | 'exterior_no_certificado' | 'otro';
  severidad: 'baja' | 'media' | 'alta';
  descripcion: string;
  sugerencia: string;
  evidencia_texto: string;
}

const TIPOS_RIESGO = ['vano_alto', 'vano_irregular', 'viento_fuerte', 'sol_directo',
  'humedad', 'acceso_dificil', 'exterior_no_certificado', 'otro'] as const;
const SEVERIDADES = ['baja', 'media', 'alta'] as const;
const N_CONTEXTO = 5;

export const a6RiesgoHooks: AgenteHooks<DatosA6Riesgo> = {
  async cargarContexto(sb, params) {
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
      .map(m => ({
        canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto!, ts_canal: m.ts_canal,
      }));

    // Inmueble del proyecto
    let inmueble: InmuebleContexto | null = null;
    let zonaNombre: string | null = null;
    if (params.proyecto_id) {
      const { data: inm } = await sb.from('inmuebles')
        .select(`tipo, ciudad, conjunto, torre, apartamento, ascensor, notas,
                 conjuntos(zona_codigo, zonas_instalacion(nombre))`)
        .eq('proyecto_id', params.proyecto_id)
        .is('deleted_at', null)
        .maybeSingle();
      if (inm) {
        const conj = (inm as any).conjuntos;
        inmueble = {
          tipo: inm.tipo, ciudad: inm.ciudad, conjunto: inm.conjunto,
          torre: inm.torre, apartamento: inm.apartamento,
          ascensor: inm.ascensor, zona_codigo: conj?.zona_codigo ?? null,
          notas: inm.notas,
        };
        zonaNombre = conj?.zonas_instalacion?.nombre ?? null;
      }
    }

    // Sistemas pedidos (de cotizacion_items o de A4_COTIZ shadow)
    const sistemas: string[] = [];
    if (params.proyecto_id) {
      const { data: cots } = await sb.from('cotizaciones')
        .select('id')
        .eq('proyecto_id', params.proyecto_id)
        .is('deleted_at', null)
        .limit(5);
      const ids = (cots ?? []).map((c: any) => c.id);
      if (ids.length > 0) {
        const { data: items } = await sb.from('cotizacion_items')
          .select('sistema_safra_codigo')
          .in('cotizacion_id', ids)
          .is('deleted_at', null);
        for (const it of items ?? []) {
          if (it.sistema_safra_codigo && !sistemas.includes(it.sistema_safra_codigo)) {
            sistemas.push(it.sistema_safra_codigo);
          }
        }
      }
    }
    // Si no hay cotizaciones aún, leer outputs shadow recientes de A4_COTIZ
    if (sistemas.length === 0) {
      const { data: cotShadow } = await sb.from('evento_pg')
        .select('payload, canal_msg_id')
        .eq('evento_padre_id', params.evento_id)
        .eq('agente_origen', 'A4_COTIZ')
        .eq('shadow', true)
        .limit(3);
      for (const e of cotShadow ?? []) {
        for (const it of ((e.payload as any)?.items ?? [])) {
          if (it.sistema_safra_codigo && !sistemas.includes(it.sistema_safra_codigo)) {
            sistemas.push(it.sistema_safra_codigo);
          }
        }
      }
    }

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      inmueble,
      sistemas_pedidos: sistemas,
      zona_nombre: zonaNombre,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 220)}`
        ).join('\n');

    const inmStr = datos.inmueble
      ? JSON.stringify(datos.inmueble, null, 2)
      : '(sin inmueble registrado)';
    const sistemasStr = datos.sistemas_pedidos.length === 0 ? '(sin sistemas pedidos)' : datos.sistemas_pedidos.join(', ');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A6_RIESGO. Detectás riesgos técnicos del proyecto cruzando varios datos:
INMUEBLE + SISTEMAS PEDIDOS + ZONA + lo que dice el CLIENTE.

TIPOS DE RIESGO Y SUS DISPARADORES:

  vano_alto:
    - Vano > 3m de alto (requiere andamio o escalera grande)
    - Apartamento piso muy alto + ventana de piso a techo
    - Sugerir: "requiere visita técnica para verificar acceso e instalación segura"

  vano_irregular:
    - Cliente menciona forma rara: "trapezoidal", "en ángulo", "en arco", "esquinero"
    - Vano que no es rectangular estándar
    - Sugerir: "riel curvo o sistema a medida, verificar factibilidad"

  viento_fuerte:
    - Toldo + zona ventosa (Melgar, exterior, terraza alta)
    - Cliente menciona "mucho viento", "ventarrón"
    - Sugerir: "motor IP44, soporte reforzado, no toldo manual"

  sol_directo:
    - Cliente menciona "da el sol todo el día", "calienta mucho", "se decolora"
    - Producto pedido sensible a UV (telas no certificadas)
    - Sugerir: "screen solar 5% mínimo, o tela con tratamiento UV"

  humedad:
    - Baño, terraza, lavadero, exterior con lluvia frecuente
    - Componentes metálicos sin tratamiento (riel acero común vs aluminio)
    - Sugerir: "componentes anti-óxido, evitar tela común en humedad alta"

  acceso_dificil:
    - Apartamento piso alto SIN ascensor + producto grande/largo (>2.5m)
    - Conjunto con restricciones de horario o pase
    - Sugerir: "coordinar logística previa, verificar dimensiones de ascensor/escalera"

  exterior_no_certificado:
    - Sistema interior (blackout, panel_japones) pedido para uso exterior
    - Sugerir: "estos sistemas no son aptos para exterior, ofrecer toldo o enrollable de exterior"

  otro: cualquier otro riesgo claro no listado.

Severidad:
  - "alta"   → puede causar falla o garantía rota (toldo manual en zona ventosa,
               sistema interior afuera)
  - "media"  → requiere ajuste de material o cotización
  - "baja"   → mención informativa, no bloquea

CRITERIOS:
  - Solo emitir riesgos con EVIDENCIA en los datos (mensaje, inmueble, zona, sistemas).
  - Si NO hay evidencia clara de ningún riesgo → riesgos_detectados=[].
  - NO inventes datos del inmueble que no estén en el contexto.

R-001 anti-alucinación:
  - evidencia_texto debe ser literal: cita la frase del cliente o el dato del
    inmueble (ej. "cliente mencionó 'da el sol todo el día'" o "inmueble.ascensor=false + apartamento=805").

CONTEXTO:
  INMUEBLE:
${inmStr}
  Zona: ${datos.zona_nombre ?? '(sin zona)'}
  Sistemas pedidos: ${sistemasStr}

Salida JSON EXACTA:
{
  "tipo_evento": "alerta",
  "confianza": "ALERTA",
  "payload": {
    "riesgos_detectados": [
      {
        "tipo": "viento_fuerte",
        "severidad": "alta",
        "descripcion": "Toldo en zona Melgar conocida por vientos fuertes",
        "sugerencia": "Usar motor IP44 + soporte reforzado. NO toldo manual.",
        "evidencia_texto": "Inmueble.ciudad=Melgar + sistema=toldos"
      }
    ],
    "tiene_riesgos_altos": true,
    "resumen": "1 riesgo alto detectado: viento fuerte para toldo en Melgar"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — riesgos_detectados=[] (no hay riesgos técnicos):
    out.confianza = "CONFIRMADO"  (no buzón)

  caso B — riesgos_detectados.length ≥ 1:
    SI ≥1 severidad="alta"        → out.confianza = "ALERTA"   (prio 1, escalación)
    SI solo severidad="media/baja" → out.confianza = "INFERIDO" (buzón normal)

PROHIBIDO ABSOLUTO:
  ✗ riesgos=[] con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ ≥1 riesgo alta sin out.confianza="ALERTA" → ERROR
  ✗ ≥1 riesgo con out.confianza="CONFIRMADO" → ERROR

Sin riesgos (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "alerta",
  "confianza": "CONFIRMADO",
  "payload": {
    "riesgos_detectados": [],
    "tiene_riesgos_altos": false,
    "resumen": "No se detectaron riesgos técnicos"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO DEL CHAT ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion}): ${datos.mensaje_actual.texto}

Detectá riesgos técnicos cruzando MENSAJE + INMUEBLE + SISTEMAS + ZONA.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!Array.isArray(p?.riesgos_detectados)) {
      throw new ValidacionError('schema', 'riesgos_detectados debe ser array');
    }
    let tieneAlta = false;
    for (const r of p.riesgos_detectados as RiesgoOutput[]) {
      if (!TIPOS_RIESGO.includes(r.tipo)) {
        throw new ValidacionError('schema', `riesgo.tipo inválido: ${r.tipo}`);
      }
      if (!SEVERIDADES.includes(r.severidad)) {
        throw new ValidacionError('schema', `severidad inválida: ${r.severidad}`);
      }
      if (typeof r.descripcion !== 'string' || r.descripcion.trim().length === 0) {
        throw new ValidacionError('schema', 'riesgo.descripcion vacía');
      }
      if (typeof r.sugerencia !== 'string' || r.sugerencia.trim().length === 0) {
        throw new ValidacionError('schema', 'riesgo.sugerencia vacía');
      }
      if (typeof r.evidencia_texto !== 'string' || r.evidencia_texto.trim().length === 0) {
        throw new ValidacionError('schema', 'riesgo.evidencia_texto vacía');
      }
      if (r.severidad === 'alta') tieneAlta = true;
    }
    if (typeof p.tiene_riesgos_altos !== 'boolean') {
      throw new ValidacionError('schema', 'tiene_riesgos_altos debe ser boolean');
    }
    if (p.tiene_riesgos_altos !== tieneAlta) {
      throw new ValidacionError('coherencia-a6r',
        `tiene_riesgos_altos=${p.tiene_riesgos_altos} no coincide con cálculo (${tieneAlta})`);
    }

    // Coherencia mecánica out.confianza ↔ riesgos
    const N = p.riesgos_detectados.length;
    if (N === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a6r',
        `riesgos=[] requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (N > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a6r',
        `con riesgos detectados, out.confianza no puede ser 'CONFIRMADO'`);
    }
    if (tieneAlta && out.confianza !== 'ALERTA') {
      throw new ValidacionError('coherencia-a6r',
        `hay riesgo severidad=alta → out.confianza='ALERTA', recibido '${out.confianza}'`);
    }
    if (N > 0 && !tieneAlta && out.confianza !== 'INFERIDO') {
      throw new ValidacionError('coherencia-a6r',
        `riesgos sin severidad alta → out.confianza='INFERIDO', recibido '${out.confianza}'`);
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

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // A6_RIESGO no escribe a tabla de negocio. Las alertas con severidad=alta
    // van al buzón con prio 1 (confianza=ALERTA) para revisión de Jhon antes
    // de confirmar la cotización.
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
