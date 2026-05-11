/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  // Las keys sensibles (OpenAI, DeepSeek) NO están acá — se obtienen via /api/keys
  // que solo responde a localhost (vite.config.ts middleware).
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
