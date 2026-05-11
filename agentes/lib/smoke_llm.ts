/**
 * Smoke test para lib/llm.ts.
 * Corre 3 escenarios: ok, tope superado, JSON estructurado.
 * Uso: npx tsx agentes/lib/smoke_llm.ts
 */

import { deepseekChat } from './llm.js';

async function main() {
  console.log('=== TEST 1: Llamada simple ===');
  const r1 = await deepseekChat({
    messages: [{ role: 'user', content: 'Responde solamente: HOLA JHON' }],
    max_tokens: 10,
    agente: 'smoke-1',
  });
  console.log('  Respuesta:', JSON.stringify(r1.contenido));

  console.log('\n=== TEST 2: JSON estructurado ===');
  const r2 = await deepseekChat({
    messages: [
      { role: 'system', content: 'Responde SOLO con JSON válido. Sin texto extra.' },
      { role: 'user', content: 'Devuelve un JSON con campos: nombre="Pedro", edad=42, sistema="blackout"' },
    ],
    response_format: { type: 'json_object' },
    max_tokens: 100,
    agente: 'smoke-2',
  });
  console.log('  Respuesta:', r2.contenido);
  try {
    const parsed = JSON.parse(r2.contenido);
    console.log('  Parsed OK:', JSON.stringify(parsed));
  } catch (e: any) {
    console.log('  Parse error:', e.message);
  }

  console.log('\n=== TEST 3: Tope hard ($0.000001 — debe abortar) ===');
  try {
    await deepseekChat({
      messages: [{ role: 'user', content: 'Escribe un párrafo largo sobre persianas blackout' }],
      max_tokens: 200,
      costoLimiteUsd: 0.000001,
      agente: 'smoke-3',
    });
    console.log('  ❌ NO ABORT (debería haber abortado)');
  } catch (e: any) {
    console.log('  ✓ Abortó correctamente:', e.message);
  }

  console.log('\n=== Resumen ===');
  console.log('Costo total tests:', '$' + (r1.costo_usd + r2.costo_usd).toFixed(6));
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
