import { createClient } from '@supabase/supabase-js';

// Cliente Supabase. URL y anon key vienen de .env del proyecto raíz (no del visor/).
// Vite carga las VITE_* automáticamente — ver vite.config.ts.

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!url || !anonKey) {
  console.warn('[supabase] Falta VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY en .env. Modo mockup activo (sin BD).');
}

export const supabase = createClient(
  url ?? 'https://placeholder.supabase.co',
  anonKey ?? 'placeholder-anon-key',
  {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  },
);

export const supabaseConfigured = Boolean(url && anonKey);
