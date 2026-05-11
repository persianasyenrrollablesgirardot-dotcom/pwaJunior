# WhatsApp Captura Safra

Extensión Chrome MV3 que captura conversaciones de WhatsApp Web en tiempo real, transcribe audios con Whisper y sincroniza con Supabase.

## Instalación

1. Abre Supabase → SQL Editor → pega el contenido de `SUPABASE_MIGRATION.sql` → Run.
2. Abre Chrome → `chrome://extensions/` → activa **Modo desarrollador**.
3. Clic **Cargar descomprimida** → selecciona la carpeta `C:\Proyectos\WhatsApp_Captura_Safra`.
4. Abre WhatsApp Web (web.whatsapp.com) → F5 si ya estaba abierto.
5. (Opcional) Abre el visor: `cd C:\Proyectos\WhatsApp_Captura_Safra_Visor && npm install && npm run dev`.

## Cómo funciona

- **Tiempo real**: observa el DOM con MutationObserver + scan cada 3 segundos de respaldo.
- **Captura completa del contacto**: nombre, teléfono, foto de perfil, presencia (en línea/escribiendo), última conexión, si es grupo.
- **Audios entrantes y salientes**: detecta `<audio src="blob:">` en el chat, pide transcripción a OpenAI Whisper (idioma es).
- **Sincronización**: DELETE + INSERT por contacto/fecha en Supabase (evita problemas de RLS con PATCH).
- **Sin bloqueos de CSP**: los blobs se leen en `world: 'MAIN'` desde el service worker via `chrome.scripting.executeScript`.

## Estructura

```
WhatsApp_Captura_Safra/
├── manifest.json           ← MV3, permisos y host permissions
├── content.js              ← observer + captura + detección de audio
├── background.js           ← sync Supabase + Whisper + DeepSeek
├── popup.html + popup.js   ← UI: Capturas / Resultados / Ajustes
├── SUPABASE_MIGRATION.sql  ← schema + RLS
└── README.md
```

## Tablas Supabase

- `ws_captures` — capturas crudas (lo que lee la extensión)
- `ws_crm` — registros organizados por IA al CRM

## Claves por defecto

Pre-configuradas en `background.js`. Cámbialas desde el popup → Ajustes si las rotas.

## Notas técnicas

- Chrome MV3 requiere Promise-based APIs, no callbacks. Todo usa `async/await`.
- El service worker duerme cuando no hay actividad — los mensajes son fire-and-forget con `.catch()`.
- El content script respeta el CSP de WhatsApp — las llamadas externas viven todas en background.
- Dedup por hash de contacto+fecha+cantidad+últimos 3 mensajes (evita spam a Supabase).
