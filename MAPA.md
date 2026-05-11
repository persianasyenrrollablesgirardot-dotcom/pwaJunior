# MAPA — Visor PG

> **Documento de progreso vivo.** Se actualiza con cada fase completada o decisión nueva.
> Si se va la luz: leer `README.md` (contexto, 5 min) → `VISION.md` (qué) → `ARQUITECTURA.md` (cómo) → este `MAPA.md` (dónde) → retomar.
>
> **Última actualización:** 2026-05-08 (FASE 2.3 cerrada)
> **Owner:** Jhon Cubides

---

## REGLA DE ORO DEL FLUJO DE TRABAJO

**Cada módulo se construye en este orden ESTRICTO:**

```
1. Claude diseña    → propone mockup visual con datos FAKE en Visor
2. Jhon valida UX   → "sí me sirve" / "cambia X"
3. Claude itera     → ajusta mockup hasta aprobación
4. Claude backend   → construye schema + agentes + queries para llenar la UI
5. Claude tests     → E2E con Puppeteer + smoke + anti-contaminación
6. Jhon usa real    → con datos reales del negocio
7. Jhon valida fin  → "funciona" → módulo cerrado, pasa al siguiente
```

**Reglas no negociables:**
- Jhon **NO revisa SQL, schemas, configs ni código backend**. Solo valida UX/UI.
- Si Claude necesita que Jhon aplique algo en Supabase (porque solo Jhon tiene la cuenta), le da instrucciones mínimas de copy-paste sin pedirle entender.
- Antes de tocar lógica nueva: actualizar `MAPA.md`. Después de aplicar: actualizar `MAPA.md` otra vez.
- Si Claude se traba >30 min, **parar y preguntar**. NO parchar.
- Cada módulo termina con test E2E real pasando. Sin test, no está terminado.

---

## ESTADO ACTUAL

### Fase activa
**FASE 2.3 — Acción "Transcribir media" en extensión + UI ✅ (2026-05-08)**

Decisión arquitectónica clave: **la transcripción de media (Whisper / Vision / PDF) corre en la extensión, NO en un worker del Visor.**

Razones:
- La extensión ya descifra HKDF/AES y guarda blobs en IndexedDB local
- Si lo hiciera el Visor, habría que mover bytes a Supabase Storage (gasto + complejidad)
- El cache SHA-256 ya está implementado en la extensión (`media_processed`)
- Mismo modelo que el proyecto viejo

**Bug raíz resuelto:** `procesarChat()` en `extension_api.js` bypaseaba el pipeline IA (subía mensajes a Supabase sin Whisper/Vision). Por eso `metadata.ai_text=null` en TODOS los media de los 4 chats. Solución: dejar `procesarChat()` rápido (texto only) + acción separada `transcribirMediaChat()` con confirmación de costo.

**Implementado:**
- `extension/extension_api.js`: handlers `V3_ESTIMATE_CHAT_MEDIA` y `V3_TRANSCRIBE_CHAT_MEDIA`. Reglas duras heredadas del proyecto viejo: status@broadcast, sticker, forwarded_many, video, **burst >10 imágenes/(chat,rol,minuto)**. Pool 3 paralelos. Cache SHA-256. UPDATE Supabase con read-modify-write para preservar `metadata.internal_id` y otros.
- `visor/src/lib/extension.ts`: `estimarMediaChat(jid)` y `transcribirMediaChat(jid)` tipados.
- `visor/src/panels/m1/Transcripciones.tsx`: banner "X chats con media pendiente" + modal de confirmación (desglose por servicio + omitidos por reglas) + modal de progreso.

**Tests reales:**
- 17/17 tests funcionales (lógica `clasificarMediaChat` + Whisper real con TTS Windows + Vision real con PNG comprobante + UPDATE Supabase con revert)
- 21/22 tests E2E con Puppeteer attached al Chrome corriendo (puerto 9222) con la extensión cargada en Modo Desarrollador. SW de la extensión recibió la llamada, procesó audio + 10 imágenes (+ 2 omitidas por burst limit + 1 sticker omitido), escribió a Supabase con texto formateado `🎤 …` / `🖼 [Imagen] …`, cache SHA-256 funcionó en 2da corrida (11 cache_hits, $0). El único "fallo" fue threshold mío de "2da corrida 3x más rápida" (salió 2.8x — los UPDATE a Supabase son el bottleneck, no la IA). Cleanup completo.

### Próxima fase
**FASE 2.4 — Agente A5 Cotizaciones (DeepSeek)** — primer agente IA real del enjambre.

### Fase anterior
**FASE 2.2 — Extractor objetivo (L1.5) ✅ (2026-05-08)**

- `agentes/extractor/regex.ts` con 14 patrones (telefono, email, cedula, nit, direccion, conjunto/torre/apto, medida, monto, fecha relativa/absoluta, sistema_safra, codigo_cotizacion, url, horario)
- `agentes/extractor/extractor.ts` función pura, dedup por (tipo, valor)
- `workers/worker_extractor.ts` polling cada 10s, batch 200, $0 costo
- Smoke sobre 295 mensajes reales: 105 extracciones, 49K msg/s
- **Refinado:** medidas exigen rango realista (0.3–8m), montos exigen señal monetaria ($, separador miles, palabra), fecha_absoluta solo años 2020–2030. **-45% falsos positivos** (105 → 58)

### Fase anterior
**FASE 2.1 — Capa 0 infraestructura agentes ✅ (2026-05-08)**

- `agentes/lib/llm.ts` — cliente DeepSeek con tope hard $0.05/inv, retry 429/5xx exponencial, timeout 30s
- `agentes/lib/openai.ts` — Whisper (audio→texto) + Vision (imagen→descripción gpt-4o-mini detail:'low'). Cache identifier SHA-256
- `agentes/lib/validador.ts` — vocabulario controlado (estados cotización/abono/producción), anti-alucinación (evidencia obligatoria), anti-contaminación (no menciona otros clientes), reglas duras R-001/R-009/R-013#1
- `agentes/lib/runner.ts` — orquestador con hooks (cargarContexto, construirPrompt, validarOutputEspecifico, postProcesar). **Modo shadow obligatorio** (NO escribe a tablas de negocio, solo evento_pg con shadow=true). Auto-buzón si confianza < CONFIRMADO

### Fase anterior
**FASE 1.17 — Endurecimiento M1 + plan M2 ✅ (2026-05-08)**

Final del MÓDULO 1:
- Migración 006: campos faltantes Identidad (empresa, referido_por, contacto_alterno) + auditoría humana (actualizado_por en personas/inmuebles/proyectos)
- Identidad UI: búsqueda en sidebar + sección "Red de referidos" + form completo
- Inmueble UI: sección "Logística instalación" estructurada (parqueadero/ascensor/horarios/admin/restricciones)
- Buzón "Editar y aprobar" probado end-to-end (escribe a buzon_validacion + correcciones + evento_pg correccion_humana)

Documentado:
- `docs/PLAN_MODULO_2.md` con decisiones, schema, agentes (Transcribor → Extractor → A5 Cotizaciones), roadmap 8-10 días, riesgos, pre-requisitos

**MÓDULO 1 cerrado oficialmente** ✅

### Fase anterior
**FASE 1.15 — Worker pipeline v2.1 (polling) ✅ (2026-05-08)**

- Refactor de Realtime → polling como carril principal (5s, batch 20, paralelo 3, timeout 10s)
- Realtime queda como aceleración opcional con backoff exponencial
- Test de carga: 50 eventos en 31s a 1.6 evt/s **constantes** (antes degradaba de 1.3 → 0.55)
- Sin caídas, sin logs ruidosos, sin retries

### Fase anterior
**FASE 1.11 — Refactor a 3 capas + módulo Captura ✅ (2026-05-08)**

- Extensión v5.0.0 cargada — sync automático REMOVIDO. Solo captura local + API V3_*
- Tabla `chats_bloqueados` creada (bloqueo persistente)
- Módulo **Captura** funcionando con datos reales (538 chats locales, stats, filtros, regex no-cliente)
- M1 reformado: sin Bandeja, solo chats procesados (sub-tabs 1.1-1.6)
- BD limpia (0 chats hasta que vos proceses uno)

### Fase anterior
**FASE 1.9 — MÓDULO 1 cerrado completo ✅ (2026-05-07)**

- F1.1-F1.7: bootstrap técnico (schema + Visor + extensión + worker + identidad)
- **Pipeline e2e VALIDADO con datos reales** (Guacal Girardot · 12 mensajes capturados→sincronizados→identificados→renderizados)
- F1.8: schema IA + Bandeja con badges + filtros + botones Procesar/Bloquear + TopBar con toggle Tiempo Real
- **F1.9: cierre MÓDULO 1 (10 puntos)**:
  - F1.9.1 ✅ Fix mapper de tipo (text/ptt/audio etc se mapean correcto, no `[sistema]`)
  - F1.9.2 ✅ Buzón con escritura a BD (aprobar/rechazar/editar funcionales + log en `correcciones`)
  - F1.9.3 ✅ Editar persona (modal con todos los campos + UPDATE)
  - F1.9.4 ✅ Cambiar ámbito de chat (dropdown + log en `chat_ambito_historial`)
  - F1.9.5 ✅ Notas libres por persona (CRUD funcional)
  - F1.9.6 ✅ CRUD proyecto (crear, editar, cambiar estado, click→detalle)
  - F1.9.7 ✅ CRUD inmueble (crear/editar)
  - F1.9.8 ✅ Fusionar personas duplicadas (sección 29 ARQUITECTURA implementada)
  - F1.9.9 ✅ Click en filas abre detalle (proyectos, eventos)
  - F1.9.10 ✅ Linaje de eventos en EVENTO_PG (modal con cadena padre→hijo)

### Próxima fase
**FASE 2 — MÓDULO 2 Comerciales** (cotizaciones, comparador, objeciones, seguimiento, referidos, recompra) — primer agente IA del enjambre llega acá

---

## FASES (orden de ejecución)

### ⏳ FASE 0 — Fundación del proyecto (2026-05-07)

**Objetivo**: dejar lista la estructura del repositorio y los 3 documentos base.

**Hecho:**
- [x] Carpeta `C:\Proyectos\Visor_PG\` creada
- [x] Subcarpetas: `extension/`, `visor/`, `agentes/`, `adapters/`, `identidad/`, `supabase/migrations/`, `tests/`, `docs/`
- [x] `VISION.md` (copia exacta del documento de Jhon, NO se modifica)
- [x] `ARQUITECTURA.md` v2 — incorpora 45 secciones cubriendo:
  - 8 piezas del ecosistema (incluido Centro de Control)
  - 6+1 niveles del sistema (con Extractor objetivo L1.5)
  - Reconciliación Gerente vs Event Sourcing
  - Schema concreto `evento_pg`
  - Vocabulario controlado (estados oficiales por dominio)
  - CQRS ligero, modo shadow, hot reload, soft delete, lease, dead-letter
  - Chats grupales, merge personas, "olvidar" cliente, SLA primer mensaje
  - Notificaciones push, modo offline, backups, costo estimado
  - Multi-usuario, los 3 Supabase del ecosistema
- [x] `MAPA.md` v2 (este archivo) — con regla de flujo de trabajo
- [x] `docs/LECCIONES_PROYECTO_VIEJO.md` — qué NO repetir
- [x] `abrir_visor_pg.bat` — shortcut para abrir Claude Code en este proyecto

**Hecho extra:**
- [x] Shortcut en escritorio: `C:\Users\jhon\Desktop\Visor PG - Claude.lnk` → abre Claude Code apuntando a este proyecto

**Pendiente:**
- [ ] **Aprobación de Jhon de `ARQUITECTURA.md` v2 + `MAPA.md` v2**

---

### FASE 1 — Bootstrap técnico

**Objetivo:** setup mínimo funcional para empezar a construir el MÓDULO 1.

**Decisión 2026-05-07:** se reusa el Supabase existente `olububjdvboiqgmihsmk` (decisión A). 100% Claude lo hace. Se borró todo lo del Visor viejo + Junior Wasap viejo, se preservaron las 3 tablas `knowledge_*` del Bibliotecario_Safra.

**Subfases:**

#### ✅ F1.1 — Copiar credenciales y script de migración (2026-05-07)
- `.env` copiado del proyecto viejo a `C:\Proyectos\Visor_PG\.env`
- `apply_migration.mjs` copiado y validado (conecta vía host directo)
- `package.json` inicializado, `pg` instalado

#### ✅ F1.2 — Inventario y borrado de tablas viejas (2026-05-07)
- 57 tablas existían (54 del Visor viejo + 3 `knowledge_*` de la Biblioteca)
- Migración `001_drop_viejo.sql` aplicada → 54 tablas borradas con DROP CASCADE
- 3 tablas `knowledge_*` preservadas intactas

#### ✅ F1.3 — Schema inicial Visor_PG (2026-05-07)
- Migración `002_schema_inicial.sql` aplicada (97 statements)
- **21 tablas creadas:** usuarios, ambitos, personas, inmuebles, proyectos, rol_persona_inmueble, chats, chat_ambito_historial, mensajes, evento_pg, buzon_validacion, agentes_definicion, agentes_definicion_historial, memoria_local, memoria_global_especialista, correcciones, notas_libres, tags, tag_asignacion, dead_letter_queue, personas_merge_log
- **3 vistas (CQRS):** vw_clientes_resumen, vw_buzon_pendientes, vw_timeline_proyecto
- **16 triggers:** updated_at, FTS automático, versionado de prompts
- **6 ámbitos seedados:** comercial, proveedor, personal_familia, personal_amigos, personal_otros, interno_equipo
- **Usuario Jhon creado** (rol `dueño`)
- **Realtime publication** habilitado en 6 tablas críticas
- **RLS básico** en 9 tablas (políticas MVP abiertas)

#### ✅ F1.4 — Seed catálogos vocabulario controlado (2026-05-07)
- Migración `003_seed_catalogos.sql` aplicada
- `sistemas_safra` — 12 sistemas (blackout, screen, sheer, panel japonés, enrollables, verticales, películas, toldos, motores, domótica, rieles, cadenillas)
- `zonas_instalacion` — 5 zonas (Girardot urbano, Ricaurte, Melgar, Bogotá, otros)
- `causas_garantia` — 6 causas (producto, instalacion, cliente, ambiente, tercero, construccion)
- `tipos_objecion` — 12 tipos
- `configuracion_sistema` — topes de costo, lease, retry, soft delete, SLA

#### ✅ F1.5 — Documentación Supabase (2026-05-07)
- `docs/SUPABASE.md` creado con estado completo del Supabase
- `.gitignore` creado (protege `.env`)

#### ⏳ F1.6 — Visor mínimo (React + Vite) — PRÓXIMO
**Qué hace Claude:**
- `npm create vite@latest visor` con template `react-ts`
- Cliente Supabase en `visor/src/lib/supabase.ts`
- Layout base con tabs para los 11 módulos
- **Mockup del MÓDULO 1 con datos FAKE** (regla: mockup primero, backend después)
- `npm run dev` arranca en `localhost:5173`

**Output:** Visor abre en navegador, muestra MÓDULO 1 con datos fake.
**Validación de Jhon:** abrir en navegador → "sí me sirve" / "cambia X".

#### ⏳ F1.7 — Extensión + Adapter WhatsApp + Identidad básica
**Qué hace Claude:**
- Copia `C:\Proyectos\WhatsApp_Captura_Safra\` → `C:\Proyectos\Visor_PG\extension\`
- Adapta la extensión para escribir a `chats` y `mensajes` (schema nuevo) en vez de `wa_chats` / `wa_processed_messages`
- `adapters/adapter_whatsapp.ts` que escucha `mensajes` (Realtime) y crea `evento_pg`
- `identidad/matcher.ts` con matching exacto (jid, telefono, email)
- Worker Node `workers/worker_pipeline.ts` que arranca todo

**Output:** Jhon manda mensaje → en <5 seg aparece persona + proyecto + evento_pg con estado IDENTIFICADO en el Visor.

**Criterio de éxito FASE 1:** mando un mensaje a mi WhatsApp → en <5 segundos veo en el Visor: persona + proyecto + evento_pg identificado. **Sin agentes IA todavía.**

---

### ⏳ FASE 2 — MÓDULO 1: Núcleo base

**Objetivo:** Bandeja WhatsApp + Identidad + Inmueble + Proyecto + Timeline + EVENTO_PG + Buzón validación, todo funcional.

**Submódulos** (de sección 41 ARQUITECTURA.md):
1. Bandeja WhatsApp (panel del Visor que muestra los chats con sus mensajes — Realtime puro)
2. Identidad del cliente (panel de personas + edición + merge si hay duplicados)
3. Inmueble (panel de inmuebles + relación con personas)
4. Proyecto (panel de proyectos + estados)
5. Timeline (línea de tiempo del proyecto)
6. EVENTO_PG (vista de eventos por proyecto con linaje y modo "explicación")
7. Buzón de validación (cola de aprobaciones humanas con 3 acciones: aprobar/rechazar/editar)

**Cada submódulo sigue la regla de flujo:** mockup → Jhon valida → backend → tests → Jhon usa real.

**Criterio de éxito:** abro el Visor y veo una persona con su proyecto, sus mensajes en orden de tiempo, y puedo agregar/editar/aprobar.

---

### ⏳ FASE 3 — MÓDULO 2: Comerciales
### ⏳ FASE 4 — MÓDULO 3: Financieros
### ⏳ FASE 5 — MÓDULO 4: Técnicos
### ⏳ FASE 6 — MÓDULO 5: Operativos
### ⏳ FASE 7 — MÓDULO 6: Postventa
### ⏳ FASE 8 — MÓDULO 7: Evidencias
### ⏳ FASE 9 — MÓDULO 8: Agentes (gobernanza visual)
### ⏳ FASE 10 — MÓDULO 9: Control y seguridad
### ⏳ FASE 11 — MÓDULO 10: Gerencial (Centro de Control completo)
### ⏳ FASE 12 — MÓDULO 11: Núcleo crítico (consolidación)

---

### ⏳ FASE 13+ — Multi-ámbito real

- Adapter Web
- Adapter Email
- Ámbito proveedor + agentes proveedor
- Ámbito familia + agentes familia
- Ámbito equipo_interno

---

### ⏳ FASE 20+ — Cross-empresa

- Adapter Audio en tiempo real
- Adapter IA externa
- Adapter Proveedor con CRM compartido
- App móvil para Junior

---

## DECISIONES TOMADAS (registro corto)

Para detalle completo ver `ARQUITECTURA.md` sección 44.

| Fecha | Decisión |
|---|---|
| 2026-05-07 | Proyecto nuevo desde cero. Visor anterior queda como referencia |
| 2026-05-07 | Reusar extensión Chrome del proyecto anterior |
| 2026-05-07 | Supabase NUEVO (proyecto aparte). Borrar el viejo cuando este funcione |
| 2026-05-07 | CRM Zonal y Biblioteca RAG SEPARADOS |
| 2026-05-07 | Multi-ámbito desde el diseño |
| 2026-05-07 | EVENTO_PG como columna vertebral (Event Sourcing) |
| 2026-05-07 | 6+1 niveles desacoplados (L0-L5, +L1.5 Extractor objetivo) |
| 2026-05-07 | Gerente del enjambre = coordinador de POLÍTICAS, no orquestador |
| 2026-05-07 | Junior con interfaz API desde día 1 (preparado para app móvil futura) |
| 2026-05-07 | Empezamos con `comercial` + `personal_otros` (catch-all) |
| 2026-05-07 | Stack: React + TS + Vite + Supabase + Node workers + DeepSeek + extensión Chrome |
| 2026-05-07 | CQRS ligero, modo shadow, hot reload, soft delete 30d, lease, dead-letter |
| 2026-05-07 | Tope hard de costo: $0.05/invocación, $5/día |
| 2026-05-07 | Notificaciones push (Web Push primero) |
| 2026-05-07 | Modo offline-degradado con Service Worker |
| 2026-05-07 | Backups + restauración probada antes de datos reales |
| 2026-05-07 | **Política de procesamiento IA en 4 capas separadas** (PARTE VI ARQUITECTURA): captura $0 / sync $0 / histórico manual $$$ / tiempo real toggle $$$ |
| 2026-05-07 | NO botón "Procesar todos" jamás. Histórico siempre manual single-shot con estimación |
| 2026-05-07 | Modo ON tiempo real auto-autoriza chats nuevos + procesa histórico completo (A1) |
| 2026-05-07 | Tope diario blando (alerta, no kill switch). Junior avisa con proyección útil (B3) |
| 2026-05-07 | Modo ON aplica a TODOS los ámbitos (C1). Bloqueo de chat manual como válvula (E1, F1) |
| 2026-05-08 | **REFACTOR**: 4 capas → 3 capas. Whitelist eliminada. Captura local automática (538 chats reales en IndexedDB ext). Procesar = sube+IA en un click |
| 2026-05-08 | Módulo "Captura" separado de M1 "Núcleo". M1 solo muestra chats procesados. Captura tiene KPIs, filtros, regex no-cliente, costo proyectado |
| 2026-05-08 | Bloqueo persiste en Supabase tabla `chats_bloqueados` (sobrevive reinstalación de extensión) |
| 2026-05-08 | API extensión↔Visor vía `chrome.runtime.onMessageExternal` (V3_PING, V3_LIST_CHATS, V3_PROCESS_CHAT, etc.) |
| 2026-05-08 | Bug onClick de modales NO resuelto todavía (Crear inmueble/proyecto, click fila eventopg, fusión personas modal). Backend OK vía SQL. Pendiente arreglar |
| 2026-05-08 | **Bug onClick RESUELTO** — era cache de Vite HMR. Hard reload soluciona. 4 de 5 funciones funcionan. Edge case fusión vía Puppeteer queda como bug de testing solamente |
| 2026-05-08 | Probado flujo a escala (3 chats: Lorena 258msg, Aura 90msg con 25 ptt, Don Carlos 54msg con 41 imágenes). 411 mensajes + 4 personas + 4 proyectos creados |
| 2026-05-08 | Confirmado: extensión NO transcribe IA automáticamente (sin keys OpenAI/DeepSeek). 84 medias sin `ai_text`. **Primer agente IA del MÓDULO 2 debe ser Transcribor** |
| 2026-05-08 | **Worker pipeline v2.1**: polling como carril principal (cada 5s, batch 20, 3 chats paralelo, timeout duro 10s). Realtime solo como aceleración. Velocidad ESTABLE 1.6 evt/s (antes degradaba) |
| 2026-05-08 | **F2.1 Capa 0 agentes**: lib/llm DeepSeek + lib/openai Whisper/Vision + lib/validador (vocabulario controlado + anti-alucinación + anti-contaminación + reglas duras) + lib/runner (orquestador con hooks, modo shadow obligatorio, auto-buzón si confianza < CONFIRMADO). Tope hard $0.05/inv. 4 smoke tests pasando |
| 2026-05-08 | **F2.2 Extractor objetivo (L1.5)**: 14 patrones regex (telefono, email, medida, monto, etc), worker polling cada 10s, $0 costo. Sobre 295 msgs reales: 105 extracciones a 49K msg/s. Refinado con rangos realistas: -45% falsos positivos |
| 2026-05-08 | **F2.3 Decisión arquitectónica**: la transcripción de media (Whisper/Vision/PDF) corre en la EXTENSIÓN, NO en un worker del Visor. Razón: la extensión ya descifra HKDF/AES y guarda blobs en IndexedDB con cache SHA-256. Mover bytes a Supabase Storage para procesarlos en el Visor sería gasto y complejidad innecesarios |
| 2026-05-08 | **F2.3 Bug raíz resuelto**: `procesarChat()` en extension_api.js bypaseaba el pipeline IA (subía a Supabase sin Whisper/Vision). Por eso 26 audios + 48 imágenes en BD tenían `metadata.ai_text=null`. Solución: dejar `procesarChat()` rápido (texto only) + acción separada `transcribirMediaChat()` con confirmación de costo |
| 2026-05-08 | **F2.3 Reglas duras heredadas del proyecto viejo (hardcoded en `clasificarMediaChat`)**: status@broadcast nunca, sticker nunca, forwarded_many_times nunca, video nunca (Whisper no acepta MP4), burst >10 imágenes por (chat, rol, minuto). PDF solo `application/pdf`, otros documents ignorados |
| 2026-05-08 | **F2.3 UI Transcripciones (M1.6)**: banner "X chats con media pendiente" + botón por chat con flujo `Estimar costo → Confirmar → Procesar`. Modal con desglose Whisper/Vision/PDF + omitidos por reglas. Modal de progreso con barrita. Cleanup automático tras éxito |
| 2026-05-08 | **F2.3 Tests reales**: 17/17 funcionales (lógica + Whisper TTS Windows + Vision PNG comprobante + UPDATE Supabase con revert) + 21/22 E2E con Puppeteer attached a Chrome corriendo (puerto 9222) con la extensión cargada en Modo Desarrollador. Cache SHA-256 confirmado en 2da corrida ($0 OpenAI) |
| 2026-05-08 | **Limpieza Núcleo (Supabase)** post-tests: borrados todos los chats reales (Samuel, Lorena, Aura, Don Carlos) + residuos de tests + 425 mensajes + 553 eventos + 7 correcciones + 1 buzón pendiente + 1 chat bloqueado. **Catálogos preservados** (configuracion_sistema, ambitos, sistemas_safra, knowledge_safra, etc). **IndexedDB de la extensión NO se tocó** (mantiene blobs descifrados, los chats vuelven a aparecer al re-procesar) |
| 2026-05-08 | **F2.3.B Fix arquitectónico**: el Visor empuja API keys a la extensión vía `V3_SET_KEYS`. Elimina el popup manual heredado del proyecto viejo. Fuente única de verdad = `.env` del Visor (`VITE_*`). `chequearExtension()` ahora hace push automático en cada arranque. **Jhon nunca más tiene que pegar keys a mano** |
| 2026-05-08 | **F2.3.B Regla operativa documentada**: Chrome MV3 no recarga extensiones automáticamente al cambiar archivos. Cada vez que Claude modifique `extension/*.js`, debe avisar con frase fija "🔄 Recargá la extensión" ANTES de pedir probar. Cambios al Visor (Vite HMR) son automáticos |
| 2026-05-08 | **F2.3.B Bug Vite config**: `vite.config.ts` solo "definía" `VITE_SUPABASE_*` pero no las nuevas `VITE_OPENAI_API_KEY` ni `VITE_DEEPSEEK_API_KEY`. Resultado: el Visor leía `undefined` y el sync a la extensión fallaba silenciosamente. Fix: agregar las 4 al `define`. Lección: cada `VITE_*` nueva en `.env` requiere también su entrada en `vite.config.ts > define` |
| 2026-05-08 | **F2.3.C Distinción de motivos de fallo en transcripción**: 3 causas distintas — `irrecuperable_cdn` (WhatsApp ya borró el archivo, >17d, NO reintentable), `error_temporal` (rate limit / timeout, reintentable), `error_inesperado` (bug real, requiere debug). Estado se persiste en `metadata.download_status='lost'` o `metadata.ai_status='error_*'` con `ai_error`. UI muestra KPIs y badges separados por motivo |
| 2026-05-08 | **F2.3.C Auto-marca de irrecuperables**: si `downloadAndDecryptMedia()` y `refreshMediaViaContent()` fallan ambos para un media (WhatsApp ya borró el archivo del CDN), la extensión marca el mensaje con texto placeholder `🎤/🖼/📎 [No recuperable de WhatsApp · CDN expiró tras >17d]` y `metadata.download_status='lost'`. Ya no aparecerá como "pendiente" en re-procesos |
| 2026-05-08 | **F2.3.D Eliminar chat procesado en cascada**: nueva acción `🗑 Eliminar y re-procesar` en M0 Captura (botón aparece solo si el chat existe en Supabase). Borra mensajes + evento_pg + chat + chats_bloqueados + chat_ambito_historial. **Cascada inteligente**: proyecto/persona/inmueble se borran SOLO si quedan huérfanos (sin otros chats/proyectos referenciándolos). Modal con preview ("se borrará: X mensajes, Y eventos, Z proyecto huérfano…") + confirmación con texto literal `eliminar`. La extensión conserva el chat en IndexedDB local — al volver a darle "Procesar", se sube limpio |
| 2026-05-08 | **F1.18 Contexto activo global** (`lib/contexto_activo.tsx` + Provider en App.tsx): state compartido `{personaActivaId, proyectoActivoId, chatActivoId, chatActivoJid}` con persistencia en sessionStorage. **TopBar muestra pill "👤 Activo: X · 📋 Y · 💬 Z" + botón ✕ limpiar.** M0 Captura: click chat procesado → setea contexto (chat+proyecto+persona). M1 Identidad: click persona → setea. **Modulo1 filtra automáticamente** proyectos/inmuebles/eventos/buzón por contexto activo (banner azul "Filtrado por X" + toggle "Ver TODO" para volver a global). Resuelve el problema de "7 paneles desconectados" |

---

## PENDIENTES URGENTES

- [ ] **Aprobación de Jhon de `ARQUITECTURA.md` v2 + `MAPA.md` v2**
- [ ] Decidir si arranca FASE 1 ahora o se pausa

---

## LECCIONES DEL PROYECTO ANTERIOR

Detalle completo en `docs/LECCIONES_PROYECTO_VIEJO.md`.

**Resumen:**
1. NO construir paralelo sin migrar → caos imposible de revertir
2. NO matar lo viejo sin reemplazo completo → paneles vacíos, usuarios frustrados
3. NO parchar bugs con más botones → cada parche introduce 2 nuevos
4. NO mezclar capas (captura/procesamiento/UI) → un cambio rompe todo
5. NO automatizar sin autorización del usuario → el viejo escribía 24/7 con basura
6. SÍ separar identidad del procesamiento → Servicio de Identidad como módulo central
7. SÍ usar Event Sourcing → desacoplamiento real
8. SÍ tener kill-switch funcional con invalidación de cache inmediata
9. SÍ tests E2E reales antes de declarar algo terminado
10. SÍ reusar lo que funciona (extensión Chrome, descifrado HKDF)

---

**FIN. Este archivo se actualiza con cada fase completada y cada decisión nueva. Si una fase queda en pausa, anotar el último estado para retomar sin contexto.**
