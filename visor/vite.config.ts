import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * F1.22 fix C1: middleware que sirve las keys sensibles (OpenAI, DeepSeek) SOLO
 * a localhost, sin meterlas en el bundle público.
 *
 * Antes: VITE_OPENAI_API_KEY/VITE_DEEPSEEK_API_KEY se inyectaban en el bundle
 * (visible en DevTools si se publicaba fuera de localhost = costos no controlados).
 *
 * Ahora: el Visor en runtime hace `fetch('/api/keys')` para obtenerlas. El
 * middleware solo responde si el request viene de localhost (verificación por
 * remoteAddress de socket). El build de producción NO tiene las keys.
 */
function keysApiPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'visor-pg-keys-api',
    configureServer(server) {
      server.middlewares.use('/api/keys', (req, res) => {
        // Validar localhost: socket.remoteAddress es '127.0.0.1', '::1' o '::ffff:127.0.0.1'
        const addr = req.socket?.remoteAddress ?? '';
        const esLocalhost = addr === '127.0.0.1' || addr === '::1' || addr.endsWith('127.0.0.1');
        if (!esLocalhost) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'forbidden: solo localhost' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({
          openaiKey: env.OPENAI_API_KEY ?? '',
          deepseekKey: env.DEEPSEEK_API_KEY ?? '',
        }));
      });
    },
  };
}

/**
 * F8.3 — endpoint /api/transcribe local (solo localhost).
 * Recibe POST con multipart/form-data field 'audio'. Delega a
 * agentes/lib/openai.ts whisperTranscribe. Devuelve { texto, costo_usd, latencia_ms }.
 *
 * Solo el Visor en runtime (mismo origen) puede usar este endpoint:
 * no se expone fuera de localhost.
 */
function transcribeApiPlugin(env: Record<string, string>): Plugin {
  return {
    name: 'visor-pg-transcribe-api',
    configureServer(server) {
      server.middlewares.use('/api/transcribe', async (req: IncomingMessage, res: ServerResponse) => {
        const addr = req.socket?.remoteAddress ?? '';
        const esLocalhost = addr === '127.0.0.1' || addr === '::1' || addr.endsWith('127.0.0.1');
        if (!esLocalhost) {
          res.statusCode = 403;
          res.end(JSON.stringify({ error: 'forbidden: solo localhost' }));
          return;
        }
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end(JSON.stringify({ error: 'method not allowed; use POST multipart' }));
          return;
        }
        if (!env.OPENAI_API_KEY) {
          res.statusCode = 503;
          res.end(JSON.stringify({ error: 'OPENAI_API_KEY no configurada en .env' }));
          return;
        }
        try {
          // Lee todo el body como Buffer
          const chunks: Buffer[] = [];
          for await (const chunk of req as any) chunks.push(chunk as Buffer);
          const fullBody = Buffer.concat(chunks);

          // Parsing simple del multipart: buscar el boundary y el archivo
          const contentType = req.headers['content-type'] ?? '';
          const boundaryMatch = contentType.match(/boundary=(.+)$/);
          if (!boundaryMatch) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'no boundary en multipart/form-data' }));
            return;
          }
          const boundary = '--' + boundaryMatch[1];
          const parts = fullBody.toString('binary').split(boundary);
          // Buscar la parte que tenga 'name="audio"' o similar
          const audioPart = parts.find(p => p.includes('Content-Disposition') && /name="?audio"?/i.test(p));
          if (!audioPart) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'field "audio" no encontrado' }));
            return;
          }
          // El cuerpo del audio está después de \r\n\r\n
          const sepIdx = audioPart.indexOf('\r\n\r\n');
          if (sepIdx < 0) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'multipart mal formado' }));
            return;
          }
          // El binario del audio (sin el \r\n final del closing boundary)
          let audioBinary = audioPart.slice(sepIdx + 4);
          if (audioBinary.endsWith('\r\n')) audioBinary = audioBinary.slice(0, -2);
          const audioBuffer = Buffer.from(audioBinary, 'binary');

          // Detectar mime/filename del header
          const mimeMatch = audioPart.match(/Content-Type:\s*([^\r\n]+)/i);
          const fnMatch = audioPart.match(/filename="([^"]+)"/i);
          const mimetype = (mimeMatch?.[1] ?? 'audio/ogg').trim();
          const filename = fnMatch?.[1] ?? 'audio.ogg';

          // Setear OPENAI_API_KEY en process.env para que el módulo lo lea
          process.env.OPENAI_API_KEY = env.OPENAI_API_KEY;

          const { whisperTranscribe } = await import('../agentes/lib/openai.js');
          const result = await whisperTranscribe({
            audioBuffer, mimetype, filename, agente: 'visor-m7.4',
          });

          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            texto: result.texto,
            costo_usd: result.costo_usd,
            latencia_ms: result.latencia_ms,
            duracion_segundos: result.duracion_segundos,
          }));
        } catch (e: any) {
          console.error('[/api/transcribe]', e.message);
          res.statusCode = 500;
          res.end(JSON.stringify({ error: e.message }));
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Cargar TODAS las variables (incluyendo las sin prefijo VITE_) del root del proyecto
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  return {
    plugins: [react(), keysApiPlugin(env), transcribeApiPlugin(env)],
    server: { port: 5173, host: true },
    define: {
      // SOLO las VITE_ se inyectan en el bundle (públicas por diseño)
      'import.meta.env.VITE_SUPABASE_URL':      JSON.stringify(env.VITE_SUPABASE_URL),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY),
    },
  };
});
