#!/usr/bin/env tsx
/**
 * Test E2E del módulo Checklist — agente A_CHECKLIST (estado conversacional).
 *
 * Escenario 1 — el cliente escribió y nadie respondió → estado 'sin_responder'.
 * Escenario 2 — el negocio prometió una cotización y no la pasó → 'te_toca' +
 *   un compromiso detectado.
 *
 * Ejercita el código real de analizarChecklist (llama a DeepSeek, ~$0.01).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { analizarChecklist } from './agentes/sintesis/checklist.js';

const SB_URL = process.env.VITE_SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
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

const JID_1 = 'checktest-uno@c.us';
const JID_2 = 'checktest-dos@c.us';
const TEL_1 = '+573009990201';
const TEL_2 = '+573009990202';

const RES = { pass: 0, fail: 0 };
function check(label: string, cond: boolean, extra?: string) {
  if (cond) { ok(label); RES.pass++; }
  else { fail(`${label}${extra ? ' — ' + extra : ''}`); RES.fail++; }
}

interface MsgSeed { dir: 'entrante' | 'saliente'; texto: string }

async function cleanup() {
  const { data: chats } = await sb.from('chats').select('id').in('canal_chat_id', [JID_1, JID_2]);
  const chatIds = (chats ?? []).map(c => c.id);
  if (chatIds.length) {
    await sb.from('chat_checklist').delete().in('chat_id', chatIds);
    await sb.from('mensajes').delete().in('chat_id', chatIds);
  }
  const { data: pers } = await sb.from('personas').select('id').in('telefono_e164', [TEL_1, TEL_2]);
  const pids = (pers ?? []).map(p => p.id);
  if (pids.length) {
    const { data: proys } = await sb.from('proyectos').select('id').in('persona_id', pids);
    const prids = (proys ?? []).map(p => p.id);
    if (chatIds.length) await sb.from('chats').delete().in('id', chatIds);
    if (prids.length) await sb.from('proyectos').delete().in('id', prids);
    await sb.from('personas').delete().in('id', pids);
  } else if (chatIds.length) {
    await sb.from('chats').delete().in('id', chatIds);
  }
}

/** Crea persona + proyecto + chat + mensajes recientes (1 h de separación). */
async function seedChat(jid: string, nombre: string, tel: string, msgs: MsgSeed[]): Promise<number> {
  const { data: per } = await sb.from('personas').insert({
    nombre, telefono_e164: tel, ciudad: 'Girardot', ambito_principal: 'comercial', origen: 'whatsapp',
  }).select('id').single();
  const { data: proy } = await sb.from('proyectos').insert({
    persona_id: per!.id, ambito: 'comercial', nombre: 'Test checklist', estado: 'abierto', prioridad: 5,
  }).select('id').single();
  const { data: chat } = await sb.from('chats').insert({
    canal: 'whatsapp', canal_chat_id: jid, tipo: 'individual', titulo: nombre,
    ambito: 'comercial', proyecto_id: proy!.id,
  }).select('id').single();

  for (let i = 0; i < msgs.length; i++) {
    const ts = new Date(Date.now() - (msgs.length - i) * 3600_000).toISOString();
    await sb.from('mensajes').insert({
      chat_id: chat!.id, canal_msg_id: `CHK-${jid}-${i}`, direccion: msgs[i].dir,
      tipo: 'texto', texto: msgs[i].texto, ts_canal: ts,
    });
  }
  return chat!.id as number;
}

async function main() {
  sec('LIMPIEZA PREVIA');
  await cleanup();
  info('datos de test anteriores borrados');

  // ───────────────────────────────────────────────────────────────────────
  sec('ESCENARIO 1 — el cliente escribió y nadie respondió');

  const chat1 = await seedChat(JID_1, 'Pepita Test', TEL_1, [
    { dir: 'entrante', texto: 'Buenas, vi sus cortinas en Facebook. Quiero cotizar blackout para 3 ventanas de mi apartamento.' },
  ]);
  info(`chat ${chat1} sembrado — 1 mensaje del cliente, sin respuesta`);

  const r1 = await analizarChecklist(sb, chat1);
  check('El agente analizó el chat sin error', r1.ok);

  const { data: ck1 } = await sb.from('chat_checklist').select('*').eq('chat_id', chat1).maybeSingle();
  check('Se creó la fila de checklist del chat', !!ck1);
  if (ck1) {
    info(`tipo=${ck1.tipo} · estado=${ck1.estado} · próximo: ${ck1.proximo_paso}`);
    check('Lo clasificó como conversación de venta', ck1.tipo === 'venta', `tipo=${ck1.tipo}`);
    check('Estado = sin responder (la pelota es de Jhon)', ck1.estado === 'sin_responder', `estado=${ck1.estado}`);
    check('El checklist de venta tiene sus 7 pasos', Array.isArray(ck1.pasos) && ck1.pasos.length === 7,
      `pasos=${(ck1.pasos as any[])?.length}`);
  }

  // ───────────────────────────────────────────────────────────────────────
  sec('ESCENARIO 2 — el negocio prometió una cotización y no la pasó');

  const chat2 = await seedChat(JID_2, 'Roberto Test', TEL_2, [
    { dir: 'entrante', texto: 'Hola, necesito cortinas para la sala de mi casa' },
    { dir: 'saliente', texto: 'Claro que sí, con gusto le ayudamos. ¿Me pasa las medidas de la ventana?' },
    { dir: 'entrante', texto: 'La ventana mide 2 metros de ancho por 1.5 de alto' },
    { dir: 'saliente', texto: 'Perfecto, mañana sin falta le paso la cotización' },
  ]);
  info(`chat ${chat2} sembrado — el negocio prometió la cotización y no la mandó`);

  const r2 = await analizarChecklist(sb, chat2);
  check('El agente analizó el chat sin error', r2.ok);

  const { data: ck2 } = await sb.from('chat_checklist').select('*').eq('chat_id', chat2).maybeSingle();
  check('Se creó la fila de checklist del chat', !!ck2);
  if (ck2) {
    const comps = (ck2.compromisos as any[]) ?? [];
    info(`tipo=${ck2.tipo} · estado=${ck2.estado} · compromisos=${comps.length}`);
    check('Lo clasificó como conversación de venta', ck2.tipo === 'venta', `tipo=${ck2.tipo}`);
    check('Estado = te toca (el negocio quedó debiendo la cotización)',
      ck2.estado === 'te_toca', `estado=${ck2.estado}`);
    check('Detectó el compromiso incumplido', comps.length >= 1, `compromisos=${comps.length}`);
  }

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
