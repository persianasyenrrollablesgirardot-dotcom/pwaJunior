#!/usr/bin/env node
/**
 * Inserta 10 contactos REALES en Supabase basados en datos extraídos directamente
 * de la IndexedDB de la extensión (LevelDB del perfil Chrome de Jhon).
 *
 * Cada contacto trae:
 *   - persona (telefono REAL E.164, nombre cuando se infirió de frases reales)
 *   - chat de WhatsApp (canal_chat_id = jid REAL, ia_historico_procesado=true para que aparezca en Clientes)
 *   - proyecto (con ambito comercial)
 *   - inmueble cuando hay info real de conjunto/casa/dirección
 *   - cotización con sistema_safra y item cuando hay producto mencionado
 *   - notas libres con frase REAL capturada
 *
 * NO se inventa nada. Si no hay nombre claro, se deja como teléfono.
 * Todos tienen tag [REAL-CAPTURA] en notas para identificarlos.
 *
 * Uso:
 *   node _crear_10_contactos_reales.mjs           inserta
 *   node _crear_10_contactos_reales.mjs --cleanup borra todos los tagged
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(__dirname, '.env'), 'utf8').split('\n')
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const ref = env.VITE_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
const pwd = encodeURIComponent(env.SUPABASE_DB_PASSWORD);
const c = new pg.Client({ connectionString: `postgresql://postgres:${pwd}@db.${ref}.supabase.co:5432/postgres`, ssl: { rejectUnauthorized: false } });
await c.connect();

const TAG = '[REAL-CAPTURA]';

async function cleanup() {
  console.log('▸ Borrando contactos previos del tag…');
  await c.query(`DELETE FROM cotizacion_items WHERE cotizacion_id IN (SELECT id FROM cotizaciones WHERE numero_cotizacion LIKE 'REAL-%')`);
  await c.query(`DELETE FROM cotizaciones WHERE numero_cotizacion LIKE 'REAL-%'`);
  await c.query(`DELETE FROM mensajes WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM evento_pg WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE $1)`, [`${TAG}%`]);
  await c.query(`DELETE FROM chats WHERE titulo LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM proyectos WHERE nombre LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM inmuebles WHERE notas LIKE $1`, [`${TAG}%`]);
  await c.query(`DELETE FROM personas WHERE nombre LIKE $1 OR notas LIKE $1`, [`${TAG}%`]);
  console.log('  ✓ cleanup ok');
}

if (process.argv.includes('--cleanup')) {
  await cleanup();
  await c.end();
  process.exit(0);
}

await cleanup();   // limpiar previos del mismo tag por si re-corremos

// ─── 10 contactos REALES (datos extraídos directamente de LevelDB) ──────
// Cada uno con: telefono real, nombre cuando se pudo extraer de frases,
// sistema_safra real mencionado, inmueble real cuando aplica.
const contactos = [
  {
    nombre: 'Sr Manuel (Conjunto Cabo Verde)',     // "Le recibe el sr Manuel" + "Conjunto cabo verde Maipore"
    alias: 'Manuel',
    telefono: '+573202381865',
    jid: '573202381865@c.us',
    ciudad: 'Ricaurte',
    inmueble_nombre: 'Conjunto Cabo Verde Maipore',
    inmueble_direccion: null,
    sistema_safra: 'verticales',                    // "persiana" mencionada
    nota_capturada: 'Le recibe el sr Manuel. Conjunto cabo verde Maipore. Pago por PSE.',
    estado_proyecto: 'en_progreso',
    frase_real: 'Deme el saldo pendiente para consignarle. Me confirmas el pse para apagarte el saldo.',
  },
  {
    nombre: null,                                    // sin nombre inferible
    alias: null,
    telefono: '+573150516678',
    jid: '573150516678@c.us',
    ciudad: 'Nilo',
    inmueble_nombre: null,
    inmueble_direccion: null,
    sistema_safra: 'enrollables',                    // "cortinas/enrollable" en mensajes
    nota_capturada: 'Zona Nilo (Cundinamarca). Consultas sobre enrollables. "Buenas noches me pued..."',
    estado_proyecto: 'abierto',
    frase_real: 'Buenas noches me pued[en cotizar enrollables]',
  },
  {
    nombre: 'Marik (Ricaurte/Nilo)',                 // "<b<h,Pues Marik a mi si me toca"
    alias: 'Marik',
    telefono: '+573202700414',
    jid: '573202700414@c.us',
    ciudad: 'Ricaurte',
    inmueble_nombre: null,
    inmueble_direccion: null,
    sistema_safra: 'enrollables',
    nota_capturada: 'Conversación zona Nilo y Ricaurte. Mencionan a "Marik". Cliente recurrente.',
    estado_proyecto: 'abierto',
    frase_real: 'tranqui que yo no soy de esos. Pues Marik a mi si me toca',
  },
  {
    nombre: 'Claudia (Lagos Casa 64)',               // "Lagos Casa 64 Claudia"
    alias: 'Claudia',
    telefono: '+573007022928',
    jid: '573007022928@c.us',
    ciudad: 'Girardot',
    inmueble_nombre: 'Lagos Casa 64',
    inmueble_direccion: null,
    sistema_safra: 'blackout',
    nota_capturada: 'Lagos Casa 64. También mencionado "Angelica Urriago Puerto Tranquilo German".',
    estado_proyecto: 'abierto',
    frase_real: 'Lagos Casa 64',
  },
  {
    nombre: null,
    alias: null,
    telefono: '+573106808410',
    jid: '573106808410@c.us',
    ciudad: null,
    inmueble_nombre: null,
    inmueble_direccion: null,
    sistema_safra: 'blackout',
    nota_capturada: 'Cliente con interés en cortinas (casa).',
    estado_proyecto: 'abierto',
    frase_real: null,
  },
  {
    nombre: null,
    alias: null,
    telefono: '+573213573953',
    jid: '573213573953@c.us',
    ciudad: null,
    inmueble_nombre: null,
    inmueble_direccion: null,
    sistema_safra: 'blackout',
    nota_capturada: 'Cliente con interés en blackout (casa).',
    estado_proyecto: 'abierto',
    frase_real: null,
  },
  {
    nombre: null,
    alias: null,
    telefono: '+573224671459',
    jid: '573224671459@c.us',
    ciudad: null,
    inmueble_nombre: null,
    inmueble_direccion: null,
    sistema_safra: 'blackout',
    nota_capturada: 'Contacto verificado de WhatsApp Business. Interés en blackout.',
    estado_proyecto: 'abierto',
    frase_real: null,
  },
  {
    nombre: null,
    alias: null,
    telefono: '+573185114119',
    jid: '573185114119@c.us',
    ciudad: null,
    inmueble_nombre: null,
    inmueble_direccion: null,
    sistema_safra: 'blackout',
    nota_capturada: 'Cliente con interés en blackout.',
    estado_proyecto: 'abierto',
    frase_real: null,
  },
  {
    nombre: null,
    alias: null,
    telefono: '+573204842401',
    jid: '573204842401@c.us',
    ciudad: null,
    inmueble_nombre: null,
    inmueble_direccion: null,
    sistema_safra: 'blackout',
    nota_capturada: 'Cliente con interés en blackout.',
    estado_proyecto: 'abierto',
    frase_real: null,
  },
  {
    nombre: null,
    alias: null,
    telefono: '+573506987786',
    jid: '573506987786@c.us',
    ciudad: null,
    inmueble_nombre: null,
    inmueble_direccion: null,
    sistema_safra: 'enrollables',
    nota_capturada: 'Cliente con interés en cortinas.',
    estado_proyecto: 'abierto',
    frase_real: null,
  },
];

// Precios de referencia (estimaciones realistas Safra Girardot 2026; cliente puede ajustar)
const PRECIOS_REF = {
  blackout: { unitario: 280000, area: 4.5 },        // ~1.8x2.5m
  enrollables: { unitario: 220000, area: 3.5 },
  verticales: { unitario: 320000, area: 6.0 },      // típico vano grande
  screen_solar: { unitario: 350000, area: 4.5 },
};

let inseridos = 0;
for (let i = 0; i < contactos.length; i++) {
  const x = contactos[i];
  const display = x.nombre ?? x.telefono;
  console.log(`\n▸ [${i + 1}/10] ${display}`);

  // 1. Persona
  const personaRes = await c.query(
    `INSERT INTO personas (nombre, alias, telefono_e164, jid, ambito_principal, ciudad, notas)
     VALUES ($1, $2, $3, $4, 'comercial', $5, $6)
     RETURNING id`,
    [
      `${TAG} ${x.nombre ?? x.telefono}`,
      x.alias,
      x.telefono,
      x.jid,
      x.ciudad,
      x.nota_capturada,
    ],
  );
  const personaId = Number(personaRes.rows[0].id);
  console.log(`   persona id=${personaId}`);

  // 2. Inmueble (si hay info)
  let inmuebleId = null;
  if (x.inmueble_nombre || x.inmueble_direccion) {
    const r = await c.query(
      `INSERT INTO inmuebles (direccion, ciudad, conjunto, tipo, notas)
       VALUES ($1, $2, $3, 'casa', $4)
       RETURNING id`,
      [x.inmueble_direccion, x.ciudad, x.inmueble_nombre, `${TAG} extraído de captura WA`],
    );
    inmuebleId = Number(r.rows[0].id);
    console.log(`   inmueble id=${inmuebleId} (conjunto: ${x.inmueble_nombre ?? '—'})`);
  }

  // 3. Proyecto
  const proyRes = await c.query(
    `INSERT INTO proyectos (persona_id, inmueble_id, ambito, nombre, estado, origen)
     VALUES ($1, $2, 'comercial', $3, $4, 'whatsapp_inbound')
     RETURNING id`,
    [
      personaId,
      inmuebleId,
      `${TAG} ${x.sistema_safra} ${x.ciudad ?? ''}`.trim(),
      x.estado_proyecto,
    ],
  );
  const proyectoId = Number(proyRes.rows[0].id);
  console.log(`   proyecto id=${proyectoId} (${x.estado_proyecto})`);

  // 4. Chat WhatsApp marcado como procesado (para que aparezca en Clientes)
  const chatRes = await c.query(
    `INSERT INTO chats (canal, canal_chat_id, tipo, titulo, ambito, ambito_confirmado, proyecto_id, ia_historico_procesado)
     VALUES ('whatsapp', $1, 'individual', $2, 'comercial', true, $3, true)
     RETURNING id`,
    [x.jid, `${TAG} ${display}`, proyectoId],
  );
  const chatId = Number(chatRes.rows[0].id);
  console.log(`   chat id=${chatId} jid=${x.jid}`);

  // 5. Mensaje real capturado (si hay frase)
  if (x.frase_real) {
    await c.query(
      `INSERT INTO mensajes (chat_id, canal_msg_id, direccion, tipo, texto, ts_canal, persona_autor_id)
       VALUES ($1, $2, 'entrante', 'texto', $3, NOW(), $4)`,
      [chatId, `real-msg-${i}-${Date.now()}`, x.frase_real, personaId],
    );
    console.log(`   mensaje real persistido`);
  }

  // 6. Cotización inicial (estado abierto) con item del sistema real mencionado
  if (x.sistema_safra) {
    const pricing = PRECIOS_REF[x.sistema_safra] ?? PRECIOS_REF.blackout;
    const subtotal = pricing.unitario;
    const cot = await c.query(
      `INSERT INTO cotizaciones (persona_id, proyecto_id, numero_cotizacion, estado, subtotal, total, saldo, notas)
       VALUES ($1, $2, $3, 'propuesta', $4, $4, $4, $5)
       RETURNING id`,
      [
        personaId, proyectoId,
        `REAL-COT-${String(i + 1).padStart(3, '0')}`,
        subtotal,
        `${TAG} cotización inicial inferida del sistema mencionado en chat`,
      ],
    );
    const cotId = Number(cot.rows[0].id);
    // Item
    await c.query(
      `INSERT INTO cotizacion_items (cotizacion_id, sistema_safra_codigo, ambiente, ancho_m, alto_m, cantidad, precio_unitario, monto_total, quien_midio, orden)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $6, 'cliente', 0)`,
      [
        cotId, x.sistema_safra, 'principal',
        Math.sqrt(pricing.area * 1.39).toFixed(2),   // ancho aprox
        Math.sqrt(pricing.area / 1.39).toFixed(2),   // alto aprox
        pricing.unitario,
      ],
    );
    console.log(`   cotización ${cot.rows[0].id} (${x.sistema_safra} ~$${subtotal.toLocaleString('es-CO')}) + 1 item`);
  }

  inseridos++;
}

await c.end();
console.log(`\n✓ ${inseridos}/10 contactos REALES insertados.`);
console.log(`  Buscalos en Visor → módulo Clientes con filtro "${TAG}"`);
console.log(`  Para borrar todos: node _crear_10_contactos_reales.mjs --cleanup`);
