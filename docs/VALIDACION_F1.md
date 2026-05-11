# Validación end-to-end — FASE 1 completa

> Pasos concretos para verificar que TODO el bootstrap técnico funciona.
> 6-7 minutos en total.

---

## Pre-requisitos (ya están listos)

- [x] Supabase reseteado con schema nuevo (24 tablas, 21 del Visor + 3 knowledge intactas)
- [x] Visor corriendo en `http://localhost:5173`
- [x] Extensión adaptada en `C:\Proyectos\Visor_PG\extension\`
- [x] Worker pipeline listo (`npm run worker:pipeline`)

---

## Paso 1 — Desinstalar la extensión vieja (importante)

1. Abre Chrome → `chrome://extensions`
2. Busca "WhatsApp Captura Safra V2" (la vieja)
3. Click en **Quitar**

**Por qué:** la nueva tiene mismo dominio de WA Web. Si las dos están activas, se pelean por interceptar mensajes.

---

## Paso 2 — Cargar la extensión nueva

1. En `chrome://extensions` (modo desarrollador ON, esquina superior derecha)
2. Click en **Cargar descomprimida**
3. Selecciona la carpeta: `C:\Proyectos\Visor_PG\extension`
4. Confirma que aparezca: **"Visor PG · Captura WhatsApp"** versión 4.0.0
5. Click en el ícono de la extensión en la barra de Chrome → debe abrir el popup

---

## Paso 3 — Configurar la API key de Supabase en la extensión

Abre el popup de la extensión y pega la **anon key**. La copio del `.env`:

(Te lo dejo más abajo en este mensaje. Es la clave que dice `VITE_SUPABASE_ANON_KEY`)

> Si la extensión ya tenía la key del Supabase viejo, está OK — es el mismo Supabase, solo con tablas distintas.

---

## Paso 4 — Abrir WhatsApp Web

1. Abre nueva pestaña → `https://web.whatsapp.com`
2. Escanea el QR (si no tenés sesión activa)
3. Espera 30-60s a que la extensión termine el sniffing inicial de IndexedDB

---

## Paso 5 — Autorizar un chat de prueba

1. Click en el ícono de la extensión → popup
2. Busca un chat **REAL** (puede ser uno de prueba con tu propio número o un contacto seguro)
3. Click en **"Autorizar"** o el toggle correspondiente

> Solo los chats autorizados sincronizan a Supabase. Esto evita gastar API en 3000 chats que no nos importan.

---

## Paso 6 — Arrancar el worker de identidad

En una terminal Bash o PowerShell aparte (no la del Visor dev server):

```bash
cd C:\Proyectos\Visor_PG
npm run worker:pipeline
```

Vas a ver:
```
[PIPELINE] iniciando worker (Supabase: olububjdvboiqgmihsmk.supabase.co)
[PIPELINE] realtime status: SUBSCRIBED
```

Lo dejas corriendo. Cada vez que llegue un evento NUEVO al Supabase, lo procesa y lo marca IDENTIFICADO.

---

## Paso 7 — Mandarse un mensaje de prueba

1. En WhatsApp Web, escribe un mensaje desde tu propio número (o pídele a alguien que te escriba al chat autorizado)
2. **Espera 5-10 segundos**

---

## Paso 8 — Verificar en el Visor

1. Abre `http://localhost:5173`
2. Verifica que el toggle **Real / Demo** esté en **Real** (verde)
3. Recorré los 7 sub-tabs del MÓDULO 1:

| Tab | Qué deberías ver |
|---|---|
| 1.1 Bandeja | El chat autorizado en la lista; al click, los mensajes con ts correctos |
| 1.2 Identidad | Una persona nueva (creada automáticamente con el nombre/teléfono del chat) |
| 1.3 Inmueble | Vacío todavía (no se infiere automáticamente, lo agregás manual) |
| 1.4 Proyecto | Un proyecto "Conversación inicial" creado automáticamente |
| 1.5 Timeline | Línea de tiempo con 1+ eventos `mensaje_entrante` |
| 1.6 EVENTO_PG | Tabla con eventos en estado `IDENTIFICADO` (pasaron por L1) |
| 1.7 Buzón | Vacío (los agentes IA aún no están activos — eso es FASE 2) |

4. En **Centro de Control** verifica los KPIs reales (>0 eventos, >0 proyectos)

---

## Si algo NO funciona

| Síntoma | Causa probable | Cómo verificar |
|---|---|---|
| Mensajes no aparecen en BD | Extensión no autorizada, o key vacía | Abre Console del SW de la extensión: `chrome://extensions` → Detalles → Inspeccionar service worker |
| Persona no se crea | Worker pipeline no está corriendo | Mirá la terminal: debe loggear `evento → IDENTIFICADO` |
| Visor muestra error de conexión | Supabase URL/key incorrectos | Console del navegador (F12) — ver la URL fallida |
| Timeline vacío pese a haber mensajes | Realtime de Supabase no propagó | Refresh del Visor (F5). Si tras refresh aparecen, es un bug de Realtime resuelto con catch-up |

---

## Cuando funcione

Decime "funciona" y cierro F1 oficialmente. Próximo paso: **MÓDULO 2 — Comerciales** (Cotizaciones, Comparador, Objeciones, Seguimiento, Referidos, Recompra).

Si querés primero pulir algo del MÓDULO 1 (UX, agregar manualmente, editar persona, fusionar duplicados), decime qué y lo afino antes de avanzar.
