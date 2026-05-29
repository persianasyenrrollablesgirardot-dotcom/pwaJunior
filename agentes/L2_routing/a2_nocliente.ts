/**
 * A2_NOCLIENTE — detector de chats que NO son clientes reales.
 *
 * Distinto a A2_AMBITO:
 *   - A2_AMBITO clasifica entre 6 ámbitos (comercial/proveedor/personal/interno)
 *   - A2_NOCLIENTE responde una pregunta BINARIA: ¿es cliente comercial real?
 *     + subtipo si no lo es (restaurante / transporte / spam / encuesta /
 *       bot / equivocado / otro).
 *
 * Filosofía: CONSERVADOR. Solo marcamos es_cliente=false cuando la evidencia es
 * MUY CLARA. Frente a duda → es_cliente=true + confianza=DUDOSO. Mejor un
 * cliente clasificado mal en alguna ruta que filtrar a un cliente real.
 *
 * Output útil para:
 *   - Suprimir agentes downstream (no gastar tokens en analizar pedidos de
 *     restaurante) — esto se integra al pipeline en versiones futuras.
 *   - Sugerir bloquear/borrar el chat al humano.
 *
 * Tope $0.01/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

const SUBTIPOS_NO_CLIENTE = [
  'colaborador',   // instalador/ayudante/taller propio del negocio (trabaja CON Jhon, no es cliente)
  'restaurante',   // entrega de comida, restaurante con quien Jhon pidió
  'transporte',    // Uber/taxi/mensajería/conductor
  'spam',          // promoción masiva, marketing, cadenas
  'encuesta',      // empresa de encuestas automatizadas
  'bot',           // bot conversacional / IVR / menú automático
  'equivocado',    // persona que mandó mensaje al número equivocado
  'otro',          // claramente no-cliente pero no encaja
] as const;
type SubtipoNoCliente = typeof SUBTIPOS_NO_CLIENTE[number] | null;

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  ts_canal: string;
}

interface DatosA2NoCliente {
  chat_id: number;
  chat_titulo: string | null;
  mensajes_chat: MensajeCtx[];
  mensaje_disparador: MensajeCtx;
}

const N_VENTANA = 15;

export const a2NoClienteHooks: AgenteHooks<DatosA2NoCliente> = {
  async cargarContexto(sb, params) {
    const { data: chat, error: cErr } = await sb.from('chats')
      .select('id, titulo')
      .eq('id', params.chat_id)
      .single();
    if (cErr || !chat) throw new Error(`chat ${params.chat_id} no encontrado: ${cErr?.message}`);

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

    const { data: msgs } = await sb.from('mensajes')
      .select('canal_msg_id, direccion, texto, ts_canal')
      .eq('chat_id', params.chat_id)
      .is('deleted_at', null)
      .not('texto', 'is', null)
      .order('ts_canal', { ascending: false })
      .limit(N_VENTANA);

    const mensajesChat: MensajeCtx[] = (msgs ?? [])
      .reverse()
      .filter(m => m.texto && m.texto.trim().length > 0)
      .map(m => ({
        canal_msg_id: m.canal_msg_id,
        direccion: m.direccion as any,
        texto: m.texto!,
        ts_canal: m.ts_canal,
      }));

    if (!mensajeDisparador && mensajesChat.length > 0) {
      mensajeDisparador = mensajesChat[mensajesChat.length - 1];
    }
    if (!mensajeDisparador) {
      throw new Error(`chat ${params.chat_id} sin mensajes con texto`);
    }

    return {
      chat_id: chat.id,
      chat_titulo: chat.titulo ?? null,
      mensajes_chat: mensajesChat,
      mensaje_disparador: mensajeDisparador,
    };
  },

  construirPrompt(datos, agente) {
    const ventana = datos.mensajes_chat.length === 0
      ? '(chat sin mensajes con texto)'
      : datos.mensajes_chat.map(m =>
          `[msg_id=${m.canal_msg_id}] (${m.direccion === 'saliente' ? 'NEGOCIO' : 'OTRO'}): ${truncar(m.texto, 160)}`
        ).join('\n');

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A2_NOCLIENTE. Detectás si un chat NO es de un cliente real de Persianas Girardot.

CONTEXTO: Persianas Girardot vende persianas/cortinas en Colombia. Los clientes
reales hablan de cotización, medidas, blackout, screen, instalación, ventanas,
conjuntos residenciales, etc.

Tu tarea: DOS valores en la salida:
  - es_cliente: true / false
  - subtipo_no_cliente: si es_cliente=false, uno de:
       * "colaborador"   → instalador/ayudante/taller que TRABAJA con Jhon (no es cliente)
       * "restaurante"   → restaurante/comida (chat surgió porque Jhon pidió comida)
       * "transporte"    → Uber, conductor, mensajería, taxi
       * "spam"          → promoción masiva, marketing, cadena viral
       * "encuesta"      → empresa de encuestas / call center
       * "bot"           → bot automático / IVR / menú interactivo
       * "equivocado"    → escribió al número equivocado, "creo que me equivoqué"
       * "otro"          → claramente no es cliente pero no encaja
       Si es_cliente=true → subtipo_no_cliente=null.

REGLA DE ORO — CONSERVADOR:
  - Marcá es_cliente=false SOLO cuando hay EVIDENCIA CLARA.
  - Frente a la mínima duda → es_cliente=true + confianza_no_cliente="DUDOSO".
  - Es mejor errar y dejar pasar un chat de proveedor (que A2_AMBITO ya clasificó)
    que filtrar a un cliente real.

confianza_no_cliente — SIEMPRE devolvé un valor (NO null, NO vacío):
  - Si es_cliente=false:
      * "CONFIRMADO" → señales muy fuertes (≥2 del mismo subtipo)
      * "INFERIDO"   → señales claras pero algunas
      * "DUDOSO"     → señales débiles, no estás seguro
  - Si es_cliente=true:
      * "CONFIRMADO" → el chat habla de persianas/medidas/cotización claramente
      * "INFERIDO"   → no parece no-cliente pero no tenés evidencia comercial fuerte
      * "DUDOSO"     → solo saludo, muy poco para saber

evidencia_msg_ids:
  - SIEMPRE incluí al menos 1 msg_id de la ventana, aunque sea para decir
    "este mensaje es típico de un cliente real" (cuando es_cliente=true) o
    para citar la señal de no-cliente (cuando es_cliente=false).
  - NUNCA devuelvas evidencia_msg_ids=[].

Señales para cada subtipo:

  colaborador (instalador / ayudante / taller propio del negocio):
    Es alguien que TRABAJA CON o PARA Persianas Girardot — no recibe el servicio,
    lo EJECUTA. Señales fuertes:
    - El OTRO reporta trabajo hecho en primera persona del equipo: "ya instalamos",
      "ya quedó instalado", "terminamos la obra", "ya medí".
    - El OTRO reporta dinero cobrado A NOMBRE del negocio: "me dió 140 en efectivo",
      "el cliente ya pagó", "recogí el saldo", "me consignaron".
    - NEGOCIO le asigna trabajo/dirección o coordinan salir juntos: "a qué horas
      salimos", "la instalación es en <dirección>", "pasa por el taller", "llevá la herramienta".
    - Tono de compañero de trabajo / confianza ("hágale", apodos), logística de campo.
    DISTINCIÓN CLAVE vs cliente: el CLIENTE pregunta precio/medidas/cuándo vienen y
    RECIBE el servicio; el COLABORADOR ejecuta y REPORTA de vuelta (instaló, cobró, sale a ruta).
    Conservador: pedí ≥2 de estas señales antes de marcar colaborador. Un cliente
    que solo dice "ya instalaron, gracias" NO es colaborador.

  restaurante:
    "su pedido", "ya está listo para entrega", "el domiciliario está en camino",
    nombres de restaurantes/marcas de comida, "menú del día", "promo 2x1 hamburguesas",
    "le confirmamos su orden #12345"

  transporte:
    "soy su conductor", "llego en X minutos", "destino confirmado",
    "Uber/Didi/inDriver/Cabify", "su domicilio", "estoy abajo"

  spam (marketing masivo):
    "ESTIMADO CLIENTE", "felicitaciones ha sido seleccionado",
    "crédito de libre inversión", "tarjeta sin cuotas de manejo",
    "Bancolombia/Davivienda le ofrece", "promoción exclusiva",
    enlaces bit.ly/promo, "responda STOP para no recibir"

  encuesta:
    "trabajamos para X Solutions/Research", "encuesta de satisfacción",
    "tomaría 2 minutos de su tiempo", scripts repetitivos formales

  bot:
    "menú principal", "marque 1 para", "no entendí su mensaje",
    respuestas muy genéricas/repetidas sin contexto

  equivocado:
    "creo que me equivoqué de número", "perdón, este no era",
    nombres de personas que Jhon no maneja en contexto comercial

Reglas duras:
  - R-001 anti-alucinación: las señales deben citar el msg_id donde aparecen.
  - Si NO hay señales claras → es_cliente=true, subtipo=null, confianza=DUDOSO
    (mantenemos el chat como cliente potencial).
  - Solo CONFIRMADO si la evidencia es muy fuerte (≥2 señales del mismo subtipo).

CÁLCULO MECÁNICO de "confianza" global (NO es opinión, es un cálculo):
  REGLA: marcar a alguien como NO-cliente es una decisión sensible. SIEMPRE
         pasa por aprobación humana, aunque estés seguro. Jhon decide si lo
         bloquea o lo deja.

  caso A — es_cliente=true (sigue siendo cliente real):
    out.confianza = payload.confianza_no_cliente  (copia tal cual)
       CONFIRMADO → no va al buzón (todo OK, sigue siendo cliente)
       INFERIDO   → al buzón (Jhon refuerza si quiere)
       DUDOSO     → al buzón con prioridad

  caso B — es_cliente=false (proponés marcar como NO-cliente):
    SI confianza_no_cliente="DUDOSO" → out.confianza="DUDOSO"
    SI confianza_no_cliente="INFERIDO" → out.confianza="INFERIDO"
    SI confianza_no_cliente="CONFIRMADO" → out.confianza="INFERIDO"  (forzado)
    → siempre va al buzón porque Jhon debe aprobar el descarte.

PROHIBIDO ABSOLUTO:
  ✗ es_cliente=false con out.confianza="CONFIRMADO" → ERROR mecánico (rechazado)
  ✗ es_cliente=true con out.confianza ≠ confianza_no_cliente → ERROR mecánico

Devolvés JSON EXACTO con la forma de los ejemplos siguientes.

EJEMPLO 1 — no-cliente CONFIRMADO (caso B, queda INFERIDO forzado para que vaya al buzón):
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "es_cliente": false,
    "subtipo_no_cliente": "restaurante",
    "confianza_no_cliente": "CONFIRMADO",
    "señales": ["mensaje 'su pedido está listo'", "marca de restaurante mencionada"],
    "resumen": "Chat con restaurante, no es cliente de persianas"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 2 — CLIENTE REAL CONFIRMADO (caso A, copia → directo, no buzón):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "es_cliente": true,
    "subtipo_no_cliente": null,
    "confianza_no_cliente": "CONFIRMADO",
    "señales": ["mensaje habla de cotización de persianas", "menciona medidas y blackout"],
    "resumen": "Cliente real interesado en persianas"
  },
  "evidencia_msg_ids": ["ABC"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 3 — edge AMBIGUO (es_cliente=true por regla conservadora, DUDOSO → buzón):
{
  "tipo_evento": "dato_extraido",
  "confianza": "DUDOSO",
  "payload": {
    "es_cliente": true,
    "subtipo_no_cliente": null,
    "confianza_no_cliente": "DUDOSO",
    "señales": ["chat muy corto", "solo saludo, no hay contenido"],
    "resumen": "Insuficiente evidencia, asumimos cliente potencial"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 4 — COLABORADOR/instalador (caso B, queda INFERIDO forzado):
{
  "tipo_evento": "dato_extraido",
  "confianza": "INFERIDO",
  "payload": {
    "es_cliente": false,
    "subtipo_no_cliente": "colaborador",
    "confianza_no_cliente": "CONFIRMADO",
    "señales": ["reporta 'ya instalamos' en nombre del equipo", "reporta 'me dió 140 en efectivo' (cobró por el negocio)", "coordinan 'a qué horas salimos' a la ruta"],
    "resumen": "Instalador/colaborador del negocio, no un cliente"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Chat #${datos.chat_id} ${datos.chat_titulo ? `"${datos.chat_titulo}"` : ''}

=== VENTANA DEL CHAT (últimos ${datos.mensajes_chat.length} mensajes) ===
${ventana}

Determiná si este chat es de un cliente real de persianas o NO lo es.
Si dudás → es_cliente=true + DUDOSO. No es nuestro trabajo etiquetar
ámbitos comerciales/proveedor — solo detectamos NO-clientes (restaurante,
transporte, spam, etc.).`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (typeof p?.es_cliente !== 'boolean') {
      throw new ValidacionError('schema', `es_cliente debe ser boolean: ${JSON.stringify(p?.es_cliente)}`);
    }
    if (p.es_cliente === true) {
      if (p.subtipo_no_cliente !== null && p.subtipo_no_cliente !== undefined) {
        throw new ValidacionError('schema',
          `Si es_cliente=true, subtipo_no_cliente debe ser null; got ${JSON.stringify(p.subtipo_no_cliente)}`);
      }
    } else {
      if (!SUBTIPOS_NO_CLIENTE.includes(p.subtipo_no_cliente)) {
        throw new ValidacionError('schema',
          `subtipo_no_cliente inválido: ${JSON.stringify(p.subtipo_no_cliente)} (válidos: ${SUBTIPOS_NO_CLIENTE.join(',')})`);
      }
    }
    if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(p?.confianza_no_cliente)) {
      throw new ValidacionError('schema', `confianza_no_cliente inválida: ${p?.confianza_no_cliente}`);
    }
    if (!Array.isArray(p?.señales)) {
      throw new ValidacionError('schema', 'payload.señales debe ser array');
    }
    // Evidencia con tolerancia de prefijo true_/false_
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
        'evidencia_msg_ids debe citar al menos 1 msg_id de la ventana');
    }
    // Coherencia es_cliente ↔ out.confianza
    if (p.es_cliente === false && out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a2-nocliente',
        `es_cliente=false no puede tener out.confianza='CONFIRMADO' (descarte requiere aprobación humana → INFERIDO)`);
    }
    if (p.es_cliente === true && out.confianza !== p.confianza_no_cliente) {
      throw new ValidacionError('coherencia-a2-nocliente',
        `es_cliente=true requiere out.confianza='${p.confianza_no_cliente}' (copia de confianza_no_cliente), recibido '${out.confianza}'`);
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // L2: no muta el chat. Si es_cliente=false con CONFIRMADO, en versión
    // productiva podríamos sugerir bloquear el chat (chats_bloqueados).
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
