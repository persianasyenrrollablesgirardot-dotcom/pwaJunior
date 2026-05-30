/**
 * Warm-ping. Lo invoca el cron de Vercel cada 5 min para mantener la
 * función /api/junior-v2 caliente — evita el cold-start (800-1500ms) en
 * la primera consulta del día desde el móvil.
 *
 * También sirve como health-check público.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).json({ ok: true, at: new Date().toISOString() });
}
