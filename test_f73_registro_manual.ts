#!/usr/bin/env tsx
/**
 * F7.3 Parte A — Test E2E: Junior pregunta antes de crear un cliente duplicado.
 *
 * Escenario A1 (cruce): ya existe "Pedro Gómez Restrepo". Jhon le dicta a Junior
 *   un "Pedro Gomez Restrepo" → Junior NO lo registra: pregunta si es el mismo.
 *   Jhon confirma → Junior ancla el pedido al Pedro existente, sin duplicar.
 * Escenario A2 (control): Jhon dicta un cliente cuyo nombre no se parece a
 *   ninguno → Junior lo registra normal (no pregunta de gusto).
 *
 * Ejercita el código real de responderJunior (llama a DeepSeek, costo ~$0.005).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { responderJunior, type MensajeChat } from './agentes/sintesis/junior_chat.js';

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

const TEL_MARCA = '+573009990033';                 // teléfono marcador, para limpiar
const NOMBRE_EXISTENTE = 'Pedro Gómez Restrepo';
const NOMBRE_DICTADO = 'Pedro Gomez Restrepo';     // como lo escribe Jhon (sin tildes)
const NOMBRE_CONTROL = 'Zoraida Penagos';          // no se parece a nadie

const RES = { pass: 0, fail: 0 };
function check(label: string, cond: boolean, extra?: string) {
  if (cond) { ok(label); RES.pass++; }
  else { fail(`${label}${extra ? ' — ' + extra : ''}`); RES.fail++; }
}

async function cleanup() {
  const { data } = await sb.from('personas').select('id').eq('telefono_e164', TEL_MARCA);
  const ids = (data ?? []).map(p => p.id);
  if (ids.length) {
    const { data: proys } = await sb.from('proyectos').select('id').in('persona_id', ids);
    const prids = (proys ?? []).map(p => p.id);
    await sb.from('evento_pg').delete().in('persona_id', ids);
    if (prids.length) await sb.from('evento_pg').delete().in('proyecto_id', prids);
    await sb.from('correcciones_humanas').delete().in('persona_id', ids);
    if (prids.length) await sb.from('proyectos').delete().in('id', prids);
    await sb.from('personas').delete().in('id', ids);
  }
}

async function main() {
  sec('LIMPIEZA PREVIA');
  await cleanup();
  info('datos de test anteriores borrados');

  // SEED — ya existe este cliente en el sistema.
  const { data: pedro, error } = await sb.from('personas').insert({
    nombre: NOMBRE_EXISTENTE, telefono_e164: TEL_MARCA, ciudad: 'Girardot',
    ambito_principal: 'comercial', origen: 'manual',
  }).select('id').single();
  if (error || !pedro) throw new Error('seed persona: ' + error?.message);
  const pedroId = pedro.id as number;
  // Síntesis: un cliente ya registrado tiene su análisis hecho (no aparece ⏳).
  await sb.from('modulo_sintesis').insert({
    persona_id: pedroId, modulo: 'm1',
    sintesis: 'Cliente de Girardot, registrado a mano. Sin novedades.',
  });
  info(`cliente existente sembrado — "${NOMBRE_EXISTENTE}" (id ${pedroId})`);

  // ───────────────────────────────────────────────────────────────────────
  sec('ESCENARIO A1 — Jhon dicta un cliente que YA existe');

  const turno1 = `Anotá un cliente nuevo: ${NOMBRE_DICTADO}, de Girardot, quiere cortinas blackout para 3 ventanas`;
  info(`Jhon: "${turno1}"`);
  const r1 = await responderJunior(sb, turno1, [], 1);
  info(`Junior: ${r1.respuesta.replace(/\n/g, ' ')}`);

  check('Junior NO registró el cliente (esperó confirmación)', r1.nuevosClientes.length === 0,
    `devolvió ${r1.nuevosClientes.length} cliente(s) nuevo(s)`);
  check('Junior respondió algo (preguntó por el posible duplicado)',
    r1.respuesta.trim().length > 0 && r1.respuesta.includes('?'),
    'la respuesta no parece una pregunta');

  const historial: MensajeChat[] = [
    { rol: 'usuario', mensaje: turno1 },
    { rol: 'junior', mensaje: r1.respuesta },
  ];
  const turno2 = `Sí, es el mismo ${NOMBRE_EXISTENTE} que ya tengo registrado, no es otro`;
  info(`Jhon: "${turno2}"`);
  const r2 = await responderJunior(sb, turno2, historial, 1);
  info(`Junior: ${r2.respuesta.replace(/\n/g, ' ')}`);

  check('Junior NO creó un cliente duplicado tras la confirmación', r2.nuevosClientes.length === 0,
    `devolvió ${r2.nuevosClientes.length} cliente(s) nuevo(s)`);
  check('Junior ancló el pedido al cliente que YA existía',
    r2.correcciones.some(c => c.persona_id === pedroId),
    `correcciones a persona_id: [${r2.correcciones.map(c => c.persona_id).join(', ')}], esperaba ${pedroId}`);

  // ───────────────────────────────────────────────────────────────────────
  sec('ESCENARIO A2 — control: cliente con nombre que no se parece a ninguno');

  const turno3 = `Anotá un cliente nuevo: ${NOMBRE_CONTROL}, vino al local, quiere cortinas roller`;
  info(`Jhon: "${turno3}"`);
  const r3 = await responderJunior(sb, turno3, [], 1);
  info(`Junior: ${r3.respuesta.replace(/\n/g, ' ')}`);

  check('Junior registró el cliente nuevo normalmente', r3.nuevosClientes.length === 1,
    `devolvió ${r3.nuevosClientes.length} cliente(s) nuevo(s)`);
  check('El cliente registrado es el correcto',
    r3.nuevosClientes.some(n => n.nombre.toLowerCase().includes('zoraida')),
    `nombres: [${r3.nuevosClientes.map(n => n.nombre).join(', ')}]`);

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
