#!/usr/bin/env tsx
/**
 * F7.2 — Test E2E del cruce automático por teléfono.
 *
 * Escenario A (cruce): Jhon registró un cliente a mano por Junior (F7.1) —
 * persona origen='manual' con teléfono pero sin jid, más su proyecto manual.
 * Después ese mismo cliente escribe por WhatsApp. El sistema debe RECONOCERLO
 * por el teléfono y unirlo: una sola persona, un solo proyecto (el manual
 * reutilizado), jid asociado. Sin duplicados.
 *
 * Escenario B (regresión): un cliente nuevo sin registro previo escribe por
 * WhatsApp → se crea persona + proyecto nuevos como siempre.
 *
 * Ejercita el código real de identidad/matcher.ts (IdentidadService).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { IdentidadService } from './identidad/matcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '.env'), 'utf8').split('\n')
    .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean)
    .map(m => [m![1], m![2].trim()]),
);
const SB_URL = env.VITE_SUPABASE_URL;
const SB_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SB_URL || !SB_KEY) {
  console.error('Falta VITE_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en .env');
  process.exit(1);
}
const sb = createClient(SB_URL, SB_KEY);

const C = { reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m', red: '\x1b[31m', green: '\x1b[32m', cyan: '\x1b[36m' };
const ok = (s: string) => console.log(`  ${C.green}✓${C.reset} ${s}`);
const fail = (s: string) => console.log(`  ${C.red}✗${C.reset} ${s}`);
const info = (s: string) => console.log(`  ${C.dim}· ${s}${C.reset}`);
const sec = (s: string) => console.log(`\n${C.cyan}${C.bold}━━ ${s} ━━${C.reset}`);

// Teléfonos de prueba — prefijo reconocible para limpiar sin tocar datos reales.
const TEL_A = '+573009990011';
const JID_A = '573009990011@c.us';
const JID_B = '573009990022@c.us';

const RES = { pass: 0, fail: 0 };
function check(label: string, cond: boolean, extra?: string) {
  if (cond) { ok(label); RES.pass++; }
  else { fail(`${label}${extra ? ' — ' + extra : ''}`); RES.fail++; }
}

/** Borra todo lo del test respetando el orden de FK. */
async function cleanup() {
  // 1. eventos del test (por canal_msg_id reconocible)
  await sb.from('evento_pg').delete().like('canal_msg_id', 'F72-%');
  // 2. personas del test (por teléfono o jid)
  const ids = new Set<number>();
  for (const f of [
    sb.from('personas').select('id').eq('telefono_e164', TEL_A),
    sb.from('personas').select('id').in('jid', [JID_A, JID_B]),
  ]) {
    const { data } = await f;
    for (const p of (data ?? [])) ids.add(p.id);
  }
  const pids = [...ids];
  if (pids.length) {
    const { data: proys } = await sb.from('proyectos').select('id').in('persona_id', pids);
    const prids = (proys ?? []).map(p => p.id);
    // eventos colgados de esas personas / proyectos (p.ej. generados por el pipeline)
    await sb.from('evento_pg').delete().in('persona_id', pids);
    if (prids.length) await sb.from('evento_pg').delete().in('proyecto_id', prids);
    await sb.from('chats').delete().in('canal_chat_id', [JID_A, JID_B]);
    if (prids.length) await sb.from('proyectos').delete().in('id', prids);
    await sb.from('personas').delete().in('id', pids);
  } else {
    await sb.from('chats').delete().in('canal_chat_id', [JID_A, JID_B]);
  }
}

/** Simula la llegada de un mensaje de WhatsApp: crea el chat + el evento NUEVO. */
async function llegaMensajeWhatsApp(jid: string, titulo: string, msgId: string) {
  const { data: chat, error: ec } = await sb.from('chats').insert({
    canal: 'whatsapp', canal_chat_id: jid, tipo: 'individual',
    titulo, ambito: 'comercial',
  }).select('id').single();
  if (ec || !chat) throw new Error('insert chat: ' + ec?.message);

  const { data: evt, error: ee } = await sb.from('evento_pg').insert({
    canal: 'whatsapp', canal_msg_id: msgId, chat_id: chat.id, ambito: 'comercial',
    tipo_evento: 'mensaje_entrante', estado: 'NUEVO', prioridad: 5,
    payload: { texto: 'Hola, quiero información de cortinas' },
    ts_canal: new Date().toISOString(),
  }).select('*').single();
  if (ee || !evt) throw new Error('insert evento_pg: ' + ee?.message);

  return { chatId: chat.id as number, evt };
}

async function main() {
  const svc = new IdentidadService(sb);

  sec('LIMPIEZA PREVIA');
  await cleanup();
  info('datos de test anteriores borrados');

  // ───────────────────────────────────────────────────────────────────────
  sec('ESCENARIO A — cruce: cliente registrado a mano escribe por WhatsApp');

  // SEED — lo que dejó F7.1: cliente del local registrado por Junior.
  const { data: personaM, error: e1 } = await sb.from('personas').insert({
    nombre: 'Pedro Gómez (F72-TEST)', telefono_e164: TEL_A, ciudad: 'Girardot',
    ambito_principal: 'comercial', origen: 'manual',
  }).select('id').single();
  if (e1 || !personaM) throw new Error('seed persona manual: ' + e1?.message);
  const personaId = personaM.id as number;

  const { data: proyM, error: e2 } = await sb.from('proyectos').insert({
    persona_id: personaId, ambito: 'comercial', nombre: 'Cliente registrado a mano',
    estado: 'abierto', origen: 'manual', prioridad: 5,
  }).select('id').single();
  if (e2 || !proyM) throw new Error('seed proyecto manual: ' + e2?.message);
  const proyectoId = proyM.id as number;
  info(`cliente manual sembrado — persona ${personaId}, proyecto ${proyectoId}, sin jid`);

  // ACCIÓN — el mismo cliente escribe por WhatsApp (jid con su teléfono).
  const { chatId, evt } = await llegaMensajeWhatsApp(JID_A, 'Pedro Gómez', 'F72-MSG-A');
  info(`mensaje de WhatsApp recibido — chat ${chatId}, evento ${evt.id}`);

  const r = await svc.resolverEvento(evt);
  if (!r) throw new Error('resolverEvento devolvió null en el escenario A');
  await svc.aplicarResolucion(evt.id, r);

  // VERIFICACIÓN
  check('La persona resuelta es la registrada a mano (no se creó otra)',
    r.persona_id === personaId, `esperaba ${personaId}, obtuvo ${r.persona_id}`);

  const { count: nPersonas } = await sb.from('personas')
    .select('id', { count: 'exact', head: true }).eq('telefono_e164', TEL_A).is('deleted_at', null);
  check('Existe UNA sola persona con ese teléfono', nPersonas === 1, `hay ${nPersonas}`);

  const { data: pers } = await sb.from('personas').select('jid, origen').eq('id', personaId).single();
  check('La persona quedó asociada al jid de WhatsApp', pers?.jid === JID_A, `jid=${pers?.jid}`);
  check("La persona conserva origen='manual' (historial de cómo entró)", pers?.origen === 'manual');

  check('El proyecto resuelto es el manual reutilizado (no uno nuevo)',
    r.proyecto_id === proyectoId, `esperaba ${proyectoId}, obtuvo ${r.proyecto_id}`);

  const { count: nProy } = await sb.from('proyectos')
    .select('id', { count: 'exact', head: true }).eq('persona_id', personaId).is('deleted_at', null);
  check('La persona tiene UN solo proyecto (sin duplicar)', nProy === 1, `hay ${nProy}`);

  const { data: chatRow } = await sb.from('chats').select('proyecto_id').eq('id', chatId).single();
  check('El chat de WhatsApp quedó enganchado al proyecto manual', chatRow?.proyecto_id === proyectoId);

  const { data: evtRow } = await sb.from('evento_pg')
    .select('estado, persona_id, proyecto_id').eq('id', evt.id).single();
  check('El evento quedó IDENTIFICADO', evtRow?.estado === 'IDENTIFICADO');
  check('El evento apunta a la persona y al proyecto correctos',
    evtRow?.persona_id === personaId && evtRow?.proyecto_id === proyectoId);

  // ───────────────────────────────────────────────────────────────────────
  sec('ESCENARIO B — regresión: cliente nuevo sin registro previo');

  const { chatId: chatB, evt: evtB } = await llegaMensajeWhatsApp(JID_B, 'Cliente Nuevo', 'F72-MSG-B');
  info(`mensaje de un número sin cliente previo — chat ${chatB}, evento ${evtB.id}`);

  const rB = await svc.resolverEvento(evtB);
  if (!rB) throw new Error('resolverEvento devolvió null en el escenario B');
  await svc.aplicarResolucion(evtB.id, rB);

  check('Se creó una persona nueva', !!rB.persona_id && rB.persona_id !== personaId);
  check('Se creó un proyecto nuevo', !!rB.proyecto_id && rB.proyecto_id !== proyectoId);
  const { data: chatRowB } = await sb.from('chats').select('proyecto_id').eq('id', chatB).single();
  check('El chat nuevo quedó enganchado a su proyecto', chatRowB?.proyecto_id === rB.proyecto_id);

  // ───────────────────────────────────────────────────────────────────────
  sec('LIMPIEZA FINAL');
  await cleanup();
  info('datos de test borrados');

  console.log(
    `\n${RES.fail === 0 ? C.green : C.red}${C.bold}` +
    `RESULTADO: ${RES.pass} OK · ${RES.fail} fallos${C.reset}\n`,
  );
  process.exit(RES.fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`\n${C.red}ERROR FATAL:${C.reset}`, e?.message ?? e);
  try { await cleanup(); } catch { /* noop */ }
  process.exit(1);
});
