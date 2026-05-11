#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
const sb = createClient(
  'https://dnsyyvtznkllneyuopoa.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRuc3l5dnR6bmtsbG5leXVvcG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA4NDQyNjUsImV4cCI6MjA4NjQyMDI2NX0.6CW_SQG9HXTu930MwclN9lDeqrn95Bsj-RpO_L057Zg',
);
const { data, error, count } = await sb.from('prospectos_conjuntos').select('*', { count: 'exact' });
if (error) { console.error('❌', error); process.exit(1); }
console.log(`✓ ${count} prospectos en BD real`);
const porEstado = {}, porSector = {};
for (const p of data) {
  porEstado[p.estado] = (porEstado[p.estado] ?? 0) + 1;
  porSector[p.sector] = (porSector[p.sector] ?? 0) + 1;
}
console.log('\nPor estado:', porEstado);
console.log('\nPor sector:');
for (const [s, n] of Object.entries(porSector).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`);

import { writeFileSync } from 'node:fs';
writeFileSync('_prospectos_real.json', JSON.stringify(data, null, 2));
console.log('\n📝 _prospectos_real.json escrito');
