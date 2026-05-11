/**
 * Smoke test para lib/openai.ts.
 * Test 1: Vision con URL pública de imagen de persiana.
 * Test 2: Whisper requiere audio binario, lo dejo pendiente hasta tener uno real.
 *
 * Uso: npx tsx agentes/lib/smoke_openai.ts
 */

import { visionDescribe } from './openai.js';

async function main() {
  console.log('=== TEST 1: Vision con URL pública (imagen de persiana) ===');
  const r1 = await visionDescribe({
    imageUrl: 'https://images.unsplash.com/photo-1631679706909-1844bbd07221?w=600',
    detail: 'low',
    agente: 'smoke-vision-1',
  });
  console.log('  Descripción:', r1.descripcion);
  console.log('  Métricas:', `tokens_in=${r1.tokens_in} tokens_out=${r1.tokens_out} costo=$${r1.costo_usd.toFixed(6)}`);

  console.log('\n=== TEST 2: Vision con prompt específico (cotización) ===');
  // Imagen de stock que parezca cotización/factura
  const r2 = await visionDescribe({
    imageUrl: 'https://images.unsplash.com/photo-1450101499163-c8848c66ca85?w=600',
    detail: 'low',
    prompt: 'Describe brevemente. Si parece un documento, indica de qué tipo (cotización, factura, recibo, comprobante).',
    agente: 'smoke-vision-2',
  });
  console.log('  Descripción:', r2.descripcion.slice(0, 200));
  console.log('  Métricas:', `tokens_in=${r2.tokens_in} tokens_out=${r2.tokens_out} costo=$${r2.costo_usd.toFixed(6)}`);

  console.log('\n=== Resumen ===');
  console.log('Costo total:', '$' + (r1.costo_usd + r2.costo_usd).toFixed(6));
  console.log('Latencia promedio:', Math.round((r1.latencia_ms + r2.latencia_ms) / 2) + 'ms');
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
