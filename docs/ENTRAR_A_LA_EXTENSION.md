# Cómo entrar a la extensión de captura programáticamente (para depurar)

> Guía para LEER la captura local de la extensión (su IndexedDB) y DISPARAR sus acciones
> (`V3_PROCESS_CHAT`, etc.) desde fuera, cuando hace falta diagnosticar un bug que solo se ve
> en los datos locales del navegador. Probado y usado el 2026-06-03.

## El problema: Chrome 148 bloquea la automatización normal

La extensión `oomdmlhadnonedbdjdcfkpceaijpkelj` ("Visor PG · Captura WhatsApp") es **unpacked**
(modo desarrollador), cargada desde `C:\Proyectos\Visor_PG\extension`, y su captura vive en la
IndexedDB del perfil **Default** (`wa_capture_v2_db`). Chrome 148 cierra todas las puertas obvias:

| Intento | Resultado |
|---|---|
| `--remote-debugging-port` sobre el perfil **Default** | **Ignorado** (Chrome 136+ lo desactiva en el data-dir por defecto) |
| `--load-extension` en Chrome normal | **Bloqueado** (Chrome 137+ con el flag `DisableLoadExtensionCommandLineSwitch`) |
| Habilitar la extensión unpacked en un **perfil copiado** | Toggle **greyed** (protección anti-sideload: *"se podría haber añadido sin tu conocimiento"*) |
| Montar la IndexedDB de la extensión bajo otro origen (ej. `localhost`) | Chrome etiqueta los datos por origen interno → no los lee |

## La solución: Chrome for Testing

`Chrome for Testing` (build de automatización, ya instalado por puppeteer) **sí** permite
extensiones unpacked + depuración remota. Binario:

```
C:\Users\jhon\.cache\puppeteer\chrome\win64-146.0.7680.153\chrome-win64\chrome.exe
```

(si cambia la versión: `ls C:\Users\jhon\.cache\puppeteer\chrome\`)

### Paso 1 — Montar una copia del perfil Default

Copiá SOLO lo necesario a un user-data-dir temporal (la IndexedDB live se copia bien aunque
Chrome real esté corriendo; los `.ldb` son append-only):

```bash
UD="/c/Users/jhon/AppData/Local/Google/Chrome/User Data"
T="/c/temp/vpg_cft"; rm -rf "$T"; mkdir -p "$T/Default/IndexedDB"
cp "$UD/Local State" "$T/Local State"
cp "$UD/Default/Preferences" "$T/Default/Preferences"
cp "$UD/Default/Secure Preferences" "$T/Default/Secure Preferences"
cp -r "$UD/Default/IndexedDB/chrome-extension_oomdmlhadnonedbdjdcfkpceaijpkelj_0.indexeddb.leveldb" "$T/Default/IndexedDB/"
cp -r "$UD/Default/IndexedDB/chrome-extension_oomdmlhadnonedbdjdcfkpceaijpkelj_0.indexeddb.blob"    "$T/Default/IndexedDB/"
# forzar modo desarrollador en el perfil copiado
node -e "const fs=require('fs');const p='C:/temp/vpg_cft/Default/Preferences';const j=JSON.parse(fs.readFileSync(p,'utf8'));j.extensions=j.extensions||{};j.extensions.ui=j.extensions.ui||{};j.extensions.ui.developer_mode=true;fs.writeFileSync(p,JSON.stringify(j));"
```

### Paso 2 — Lanzar Chrome for Testing con la extensión + puerto de depuración

```powershell
Start-Process 'C:\Users\jhon\.cache\puppeteer\chrome\win64-146.0.7680.153\chrome-win64\chrome.exe' -ArgumentList `
  '--user-data-dir=C:\temp\vpg_cft','--remote-debugging-port=9240','--remote-allow-origins=*', `
  '--disable-features=DisableLoadExtensionCommandLineSwitch', `
  '--load-extension=C:\Proyectos\Visor_PG\extension','--no-first-run','--headless=new'
```

La extensión carga con su **ID real `oomdmlhad`** (no path-derivado, porque el perfil la tiene
registrada) y abre su IndexedDB real. Verificar que el service worker está vivo:

```bash
curl -s http://localhost:9240/json | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const t=JSON.parse(d);console.log(t.some(x=>x.type==='service_worker'&&x.url.includes('oomdmlhad'))?'SW vivo':'SW dormido');})"
```

> El SW MV3 se duerme a los ~30s. Para despertarlo: abrí `chrome-extension://oomdmlhad.../popup.html`
> o mandale un mensaje. Conectá con `puppeteer-core` (ya en `node_modules` del root):
> `const v=await (await fetch('http://localhost:9240/json/version')).json(); const b=await puppeteer.connect({browserWSEndpoint:v.webSocketDebuggerUrl});`

### Paso 3a — LEER la captura local

Abrí una página del **origen de la extensión** (`popup.html`) y consultá la IndexedDB nativa.
DB = `wa_capture_v2_db`, store = `messages`, índice = `by_chat` (key = jid del chat):

```js
const page = await b.newPage();
await page.goto('chrome-extension://oomdmlhadnonedbdjdcfkpceaijpkelj/popup.html', {waitUntil:'domcontentloaded'});
const msgs = await page.evaluate(async (JID) => {
  const db = await new Promise((rs,rj)=>{const q=indexedDB.open('wa_capture_v2_db');q.onsuccess=()=>rs(q.result);q.onerror=()=>rj(q.error);});
  const st = db.transaction('messages','readonly').objectStore('messages');
  return await new Promise(rs=>{const a=[];st.index('by_chat').openCursor(IDBKeyRange.only(JID)).onsuccess=e=>{const c=e.target.result;if(!c){rs(a);return;}a.push(c.value);c.continue();};});
}, '48967475790015@lid');
// cada msg: {id, chat_id, type, text, caption, mimetype, media:{ai_status,ai_text}, processing_state, is_owner, timestamp_ms, ...}
```

Otros stores útiles: `chat_metadata` (stats por chat), `processing_state`, `pending_queue`.

### Paso 3b — DISPARAR acciones (procesar un chat, etc.)

Inyectá la anon key (la extensión la lee de `chrome.storage.local`, key `ws_settings.supabaseKey`)
desde el popup, y luego llamá la API externa desde una página del Visor (`http://localhost:5180`,
origen permitido por `externally_connectable`):

```js
// 1) inyectar key (anon de .env → VITE_SUPABASE_ANON_KEY)
await popPage.evaluate((anon)=>new Promise(r=>chrome.storage.local.get(['ws_settings'],d=>{const s=d.ws_settings||{};s.supabaseKey=anon;chrome.storage.local.set({ws_settings:s},()=>r());})), ANON);
// 2) llamar V3_PROCESS_CHAT desde una página de localhost:5180
const visor = await b.newPage();
await visor.goto('http://localhost:5180/', {waitUntil:'domcontentloaded'});
const res = await visor.evaluate((EXT,jid)=>new Promise(resolve=>{
  window.chrome.runtime.sendMessage(EXT, {type:'V3_PROCESS_CHAT', jid}, r=>resolve(r));
}), 'oomdmlhadnonedbdjdcfkpceaijpkelj', '48967475790015@lid');
// res = { ok, chat_id_db, re_sync, mensajes_subidos, reparados, eventos_creados, mensajes_total }
```

Handlers externos disponibles (ver `extension/extension_api.js`): `V3_PING`, `V3_LIST_CHATS`,
`V3_GET_MESSAGES`, `V3_PROCESS_CHAT`, `V3_BLOCK_CHAT`, `V3_TRANSCRIBE_CHAT_MEDIA`, `V3_WA_STATUS`, `V3_SET_KEYS`.

### Paso 4 — LIMPIAR SIEMPRE

```bash
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { \$_.CommandLine -like '*vpg_cft*' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }"
rm -rf /c/temp/vpg_cft
```

## Notas / gotchas

- **El perfil productivo es `Default`** (display "Tu Chrome"), NO un "Profile 2 / Jhon Cubides" —
  eso es solo la etiqueta del selector. Solo Default tiene la extensión + WhatsApp.
- Disparar `V3_PROCESS_CHAT` desde esta instancia escribe en el **Supabase REAL** (es lo mismo
  que el botón "Procesar nuevos"). La instancia copiada usa un **snapshot** de la IndexedDB.
- Para reproducir bugs de escritura usar la **anon key** (es la que usa la extensión, con RLS),
  no la service_role.
- Esto NO toca el Chrome real de Jhon — corre en una instancia aparte de Chrome for Testing.
