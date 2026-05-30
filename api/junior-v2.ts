/**
 * Vercel Serverless Function: /api/junior-v2.
 *
 * Mismo contrato que el plugin local de Vite (en dev). En producción Vercel
 * detecta `/visor/api/*.ts` y lo deploya como función edge/node.
 *
 * Body: { pregunta: string, historial?: {rol, texto}[] }
 * → { respuesta, tarjetas_usadas, via_indice, costo_usd } | { error }
 *
 * Variables de entorno requeridas en Vercel:
 *   VITE_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   DEEPSEEK_API_KEY
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Polyfill WebSocket para Node 20 (Vercel default). El cliente Supabase-js
  // chequea presencia de WebSocket al construir (aunque no usemos realtime).
  // Sin esto: 'Node.js 20 detected without native WebSocket support'.
  if (typeof (globalThis as any).WebSocket === 'undefined') {
    const ws = (await import('ws')).default;
    (globalThis as any).WebSocket = ws as any;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'use POST' });
    return;
  }
  try {
    const { pregunta, historial } = req.body ?? {};
    if (!pregunta || typeof pregunta !== 'string') {
      res.status(400).json({ error: 'falta pregunta' });
      return;
    }
    const url = process.env.VITE_SUPABASE_URL;
    const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const dsk = process.env.DEEPSEEK_API_KEY;
    if (!url || !srk || !dsk) {
      res.status(500).json({ error: 'env keys faltantes en Vercel' });
      return;
    }
    // El módulo lib/llm lee process.env al cargar — setear antes de importar.
    process.env.VITE_SUPABASE_URL = url;
    process.env.SUPABASE_SERVICE_ROLE_KEY = srk;
    process.env.DEEPSEEK_API_KEY = dsk;
    const { createClient } = await import('@supabase/supabase-js');
    const sb = createClient(url, srk);
    // Path relativo desde /api/junior-v2.ts (raíz) hasta /agentes/sintesis/junior_v2.ts
    const { responderJuniorTarjeta } = await import('../agentes/sintesis/junior_v2.js');
    const hist = Array.isArray(historial) ? historial.slice(-6) : [];
    const r = await responderJuniorTarjeta(sb, pregunta, hist);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(r);
  } catch (e: any) {
    console.error('[/api/junior-v2]', e?.message ?? e);
    res.status(500).json({ error: e?.message ?? 'error' });
  }
}
