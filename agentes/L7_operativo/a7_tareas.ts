/**
 * A7_TAREAS — extractor de tareas operativas del mensaje.
 *
 * Detecta cuando el cliente (o el contexto) implica que hay que hacer algo:
 *   "Llamame mañana" → tarea llamar, fecha=mañana
 *   "Vengan el viernes a instalar" → agendar_instalacion, viernes
 *   "Pasame la ficha técnica" → pedir_ficha (le pedimos al proveedor)
 *   "Confírmame cuando llegue el pago" → confirmar_pago
 *
 * Tipos válidos (CHECK del schema tareas):
 *   llamar, enviar_cotizacion, confirmar_pago, pedir_ficha,
 *   agendar_instalacion, reclamar_proveedor, pedir_resena, otro
 *
 * Diferente a:
 *   - A4_COTIZ → propone cotización (no tarea)
 *   - A4_RECOMPRA → genera tarea de seguimiento batch
 *   - A4_REFERIDOS → genera tarea de seguimiento de referido
 *   - A7_TAREAS → ruta default cuando A2_INTENCION no encajó en otras
 *
 * Múltiples tareas en un mensaje son posibles. Listalas todas.
 *
 * tipo_evento='tarea'. Tope $0.02/invocación.
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

interface DatosA7Tareas {
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  fecha_hoy: string;       // YYYY-MM-DD para inferencia de fechas relativas
}

const TIPOS_TAREA = [
  'llamar', 'enviar_cotizacion', 'confirmar_pago', 'pedir_ficha',
  'agendar_instalacion', 'reclamar_proveedor', 'pedir_resena', 'otro',
] as const;
type TipoTarea = typeof TIPOS_TAREA[number];

interface TareaOutput {
  tipo: TipoTarea;
  titulo: string;
  descripcion: string;
  fecha_vence: string | null;       // YYYY-MM-DD
  hora_vence: string | null;        // HH:MM
  prioridad: number;                // 1-10
  asignado_a: string;
  evidencia_texto: string;          // frase del mensaje que motivó la tarea
}

const N_CONTEXTO = 4;

export const a7TareasHooks: AgenteHooks<DatosA7Tareas> = {
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

    return {
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      fecha_hoy: new Date().toISOString().slice(0, 10),
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto)'
      : datos.mensajes_contexto.map(m =>
          `[${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 200)}`
        ).join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A7_TAREAS. Extraés tareas OPERATIVAS que el chat sugiere realizar.

TIPOS DE TAREA VÁLIDOS (usá EXACTAMENTE estos codigos del schema):
  - llamar               → "llamame", "que me llamen", "marcame"
  - enviar_cotizacion    → "pasame la cotización", "mandame propuesta",
                            "envíame el presupuesto"
  - confirmar_pago       → "confirmáme cuando llegue", "avisame del pago"
  - pedir_ficha          → "mandame la ficha técnica", "info detallada del producto"
  - agendar_instalacion  → "vengan el viernes", "para cuándo instalan",
                            "fecha de instalación"
  - reclamar_proveedor   → "pedile al proveedor", "cuando llega lo del proveedor"
  - pedir_resena         → "mandame el link de Google", "cómo dejo la reseña"
  - otro                 → cualquier acción que no encaje en los anteriores
                            pero que el negocio tiene que hacer

INFERIR FECHA_VENCE (YYYY-MM-DD):
  Hoy = ${datos.fecha_hoy}
  - "hoy"                → ${datos.fecha_hoy}
  - "mañana"             → ${addDays(datos.fecha_hoy, 1)}
  - "pasado mañana"      → ${addDays(datos.fecha_hoy, 2)}
  - "esta semana"        → fin de esta semana
  - "el viernes"         → próximo viernes
  - "el lunes"           → próximo lunes
  - "en X días"          → hoy + X
  - "para la otra semana"→ próximo lunes o miércoles
  - sin fecha            → null (deja que humano lo decida)

PRIORIDAD (1-10, donde 10 = urgente):
  - "urgente", "YA", "ahora mismo"  → 9-10
  - reporte de falla / queja        → 8
  - cliente pide responder pronto   → 6-7
  - tarea normal                    → 4-5
  - tarea informativa               → 1-3

QUIÉN PIDE LA TAREA:
  - Direccion=entrante (cliente): cliente pide algo al negocio
  - Direccion=saliente (negocio): negocio se hace nota a sí mismo (raro pero
    válido: "hay que llamar al cliente en una semana")

NO EXTRAER:
  - Cotizaciones (eso es A4_COTIZ)
  - Reportes de falla (eso es A8_GARANTIA)
  - Promesas de pago futuras (NO genera tarea, A5_ABONO ya lo nota)
  - Saludos / agradecimientos
  Si el mensaje no tiene acción operativa clara → tareas=[].

REGLAS DURAS:
  - tipo DEBE estar en el enum ${TIPOS_TAREA.join(', ')}.
  - fecha_vence (si no null) en formato YYYY-MM-DD.
  - hora_vence (si no null) formato HH:MM (24h).
  - prioridad ∈ [1, 10].
  - asignado_a: default "jhon".
  - evidencia_texto: frase exacta del mensaje que motivó la tarea (cita
    LITERAL, sin parafrasear).

CÁLCULO MECÁNICO de "confianza" global (NO opinión, regla fija):
  caso A — tareas=[] (no hay tarea operativa real):
    out.confianza = "CONFIRMADO"  (no va al buzón, no aporta revisar)
  caso B — tareas.length ≥ 1:
    out.confianza = "INFERIDO"    (al buzón para que Jhon apruebe)

PROHIBIDO ABSOLUTO:
  ✗ tareas=[] con out.confianza ≠ "CONFIRMADO" → ERROR
  ✗ tareas≥1 con out.confianza = "CONFIRMADO" → ERROR

Salida JSON EXACTA — con tareas:
{
  "tipo_evento": "tarea",
  "confianza": "INFERIDO",
  "payload": {
    "tareas": [
      {
        "tipo": "llamar",
        "titulo": "Llamar a {persona} mañana",
        "descripcion": "El cliente pidió que lo llamemos mañana para coordinar instalación.",
        "fecha_vence": "${addDays(datos.fecha_hoy, 1)}",
        "hora_vence": null,
        "prioridad": 6,
        "asignado_a": "jhon",
        "evidencia_texto": "llamame mañana"
      }
    ],
    "resumen": "1 tarea: llamar mañana"
  },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}

Sin tareas (caso A, CONFIRMADO → NO al buzón):
{
  "tipo_evento": "tarea",
  "confianza": "CONFIRMADO",
  "payload": { "tareas": [], "resumen": "Sin tareas operativas en el mensaje" },
  "evidencia_msg_ids": ["${datos.mensaje_actual.canal_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `=== CONTEXTO ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[${datos.mensaje_actual.canal_msg_id}] (${datos.mensaje_actual.direccion}): ${datos.mensaje_actual.texto}

Detectá tareas operativas. Si el mensaje no implica acción clara, devolvé tareas=[].`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!Array.isArray(p?.tareas)) {
      throw new ValidacionError('schema', 'payload.tareas debe ser array');
    }
    for (const t of p.tareas as TareaOutput[]) {
      if (!TIPOS_TAREA.includes(t.tipo as any)) {
        throw new ValidacionError('schema', `tipo='${t.tipo}' no está en enum`);
      }
      if (typeof t.titulo !== 'string' || t.titulo.trim().length === 0) {
        throw new ValidacionError('schema', 'tarea.titulo vacío');
      }
      if (t.fecha_vence !== null && t.fecha_vence !== undefined) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(t.fecha_vence)) {
          throw new ValidacionError('schema', `fecha_vence inválida: ${t.fecha_vence}`);
        }
      }
      if (t.hora_vence !== null && t.hora_vence !== undefined) {
        if (!/^\d{2}:\d{2}$/.test(t.hora_vence)) {
          throw new ValidacionError('schema', `hora_vence inválida: ${t.hora_vence}`);
        }
      }
      if (typeof t.prioridad !== 'number' || t.prioridad < 1 || t.prioridad > 10) {
        throw new ValidacionError('schema', `prioridad fuera de [1,10]: ${t.prioridad}`);
      }
      if (typeof t.evidencia_texto !== 'string' || t.evidencia_texto.trim().length === 0) {
        throw new ValidacionError('schema', 'evidencia_texto vacía');
      }
      const textoMsg = datos.mensaje_actual.texto.toLowerCase();
      const evidenciaTok = t.evidencia_texto.toLowerCase().split(/\s+/).filter(w => w.length > 3);
      const ocurrencias = evidenciaTok.filter(w => textoMsg.includes(w)).length;
      if (evidenciaTok.length > 0 && ocurrencias === 0) {
        throw new ValidacionError('R-anti-alucinacion',
          `evidencia_texto "${t.evidencia_texto}" no aparece en el mensaje analizado`);
      }
    }

    // Coherencia mecánica out.confianza ↔ N tareas
    if (p.tareas.length === 0 && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a7t',
        `tareas=[] requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (p.tareas.length > 0 && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a7t',
        `tareas.length=${p.tareas.length} requiere out.confianza='INFERIDO' (Jhon aprueba), no CONFIRMADO`);
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
    const tareas = Array.isArray(p.tareas) ? p.tareas as TareaOutput[] : [];
    if (tareas.length === 0) return;

    // Insertar PRIMERA tarea como shadow=true. Si hay más, las metemos en notas
    // para que Jhon vea en el buzón y cree manualmente las que quiera.
    const t = tareas[0];
    const desc = tareas.length > 1
      ? `${t.descripcion}\n\n— Detectadas ${tareas.length} tareas. Esta es la primera; ver detalle del ítem del buzón.`
      : t.descripcion;
    const { data: row, error } = await sb.from('tareas').insert({
      persona_id: ctx.persona_id,
      proyecto_id: ctx.proyecto_id,
      titulo: t.titulo,
      descripcion: desc,
      tipo: t.tipo,
      fecha_vence: t.fecha_vence,
      hora_vence: t.hora_vence,
      asignado_a: t.asignado_a || 'jhon',
      origen: 'agente',
      origen_chat_id: ctx.chat_id,
      prioridad: t.prioridad,
      shadow: true,
      agente_origen: ctx.agente.codigo,
    } as any).select('id').single();
    if (error || !row) {
      throw new Error(`A7_TAREAS insert tarea: ${error?.message ?? 'sin data'}`);
    }
    return { entidad_tipo: 'tarea', entidad_id: row.id };
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
