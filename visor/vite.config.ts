import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/**
 * Vite config minimal para PWA Junior (deploy en Vercel).
 *
 * En este repo NO van los plugins de dev del Visor_PG (worker spawner,
 * endpoints /api/* inline, keys local, etc). Acá:
 *   - /api/junior-v2 y /api/ping son Vercel serverless functions (en /api/ raíz).
 *   - Solo se inyectan las VITE_* públicas en el bundle.
 *   - El desarrollo de UI sigue ocurriendo en C:\Proyectos\Visor_PG\visor — este
 *     repo es solo para el deploy del PWA.
 */
export default defineConfig(({ mode }) => {
  // Cargar TODAS las variables (incluso sin prefijo VITE_) desde el root del repo.
  const env = loadEnv(mode, path.resolve(__dirname, '..'), '');
  return {
    plugins: [react()],
    server: { port: 5180, strictPort: true, host: true },
    define: {
      'import.meta.env.VITE_SUPABASE_URL':      JSON.stringify(env.VITE_SUPABASE_URL),
      'import.meta.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY),
    },
  };
});
