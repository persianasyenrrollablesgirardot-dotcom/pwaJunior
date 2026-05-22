#!/usr/bin/env tsx
/**
 * F7.3 Parte B — Test E2E: duplicados detectados desde WhatsApp.
 *
 * B1 — A3_IDENTIDAD detecta el duplicado → lo escribe en duplicados_detectados
 *      (y no lo duplica si vuelve a detectarlo).
 * B2 — Junior plantea el duplicado pendiente en el chat.
 * B3 — Jhon confirma en el chat → responderJunior emite [RESOLVER_DUPLICADO].
 * B4 — la fusión une las dos personas en una sola, sin perder datos.
 *
 * Ejercita el código real: a3IdentidadHooks.postProcesar, responderJunior y
 * fusionarPersonas (llama a DeepSeek en B2/B3, costo ~$0.005).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { responderJunior, type MensajeChat } from './agentes/sintesis/junior_chat.js';
import { a3IdentidadHooks } from './agentes/L3_identidad/a3_identidad.js';
import { fusionarPersonas } from './identidad/fusionar_personas.js';

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

const TEL_E = '+573009990066';                 // cliente existente
const TEL_N = '+573009990077';                 // cliente "nuevo" (entró por WhatsApp)
const JID_N = '573009990077@c.us';
const NOMBRE = 'Marta López Restrepo';

const RES = { pass: 0, fail: 0 };
function check(label: string, cond: boolean, extra?: string) {
  if (cond) { ok(label); RES.pass++; }
  else { fail(`${label}${extra ? ' — ' + extra : ''}`); RES.fail++; }
}

async function cleanup() {
  const ids = new Set<number>();
  for (const f of [
    sb.from('personas').select('id').in('telefono_e164', [TEL_E, TEL_N]),
    sb.from('personas').select('id').eq('jid', JID_N),
  ]) {
    const { data } = await f;
    for (const p of (data ?? [])) ids.add(p.id);
  }
  const pids = [...ids];
  if (pids.length === 0) return;
  const { data: proys } = await sb.from('proyectos').select('id').in('persona_id', pids);
  const prids = (proys ?? []).map(p => p.id);
  await sb.from('personas_merge_log').delete()
    .or(`persona_sobreviviente_id.in.(${pids.join(',')}),persona_fusionada_id.in.(${pids.join(',')})`);
  await sb.from('duplicados_detectados').delete()
    .or(`persona_nueva_id.in.(${pids.join(',')}),persona_existente_id.in.(${pids.join(',')})`);
  await sb.from('evento_pg').delete().in('persona_id', pids);
  if (prids.length) await sb.from('evento_pg').delete().in('proyecto_id', prids);
  if (prids.length) await sb.from('proyectos').delete().in('id', prids);
  await sb.from('modulo_sintesis').delete().in('persona_id', pids);
  await sb.from('correcciones_humanas').delete().in('persona_id', pids);
  await sb.from('personas').delete().in('id', pids);
}

async function main() {
  sec('LIMPIEZA PREVIA');
  await cleanup();
  info('datos de test anteriores borrados');

  // SEED — dos personas que en realidad son la MISMA (mismo nombre, distinto
  // teléfono): la "existente" (registrada antes) y la "nueva" (entró por WA).
  const { data: pE, error: eE } = await sb.from('personas').insert({
    nombre: NOMBRE, telefono_e164: TEL_E, ciudad: 'Girardot',
    ambito_principal: 'comercial', origen: 'manual',
  }).select('id').single();
  if (eE || !pE) throw new Error('seed persona existente: ' + eE?.message);
  const E = pE.id as number;
  await sb.from('modulo_sintesis').insert({
    persona_id: E, modulo: 'm1', sintesis: 'Cliente de Girardot, registrada hace tiempo.',
  });

  const { data: pN, error: eN } = await sb.from('personas').insert({
    nombre: 'Marta Lopez Restrepo', telefono_e164: TEL_N, jid: JID_N, ciudad: 'Girardot',
    ambito_principal: 'comercial', origen: 'whatsapp',
  }).select('id').single();
  if (eN || !pN) throw new Error('seed persona nueva: ' + eN?.message);
  const N = pN.id as number;

  // La persona nueva trae un proyecto + un evento (para verificar que la fusión los mueve).
  const { data: proyN } = await sb.from('proyectos').insert({
    persona_id: N, ambito: 'comercial', nombre: 'Conversación WhatsApp', estado: 'abierto',
    origen: 'whatsapp_inbound', prioridad: 5,
  }).select('id').single();
  const { data: evtN } = await sb.from('evento_pg').insert({
    canal: 'whatsapp', canal_msg_id: 'F73B-MSG-1', persona_id: N, proyecto_id: proyN!.id,
    ambito: 'comercial', tipo_evento: 'mensaje_entrante', estado: 'PROCESADO', prioridad: 5,
    payload: { texto: 'Hola, soy Marta' }, ts_canal: new Date().toISOString(),
  }).select('id').single();
  info(`sembradas: existente id ${E} · nueva id ${N} (proyecto ${proyN!.id}, evento ${evtN!.id})`);

  // ───────────────────────────────────────────────────────────────────────
  sec('B1 — A3_IDENTIDAD detecta el duplicado y lo registra');

  const fakeOut = {
    tipo_evento: 'dato_extraido', confianza: 'INFERIDO',
    payload: {
      persona_actual_id: N,
      candidatos_fusion: [{
        persona_id_candidata: E, score: 0.4, confianza_fusion: 'INFERIDO',
        campos_match: ['nombre', 'ciudad'],
        razon: `Mismo nombre "${NOMBRE}" y misma ciudad, distinto teléfono`,
      }],
      resumen: '1 candidato de fusión detectado',
    },
  };
  await a3IdentidadHooks.postProcesar(sb, fakeOut as any, {} as any);
  await a3IdentidadHooks.postProcesar(sb, fakeOut as any, {} as any);   // 2da vez: no debe duplicar

  const { data: dups } = await sb.from('duplicados_detectados').select('id, estado')
    .eq('persona_nueva_id', N).eq('persona_existente_id', E);
  check('A3 registró el duplicado en duplicados_detectados', (dups?.length ?? 0) === 1,
    `hay ${dups?.length ?? 0} registros`);
  check('El duplicado quedó en estado pendiente', dups?.[0]?.estado === 'pendiente');
  const dupId = dups?.[0]?.id as number;

  // ───────────────────────────────────────────────────────────────────────
  sec('B2 — Junior plantea el duplicado en el chat');

  const turno1 = '¿Tenés algo pendiente que deba revisar?';
  info(`Jhon: "${turno1}"`);
  const r1 = await responderJunior(sb, turno1, [], 1);
  info(`Junior: ${r1.respuesta.replace(/\n/g, ' ')}`);
  check('Junior mencionó el posible cliente duplicado',
    r1.respuesta.toLowerCase().includes('marta'),
    'la respuesta no menciona a Marta');

  // ───────────────────────────────────────────────────────────────────────
  sec('B3 — Jhon confirma en el chat que son la misma persona');

  const historial: MensajeChat[] = [
    { rol: 'usuario', mensaje: turno1 },
    { rol: 'junior', mensaje: r1.respuesta },
  ];
  const turno2 = 'Sí, esas dos Marta López Restrepo son la misma persona, unilas en una sola ficha';
  info(`Jhon: "${turno2}"`);
  const r2 = await responderJunior(sb, turno2, historial, 1);
  info(`Junior: ${r2.respuesta.replace(/\n/g, ' ')}`);
  check('Junior emitió la orden de fusionar el duplicado correcto',
    r2.resoluciones.some(x => x.duplicado_id === dupId && x.accion === 'fusionar'),
    `resoluciones: ${JSON.stringify(r2.resoluciones)}`);

  // ───────────────────────────────────────────────────────────────────────
  sec('B4 — la fusión une las dos personas sin perder datos');

  await fusionarPersonas(sb, E, N, `Confirmado por Jhon (duplicado #${dupId})`);

  const { data: persN } = await sb.from('personas').select('deleted_at').eq('id', N).single();
  check('La persona nueva quedó eliminada (soft-delete)', persN?.deleted_at != null);

  const { data: persE } = await sb.from('personas').select('deleted_at, jid').eq('id', E).single();
  check('La persona existente sobrevive', persE?.deleted_at == null);
  check('La existente heredó el jid de WhatsApp de la otra', persE?.jid === JID_N,
    `jid=${persE?.jid}`);

  const { data: proyMovido } = await sb.from('proyectos').select('persona_id').eq('id', proyN!.id).single();
  check('El proyecto de la nueva se movió a la persona sobreviviente', proyMovido?.persona_id === E);

  const { data: evtMovido } = await sb.from('evento_pg').select('persona_id').eq('id', evtN!.id).single();
  check('El evento de la nueva se movió a la persona sobreviviente', evtMovido?.persona_id === E);

  const { data: dupFinal } = await sb.from('duplicados_detectados').select('estado').eq('id', dupId).single();
  check('El duplicado quedó marcado como fusionado', dupFinal?.estado === 'fusionado');

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
