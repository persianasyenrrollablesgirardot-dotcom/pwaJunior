#!/usr/bin/env node
// Aplica migraciones SQL contra Supabase usando el service_role como password
// del Postgres pooler (Supabase soporta esto desde finales de 2023).
//
// Uso:
//   node apply_migration.mjs supabase/migrations/001_chat_model.sql

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  readFileSync(join(__dirname, '.env'), 'utf8')
    .split('\n').map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()])
);

const SUPABASE_URL  = env.VITE_SUPABASE_URL;
const DB_PASSWORD   = env.SUPABASE_DB_PASSWORD || process.argv[3];
if (!SUPABASE_URL || !DB_PASSWORD) {
  console.error('Falta VITE_SUPABASE_URL o SUPABASE_DB_PASSWORD (en .env o como 3er arg)');
  process.exit(1);
}
const ref = SUPABASE_URL.match(/https:\/\/([^.]+)\./)?.[1];
if (!ref) { console.error('No pude extraer el project ref de la URL'); process.exit(1); }

const sqlFile = process.argv[2];
if (!sqlFile) { console.error('Uso: node apply_migration.mjs <ruta.sql>'); process.exit(1); }
const sql = readFileSync(resolve(sqlFile), 'utf8');

console.log(`📦 Proyecto: ${ref}`);
console.log(`📄 Archivo:  ${sqlFile} (${sql.length} bytes)`);

// Probaremos varias variantes de host. Supabase tiene tanto direct host como pooler.
const pwd = encodeURIComponent(DB_PASSWORD);
const candidates = [
  { label: 'pooler us-east-1:5432',  conn: `postgresql://postgres.${ref}:${pwd}@aws-0-us-east-1.pooler.supabase.com:5432/postgres` },
  { label: 'pooler us-east-2:5432',  conn: `postgresql://postgres.${ref}:${pwd}@aws-0-us-east-2.pooler.supabase.com:5432/postgres` },
  { label: 'pooler us-west-1:5432',  conn: `postgresql://postgres.${ref}:${pwd}@aws-0-us-west-1.pooler.supabase.com:5432/postgres` },
  { label: 'pooler sa-east-1:5432',  conn: `postgresql://postgres.${ref}:${pwd}@aws-0-sa-east-1.pooler.supabase.com:5432/postgres` },
  { label: 'pooler eu-west-2:5432',  conn: `postgresql://postgres.${ref}:${pwd}@aws-0-eu-west-2.pooler.supabase.com:5432/postgres` },
  { label: 'pooler eu-central-1:5432', conn: `postgresql://postgres.${ref}:${pwd}@aws-0-eu-central-1.pooler.supabase.com:5432/postgres` },
  { label: 'pooler ap-southeast-1:5432', conn: `postgresql://postgres.${ref}:${pwd}@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres` },
  { label: 'direct',                conn: `postgresql://postgres:${pwd}@db.${ref}.supabase.co:5432/postgres` },
];

async function tryConnect(c) {
  const client = new pg.Client({ connectionString: c.conn, ssl: { rejectUnauthorized: false } });
  try { await client.connect(); return client; }
  catch (e) { await client.end().catch(() => {}); throw e; }
}

let client = null;
let lastErr = null;
for (const c of candidates) {
  try {
    console.log(`  🔌 probando ${c.label}...`);
    client = await tryConnect(c);
    console.log(`  ✓ conectado vía ${c.label}`);
    break;
  } catch (e) {
    lastErr = e;
    console.log(`     ✗ ${e.message.slice(0, 100)}`);
  }
}

if (!client) {
  console.error('\n❌ No conecté a ninguna región. Necesito el connection string completo.');
  console.error(`   Último error: ${lastErr?.message}`);
  process.exit(1);
}

try {
  console.log('\n⚙️  Ejecutando SQL...');
  const res = await client.query(sql);
  if (Array.isArray(res)) {
    console.log(`✅ ${res.length} statements ejecutados`);
    const last = res[res.length - 1];
    if (last?.rows?.length) console.log('Resultado:', last.rows);
  } else {
    console.log(`✅ Ejecutado. ${res.command || ''} ${res.rowCount ?? ''}`);
    if (res.rows?.length) console.log('Resultado:', res.rows);
  }
} catch (e) {
  console.error('❌ Error SQL:', e.message);
  process.exit(1);
} finally {
  await client.end();
}
