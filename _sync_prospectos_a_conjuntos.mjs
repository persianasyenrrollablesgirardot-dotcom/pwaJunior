#!/usr/bin/env node
/**
 * Sincroniza los 324 prospectos del proyecto Gestor_Prospectos_Girardot
 * (Supabase `dnsyyvtznkllneyuopoa`) → tabla `conjuntos` del Visor_PG
 * (Supabase `olububjdvboiqgmihsmk`).
 *
 * Mapea sectores → zona_codigo (zonas_instalacion del Visor).
 * Idempotente vía ON CONFLICT(nombre).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(readFileSync(join(__dirname, '.env'), 'utf8').split('\n')
  .map(l => l.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));

// 1. Leer del Supabase Prospectos
const sbProsp = createClient(
  'https://dnsyyvtznkllneyuopoa.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRuc3l5dnR6bmtsbG5leXVvcG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NDQyNjUsImV4cCI6MjA4NjQyMDI2NX0.6CW_SQG9HXTu930MwclN9lDeqrn95Bsj-RpO_L057Zg',
);
const { data: prospectos, error } = await sbProsp.from('prospectos_conjuntos').select('*');
if (error) { console.error('❌ leer Prospectos:', error); process.exit(1); }
console.log(`▸ ${prospectos.length} prospectos leídos del Supabase de Prospectos`);

// 2. Map sector → zona_codigo del Visor
const SECTOR_A_ZONA = {
  'Ricaurte - Peñalisa':   'ricaurte_penalisa',
  'Ricaurte - Vía Melgar': 'ricaurte_via_melgar',
  'Ricaurte':              'ricaurte',
  'Girardot - El Peñón':   'girardot_el_penon',
  'Girardot - Vía Nariño': 'girardot_via_narino',
  'Girardot - Norte':      'girardot_norte',
  'Girardot - Urbano':     'girardot_urbano',
  'Girardot - Vía Tocaima':'girardot_via_tocaima',
  'Girardot':              'girardot_urbano',
  'Flandes - Urbano':      'flandes_urbano',
  'Flandes - Vía Espinal': 'flandes_via_espinal',
  'Nilo - San Marcos':     'nilo_san_marcos',
  'Tocaima':               'tocaima',
};

// 3. Insertar en Visor
const ref = env.VITE_SUPABASE_URL.match(/https:\/\/([^.]+)\./)[1];
const pwd = encodeURIComponent(env.SUPABASE_DB_PASSWORD);
const pgc = new pg.Client({ connectionString: `postgresql://postgres:${pwd}@db.${ref}.supabase.co:5432/postgres`, ssl: { rejectUnauthorized: false } });
await pgc.connect();

let inseridos = 0, actualizados = 0, errores = 0;
for (const p of prospectos) {
  const zonaCodigo = SECTOR_A_ZONA[p.sector] ?? null;
  // Ciudad inferida del sector
  let ciudad = null;
  if (p.sector.startsWith('Ricaurte')) ciudad = 'Ricaurte';
  else if (p.sector.startsWith('Girardot')) ciudad = 'Girardot';
  else if (p.sector.startsWith('Flandes')) ciudad = 'Flandes';
  else if (p.sector.startsWith('Nilo')) ciudad = 'Nilo';
  else if (p.sector === 'Tocaima') ciudad = 'Tocaima';

  try {
    const r = await pgc.query(
      `INSERT INTO conjuntos
         (prospecto_uuid, nombre, sector, direccion, estado_prospeccion, prioridad,
          zona_codigo, ciudad, notas, last_visit, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'gestor_prospectos')
       ON CONFLICT (nombre) DO UPDATE SET
         prospecto_uuid     = EXCLUDED.prospecto_uuid,
         sector             = EXCLUDED.sector,
         direccion          = EXCLUDED.direccion,
         estado_prospeccion = EXCLUDED.estado_prospeccion,
         prioridad          = EXCLUDED.prioridad,
         zona_codigo        = EXCLUDED.zona_codigo,
         ciudad             = EXCLUDED.ciudad,
         last_visit         = EXCLUDED.last_visit,
         updated_at         = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        p.id, p.nombre, p.sector, p.direccion, p.estado, p.prioridad,
        zonaCodigo, ciudad, p.notas, p.last_visit,
      ],
    );
    if (r.rows[0].inserted) inseridos++;
    else actualizados++;
  } catch (e) {
    errores++;
    if (errores <= 3) console.error(`  err en ${p.nombre}: ${e.message}`);
  }
}

await pgc.end();
console.log(`\n✓ Sync completo:`);
console.log(`  Insertados: ${inseridos}`);
console.log(`  Actualizados: ${actualizados}`);
console.log(`  Errores: ${errores}`);
