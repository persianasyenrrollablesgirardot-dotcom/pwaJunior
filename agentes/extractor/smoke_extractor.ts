/**
 * Smoke test del extractor sobre los 411 mensajes ya en BD.
 * Reporta:
 *   - cuántos mensajes tienen al menos 1 extracción
 *   - tipos detectados (top)
 *   - sample de extracciones por tipo
 *   - latencia total
 *
 * Uso: npx tsx agentes/extractor/smoke_extractor.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { extraer, extraerLote } from './extractor.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

async function main() {
  console.log('=== Tests unitarios sobre frases representativas ===');

  const FRASES_TEST = [
    'mi celular es 3225458821, llámame',
    'envía a la Cra 10 # 35-20 conjunto Mirador del Río',
    'la sala mide 2.40 x 1.80 m',
    'cotización: $1.500.000',
    'el sábado a las 9am estamos en casa',
    'cliente@example.com escribió pidiendo blackout motorizado',
    'NIT 900123456-7 factura',
    'cc 1234567890 verificar',
    'nos vemos el 15 de octubre',
    'son 350 mil por la sheer elegance',
    'blackout sala + screen solar oficina · cotizar urgente',
  ];

  for (const f of FRASES_TEST) {
    const exts = extraer(f, 'test_msg');
    console.log(`\n  "${f}"`);
    if (exts.length === 0) console.log('    (sin extracciones)');
    else exts.forEach(e => console.log(`    [${e.tipo}] ${e.valor}${e.meta ? ' ' + JSON.stringify(e.meta) : ''}`));
  }

  console.log('\n=== Procesando 411 mensajes reales de BD ===');
  const t0 = Date.now();
  const { data: msgs, error } = await sb
    .from('mensajes')
    .select('canal_msg_id, texto, chat_id, chats!inner(titulo)')
    .not('texto', 'is', null)
    .is('deleted_at', null);
  if (error) { console.error(error); process.exit(1); }
  console.log(`  ${msgs?.length} mensajes con texto cargados (${Date.now() - t0}ms query)`);

  const t1 = Date.now();
  const r = extraerLote((msgs ?? []).map(m => ({ canal_msg_id: m.canal_msg_id, texto: m.texto })));
  const dt = Date.now() - t1;

  console.log(`\n  Procesado en ${dt}ms (${(msgs!.length / (dt / 1000)).toFixed(0)} msg/s)`);
  console.log(`  Total extracciones: ${r.total}`);
  console.log(`  Mensajes con al menos 1 extracción: ${r.porMensaje.size} de ${msgs?.length} (${Math.round(100 * r.porMensaje.size / msgs!.length)}%)`);

  console.log('\n  Por tipo:');
  const tipos = Object.entries(r.porTipo).sort((a, b) => b[1].length - a[1].length);
  for (const [tipo, exts] of tipos) {
    console.log(`    ${tipo.padEnd(22)} ${String(exts.length).padStart(4)}    sample: ${exts.slice(0, 3).map(e => e.valor).join(' | ')}`);
  }

  console.log('\n=== Top 10 extracciones más interesantes ===');
  const interesantes = ['telefono', 'medida', 'monto', 'sistema_safra', 'direccion', 'fecha_absoluta'];
  for (const tipo of interesantes) {
    const exts = (r.porTipo as any)[tipo] as any[];
    if (!exts || exts.length === 0) continue;
    console.log(`\n  ${tipo} (${exts.length} encontradas):`);
    exts.slice(0, 5).forEach(e => {
      const ctx = msgs!.find(m => m.canal_msg_id === e.msg_id);
      const titulo = (ctx as any)?.chats?.titulo ?? '';
      console.log(`    [${titulo.padEnd(20).slice(0, 20)}] ${e.valor.padEnd(40).slice(0, 40)} ← "${e.valor_raw.slice(0, 50)}"`);
    });
  }

  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
