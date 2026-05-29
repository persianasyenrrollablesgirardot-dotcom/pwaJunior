/**
 * WORKER DE TARJETAS V2 — standalone (uso manual/debug).
 *
 * La lógica del ciclo vive en tarjeta_engine.cicloTarjetas, que TAMBIÉN corre
 * embebida en el worker principal (worker_pipeline_v2). Este standalone queda
 * para correr el motor de tarjetas aislado cuando convenga.
 *
 * Correr: npx tsx workers/worker_tarjetas.ts
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { cicloTarjetas } from '../agentes/sintesis/tarjeta_engine.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const POLL_MS = 8000;
const ts = () => new Date().toLocaleTimeString('es-CO');
const log = (m: string) => console.log(`[${ts()}] ${m}`);

console.log('[TARJETAS] worker V2 standalone arrancando…');
await cicloTarjetas(sb, log);
setInterval(() => { cicloTarjetas(sb, log).catch(e => console.error('[TARJETAS]', e.message)); }, POLL_MS);
