/**
 * Smoke test para lib/validador.ts.
 * Cubre: schema OK, anti-alucinación, anti-contaminación, reglas duras.
 * Uso: npx tsx agentes/lib/smoke_validador.ts
 */

import { validarOutput, parsearJSONSeguro, ValidacionError, type OutputAgente, type ContextoValidacion } from './validador.js';

const ctx: ContextoValidacion = {
  persona_id_actual: 1,
  identificadores_otros_clientes: ['Pedro Martínez', '+573225458821', 'maria@example.com'],
  msg_ids_disponibles: new Set(['msg_001', 'msg_002', 'msg_003']),
  agente: 'smoke',
};

let pasaron = 0, fallaron = 0;

function probar(nombre: string, fn: () => void, esperaError: string | null) {
  try {
    fn();
    if (esperaError) {
      console.log(`  ❌ ${nombre} — esperaba error '${esperaError}' pero pasó`);
      fallaron++;
    } else {
      console.log(`  ✓ ${nombre}`);
      pasaron++;
    }
  } catch (e: any) {
    if (esperaError && (e.message?.includes(esperaError) || e.regla === esperaError)) {
      console.log(`  ✓ ${nombre} — rechazó correctamente: ${e.message?.slice(0, 80)}`);
      pasaron++;
    } else {
      console.log(`  ❌ ${nombre} — error inesperado: ${e.message}`);
      fallaron++;
    }
  }
}

console.log('=== Validador: outputs válidos (deben pasar) ===');

probar('Output válido con evidencia', () => {
  const out: OutputAgente = {
    tipo_evento: 'inferencia',
    confianza: 'INFERIDO',
    payload: { sistema: 'blackout', ambiente: 'sala' },
    evidencia_msg_ids: ['msg_001', 'msg_002'],
  };
  validarOutput(out, ctx);
}, null);

probar('DUDOSO sin evidencia (permitido)', () => {
  validarOutput({
    tipo_evento: 'inferencia', confianza: 'DUDOSO',
    payload: { observacion: 'cliente vago' }, evidencia_msg_ids: [],
  }, ctx);
}, null);

probar('pregunta_humano sin evidencia (permitido)', () => {
  validarOutput({
    tipo_evento: 'pregunta_humano', confianza: 'INFERIDO',
    payload: { pregunta: '¿confirmas medida?' }, evidencia_msg_ids: [],
  }, ctx);
}, null);

console.log('\n=== Validador: schema (deben fallar) ===');

probar('tipo_evento inválido', () => {
  validarOutput({
    tipo_evento: 'tipo_inventado' as any, confianza: 'INFERIDO',
    payload: {}, evidencia_msg_ids: ['msg_001'],
  }, ctx);
}, 'schema');

probar('confianza inválida', () => {
  validarOutput({
    tipo_evento: 'inferencia', confianza: 'WHATEVER' as any,
    payload: {}, evidencia_msg_ids: ['msg_001'],
  }, ctx);
}, 'schema');

console.log('\n=== Validador: anti-alucinación ===');

probar('INFERIDO sin evidencia', () => {
  validarOutput({
    tipo_evento: 'inferencia', confianza: 'INFERIDO',
    payload: { sistema: 'blackout' }, evidencia_msg_ids: [],
  }, ctx);
}, 'R-anti-alucinacion');

probar('msg_id inexistente', () => {
  validarOutput({
    tipo_evento: 'inferencia', confianza: 'INFERIDO',
    payload: { sistema: 'blackout' }, evidencia_msg_ids: ['msg_999'],
  }, ctx);
}, 'R-anti-alucinacion');

console.log('\n=== Validador: anti-contaminación ===');

probar('payload menciona OTRO cliente', () => {
  validarOutput({
    tipo_evento: 'inferencia', confianza: 'INFERIDO',
    payload: { observacion: 'similar a la cotización de Pedro Martínez' },
    evidencia_msg_ids: ['msg_001'],
  }, ctx);
}, 'R-anti-contaminacion');

probar('payload con teléfono de otro cliente', () => {
  validarOutput({
    tipo_evento: 'inferencia', confianza: 'INFERIDO',
    payload: { telefono_referencia: '+573225458821' },
    evidencia_msg_ids: ['msg_001'],
  }, ctx);
}, 'R-anti-contaminacion');

console.log('\n=== Validador: reglas duras ===');

probar('R-001: GANADA con CONFIRMADO debe abortar', () => {
  validarOutput({
    tipo_evento: 'cambio_estado', confianza: 'CONFIRMADO',
    payload: { nuevo_estado: 'ganada' },
    evidencia_msg_ids: ['msg_001'],
  }, ctx);
}, 'R-001');

probar('R-013#1: medida sin bandera_riesgo si quien_midio=cliente', () => {
  validarOutput({
    tipo_evento: 'medida', confianza: 'INFERIDO',
    payload: { ancho: 2.5, alto: 1.8, quien_midio: 'cliente' },
    evidencia_msg_ids: ['msg_001'],
  }, ctx);
}, 'R-013#1');

probar('R-013#1 OK: medida con bandera correcta', () => {
  validarOutput({
    tipo_evento: 'medida', confianza: 'INFERIDO',
    payload: { ancho: 2.5, alto: 1.8, quien_midio: 'cliente', bandera_riesgo: 'RIESGO_MEDICION_CLIENTE' },
    evidencia_msg_ids: ['msg_001'],
  }, ctx);
}, null);

probar('R-009: pago foto sola con CONFIRMADO debe abortar', () => {
  validarOutput({
    tipo_evento: 'pago', confianza: 'CONFIRMADO',
    payload: { monto: 1000000, solo_foto_comprobante: true },
    evidencia_msg_ids: ['msg_001'],
  }, ctx);
}, 'R-009');

console.log('\n=== Helper parsearJSONSeguro ===');

const j1 = parsearJSONSeguro('{"a":1,"b":"hola"}');
console.log('  JSON normal:', j1.ok ? '✓' : '❌');

const j2 = parsearJSONSeguro('```json\n{"a":1}\n```');
console.log('  JSON envuelto en ```:', j2.ok ? '✓' : '❌');

const j3 = parsearJSONSeguro('not json {');
console.log('  JSON inválido detectado:', !j3.ok ? '✓' : '❌');

console.log('\n=== Resumen ===');
console.log(`Pasaron: ${pasaron} / ${pasaron + fallaron}`);
if (fallaron > 0) process.exit(1);
