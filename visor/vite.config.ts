import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
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

/**
 * F40 — worker_pipeline_v2 embebido en Vite dev server.
 *
 * Antes: Jhon tenía que arrancar `npm run worker:v2` en una terminal aparte.
 * Si se olvidaba, el "Procesar histórico" del Visor creaba eventos en BD
 * pero ningún agente los tomaba — todo quedaba en estado IDENTIFICADO y
 * la UI no mostraba nada nuevo (síntoma: "32 agentes activos pero nada
 * pasa cuando proceso un cliente").
 *
 * Ahora: al arrancar `npm run visor:dev`, el plugin spawnea el worker como
 * child process. stdout/stderr se ven en la misma terminal con prefijo
 * `[worker]`. Si Vite se cierra, mata el child. El worker se reinicia
 * automáticamente con backoff exponencial si crashea.
 *
 * Solo activo en modo `serve` (dev). En `build` no spawna nada.
 *
 * Para deshabilitar puntualmente: `VISOR_NO_WORKER=1 npm run dev`.
 */
function embeddedWorkerPlugin(): Plugin {
  let child: ChildProcess | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let restartDelayMs = 2000;
  let stopping = false;
  const REPO_ROOT = path.resolve(__dirname, '..');
  const WORKER_SCRIPT = path.join('workers', 'worker_pipeline_v2.ts');
  const PREFIX = '\x1b[36m[worker]\x1b[0m';

  function log(line: string) {
    for (const l of line.split(/\r?\n/)) {
      if (l.trim()) console.log(`${PREFIX} ${l}`);
    }
  }

  function spawnWorker() {
    if (stopping) return;
    log('spawn → tsx ' + WORKER_SCRIPT);
    child = spawn('npx', ['tsx', WORKER_SCRIPT], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env },
    });
    child.stdout?.on('data', d => log(d.toString()));
    child.stderr?.on('data', d => log('\x1b[33m' + d.toString() + '\x1b[0m'));
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) return;
      log(`exit code=${code} signal=${signal} — reintentando en ${restartDelayMs}ms`);
      restartTimer = setTimeout(() => {
        restartDelayMs = Math.min(restartDelayMs * 2, 30000);
        spawnWorker();
      }, restartDelayMs);
    });
    // si vive >30s, resetear backoff
    setTimeout(() => { if (child && !child.killed) restartDelayMs = 2000; }, 30000);
  }

  function kill() {
    stopping = true;
    if (restartTimer) clearTimeout(restartTimer);
    if (child && !child.killed) {
      log('kill child');
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
        } else {
          child.kill('SIGTERM');
        }
      } catch {/* ignore */}
    }
    child = null;
  }

  return {
    name: 'visor-pg-embedded-worker',
    apply: 'serve',
    configureServer(server) {
      if (process.env.VISOR_NO_WORKER === '1') {
        log('VISOR_NO_WORKER=1 — worker NO arrancado (modo manual)');
        return;
      }
      spawnWorker();
      server.httpServer?.once('close', kill);
      process.once('SIGINT', () => { kill(); process.exit(0); });
      process.once('SIGTERM', () => { kill(); process.exit(0); });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Cargar TODAS las variables (incluyendo las sin prefijo VITE_) del root del proyecto
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  return {
    plugins: [react(), keysApiPlugin(env), transcribeApiPlugin(env), embeddedWorkerPlugin()],
    server: { port: 5180, strictPort: true, host: true },
    define: {
      // SOLO las VITE_ se inyectan en el bundle (públicas por diseño)
      'import.meta.env.VITE_SUPABASE_URL':      JSON.stringify(env.VITE_SUPABASE_URL),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY),
    },
  };
});
