/**
 * A2_ROL — detector de rol del EMISOR del mensaje.
 *
 * Distinto a:
 *   - A2_AMBITO  → clasifica el CHAT (toda la conversación)
 *   - A2_INTENCION → clasifica la INTENCIÓN del mensaje
 *   - A2_ROL → clasifica al AUTOR del mensaje específico
 *
 * En chats individuales 1:1 el rol casi siempre es 'cliente'. Donde
 * realmente aporta es en GRUPOS WhatsApp donde el cliente comparte
 * conversación con su esposa, el administrador del conjunto, un técnico
 * externo, vecinos, etc. Cada mensaje puede tener un autor distinto.
 *
 * Roles válidos:
 *   - cliente       → el cliente principal del proyecto comercial
 *   - vecino        → vecino del cliente que entra al chat
 *   - tecnico       → instalador/técnico externo coordinando trabajo
 *   - familiar      → esposa/hijo/hermano/familia del cliente
 *   - admin         → administrador del conjunto/edificio
 *   - proveedor     → un proveedor de Safra interactuando (raro)
 *   - desconocido   → no se puede determinar
 *
 * Default conservador: chat individual + sin señales → 'cliente' + DUDOSO.
 *
 * Tope $0.01/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

const ROLES = ['cliente', 'vecino', 'tecnico', 'familiar', 'admin', 'proveedor', 'desconocido'] as const;
type Rol = typeof ROLES[number];

interface MensajeCtx {
  canal_msg_id: string;
  direccion: 'entrante' | 'saliente';
  texto: string;
  ts_canal: string;
  autor_jid?: string | null;  // en grupos: jid del emisor real
}

interface DatosA2Rol {
  chat_tipo: 'individual' | 'grupo' | 'difusion';
  chat_titulo: string | null;
  mensaje_actual: MensajeCtx;
  mensajes_contexto: MensajeCtx[];
  autor_jid_actual: string | null;
}

const N_CONTEXTO = 5;

export const a2RolHooks: AgenteHooks<DatosA2Rol> = {
  async cargarContexto(sb, params) {
    const { data: chat, error: cErr } = await sb.from('chats')
      .select('id, titulo, tipo')
      .eq('id', params.chat_id)
      .single();
    if (cErr || !chat) throw new Error(`chat ${params.chat_id} no encontrado: ${cErr?.message}`);

    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal, payload')
      .eq('id', params.evento_id)
      .single();
    const msgIdPrincipal: string | null = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? null;

    let mensajeActual: MensajeCtx | null = null;
    if (msgIdPrincipal) {
      const { data: m } = await sb.from('mensajes')
        .select('canal_msg_id, direccion, texto, ts_canal, autor_jid')
        .eq('chat_id', params.chat_id)
        .eq('canal_msg_id', msgIdPrincipal)
        .is('deleted_at', null)
        .maybeSingle();
      if (m?.texto) {
        mensajeActual = {
          canal_msg_id: m.canal_msg_id,
          direccion: m.direccion as any,
          texto: m.texto,
          ts_canal: m.ts_canal,
          autor_jid: m.autor_jid,
        };
      }
    }
    if (!mensajeActual) {
      const { data: msgs } = await sb.from('mensajes')
        .select('canal_msg_id, direccion, texto, ts_canal, autor_jid')
        .eq('chat_id', params.chat_id)
        .is('deleted_at', null)
        .not('texto', 'is', null)
        .lte('ts_canal', evt?.ts_canal ?? new Date().toISOString())
        .order('ts_canal', { ascending: false })
        .limit(1);
      const m = msgs?.[0];
      if (!m?.texto) throw new Error(`evento ${params.evento_id} sin mensaje con texto`);
      mensajeActual = {
        canal_msg_id: m.canal_msg_id, direccion: m.direccion as any, texto: m.texto,
        ts_canal: m.ts_canal, autor_jid: m.autor_jid,
      };
    }

    const { data: ctxMsgs } = await sb.from('mensajes')
      .select('canal_msg_id, direccion, texto, ts_canal, autor_jid')
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
        autor_jid: m.autor_jid,
      }));

    return {
      chat_tipo: chat.tipo as any,
      chat_titulo: chat.titulo ?? null,
      mensaje_actual: mensajeActual,
      mensajes_contexto: contexto,
      autor_jid_actual: mensajeActual.autor_jid ?? null,
    };
  },

  construirPrompt(datos, agente) {
    const ctxLineas = datos.mensajes_contexto.length === 0
      ? '(sin contexto previo)'
      : datos.mensajes_contexto.map(m => {
          const quien = m.direccion === 'saliente' ? 'NEGOCIO' : `OTRO${m.autor_jid ? ` (autor=${m.autor_jid})` : ''}`;
          return `[msg_id=${m.canal_msg_id}] (${quien}): ${truncar(m.texto, 200)}`;
        }).join('\n');

    const quienAct = datos.mensaje_actual.direccion === 'saliente' ? 'NEGOCIO' : `OTRO${datos.autor_jid_actual ? ` (autor=${datos.autor_jid_actual})` : ''}`;

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A2_ROL. Identificás el ROL del autor del MENSAJE A ANALIZAR.

NO clasificás al "negocio" — si direccion=saliente, el rol es siempre "desconocido"
(eso lo emite Persianas Girardot, no necesita clasificación).

Roles válidos (para mensajes ENTRANTES):
  - cliente     → el cliente principal del proyecto comercial.
                  Default en chats INDIVIDUALES (1 a 1).
  - familiar    → esposa, hijo, hermano, padres del cliente.
                  Señales: "soy la esposa de", "mi marido", "papá no podía
                  contestar", trato familiar entre dos personas en el chat.
  - tecnico     → instalador, electricista, plomero, técnico externo coordinando.
                  Señales: "soy el técnico que va a", "vengo de parte del cliente
                  a coordinar", jerga operativa, NO compra producto.
  - admin       → administrador de conjunto/edificio.
                  Señales: "soy administrador del conjunto", "como administradora
                  del edificio necesito", "para autorizar acceso", "permisos del
                  consejo".
  - vecino      → vecino del cliente que entra al chat (a veces grupos).
                  Señales: "soy vecino de", "me dio su número Don X", "yo vivo al
                  lado".
  - proveedor   → proveedor de Safra que se infiltra al chat. Raro.
                  Señales: jerga B2B textil, lote, despacho, factura proveedor.
  - desconocido → no se puede inferir el rol con seguridad.

Contexto del chat:
  - tipo=individual → 1 a 1 con Safra. Default cliente.
  - tipo=grupo      → varios autores. Cada mensaje puede tener rol distinto.
  - tipo=difusion   → mensaje masivo de Safra. Default desconocido.

DEFAULT (caso esperado, sin saturar el buzón):
  - Si el chat es INDIVIDUAL y NO hay señales de otro rol → rol="cliente" + CONFIRMADO.
    Razón: en chats 1 a 1 el cliente es casi siempre quien escribe. Mandar este
    caso al buzón es ruido. Solo va a DUDOSO si HAY indicios de que NO es el
    cliente (familiar, técnico, admin).
  - Si el chat es GRUPO y NO hay señales → rol="desconocido" + DUDOSO.
    Razón: en grupos hay múltiples autores, ahí sí vale la pena revisar.
  - Si direccion=saliente (NEGOCIO) → rol="desconocido" + CONFIRMADO.

Usar DUDOSO/INFERIDO solo cuando HAY señal de rol no-default:
  - "soy la esposa de", "como administradora del conjunto", etc.

Reglas duras:
  R-001: evidencia obligatoria — citá el msg_id donde aparece la señal.
  Anti-contaminación: NO uses identidades de otros clientes que recuerdes.
  es_emisor_principal: true SI el rol es "cliente" Y este es el cliente principal
                       del proyecto (en chats individuales casi siempre true);
                       false si es familiar/admin/vecino/tecnico/proveedor o si
                       hay múltiples clientes en grupos.

CÁLCULO MECÁNICO de "confianza" global (NO es una opinión, es una copia):
  out.confianza SIEMPRE = payload.confianza_rol
    - confianza_rol="CONFIRMADO" → out.confianza="CONFIRMADO"  (no va al buzón)
    - confianza_rol="INFERIDO"   → out.confianza="INFERIDO"   (Jhon revisa)
    - confianza_rol="DUDOSO"     → out.confianza="DUDOSO"     (Jhon revisa, prioridad)

PROHIBIDO ABSOLUTO:
  ✗ out.confianza ≠ payload.confianza_rol → ERROR mecánico (rechazado)
  ✗ rol_emisor ≠ "cliente" con es_emisor_principal=true → ERROR de coherencia

Devolvés JSON EXACTO con la forma de los ejemplos siguientes.

EJEMPLO 1 — mensaje del NEGOCIO (siempre desconocido + CONFIRMADO):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "rol_emisor": "desconocido",
    "es_emisor_principal": false,
    "confianza_rol": "CONFIRMADO",
    "señales": ["mensaje saliente del propio negocio"],
    "resumen": "Mensaje del negocio, no clasificamos"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 2 — esposa del cliente (familiar + CONFIRMADO):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "rol_emisor": "familiar",
    "es_emisor_principal": false,
    "confianza_rol": "CONFIRMADO",
    "señales": ["se identifica como esposa del cliente", "habla en nombre de él"],
    "resumen": "Esposa del cliente respondiendo en su nombre"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}

EJEMPLO 3 — chat individual sin señales (default cliente + CONFIRMADO):
{
  "tipo_evento": "dato_extraido",
  "confianza": "CONFIRMADO",
  "payload": {
    "rol_emisor": "cliente",
    "es_emisor_principal": true,
    "confianza_rol": "CONFIRMADO",
    "señales": ["chat 1 a 1, autor por defecto es el cliente principal"],
    "resumen": "Cliente principal del chat individual"
  },
  "evidencia_msg_ids": ["XYZ"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Tipo de chat: ${datos.chat_tipo} ${datos.chat_titulo ? `· "${datos.chat_titulo}"` : ''}

=== CONTEXTO RECIENTE ===
${ctxLineas}

=== MENSAJE A ANALIZAR ===
[msg_id=${datos.mensaje_actual.canal_msg_id}] (${quienAct}): ${datos.mensaje_actual.texto}

Identificá el rol del AUTOR del mensaje analizado.
Si direccion=saliente (el NEGOCIO) → rol=desconocido, CONFIRMADO.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!ROLES.includes(p?.rol_emisor)) {
      throw new ValidacionError('schema',
        `rol_emisor inválido: ${JSON.stringify(p?.rol_emisor)} (válidos: ${ROLES.join(',')})`);
    }
    if (typeof p?.es_emisor_principal !== 'boolean') {
      throw new ValidacionError('schema',
        `es_emisor_principal debe ser boolean: ${JSON.stringify(p?.es_emisor_principal)}`);
    }
    if (!['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(p?.confianza_rol)) {
      throw new ValidacionError('schema', `confianza_rol inválida: ${p?.confianza_rol}`);
    }
    if (!Array.isArray(p?.señales)) {
      throw new ValidacionError('schema', 'payload.señales debe ser array');
    }
    // Resolver el msg_id principal en evidencia_msg_ids (tolera prefijo)
    const msgIdActual = datos.mensaje_actual.canal_msg_id;
    const msgIdsValidos = new Set<string>([
      msgIdActual,
      ...datos.mensajes_contexto.map(m => m.canal_msg_id),
    ]);
    let cubreActual = false;
    if (Array.isArray(out.evidencia_msg_ids)) {
      for (let i = 0; i < out.evidencia_msg_ids.length; i++) {
        const real = resolverMsgId(out.evidencia_msg_ids[i], msgIdsValidos);
        if (real) {
          out.evidencia_msg_ids[i] = real;
          if (real === msgIdActual) cubreActual = true;
        }
      }
    }
    if (!cubreActual) {
      throw new ValidacionError('R-001',
        'evidencia_msg_ids debe incluir el msg_id del mensaje analizado');
    }
    // Coherencia: rol != cliente ⇒ es_emisor_principal=false
    if (p.rol_emisor !== 'cliente' && p.es_emisor_principal === true) {
      throw new ValidacionError('coherencia-a2-rol',
        `es_emisor_principal=true requiere rol_emisor=cliente, got rol=${p.rol_emisor}`);
    }
    // Coherencia mecánica: out.confianza copia payload.confianza_rol
    if (out.confianza !== p.confianza_rol) {
      throw new ValidacionError('coherencia-a2-rol',
        `out.confianza='${out.confianza}' debe igualar payload.confianza_rol='${p.confianza_rol}'`);
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // L2: no muta datos. La info de rol se consume por agentes downstream
    // (A3_IDENTIDAD podría usar es_emisor_principal para decidir asociaciones).
    return;
  },
};

function truncar(s: string, n: number): string {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n) + '…';
}
