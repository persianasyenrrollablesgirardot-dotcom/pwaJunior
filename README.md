# PWA Junior — Persianas Girardot

App móvil PWA del asistente Junior. Es una vista slim del [Visor PG](#) (chat, checklist, agendamientos, tareas) sin sidebar ni captura. Conectada al mismo Supabase del Visor desktop — cualquier acción se ve al instante en los dos lados.

## Stack

- React + TypeScript + Vite (frontend).
- Vercel Serverless Functions (`/api/junior-v2`, `/api/ping`).
- Supabase (BD compartida con Visor PG).
- DeepSeek (LLM).

## Deploy

1. **Importar repo en Vercel** (https://vercel.com/new). El `vercel.json` ya configura todo.
2. **Variables de entorno** (Settings → Environment Variables):
   - `VITE_SUPABASE_URL` = `https://olububjdvboiqgmihsmk.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = (la del `.env` original)
   - `SUPABASE_SERVICE_ROLE_KEY` = (la del `.env` original)
   - `DEEPSEEK_API_KEY` = (la del `.env` original)
3. Push → auto-deploy. URL inicial: `<proyecto>.vercel.app/junior`.
4. En el celular (Safari iOS / Chrome Android): **"Agregar a pantalla de inicio"** → ícono Junior instalado.

## Estructura

```
visor/         # Frontend React (UI Junior)
  src/         # Componentes y panels
  public/      # PWA manifest, service worker, ícono
  api/         # Serverless functions (endpoint Junior + warm ping)
agentes/       # Lógica de Junior (importada por la serverless function)
vercel.json    # Build + functions + cron warm-ping cada 5 min
```

## Warm-ping

`vercel.json` corre un cron cada 5 min a `/api/ping` para evitar cold-starts en la función Junior (que tarda 800-1500ms si la instance estuvo dormida).

## Sincronizar con Visor PG

El código fuente vive en `C:\Proyectos\Visor_PG\`. Cuando cambien `agentes/sintesis/junior_v2.ts` o `visor/src/panels/Junior*.tsx`, sincronizar a este repo:

```bash
# Desde C:\Proyectos\Visor_PG\
cp -r visor/src visor/public visor/api ../pwaJunior_repo/visor/
cp -r agentes ../pwaJunior_repo/
cd ../pwaJunior_repo
git add -A && git commit -m "sync: cambios desde Visor PG" && git push
```
