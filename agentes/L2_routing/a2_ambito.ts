/**
 * A2_AMBITO — clasificador de ámbito del chat (correctivo).
 *
 * A diferencia de A2_INTENCION (que clasifica UN mensaje), A2_AMBITO analiza el
 * CHAT COMPLETO (10-15 mensajes) y propone el ámbito más probable.
 *
 * Ámbitos válidos (tabla `ambitos`):
 *   - comercial          → cliente actual o potencial de persianas
 *   - proveedor          → empresa que vende a Safra (telas, motores, etc.)
 *   - personal_familia   → familia de Jhon
 *   - personal_amigos    → amigos personales
 *   - personal_otros     → conocido no clasificable / spam detectado
 *   - interno_equipo     → instalador, técnico, contadora, equipo de Safra
 *
 * Rol correctivo: si el chat ya tiene `ambito_confirmado=true`, A2_AMBITO solo
 * loggea (CONFIRMADO sin cambio). Si NO está confirmado o difiere de lo que
 * detectamos, propone el cambio al buzón.
 *
 * No muta `chats.ambito` directamente (eso lo hace el humano vía buzón o un
 * agente de capa superior con autoridad de escritura).
 *
 * Tope $0.01/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

const AMBITOS = [
  'comercial',
  'proveedor',
  'personal_familia',
  'personal_amigos',
  'personal_otros',
  'interno_equipo',
] as const;
type Ambito = typeof AMBITOS[number];

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  ts_canal: string;
}

interface DatosA2Ambito {
  chat_id: number;
  chat_titulo: string | null;
  ambito_actual: string;
  ambito_confirmado: boolean;
  mensajes_chat: MensajeCtx[];     // ventana amplia del chat (15 últimos)
  mensaje_disparador: MensajeCtx;  // el msg que llegó en este evento
}

const N_VENTANA_CHAT = 15;

export const a2AmbitoHooks: AgenteHooks<DatosA2Ambito> = {
  async cargarContexto(sb, params) {
    // 1. Cargar chat actual con su ámbito + flag confirmado
    const { data: chat, error: cErr } = await sb.from('chats')
      .select('id, titulo, ambito, ambito_confirmado')
      .eq('id', params.chat_id)
      .single();
    if (cErr || !chat) throw new Error(`chat ${params.chat_id} no encontrado: ${cErr?.message}`);

    // 2. Mensaje disparador
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    const msgIdPrincipal: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? evt?.canal_msg_id ?? null;

    let mensajeDisparador: MensajeCtx | null = null;
    if (msgIdPrincipal) {
      const { data: m } = await sb.from('mensajes')
        .select('canal_msg_id, direccion, texto, ts_canal')
        .eq('chat_id', params.chat_id)
        .eq('canal_msg_id', msgIdPrincipal)
        .is('deleted_at', null)
        .maybeSingle();
      if (m?.texto) mensajeDisparador = { canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto, ts_canal: m.ts_canal };
    }

    // 3. Ventana amplia del chat (15 mensajes más recientes con texto)
    const { data: msgs } = await sb.from('mensajes')
      .select('canal_msg_id, direccion, texto, ts_canal')
      .eq('chat_id', params.chat_id)
      .is('deleted_at', null)
      .not('texto', 'is', null)
      .order('ts_canal', { ascending: false })
      .limit(N_VENTANA_CHAT);

    const mensajesChat: MensajeCtx[] = (msgs ?? [])
      .reverse()
      .filter(m => m.texto && m.texto.trim().length > 0)
      .map(m => ({
        canal_msg_id: m.canal_msg_id,
        direccion: m.direccion as any,
        texto: m.texto!,
        ts_canal: m.ts_canal,
      }));

    // Si no encontramos mensaje disparador, usar el último de la ventana
    if (!mensajeDisparador && mensajesChat.length > 0) {
      mensajeDisparador = mensajesChat[mensajesChat.length - 1];
    }
    if (!mensajeDisparador) {
      throw new Error(`chat ${params.chat_id} no tiene mensajes con texto`);
    }

    return {
      chat_id: chat.id,
      chat_titulo: chat.titulo ?? null,
      ambito_actual: chat.ambito,
      ambito_confirmado: !!chat.ambito_confirmado,
      mensajes_chat: mensajesChat,
      mensaje_disparador: mensajeDisparador,
    };
  },

  construirPrompt(datos, agente) {
    const ventana = datos.mensajes_chat.length === 0
      ? '(chat sin mensajes con texto)'
      : datos.mensajes_chat.map(m =>
          `[msg_id=${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'CLIENTE'}): ${truncar(m.texto, 160)}`
        ).join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A2_AMBITO. Clasificás el chat COMPLETO en EXACTAMENTE UN ámbito.
No clasificás cada mensaje, mirás la conversación entera.

Ámbitos (mutuamente excluyentes):

  comercial         → Cliente actual o potencial de persianas/cortinas.
                      Señales: habla de cotización, medidas, precios, persianas,
                               instalación, ventanas, espacios del hogar.

  proveedor         → Empresa que VENDE insumos a Safra (no es cliente).
                      Señales: factura proveedor, lote, despacho, telas al por mayor,
                               motores, "envío su pedido", "ref proveedor", logo de empresa
                               textil/industrial. Generalmente B2B con jerga distinta.

  personal_familia  → Familiar de Jhon (esposa, hijos, padres, hermanos).
                      Señales: trato muy familiar, temas domésticos no comerciales,
                               apodos cariñosos, ningún tema de negocio en la ventana.

  personal_amigos   → Amigo de Jhon.
                      Señales: conversación casual entre adultos, planes sociales,
                               sin pedido de persianas.

  personal_otros    → Conocido no clasificable, spam, encuesta, marketing masivo.
                      Señales: "ESTIMADO CLIENTE", encuesta automática, links de promo,
                               mensaje único masivo sin respuesta, llegó por error.

  interno_equipo    → Instalador/técnico/contadora del equipo de Safra.
                      Señales: trato profesional pero interno, jerga operativa
                               ("ya llegué a la dirección", "termino en una hora"),
                               coordina trabajo de campo, NO compra.

Reglas:
  - UNA SOLA etiqueta. Mirá la VENTANA del chat completo, no un mensaje aislado.
  - confianza_ambito según señales claras:
       CONFIRMADO  → señales múltiples sin duda (chat largo con keywords claros)
       INFERIDO    → señales pero alguna ambigüedad (1-2 mensajes solamente)
       DUDOSO      → muy poco para juzgar
  - Si DUDÁS y el ambito_actual es razonable → mantenelo + DUDOSO.
  - R-001 anti-alucinación: TODA propuesta cita ≥1 msg_id de la ventana.

CÁLCULO MECÁNICO de "confianza" global (NO es una opinión, es un cálculo):
  REGLA: si proponés un cambio de ámbito, SIEMPRE pasa por aprobación humana,
         aunque estés seguro del nuevo ámbito. Jhon es la autoridad final.

  caso A — cambio_propuesto=false (ratificás el ámbito actual):
    out.confianza = payload.confianza_ambito  (copia tal cual)
       CONFIRMADO → no va al buzón (ámbito ya está bien)
       INFERIDO   → al buzón (Jhon refuerza si quiere)
       DUDOSO     → al buzón con prioridad

  caso B — cambio_propuesto=true (proponés cambiar el ámbito):
    SI confianza_ambito="DUDOSO" → out.confianza="DUDOSO"
    SI confianza_ambito="INFERIDO" → out.confianza="INFERIDO"
    SI confianza_ambito="CONFIRMADO" → out.confianza="INFERIDO"  (forzado, NO CONFIRMADO)
    → siempre va al buzón porque Jhon debe aprobar el cambio.

PROHIBIDO ABSOLUTO:
  ✗ cambio_propuesto=true con out.confianza="CONFIRMADO" → ERROR mecánico (rechazado)
  ✗ cambio_propuesto=false con out.confianza ≠ confianza_ambito → ERROR mecánico (rechazado)

Devolvés JSON EXACTO con la forma de los ejemplos siguientes.

EJEMPLO 1 — chat comercial sin cambio (caso A, CONFIRMADO):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "ambito_propuesto": "comercial",
    "ambito_actual": "comercial",
    "cambio_propuesto": false,
    "confianza_ambito": "CONFIRMADO",
    "señales": ["habla de blackout", "pidió cotización", "menciona medidas"],
    "resumen": "Cliente comercial activo"
  },
  "evidencia_msg_ids": ["XYZ", "ABC"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 2 — cambio propuesto (caso B, queda INFERIDO aunque LLM esté seguro):
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "ambito_propuesto": "proveedor",
    "ambito_actual": "comercial",
    "cambio_propuesto": true,
    "confianza_ambito": "CONFIRMADO",
    "señales": ["factura proveedor", "lote textil", "B2B"],
    "resumen": "Reclasificar a proveedor"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Chat #${datos.chat_id} ${datos.chat_titulo ? `"${datos.chat_titulo}" ` : ''}
Ámbito ACTUAL: ${datos.ambito_actual} (${datos.ambito_confirmado ? 'CONFIRMADO por Jhon' : 'sin confirmar'})

=== VENTANA DEL CHAT (últimos ${datos.mensajes_chat.length} mensajes) ===
${ventana}

Clasificá el ámbito del chat completo. Devolvé también:
  - ambito_propuesto = tu clasificación
  - ambito_actual    = "${datos.ambito_actual}" (lo dejás tal cual)
  - cambio_propuesto = true si ambito_propuesto !== ambito_actual

Si el chat es muy corto (1-2 mensajes), inclinate por mantener el ambito_actual
con confianza DUDOSO (mejor no proponer cambios sin evidencia).`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!AMBITOS.includes(p?.ambito_propuesto)) {
      throw new ValidacionError('schema',
        `ambito_propuesto inválido: ${JSON.stringify(p?.ambito_propuesto)} (válidos: ${AMBITOS.join(',')})`);
    }
    if (p?.ambito_actual !== datos.ambito_actual) {
      throw new ValidacionError('schema',
        `ambito_actual debe reflejar el real (${datos.ambito_actual}), pero el agente puso ${p?.ambito_actual}`);
    }
    if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(p?.confianza_ambito)) {
      throw new ValidacionError('schema', `confianza_ambito inválida: ${p?.confianza_ambito}`);
    }
    const cambio = p.ambito_propuesto !== p.ambito_actual;
    if (typeof p?.cambio_propuesto !== 'boolean' || p.cambio_propuesto !== cambio) {
      throw new ValidacionError('schema',
        `cambio_propuesto debe ser ${cambio} (propuesto=${p.ambito_propuesto} actual=${p.ambito_actual}), pero el agente puso ${p?.cambio_propuesto}`);
    }
    if (!Array.isArray(p?.señales)) {
      throw new ValidacionError('schema', 'payload.señales debe ser array');
    }
    // Evidencia: al menos 1 msg_id de la ventana del chat (con tolerancia prefijo)
    const msgIdsValidos = new Set<string>(datos.mensajes_chat.map(m => m.canal_msg_id));
    let haEvidencia = false;
    if (Array.isArray(out.evidencia_msg_ids)) {
      for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
        const real = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
        if (real) {
          out.evidencia_msg_ids[i] = real;
          haEvidencia = true;
        }
      }
    }
    if (!haEvidencia) {
      throw new ValidacionError('R-anti-alucinacion',
        'evidencia_msg_ids debe citar al menos 1 mensaje de la ventana del chat');
    }

    // Coherencia cambio_propuesto ↔ out.confianza
    if (cambio && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a2-ambito',
        `cambio_propuesto=true no puede tener out.confianza='CONFIRMADO' (cambios requieren aprobación humana → INFERIDO)`);
    }
    if (!cambio && out.confianza !== p.confianza_ambito) {
      throw new ValidacionError('coherencia-a2-ambito',
        `cambio_propuesto=false requiere out.confianza='${p.confianza_ambito}' (copia de confianza_ambito), recibido '${out.confianza}'`);
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // L2: no muta chats.ambito directamente. El cambio se propone al buzón
    // (lo hace el runner automáticamente si confianza != CONFIRMADO).
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
