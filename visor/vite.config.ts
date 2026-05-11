import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

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

export default defineConfig(({ mode }) => {
  // Cargar TODAS las variables (incluyendo las sin prefijo VITE_) del root del proyecto
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  return {
    plugins: [react(), keysApiPlugin(env)],
    server: { port: 5173, host: true },
    define: {
      // SOLO las VITE_ se inyectan en el bundle (públicas por diseño)
      'import.meta.env.VITE_SUPABASE_URL':      JSON.stringify(env.VITE_SUPABASE_URL),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY),
    },
  };
});
