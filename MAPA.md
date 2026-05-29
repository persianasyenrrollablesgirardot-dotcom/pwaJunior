# MAPA — Visor PG

> **Documento de progreso vivo.** Se actualiza con cada fase completada o decisión nueva.
> Si se va la luz: leer `README.md` (contexto, 5 min) → `VISION.md` (qué) → `ARQUITECTURA.md` (cómo) → este `MAPA.md` (dónde) → retomar.
>
> **Última actualización:** 2026-05-29 — **Rediseño V2 COMPLETO** (4 hitos: tarjeta + agregador + 3 derivados + Junior V2). Junior viejo retirado. Ver sección "REDISEÑO V2".
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

### 🔄 REDISEÑO V2 — APROBADO 2026-05-28 (en construcción)

Decisión de Jhon: rediseñar la capa de Junior. El modelo actual (Junior hace todo + carga el contexto de los 75 chats en cada llamada) alucina, pierde contexto y es caro. **Diseño completo en `ARQUITECTURA_V2.md`.**

Modelo nuevo gira en torno a la **tarjeta** (contexto materializado por chat): un **agregador** que ensambla (no resume) + **3 agentes derivados** (checklist / tareas / agendamiento) que leen la tarjeta y escriben en sus tablas + **Junior delgado** que consulta con filtros. Detección de cambio por hash (idempotencia, menos costo y menos alucinación).

**Plan de construcción (VERTICAL primero — validar punta a punta antes de escalar):**
- **Hito 0 — Mockup** (en curso): tarjeta con datos fake → Jhon valida la experiencia. Vista `🃏 Tarjeta V2` en el sidebar.
- **Hito 1 — Rebanada vertical sobre UN cliente real** (Pedidos Cubides): tablas + agregador + 3 derivados mínimos + Junior lee esa tarjeta. End-to-end, datos reales, test por LLM real, Jhon valida la rebanada.
- **Hito 2 — Escalar y endurecer a las 75**: triggers realtime + coalescing 30s + hash + backfill + derivados completos. **+ Recablear Tareas y Agendamientos a V2**: los agentes V2 alimentan las tablas canónicas estructuradas (`tareas`/`agendamientos`, origen='agente_v2', regenerando solo lo suyo) — el agente de agenda debe extraer **fechas estructuradas** para el calendario — y se apagan los agentes viejos de tareas/agenda a la vez (corte sin duplicados). Hasta entonces esas dos pestañas siguen sobre las tablas reales (funcionando, old-driven).
- **Hito 3 — Junior delgado completo** (tools de consulta + agregar_nota, recuperar-y-razonar). *Avance:* chat de Junior ya lee solo las tarjetas relevantes vía `/api/junior-v2`; checklist board lee `tarjeta_checklist`; pestaña Instrucciones eliminada.
- **Hito 4 — Corte**: ✅ **Junior viejo (monolítico) RETIRADO** — `cicloJuniorChat` apagado con flag `JUNIOR_VIEJO_ACTIVO=false` (reversible). Lo reemplazó Junior V2 (/api/junior-v2). Se va con él el JSON de 11 arrays + los guards anti-mentira/anti-ráfaga.
  - **Aclaración clave:** el resto del "pipeline viejo" NO se jubila — los 32 agentes + `modulo_sintesis` (síntesis M1-M7) **alimentan la tarjeta**, A_CHECKLIST mantiene `chat_checklist` que V2 usa para disparar, y `poblarTareas`/A7_TAREAS crean tareas estructuradas que ya funcionan. V2 fue una **reorganización de la capa Junior**, no un rewrite de los agentes. La síntesis se queda (la tarjeta la agrega, no la reemplaza).

5 decisiones validadas: tipo_contacto≠estado_conversacion · derivados híbridos · coalescing 30s · notas vía Junior directas · histórico se reclasifica (no se borra). Costo aceptado ~$30–50/mes neto.

**Reglas de construcción vinculantes (lecciones de la experiencia, en `ARQUITECTURA_V2.md` §9):** (1) el riesgo está en las costuras, no en los agentes; (2) ningún "verde" cuenta si no pasó por el LLM real; (3) regla del tercer guard = frenar y revisar el contrato; (4) toda red de seguridad se prueba; (5) diagnosticar antes de tocar; (6) refactor, no rewrite (conservar los 32 agentes); (7) costo y latencia = presupuesto de diseño.

**Lección madre:** todos los bugs de este proyecto estuvieron en las UNIONES, no en los agentes (cascada con id equivocado → commit `85c08ee`; revert incompleto; worker que bloquea a Junior; ARRAY que no verificaba). V2 trata las costuras como el producto.

### Fase activa
**FASE 9 — Procesamiento en tiempo real** (2026-05-22, ✅ COMPLETA — falta validación de Jhon)

El botón "IA Tiempo real" del TopBar ahora funciona: con un toque, el sistema captura y procesa todos los chats automáticamente, sin el "Procesar" manual chat por chat. Plan de 3 puntos:

- **Punto 1 — botón activado:** el toggle del TopBar dejó de ser placeholder muerto. Guarda `ia_modo_global` en `configuracion_sistema` y le empuja el flag a la extensión (handler nuevo `V3_SET_REALTIME`). Al cargar el Visor, sincroniza el modo guardado.
- **Punto 2 — captura opt-out:** la extensión deja de ser lista blanca. Con realtime ON, `syncToVisorPG` sube a Supabase los mensajes nuevos de TODOS los chats. Se cableó `syncToVisorPG` al `alarm` (cada 30 s) y al arranque — antes no corría ningún sync automático al esquema nuevo (el comentario "no se conecta" estaba desactualizado, pero el cableado faltaba).
- **Punto 3 — bloqueo = freno:** los chats en `chats_bloqueados` quedan fuera del sync (`syncToVisorPG`) y del encolado de media (`saveMessages`). Bloquear un chat detiene su procesamiento al instante.
- Procesa **de ahora en adelante** (`ws_v2_ia_realtime_since` marca el encendido): el histórico viejo se sigue subiendo con "Procesar". El tope de $5/día sigue como red de seguridad.
- ⚠ **Requiere recargar la extensión** en `chrome://extensions/` (paso manual de Jhon). La validación E2E es Jhon usando WhatsApp real con el modo prendido.

**FASE 9.1 — Corrector automático de nombres @lid** (2026-05-22, ✅ aplicado — falta validación)

Bug detectado al usar el modo tiempo real: 3 clientes aparecieron en el módulo Clientes con un número largo (`116917801062503`, `89194038878323`, `251376533766220`) en vez de nombre. Causa raíz: los chats `@lid` (identificador opaco de WhatsApp, sin teléfono adentro) entran por el modo tiempo real **antes** de que `gatherChatMetadata` (corre cada 20 s, reloj aparte) haya leído el nombre del contacto → el fallback de título usaba el `@lid` crudo → `IdentidadService` lo propagaba a `personas.nombre`. Los `@lid` procesados con "Procesar" manual no sufren esto (leen todo junto).

Solución (sin tocar el flujo de captura — solo agregados):
- `tituloFallback(jid)` en `visor_pg_sync.js`: para `@lid` sin nombre devuelve el placeholder `⏳ Identificando…` en vez del número crudo. Usado en `visor_pg_sync.js` + los 3 fallbacks de `extension_api.js`. Para `@c.us` sigue dando el teléfono (sí identifica).
- `reconciliarNombresLid()` en `visor_pg_sync.js`: corrector automático. Corre dentro de `saveChatMetadata` (cada 20 s); en cuanto la metadata trae el nombre humano, hace PATCH condicional de `chats.titulo` y `personas.nombre` para los `@lid` que quedaron con valor provisional. El filtro PostgREST re-verifica el valor exacto en el servidor → **nunca pisa un nombre bueno**.
- Auto-curativo: corrige los 3 registros ya rotos y cualquier futuro, sin que Jhon dicte ningún nombre. ⚠ Requiere recargar la extensión.

Fix de UI del Timeline (módulo 1 Núcleo): los eventos sin texto (notificaciones de sistema `notification_template`, media sin caption, mensajes sin descifrar) mostraban el `canal_msg_id` crudo como `Evidencia: msg #false_…@lid_…`. Ahora `resumenEvento()` en `queries.ts` da una etiqueta legible y se quitó del `Timeline.tsx` el bloque que listaba los IDs crudos. Solo UI — se aplica por HMR, sin recargar nada.

Captura de subtipo de notificaciones: el `type` genérico (`notification_template`) no distingue una llamada perdida de una saliente ni el motivo de un aviso. `hydrate()` en `content.v2.js` ahora guarda `subtype` + `sys_raw` (copia liviana del row crudo de WhatsApp, sin binarios) para todo mensaje de sistema; `canonicalToMensajeRow`/`canonicalToEventoRow` los propagan a `metadata`/`payload`. `resumenEvento()` traduce tipo+subtipo a etiquetas precisas (`📞 Llamada perdida/saliente/recibida`, `👥 Cambio en el grupo`, etc.). Las notificaciones capturadas ANTES de este cambio quedan genéricas (no tienen el dato). El texto fino de `notification_template` se afina leyendo el `sys_raw` de la primera notificación nueva. ⚠ Requiere recargar la extensión.

Botón "Eliminar" en el módulo Clientes: cada tarjeta de cliente tiene ahora un botón 🗑 que abre un modal de borrado en cascada con preview + confirmación por texto. Reusa `eliminarChatProcesado()`/`previewEliminarChat()` de `queries.ts` — la MISMA lógica probada de M0 Captura (F2.3.D). Permite borrar desde Clientes un chat mal procesado y re-procesarlo limpio desde Captura (la extensión conserva el chat en local). Solo UI — se aplica por HMR.

**FASE 9.2 — Notas libres conectadas + re-clasificación de ámbito** (2026-05-22)

Bug detectado por Jhon: escribió una nota libre sobre un contacto ("Don Leonel es mi mecánico, no un cliente") esperando que retroalimentara a Junior — no pasó. Causa raíz: la UI promete en 3 lugares "los agentes leen esto antes de inferir", pero NINGÚN agente leía `notas_libres` ni `personas.notas`. Promesa de UI sin backend desde el Módulo 1; la capa de síntesis (FASE 5) tampoco se conectó. El único canal de feedback que sí funcionaba era `correcciones_humanas` (corregir a Junior por el chat).

- **Notas conectadas**: `sintetizarPersona` (`analistas.ts`) y `construirContextoClientes` (`junior_chat.ts`) ahora cargan `personas.notas` + `notas_libres` y los inyectan en el contexto como "NOTAS DEL HUMANO (verdad prioritaria)". También inyectan el ámbito del contacto con su descripción. Junior y los 8 analistas ahora SÍ leen lo que Jhon escribe. ⚠ Requiere reiniciar el worker (se hizo).
- **Re-clasificación de ámbito**: el módulo Clientes tiene (a) filtro por ámbito arriba (chips Comercial/Proveedor/Personal/Equipo/Todos, default Comercial) y (b) un selector de ámbito por tarjeta. `reclasificarAmbito()` en `queries.ts` actualiza coherentemente `chats.ambito` + `proyectos.ambito` + `personas.ambito_principal` y registra en `chat_ambito_historial`. Un contacto reclasificado a `proveedor` desaparece de la vista Comercial. Solo UI — HMR.
- **Re-síntesis al toque** (migración `036`): `personas.sintesis_pendiente` (boolean) + índice parcial. El worker tiene un ciclo nuevo `cicloSintesisPendiente` (cada 4 s) que recoge a las marcadas, las re-sintetiza y baja el flag. **Marcadores que disparan re-síntesis** (todos en `queries.ts`): `reclasificarAmbito()`, `agregarNota()`, `eliminarNota()`, `actualizarPersona()` (cualquier edición de la ficha). Cambiar el ámbito, agregar una nota o editar la persona refresca la `modulo_sintesis` en segundos. Validado con Leonel Carro Blanco Taller: tras agregar la nota "es mi mecánico" + marcar el flag, los 7 analistas + Junior pasaron de tratarlo como "cliente nuevo sin historial" a "mecánico de confianza de Jhon, no cliente comercial" en ~15 s ($0.0024 USD).

- **Fix re-procesar tras Eliminar**: bug detectado con `+573123380508` — Jhon eliminó un chat procesado y al darle "Procesar" de nuevo no pasaba nada. Causa raíz: `eliminarChatProcesado()` hace **soft-delete** (`deleted_at=NOW`) intencionalmente para evitar race con el worker, pero `procesarChat()` en la extensión no lo sabía: el UPSERT con `on_conflict=canal,canal_chat_id` matchea la fila soft-deleted, hace merge SIN limpiar `deleted_at`, y los INSERTs de mensajes/eventos con `ignore-duplicates` se saltean por UNIQUE → todo queda igual y el chat nunca reaparece. **Fix**: `resucitarChatSoftDeleted()` en `visor_pg_sync.js` revive chat + mensajes + eventos (reset `estado='NUEVO'`) + proyecto + persona + inmueble. `procesarChat()` lo invoca cuando detecta un chat con `deleted_at` antes de subir nada. ⚠ Requiere recargar la extensión.

- **Checklist conectado al feedback humano** (migración `037`): el agente `A_CHECKLIST` no leía notas, ámbito ni correcciones — generaba "venta · Iniciar contacto" para contactos que ya estaban marcados como proveedor/familia/etc. Fix en `agentes/sintesis/checklist.ts`: carga `personas.notas` + `notas_libres` + `personas.ambito_principal` + `correcciones_humanas` y los inyecta en el prompt con el mismo patrón que los analistas. Migración `037` agrega `'no_aplica'` como cuarto valor del CHECK de `chat_checklist.tipo`; nueva plantilla `no_aplica: []` (sin pasos). El worker `cicloSintesisPendiente` ahora, además de re-sintetizar, **re-checklistea todos los chats de la persona** marcada → un cambio de ámbito/nota/corrección actualiza síntesis + Junior + checklist en cascada en segundos. Validado con Leonel: su checklist pasó de `tipo=venta, "Iniciar contacto"` a `tipo=no_aplica, estado=cerrada, motivo="No es cliente comercial"` en 3.5 s.

- **Guard rail anti-LLM en el checklist** (sub-fix de `037`): detectado al repasar contactos viejos — Margarita (`ambito='interno_equipo'`) salió como `tipo=consulta` aunque el prompt le pedía `no_aplica`. Causa: el LLM a veces ignora el PASO 0 del prompt. Defensa dura en `checklist.ts` post-parseo: si `ambitoPersona !== 'comercial'` y el LLM devolvió otra cosa, el código fuerza `tipo='no_aplica'` + `estado='cerrada'` + motivo de cierre fijo + `compromisos=[]`. Loguea la corrección. Garantiza coherencia sin depender de la obediencia del LLM.

- **Fix UI Checklist coherente con `no_aplica`**: bache detectado por Jhon al abrir Junior → Checklist tras el repaso ("no abre"). `JuniorChecklist.tsx` tenía `TipoConv` hardcodeado en 3 valores y `TIPO_META[fila.tipo]` → para `'no_aplica'` daba `undefined` y crasheaba el render. Fix: agregar `'no_aplica'` al `TipoConv` y al `TIPO_META` (label "No aplica", color gris `#6b7280`). Lección: cuando se agrega un valor a un enum/constraint backend, revisar el frontend que lo consume.

- **Fix mensajes salientes que se quedaban colgados**: bug detectado por Jhon — escribió "perfecto ya le confirmo" a Peñon Marg en tiempo real y nunca llegó a `mensajes` ni `evento_pg` → checklist seguía diciendo `sin_responder` y los agentes no sabían que respondió. Causa raíz en `background.v2.js saveMessages`: la regla `processing_state` no distinguía entrante/saliente — para texto sin descifrar mandaba a `pending_decryption`. Los entrantes esperaban a que la cache de descifrado tuviera el plaintext (el `retryPendingCycle` los promovía cuando WA Web rendeaba el chat). Pero para los outgoing la cache muchas veces NUNCA tiene el plaintext (WA Web no necesita descifrarlos, vos los escribiste) → quedaban en `pending_decryption` eternamente, fuera del sync. Fix en DOS piezas: **(A)** `hydrate()` en `content.v2.js` usa `row.body` como fallback **solo para tipos texto puro** (`chat/text/extendedText`) si el descifrado del opaque no produjo texto. **(B)** `saveMessages` en `background.v2.js`: si `msg.is_owner=true`, SIEMPRE `processing_state='ready_to_sync'`, nunca pending. Preferible el evento sin texto que perder el evento. Combinado: outgoing llegan al instante a Supabase. ⚠ Requiere recargar la extensión.

- **Regresión del fix A — base64 en `mensajes.texto`**: la primera versión del fallback A no filtraba por tipo. Para tipos media (image/video/document/location/product) `row.body` trae el **thumbnail JPEG en base64** (`/9j/4AAQ…`) — se coló en `mensajes.texto` para 8 mensajes recién subidos + 33 mensajes históricos que ya arrastraban contaminación similar. Limpieza: `UPDATE mensajes SET texto=NULL WHERE texto LIKE '/9j/4AAQ%'` (41 filas) + limpieza paralela en `evento_pg.payload->>'preview'` (20 filas). Fix en `content.v2.js`: el fallback A ahora solo aplica si `msg.type === 'chat' || 'text' || 'extendedText'`. ⚠ Requiere recargar la extensión de nuevo.

- **Módulo Tareas en Junior** (5 piezas, una sola tanda): nueva pestaña al lado de Chat / Instrucciones / Checklist. Diferencia conceptual con Checklist: **Checklist = foto del estado de cada chat** ("sin_responder", pasos); **Tareas = lista de acciones concretas con vencimiento** que Jhon debe hacer. Tabla `tareas` y agente `A7_TAREAS` ya existían (migración `018`) — sólo faltaba UI y conexión a Junior. **Las 5 piezas**: (1) `fetchTareasTransversales()` + `fetchPersonasMinimo()` en `queries.ts`; (2) `JuniorTareas.tsx` nuevo (lista agrupada, modal con selector de cliente opcional); (3) `Junior.tsx` suma la pestaña; (4) `junior_chat.ts` carga tareas abiertas en el contexto del LLM + protocolos nuevos `[NUEVA_TAREA] titulo=… | tipo=… | persona_id=… | fecha=… | hora=… | prioridad=…` y `[COMPLETAR_TAREA] id=…` + parseo + retorno; (5) `worker_pipeline_v2.ts cicloJuniorChat` ejecuta INSERT/UPDATE en `tareas` con `origen='chat'`. Sin migración nueva.

- **Fix anti-alucinación de audios/multimedia en Junior**: bug detectado por Jhon revisando el chat — Junior inventó la transcripción completa del audio de su mamá ("Hijo, ¿cómo estás? Te llamé pero no contestaste…"), aunque el audio (id 1105) tiene `ai_text=null` (nunca se transcribió con Whisper). Cuando Jhon le preguntó "¿de dónde sacas esa transcripción?" Junior se autocorrigió. Causa: la regla genérica *"NUNCA inventes números ni hechos ni fechas"* no era suficiente — el LLM se ponía "complaciente" ante pedidos tipo *"escuchalo"* y generaba algo verosímil. Fix en `agentes/sintesis/junior_chat.ts systemPrompt`: bloque destacado **"AUDIOS / IMÁGENES / DOCUMENTOS — NUNCA INVENTES SU CONTENIDO"** que aclara que el LLM no tiene acceso a audios / imágenes / PDFs, instruye a responder explícitamente *"no puedo escuchar audios, andá a Vistas globales → Transcripciones"*, y prohíbe inventar transcripciones "plausibles" aunque parezcan obvias. Permite inferencias del contexto solo si las marca como tales ("no escuché el audio, pero por el contexto parece que…").

- **Modelo conceptual final de Tareas** (corrección de diseño tras feedback de Jhon — el primer modelo "lista global" no encajaba). Las tareas tienen DOS naturalezas según `persona_id`:
   · **DE CLIENTE** (`persona_id != null`): pendientes operativos del flujo de un cliente. Las generan los agentes (`A_SINTESIS_M5`, `A7_TAREAS`, `A4_RECOMPRA`). Viven en **M5 → Tareas** del cliente activo.
   · **TRANSVERSALES** (`persona_id IS NULL`): acciones personales / cross-cliente / con terceros (proveedor, instalador, contadora). Nacen del chat con Junior o desde su panel. Viven SOLO en **Junior → Tareas**.
  La pestaña Junior → Tareas filtra `persona_id IS NULL` (`fetchTareasTransversales`) — las del flujo de clientes no la ensucian. El modal de "Nueva tarea" permite seleccionar cliente pero avisa que si se selecciona, la tarea se mueve a M5 del cliente. **Junior chat sí ve AMBAS** (su `cargarTareasAbiertas` ahora separa en dos bloques: "DEL FLUJO DE CLIENTES" y "TRANSVERSALES / TUYAS") y las gestiona por chat. **Al inicio de cada sesión nueva**, Junior arranca con un resumen breve de cuántas pendientes hay de cada tipo y ofrece repasar.

- **Dedup por jid + colaboradores en A2_NOCLIENTE** (2026-05-29): bug detectado cuando Junior, para `+573185114119` (chat 81), alucinó "cliente pide cotización de 6 cortinas" — la conversación real es de un INSTALADOR coordinando una obra y reportando 140k en efectivo. Tres frentes:
   1. **A2_NOCLIENTE no detectaba colaboradores/instaladores** → el chat aparecía como cliente comercial en el índice de Junior. Fix: agregado subtipo `'colaborador'` (`agentes/L2_routing/a2_nocliente.ts`) con señales fuertes y específicas (reporta "ya instalamos" en primera persona del equipo, "me dió X en efectivo" cobrando para el negocio, coordinan "a qué horas salimos" a la ruta; pide ≥2 señales). Backfill (`tests/recorrer_nocliente.ts`, A2 vía `ejecutarAgente skipLock`) re-corrió A2 sobre 81 chats activos y marcó **4 colaboradores**: chat 81 (instalador), 82 (Don Roa), 93, 103. Quedaron filtrados del índice de Junior por `cargarIndice`/`tarjeta.es_no_cliente`.
   2. **Race en `crearPersonaDesdeJid`** creaba personas duplicadas con MISMO jid (pares #134/#137 y #125/#139). Fix de raíz (`043_dedup_jid.sql`): **índice único parcial** `personas_jid_activa_uniq` sobre `personas(jid) WHERE deleted_at IS NULL AND jid IS NOT NULL` — la BD rechaza el insert duplicado. `identidad/matcher.ts crearPersonaDesdeJid` captura el conflicto `23505` y reusa la persona existente.
   3. **Función SQL transaccional `fusionar_persona(survivor, dup)`** (`043_dedup_jid.sql`) — **cierra la limitación conocida de F7.3** (fusión no transaccional). Reasigna las 40 columnas FK de dup→survivor con conflict-safe en `modulo_sintesis(persona_id,modulo)` y `rol_persona_inmueble(persona_id,inmueble_id,rol)` (el survivor gana, las filas del dup que chocarían se borran primero). Soft-deletea el dup. Aplicada a los 2 pares: data ahora vive en los survivors activos (#137, #139); los gemelos borrados quedaron vacíos. `identidad/fusionar_personas.ts` (F7.3) sigue para el resolver de Junior — futura mejora: que llame a esta SQL.

   **NO se tocó** el par `+573105879410` (#126 "Rocio Romero" vs #169 "Lorena MORALES"): jids `@lid` distintos + nombres distintos → NO es dup. El tel compartido viene del Nequi del negocio (Sandra Lorena Morales) que quedó mal asignado como `telefono_e164` en uno de los dos. Decisión de negocio para Jhon: cuál persona tiene el tel correcto.

---

**FASE 8 — Módulo Checklist por chat** (2026-05-22, ✅ COMPLETA)

Nueva pestaña en el módulo Junior (`Chat` | `Instrucciones por chat` | `Checklist por chat`). Tablero de "¿quién tiene la pelota?": el estado de cada conversación.

- **Agente `A_CHECKLIST`** (`agentes/sintesis/checklist.ts`) — lee la conversación de un chat y produce: el tipo (venta / garantía / consulta) con su checklist de pasos secuencial, el estado (🔴 sin responder · 🟠 te toca · ⚪ frío · 🔵 esperando cliente · 🟢 cerrada), el próximo paso concreto y los compromisos que el negocio prometió y no cumplió.
- **Tabla `chat_checklist`** (migración `034`) — una fila por chat, regenerada entera en cada corrida (síntesis, no gestión manual).
- **Worker** `cicloChecklist` (cada 45 s) — analiza los chats con actividad nueva, máx 4 por ciclo para acotar costo.
- **UI** `JuniorChecklist.tsx` — semáforo de conteos, sección de compromisos pendientes, y los chats en dos grupos: "Te toca a vos" / "No te toca". Cada tarjeta expande su checklist con el paso pendiente marcado TE TOCA / ESPERA AL CLIENTE.
- Verificado E2E (`test_checklist.ts`, 10/10): clasificación de tipo, estado y detección de compromisos.
- **Próximo:** el módulo de Tareas se alimenta de acá — cada paso pendiente de Jhon y cada compromiso incumplido es una tarea.

---

**FASE 7 — Clientes manuales y cruce con WhatsApp** (2026-05-21 → 2026-05-22, ✅ COMPLETA)

Junior puede registrar clientes que NO llegan por WhatsApp (vienen al local, llaman, contactan por otro medio) y el sistema evita duplicarlos. Plan de 3 partes: F7.1, F7.1b, F7.2 y F7.3 entregadas — FASE 7 cerrada.

- **F7.1 Junior crea clientes manuales ✅ (2026-05-21)**
  - Migración `031`: `personas.origen` (`'whatsapp'` / `'manual'`).
  - Junior reconoce cuando Jhon le cuenta de un cliente que no está en la lista y emite una línea `[NUEVO_CLIENTE] nombre= | telefono= | ciudad=`. Las medidas/novedades se anclan con `[CORRECCION] persona_id=0` (0 = el cliente que se está creando en ese mensaje).
  - El worker crea la persona (`origen='manual'`) + proyecto, normaliza el teléfono a E.164. Los analistas ahora sintetizan clientes sin chat de WhatsApp, usando solo lo que Jhon dictó (antes `sintetizarPersona` cortaba si no había mensajes).
  - Verificado E2E: el cliente del local queda con ficha, correcciones ancladas y las 8 síntesis.

- **F7.1b Módulo Junior con pestañas — "Instrucciones por chat" ✅ (2026-05-21)**
  - El módulo Junior pasa de chat único a contenedor con pestañas: `Chat` | `Instrucciones por chat` (`Junior.tsx` contenedor, `JuniorChat.tsx`, `JuniorInstrucciones.tsx`). Preparado para sumar Checklist y Tareas.
  - Migración `032`: tabla `junior_instrucciones`. El worker registra cada instrucción dada por chat (cliente nuevo, corrección, preferencia) con tipo, fecha, cliente afectado y vínculo al mensaje. La pestaña la muestra — como es un visor, lo dictado por chat queda documentado y visible.
  - Verificado E2E: los 3 tipos de instrucción se registran.

- **F7.2 Cruce automático por teléfono ✅ (2026-05-22)**
  - Cuando un cliente registrado a mano (F7.1) escribe luego por WhatsApp, `matcher.ts` lo reconoce por el teléfono (`telefono_e164`), le asocia el `jid` y —lo clave— engancha el chat de WhatsApp al proyecto manual existente en vez de crear uno duplicado. El cliente del local queda con un único expediente. La persona conserva `origen='manual'` como historial de cómo entró.
  - `matchExactoPersona` reporta si matcheó por `jid` o por `telefono`; `proyectoManualReutilizable` busca el proyecto `origen='manual'` abierto y sin chat para reusarlo.
  - Verificado E2E (`test_f72_cruce_telefono.ts`, 12/12): escenario de cruce + regresión de cliente nuevo sin registro previo.

- **F7.3 Cruce asistido de duplicados ✅ (2026-05-22)**
  - Parte A — al registrar a mano: si Jhon le dicta a Junior un cliente cuyo nombre ya aparece (igual o parecido) en la lista, Junior pregunta en el chat si es la misma persona antes de crearlo. Si es el mismo, ancla el pedido al existente; si es otro, lo registra. La sección CLIENTE NUEVO del prompt se reestructuró en 2 pasos (¿ya existe? → registrar).
  - Parte B — desde WhatsApp: `A3_IDENTIDAD` escribe los duplicados que detecta (mismo nombre, distinto teléfono — lo que F7.2 no resuelve solo) en la tabla `duplicados_detectados` (migración `033`). Junior los plantea en sus respuestas; cuando Jhon confirma, emite `[RESOLVER_DUPLICADO]` y el worker fusiona o descarta. La fusión (`identidad/fusionar_personas.ts`) mueve todo a la persona sobreviviente, le hereda el `jid` y deja un único expediente.
  - Verificado E2E: `test_f73_registro_manual.ts` (6/6) + `test_f73_whatsapp_fusion.ts` (10/10).
  - Limitación conocida: la fusión no es transaccional (mueve tabla por tabla); un choque de constraint a mitad dejaría la fusión incompleta. Mismo comportamiento que la fusión de M1 Identidad. Mejora futura: función SQL con transacción.

---

**FASE 6 — Junior con sesiones y memoria persistente** (2026-05-21)

Tras evaluar las capacidades de Junior (conciencia, autoaprendizaje, memoria), se detectaron tres falencias críticas: solo veía los últimos 12 mensajes, no existían sesiones (hilo único infinito) y no aprendía sobre sí mismo. Esta fase ataca las dos primeras y la tercera.

- **F6.1 Sesiones de chat ✅ (2026-05-21)**
  - Migración `029`: tabla `junior_sesiones` + columna `sesion_id` en `junior_chat`. Cada conversación es independiente; el historial que ve Junior es solo el de la sesión activa.
  - UI: selector de conversaciones + botón "+ Nueva" en el módulo Junior. Auto-título con el primer mensaje. El worker filtra el historial por `sesion_id`.

- **F6.2 Memoria persistente ✅ (2026-05-21)**
  - Migración `029`: tabla `junior_memoria`. Cuando Jhon le da una preferencia de comportamiento ("sé breve", "tratame de usted") o un dato general del negocio, Junior lo guarda con una línea `[MEMORIA]` (igual mecanismo que `[CORRECCION]`) y lo recuerda SIEMPRE, en cualquier sesión nueva.
  - El `systemPrompt` inyecta las memorias vigentes en TODA respuesta. Verificado E2E: en un chat recién abierto Junior aplica una preferencia enseñada en otra sesión.

- **F6.3 Compactación de conversación larga ✅ (2026-05-21)**
  - Migración `030`: `junior_sesiones.resumen` + `resumen_msgs`. Cuando una sesión supera 20 mensajes, los viejos (todos menos los últimos 10) se resumen con el LLM en vez de descartarse. El resumen se guarda en la sesión y se reusa hasta que la conversación vuelve a crecer.
  - Junior ya no olvida el principio de un chat largo. Verificado E2E: con 24 mensajes, recuerda un dato sembrado en el primer mensaje vía el resumen.

---

**FASE 5 — Junior conversacional + datos estructurados** (2026-05-20)

Junior cobra vida y la capa de síntesis se completa. Ya no solo redacta análisis: también **estructura los datos** en las tablas de cada módulo, y se cierra el **ciclo de aprendizaje** — el conocimiento de Jhon corrige al enjambre.

- **F5.5 Novedades visibles + limpieza ✅ (2026-05-20, commits `a057d6f`, `69272e3`)**
  - `PanelSintesis` muestra "📌 Novedades que registraste": las correcciones de Jhon documentadas en SU módulo, con fecha.
  - Footer del sidebar: "Mockup con datos fake" → "Datos reales · en producción".

- **F5.4 Ciclo de aprendizaje — correcciones de Jhon retroalimentan el enjambre ✅ (2026-05-20, commit `1308cbe`)**
  - Flujo bidireccional: Jhon le dice algo a Junior → Junior detecta si es corrección/info nueva → la guarda en `correcciones_humanas` → re-sintetiza al cliente → los analistas la toman como **VERDAD PRIORITARIA** → el módulo se actualiza.
  - Migración `028`: tabla `correcciones_humanas`. Junior **infiere las implicaciones lógicas** (1 mensaje de Jhon → varias correcciones en distintos módulos). Se le pasa la fecha de hoy para razonar vencimientos sin adivinar.
  - Respeta la jerarquía: Jhon → Junior → analistas → módulos.

- **F5.3 Chat conversacional con Junior ✅ (2026-05-20, commit `2c40e48`)**
  - Módulo "Junior" con chat. Migración `027`: tabla `junior_chat`. Junior ve todo el negocio (las síntesis de todos los clientes). El worker (ciclo cada 3s) atiende los mensajes — la API key nunca se expone al navegador.

- **F5.2 Analistas M2-M6 estructuran sus tablas de dominio ✅ (2026-05-20, commits `28f4da3`, `c84e7d6`)**
  - Cada analista, además del texto, devuelve los registros estructurados y los escribe en la tabla nativa: M2→cotizaciones, M3→abonos, M4→medidas, M5→tareas, M6→garantías/reclamos. Reemplazan las cáscaras de los agentes por-mensaje (A4_COTIZ etc. quedan jubilados). El análisis y las sub-tabs salen de la misma fuente → coinciden.

- **F5.1 Junior — visión global del cliente ✅ (2026-05-20, commit `dbecf53`)**
  - Junior (A10) lee las 7 síntesis de módulo de cada cliente y produce la visión global (`modulo='junior'`). La grilla de Clientes pasa a dashboard: cada tarjeta con el diagnóstico de Junior + semáforo.
  - Cierra la jerarquía del enjambre: **31 extractores → 7 analistas → Junior**.

### Próxima fase
**Endurecer con uso real** — Jhon usa el chat de Junior y los módulos con clientes nuevos, va corrigiendo, se afinan los analistas y Junior. Después M9 (Control y seguridad) → M10 (Gerencial / Centro de Control) → M11 (Núcleo crítico).

### Fase anterior
**FASE 4 — Visor inteligente: módulos como síntesis ✅ (2026-05-19 → 2026-05-20)**

Cambio de fondo del producto, decidido por Jhon: el Visor deja de comportarse como un CRM de gestión manual. Cada módulo entrega una conclusión redactada por un agente analista, no tablas de registros para aprobar.

- **F4.3 Capa de síntesis ✅ (`4058c88`)** — migración `026` tabla `modulo_sintesis`, 7 analistas (`agentes/sintesis/analistas.ts`), `PanelSintesis.tsx` integrado en M1-M7, worker re-sintetiza al cliente cuando el pipeline drena la cola.
- **F4.2 Modo B — sin buzón de aprobación rutinaria ✅ (`4058c88`)** — solo `confianza=ALERTA` va al buzón; CONFIRMADO/INFERIDO/DUDOSO escriben directo al módulo, visibles. Modelo: corrección post-hoc, no pre-aprobación.
- **F4.1 Diagnóstico + reproceso de huérfanos ✅** — 206 eventos `mensaje_*` quedaron PROCESADO sin que ningún agente corriera (pre-rollout). Reseteados a IDENTIFICADO y reprocesados por el enjambre actual (~$2 USD).

### Fase anterior
**FASE 3+ — Hardening producción ✅ (2026-05-15 → 2026-05-18)**

- **F3.2 Cleanup leases zombie ✅ (2026-05-18, commit `72aefaa`)** — 3 piezas defensivas en `worker_pipeline_v2.ts`: limpieza de lease en rama "sin pipeline", filtro de leases vivos en el SELECT del ciclo, y barrido proactivo al arrancar (`procesando_hasta < ahora` AND `procesando_por != null` = zombie). Limpió 1 zombie histórico (ev714).

- **F3.1 Fallback `canal_msg_id` ✅ (2026-05-15, commit `0926650`)** — Bug raíz crítico: los 32 agentes leían `msg_id` desde `evt.evidencia_ids.msg_ids[0]`, `null` en los eventos originales. El runner tragaba el error y marcaba PROCESADO sin invocar nada — el enjambre **parecía activo pero ignoraba todo silenciosamente**. Fix en 31 agentes: `msg_ids?.[0] ?? evt?.canal_msg_id ?? null`. Validado E2E con el comprobante de Claudia ($1.000.000).

### Fase anterior
**FASE 2.x — Rollout enjambre + UI globales + Captura+Prospectos ✅ (2026-05-11 → 2026-05-14)**

5 commits encadenados que cerraron la mayor parte del trabajo:

- **F2.10 Rollout 32 agentes productivos + audit Visor E2E ✅ (2026-05-14, `e6aaa20`)**:
  - Migración `024_enjambre_agentes.sql`: tabla `agente_pipelines` + seed de 33 agentes
  - Capas L1-L10 con runner DAG (paralelo / serial / routing). Pipelines: `PIPE_MENSAJE_COMERCIAL`, `PIPE_AUDIO`, `PIPE_IMAGEN`
  - `worker_pipeline_v2` unificado (polling como carril principal)
  - **32 de 33 agentes activos** (`activo=true`, `shadow=false`) con coherencia mecánica determinista, `ValidacionError` tipado y `resolverMsgId` (tolera prefijos `true_/false_` y truncamiento LLM)
  - A6_BIBLIO queda en shadow (depende del Agente_Biblioteca_RAG externo, todavía no construido)
  - **MÓDULO 8 Agentes UI** (5 sub-tabs: Lista, Pipelines, Invocaciones, DLQ, Correcciones)
  - **Audit Visor E2E**: 65/65 vistas OK. Fixes: G.Rutas y G.Recompra rotas por embed PostgREST ambiguo (>1 FK a personas en `instalaciones`/`cotizaciones`, desambiguar con FK explícito); A8_REPUT duplicado en ruta `_default` del PIPE_MENSAJE_COMERCIAL causaba doble invocación; `Recompra.tsx` sin `.catch()` (unhandled rejection); `Pipelines.tsx` key compuesta para tolerar duplicados.

- **F2.11 Worker embebido en Vite dev server ✅ (2026-05-14, `5b736d4`)**:
  - Antes Jhon tenía que correr `npm run worker:v2` en otra terminal. Si se olvidaba: "Procesar histórico" creaba eventos pero ningún agente los tomaba (síntoma: "32 agentes activos pero nada pasa").
  - Ahora `npm run visor:dev` spawnea el worker como child process. Logs prefijados con `[worker]`. Restart automático con backoff exponencial (2s→4s→…→30s). Reset si vive >30s estable. Kill limpio al cerrar Vite (`taskkill /f /t` en Windows). Solo en modo `serve`, no en build. Escape hatch: `VISOR_NO_WORKER=1`.

- **F2.12 Puerto Vite fijo + strictPort ✅ (2026-05-14, `076ee24`)**:
  - Server pasa de 5173 default a **5180 con `strictPort=true`**. Si está ocupado, Vite falla limpio en vez de saltar a 5174/5175 — antes el salto rompía silenciosamente la URL fija de la extensión Chrome y los shortcuts.

- **F2.13 Refactor UI "Vistas globales" ✅ (2026-05-11, `f2ff8ae`)**:
  - Problema: al seleccionar un cliente y entrar a M3.3 Cartera (o M5.3 Agenda, M2.6 Recompra, etc.), aparecían datos de **todos** los clientes. Diseño correcto a nivel datos pero confuso visualmente.
  - Solución: separar las 8 sub-tabs que NO dependen del cliente activo en un panel top-level **"🌐 Vistas globales"** del sidebar: G.1 Agenda, G.2 Rutas/zonas, G.3 Cartera, G.4 Recompra, G.5 Transcripciones, G.6 Difusiones, G.7 Compatibilidad, G.8 Biblioteca.
  - M1-M7 quedan 100% per-cliente. Antes: 30 sub-tabs per-cliente + 8 mezcladas como globales. Ahora: 26 per-cliente + 8 globales. Sidebar separa los dos universos visualmente.

- **F2.14 Captura+Prospectos integrados ✅ (2026-05-11, `45bad31`)**:
  - Análisis de la IndexedDB real de la extensión WhatsApp en Chrome (lectura directa del LevelDB del perfil de Jhon): 30 MB leídos, **506.026 strings** extraídos, 288 JIDs, 911 menciones a productos Safra, 482 a zonas, 442 saludos, 213 pedidos de cotización, 136 confirmaciones de pago.
  - **7 patrones operativos no cubiertos por M1-M7 detectados** y aplicados como fixes.
  - **Integración con `Gestor_Prospectos_Girardot`**: 324 conjuntos sincronizados como fuente de verdad geográfica.
  - 10 contactos REALES insertados en BD con tag `[REAL-CAPTURA]` (eliminados después en F2.13 — tenían precios/medidas inventadas por heurística; quedan para cuando A5_COTIZ genere desde mensajes reales).

- **F2.15 Fix pre-agentes (5 críticos + 3 importantes) ✅ (2026-05-11, `f4692f9`)**:
  - Auditoría antes de encender los agentes: 5 fixes críticos + 3 importantes en infra del pipeline. **63/63 smoke tests pasando** antes del rollout.

### Fase anterior
**FASE 2.4-2.9 — MÓDULOS 2 al 7 cerrados con E2E ✅ (2026-05-10 → 2026-05-11)**

Cada módulo cierra con su suite Puppeteer correspondiente:

| Módulo | Commit | E2E | Sub-tabs |
|---|---|---|---|
| M2 Comerciales hardening + Comparador | `062b089` (2026-05-10) | 27/27 | 5 (post-refactor) |
| M3 Financieros 3.1+3.2+3.3 | `f12e616` (2026-05-10) | 21/21 | 3 inicialmente |
| M3 cierre con 3.4 Variaciones + 3.5 Rentabilidad | `f62a254` (2026-05-10) | 37/37 | 4 (post-refactor) |
| M4 Técnicos | `c741dde` (2026-05-10) | 26/26 | 4 (post-refactor) |
| M5 Operativos | `953a8ef` (2026-05-10) | 28/28 | 4 (post-refactor) |
| M6 Postventa | `b2d0e6a` (2026-05-11) | 35/35 | 5 |
| M7 Evidencias | `bf54706` (2026-05-11) | 25/25 | 3 (post-refactor) |

Total E2E acumulado M2-M7: **199 checks pasando**. Scripts en `test_m{2..7}_*.mjs` con logs en `test_m{N}_run.log` y screenshots en `test_m{N}_shots/`.

### Fase anterior
**FASE 2.3 — Acción "Transcribir media" en extensión + UI ✅ (2026-05-08)**

Decisión arquitectónica: **la transcripción de media (Whisper / Vision / PDF) corre en la extensión, NO en un worker del Visor.** La extensión ya descifra HKDF/AES y guarda blobs en IndexedDB local + cache SHA-256.

- `extension/extension_api.js`: handlers `V3_ESTIMATE_CHAT_MEDIA` y `V3_TRANSCRIBE_CHAT_MEDIA`. Reglas duras: status@broadcast, sticker, forwarded_many, video, burst >10 imágenes/(chat,rol,minuto). Pool 3 paralelos. Cache SHA-256.
- `visor/src/panels/m1/Transcripciones.tsx`: banner "X chats con media pendiente" + modal de confirmación (desglose por servicio + omitidos) + modal de progreso.
- Tests: 17/17 funcionales + 21/22 E2E con Puppeteer attached a Chrome (puerto 9222).

### Fase anterior
**FASE 2.2 — Extractor objetivo (L1.5) ✅ (2026-05-08)**

- `agentes/extractor/` con 14 patrones regex (telefono, email, cedula, nit, direccion, conjunto/torre/apto, medida, monto, fecha, sistema_safra, codigo_cotizacion, url, horario)
- `workers/worker_extractor.ts` polling cada 10s, batch 200, $0 costo
- Smoke sobre 295 msgs reales: 105 extracciones, 49K msg/s
- Refinado con rangos realistas: -45% falsos positivos (105 → 58)

### Fase anterior
**FASE 2.1 — Capa 0 infraestructura agentes ✅ (2026-05-08)**

- `agentes/lib/llm.ts` — cliente DeepSeek con tope hard $0.05/inv, retry 429/5xx exponencial, timeout 30s
- `agentes/lib/openai.ts` — Whisper + Vision (gpt-4o-mini detail:'low'). Cache identifier SHA-256
- `agentes/lib/validador.ts` — vocabulario controlado + anti-alucinación + anti-contaminación + reglas duras
- `agentes/lib/runner.ts` — orquestador con hooks. **Modo shadow obligatorio**. Auto-buzón si confianza < CONFIRMADO

### Fase anterior
**FASE 1.17 — Endurecimiento M1 + plan M2 ✅ (2026-05-08)** — MÓDULO 1 cerrado oficialmente.

### Fase anterior
**FASE 1.15 — Worker pipeline v2.1 (polling) ✅ (2026-05-08)**

- Refactor Realtime → polling como carril principal (5s, batch 20, paralelo 3, timeout 10s)
- Test de carga: 50 eventos en 31s a 1.6 evt/s constantes (antes degradaba 1.3 → 0.55)

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
- [x] Aprobación implícita de ARQUITECTURA + MAPA v2: el proyecto avanzó hasta cerrar M1-M7 + 32 agentes sin pedir rediseño

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

#### ✅ F1.6 — Visor mínimo (React + Vite) — completado 2026-05-07
- Vite + React-TS arrancando en `localhost:5180` (cambiado de 5173 en F2.12)
- Cliente Supabase en `visor/src/lib/supabase.ts`
- Layout base con sidebar de módulos
- Mockup MÓDULO 1 con datos FAKE → backend después

#### ✅ F1.7 — Extensión + Adapter WhatsApp + Identidad básica — completado 2026-05-07
- Extensión Chrome reusada del proyecto WhatsApp_Captura_Safra → `extension/`
- Adapter escribe a `chats`/`mensajes` (schema nuevo)
- `adapters/adapter_whatsapp.ts` escucha y crea `evento_pg`
- `identidad/matcher.ts` con matching exacto (jid, telefono, email)
- Worker `workers/worker_pipeline.ts` arrancando todo
- **Criterio de éxito FASE 1 cumplido**: mensaje a WhatsApp → <5s aparece persona+proyecto+`evento_pg` IDENTIFICADO en el Visor

---

### ✅ FASE 2 — MÓDULO 1: Núcleo base — completada 2026-05-08

Bandeja WhatsApp + Identidad + Inmueble + Proyecto + Timeline + EVENTO_PG + Buzón validación, todo funcional con 7 submódulos. Cerrada en F1.9 con 10 puntos de cierre + F1.17 endurecimiento. Ver "Fase anterior" en ESTADO ACTUAL para detalle.

---

### ✅ FASE 3 — MÓDULO 2: Comerciales — completada 2026-05-10 (`062b089`, 27/27 E2E)
### ✅ FASE 4 — MÓDULO 3: Financieros — completada 2026-05-10 (`f62a254`, 37/37 E2E)
### ✅ FASE 5 — MÓDULO 4: Técnicos — completada 2026-05-10 (`c741dde`, 26/26 E2E)
### ✅ FASE 6 — MÓDULO 5: Operativos — completada 2026-05-10 (`953a8ef`, 28/28 E2E)
### ✅ FASE 7 — MÓDULO 6: Postventa — completada 2026-05-11 (`b2d0e6a`, 35/35 E2E)
### ✅ FASE 8 — MÓDULO 7: Evidencias — completada 2026-05-11 (`bf54706`, 25/25 E2E)
### ✅ FASE 9 — MÓDULO 8: Agentes (gobernanza visual) — completada 2026-05-14 (`e6aaa20`)
5 sub-tabs: Lista, Pipelines, Invocaciones, DLQ, Correcciones. Audit Visor E2E 65/65 vistas OK.
### ⏳ FASE 10 — MÓDULO 9: Control y seguridad — PRÓXIMA
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
| 2026-05-10 | **Initial commit a git** (`874a82c`). Proyecto sube por primera vez a control de versiones tras 3 días de iteración local intensa |
| 2026-05-10 | **M2 hardening + cobertura E2E del Comparador** (`062b089`): 27/27 checks PASS |
| 2026-05-10 | **M3 Financieros** (`f12e616` → `f62a254`): 3.1 Cotizaciones + 3.2 Abonos + 3.3 Cartera (21/21) → cierre con 3.4 Variaciones de rentabilidad + 3.5 Rentabilidad por proyecto (37/37 E2E). Migración 016: variaciones |
| 2026-05-10 | **M4 Técnicos** (`c741dde`): 6 sub-tabs originales, 26/26 E2E. Migración 017 |
| 2026-05-10 | **M5 Operativos** (`953a8ef`): 6 sub-tabs originales, 28/28 E2E. Migración 018 |
| 2026-05-11 | **M6 Postventa** (`b2d0e6a`): 5 sub-tabs, 35/35 E2E. Migración 019 |
| 2026-05-11 | **M7 Evidencias** (`bf54706`): 4 sub-tabs originales, 25/25 E2E. Migración 020 (vista unificada `vw_evidencias_unificadas` con 4 fuentes: evidencia_manual, mensaje_wa, abono_comprobante, garantia_evidencia) |
| 2026-05-11 | **Audit pre-agentes** (`f4692f9`): 5 críticos + 3 importantes resueltos antes de encender el enjambre. 63/63 smoke PASS. Migración 021 |
| 2026-05-11 | **Captura+Prospectos integrados** (`45bad31`): análisis de IndexedDB real (30 MB, 506K strings, 288 JIDs, 911 menciones Safra). 7 patrones operativos no cubiertos por M1-M7 detectados. Migración 023. **Integración con `Gestor_Prospectos_Girardot` como fuente geográfica (324 conjuntos sync)** |
| 2026-05-11 | **Refactor UI "Vistas globales"** (`f2ff8ae`): 8 sub-tabs que NO dependen del cliente activo separadas del módulo per-cliente. Sidebar ahora tiene "🌐 Vistas globales" como top-level (G.1-G.8). M2-M7 renumeradas. Resuelve confusión visual entre "datos del cliente activo" vs "ranking global del negocio" |
| 2026-05-14 | **Rollout 32 agentes productivos** (`e6aaa20`): migración 024 con tabla `agente_pipelines` + seed 33 agentes (32 active + A6_BIBLIO en shadow). Capas L1-L10 con runner DAG. Pipelines `PIPE_MENSAJE_COMERCIAL`, `PIPE_AUDIO`, `PIPE_IMAGEN`. Coherencia mecánica determinista. `ValidacionError` tipado. `resolverMsgId` tolera prefijos `true_/false_` + truncamiento LLM. **MÓDULO 8 Agentes UI** completo con 5 sub-tabs. Audit Visor E2E 65/65 vistas OK con fixes a embed PostgREST ambiguo (G.Rutas/G.Recompra), A8_REPUT duplicado, unhandled rejection en Recompra |
| 2026-05-14 | **Worker embebido en Vite dev server** (`5b736d4`): `npm run visor:dev` spawnea `worker_pipeline_v2` como child process. Logs prefijados con `[worker]`. Restart con backoff exponencial (2s→30s). Kill limpio en Windows (`taskkill /f /t`). Resuelve síntoma "32 agentes activos pero nada pasa cuando proceso un cliente" (faltaba arrancar worker manualmente) |
| 2026-05-14 | **Puerto Vite 5180 strictPort** (`076ee24`): cambio de 5173 default. `strictPort=true` fuerza fallo limpio si está ocupado. Antes el salto a 5174/5175 rompía silenciosamente la URL fija de la extensión Chrome |
| 2026-05-15 | **Fix raíz `canal_msg_id` fallback** (`0926650`): los 32 agentes leían `msg_id` desde `evt.evidencia_ids.msg_ids[0]` pero ese campo era `null` en eventos `mensaje_entrante`/`mensaje_saliente` creados por la sync de la extensión. `canal_msg_id` sí existía como columna directa. **Bug fatal silencioso**: `cargarContexto` tiraba error, runner lo tragaba, evento marcado PROCESADO sin invocar nada — el enjambre **parecía** activo. Fix uniforme en 31 agentes: `msg_ids?.[0] ?? evt?.canal_msg_id ?? null`. A5_COMPROB: aceptar `monto_coincide=null` cuando no hay cotización activa. Validado E2E con ev2282 (Claudia Lagos Casa 64, $1.000.000 detectado correctamente) |
| 2026-05-18 | **Cleanup defensivo leases zombie** (`72aefaa`): 3 piezas en `worker_pipeline_v2.ts` para evitar que eventos queden con `procesando_por`/`procesando_hasta` seteados tras crash o ruta no-feliz. Regla: `procesando_hasta < ahora AND procesando_por != null = zombie` por definición, sea cual sea el estado. Validado en BD productiva: 1 zombie histórico (ev714, PROCESADO desde 2026-05-12) limpiado. Post-cleanup: 0 zombies en 1647 filas |
| 2026-05-19 | **Diagnóstico: 206 eventos huérfanos pre-rollout.** De 225 eventos `mensaje_*` en PROCESADO, 206 nunca pasaron por ningún agente — el worker los marcó procesados antes de que existieran los pipelines (rollout 2026-05-14). Causa raíz de "los módulos se ven vacíos". Reproceso: reseteados a IDENTIFICADO, el enjambre los procesó (~$2 USD) |
| 2026-05-19 | **MODO B — se elimina el buzón de aprobación rutinaria** (`4058c88`). Decisión de Jhon: "para qué quiero un buzón de 100 aprobaciones, los agentes están para trabajar por mí". `runner.ts` ahora manda al buzón SOLO `confianza=ALERTA` (contradicción/riesgo grave). Todo lo demás escribe directo al módulo, visible. 12 agentes: `shadow = (confianza===ALERTA)`. Modelo: corrección post-hoc, no pre-aprobación. **Revierte la decisión fundacional del 2026-05-07** (buzón antes del CRM) |
| 2026-05-20 | **El Visor NO es un CRM — es un visor inteligente.** Decisión de Jhon: cada módulo entrega UNA síntesis redactada por agentes, no tablas de gestión manual. Nace la **capa de síntesis**: 7 analistas (`agentes/sintesis/analistas.ts`) sobre los 31 extractores. Migración `026` tabla `modulo_sintesis`. `PanelSintesis.tsx` en M1-M7. Worker re-sintetiza al cliente al drenar el pipeline (`4058c88`) |
| 2026-05-20 | **Jerarquía del enjambre confirmada (organigrama).** 31 extractores (dato crudo por mensaje) → 7 analistas (síntesis por cliente/módulo) → Junior (visión global). "A cargo" = cada nivel LEE el reporte del de abajo; NO se llaman entre sí. Jerarquía por reportes para no re-acoplar como el visor viejo |
| 2026-05-20 | **Junior — visión global** (`dbecf53`): A10 lee las 7 síntesis de módulo y produce la conclusión integral del cliente (`modulo='junior'`). La grilla de Clientes pasa a dashboard con semáforo + diagnóstico por tarjeta |
| 2026-05-20 | **Los analistas estructuran datos, no solo texto** (`28f4da3`, `c84e7d6`): M2-M6 devuelven JSON con los registros de su dominio y pueblan las tablas nativas (cotizaciones, abonos, medidas, tareas, garantías, reclamos). Los agentes de dominio por-mensaje (A4_COTIZ, A5_ABONO, A6_MEDIDAS…) quedan jubilados — el analista que lee toda la conversación los reemplaza. Análisis y sub-tabs salen de la misma fuente |
| 2026-05-20 | **Chat con Junior** (`2c40e48`): módulo Junior con chat. Migración `027` `junior_chat`. Junior ve todo el negocio. El worker atiende los mensajes (la API key no se expone al navegador) |
| 2026-05-20 | **Ciclo de aprendizaje** (`1308cbe`): las correcciones que Jhon le da a Junior por chat se guardan (`correcciones_humanas`, migración `028`), re-sintetizan al cliente y los analistas las toman como VERDAD PRIORITARIA. Junior infiere las implicaciones lógicas (1 mensaje → varias correcciones). Documentadas visibles en el panel de cada módulo (`a057d6f`). Flujo bidireccional cerrado: el conocimiento de Jhon corrige al enjambre |
| 2026-05-21 | **Junior con sesiones y memoria persistente** (migración `029`): cada conversación es una sesión independiente (`junior_sesiones` + `sesion_id`); el historial que ve Junior es solo el de la sesión activa. Memoria propia (`junior_memoria`): Junior guarda preferencias de comportamiento y datos generales con líneas `[MEMORIA]` y los recuerda en cualquier chat nuevo. Verificado E2E. Resuelve las falencias de "memoria independiente" detectadas al evaluar a Junior |
| 2026-05-21 | **Compactación de conversación larga** (migración `030`): superados los 20 mensajes de una sesión, los viejos se resumen con el LLM (`junior_sesiones.resumen` / `resumen_msgs`) en vez de truncarse. Junior deja de olvidar el principio de los chats largos. Cierra la FASE 6 |
| 2026-05-21 | **Fix — Junior daba falso negativo con clientes recién capturados**: si una persona existía pero los analistas aún no habían generado su síntesis (ventana de ~3 min tras capturar el chat), Junior afirmaba que "no existe / no hay datos". Ahora `construirContextoClientes` incluye a esas personas con marca "⏳ análisis en generación" → Junior responde "su análisis se está generando, preguntá en un minuto". No era pérdida de datos: era una carrera entre captura y síntesis |
| 2026-05-21 | **F7.1 — Junior crea clientes manuales** (migración `031`): cliente que llega al local / por otro medio se registra dictándoselo a Junior. Línea `[NUEVO_CLIENTE]` + correcciones con `persona_id=0`. El worker crea la persona `origen='manual'` + proyecto; los analistas sintetizan clientes sin chat de WhatsApp. Primera parte del plan de 3 (clientes manuales + cruce con WhatsApp) |
| 2026-05-21 | **F7.1b — Módulo Junior con pestañas** (migración `032`): el módulo Junior pasa a contenedor con pestañas `Chat` \| `Instrucciones por chat`. Tabla `junior_instrucciones` registra cada instrucción dada por chat (cliente nuevo, corrección, preferencia); la pestaña la muestra documentada. Base para futuras pestañas (checklist, tareas) |
| 2026-05-22 | **F7.2 — Cruce automático por teléfono**: el cliente registrado a mano que luego escribe por WhatsApp se reconoce por `telefono_e164`; `matcher.ts` le asocia el `jid` y engancha el chat al proyecto manual existente en vez de duplicarlo → un único expediente por cliente. Verificado E2E (`test_f72_cruce_telefono.ts`, 12/12) |
| 2026-05-22 | **F7.3 Parte A — Junior pregunta antes de duplicar un cliente**: si Jhon dicta un cliente cuyo nombre ya está (igual o parecido) en la lista, Junior pregunta en el chat si es la misma persona antes de registrarlo. Sección CLIENTE NUEVO del prompt reestructurada en 2 pasos. E2E 6/6 |
| 2026-05-22 | **F7.3 Parte B — Duplicados de WhatsApp en el chat** (migración `033` `duplicados_detectados`): A3_IDENTIDAD registra los duplicados que detecta; Junior los plantea y, con la confirmación de Jhon (`[RESOLVER_DUPLICADO]`), el worker fusiona las personas (`identidad/fusionar_personas.ts`: mueve todo al sobreviviente + hereda el jid). Cierra la FASE 7. E2E 10/10 |
| 2026-05-22 | **FASE 8 — Módulo Checklist por chat** (migración `034` `chat_checklist`): nueva pestaña en Junior con el estado de cada conversación (sin responder / te toca / frío / esperando cliente / cerrada), checklist adaptativo por tipo (venta/garantía/consulta) y compromisos incumplidos. Agente `A_CHECKLIST` + `cicloChecklist` (45 s). Base del futuro módulo de Tareas. E2E 10/10 |
| 2026-05-22 | **FASE 9 — Procesamiento en tiempo real**: el botón "IA Tiempo real" del TopBar funciona. Captura opt-out (todos los chats menos los bloqueados), `syncToVisorPG` cableado al alarm de la extensión (antes no corría sync automático), bloqueo como freno instantáneo. Procesa de ahora en adelante (`ws_v2_ia_realtime_since`). Requiere recargar la extensión en Chrome |
| 2026-05-22 | **Corrector universal de contactos** (reemplaza al parcial @lid-only): `reconciliarContactos()` en `visor_pg_sync.js` corre cada 20 s desde `saveChatMetadata` y reconcilia `chats.titulo` + `personas.nombre` + `personas.telefono_e164` para CUALQUIER tipo de JID (@c.us / @lid). El filtro es por VALOR del campo (`esTituloProvisional()`), no por forma del JID, así Maritza Jhon (@c.us sin nombre por timing) y los 8 @lid sin teléfono se recuperan con el mismo mecanismo. Garantías: filtro doble en PATCH (re-verifica valor exacto en server) + filtro `is.null` para teléfono → jamás pisa un valor manual. Marca `personas.sintesis_pendiente=true` al corregir → re-síntesis al toque. `tituloFallback()`, `esTituloProvisional()` y el placeholder `⏳ Identificando…` se mantienen como ayudas |
| 2026-05-22 | **Notas libres conectadas + re-clasificación de ámbito + re-síntesis al toque**: las notas que Jhon escribe sobre un contacto ahora SÍ las leen Junior y los analistas (antes la UI lo prometía pero ningún agente las leía — promesa sin backend desde el Módulo 1). El módulo Clientes filtra por ámbito y permite reclasificar un contacto (ej. cliente→proveedor) con `reclasificarAmbito()`, que actualiza chats+proyectos+personas de forma coherente Y marca `personas.sintesis_pendiente` (migración `036`); el worker tiene un ciclo nuevo `cicloSintesisPendiente` (cada 4 s) que la recoge y re-sintetiza al instante |

---

## PENDIENTES URGENTES

- [ ] Endurecer los analistas y Junior con uso real — Jhon usa el chat, corrige, se afinan
- [ ] M9 Control y seguridad (próxima fase mayor)
- [ ] Construir `Agente_Biblioteca_RAG` externo para liberar A6_BIBLIO del shadow

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
