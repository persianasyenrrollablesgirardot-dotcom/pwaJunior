# ARQUITECTURA — Visor PG

> **Documento técnico permanente.** Toda decisión de arquitectura del proyecto vive acá.
> Si se va la luz: leer `VISION.md` (qué es) → `ARQUITECTURA.md` (cómo se construye) → `MAPA.md` (dónde estamos).
>
> **Última actualización:** 2026-05-07
> **Owner:** Jhon Cubides — Fábrica de Cortinas Girardot (Safra)

---

## ÍNDICE

**PARTE I — VISIÓN**
1. Resumen ejecutivo
2. Frase guía permanente
3. Las 8 piezas del ecosistema empresarial
4. Pipeline canónico

**PARTE II — ARQUITECTURA TÉCNICA**
5. Los 6+1 niveles del sistema (L0 → L5)
6. Centro de Control (sala de mando)
7. Multi-ámbito
8. Servicio de Identidad
9. Concatenación inteligente cross-canal
10. Anti-contaminación
11. Junior — el asistente personal
12. Biblioteca RAG con 13 agentes especialistas
13. Schema concreto de `evento_pg`
14. Estados oficiales por dominio (vocabulario controlado)
15. CQRS ligero (separar escritura de lectura)
16. Permisos y multi-usuario

**PARTE III — PATRONES OPERATIVOS**
17. Cómo agregar canal nuevo
18. Cómo agregar agente nuevo (checklist obligatorio)
19. Cómo conectar CRM Zonal
20. Modo shadow para agentes nuevos
21. Hot reload de prompts
22. Soft delete + papelera 30 días
23. Tags libres y búsqueda full-text
24. Modo "explicación" de cada inferencia
25. Cola de procesamiento priorizada
26. Lock / lease al procesar (concurrencia)
27. Política de retry y dead-letter
28. Manejo de chats grupales de WhatsApp
29. Merge de personas duplicadas
30. Borrado / "olvidar" un cliente
31. SLA del primer mensaje de cliente nuevo

**PARTE IV — RESILIENCIA Y OPERACIÓN**
32. Notificaciones push al celular
33. Modo offline-degradado
34. Sincronización backwards desde CRM Zonal
35. Backups automáticos y restauración probada
36. Costo estimado real (presupuesto API)

**PARTE V — REGLAS Y DISCIPLINA**
37. Patrones que NO usamos y por qué
38. Reglas duras del negocio (R-001 a R-013)
39. Stack técnico
40. Estructura del repositorio
41. Los 11 módulos del Visor (orden de construcción)
42. Roadmap de evolución
43. Tres Supabase distintos en el ecosistema
44. Decisiones de arquitectura (registro)
45. Disciplina de desarrollo

**PARTE VI — POLÍTICA DE PROCESAMIENTO IA** ⚠️ **leer ANTES de tocar agentes**
46. Las 4 capas separadas de costo
47. Modo OFF — control manual estricto (default hoy)
48. Modo ON — tiempo real automático
49. Bloqueo de chats (válvula de escape)
50. Schema y configuración
51. Junior como guardián del costo
52. Reglas duras de costo (R-IA-001 a R-IA-007)

---

# PARTE I — VISIÓN

## 1. Resumen ejecutivo

El **Visor PG** es la **consola viva de operación** de Persianas Girardot. NO es solo WhatsApp, ni solo CRM, ni solo IA, ni solo dashboard. Es el **punto de conexión** entre conversación, cliente, inmueble, proyecto, cotización, pago, instalación, garantía, evidencia, agente, validación y decisión.

Pertenece a un ecosistema más grande:

```
┌──────────────────────────────────────────────────────────────────────┐
│                  ECOSISTEMA EMPRESARIAL PERSIANAS GIRARDOT           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐  ┌─────────────┐  ┌──────────┐  ┌───────────────┐  │
│  │  BIBLIOTECA  │  │   CRM       │  │  PÁGINA  │  │    AUDIO      │  │
│  │  EMPRESARIAL │  │   ZONAL     │  │   WEB    │  │ (transcripción│  │
│  │  (13 agentes │  │  (verdad    │  │ (entrada │  │   + capturas) │  │
│  │ especialistas│  │  estructura │  │  leads)  │  │   FUTURO      │  │
│  │  por sistema)│  │  offline-   │  │          │  │               │  │
│  │ localhost:   │  │  first)     │  │          │  │               │  │
│  │   5500       │  │             │  │          │  │               │  │
│  └──────┬───────┘  └──────┬──────┘  └────┬─────┘  └───────┬───────┘  │
│         │                  │              │                │          │
│         │   consultar      │   validar    │   alimentar    │ alimentar│
│         │                  │   y guardar  │                │          │
│         │                  │   verdad     │                │          │
│         │                  │              │                │          │
│         └────────┬─────────┴──────────────┴────────────────┘          │
│                  │                                                    │
│         ┌────────▼─────────────────────────┐                          │
│         │       VISOR PG                   │   ← este proyecto        │
│         │   (consola viva,                 │                          │
│         │    procesamiento,                │                          │
│         │    presentación,                 │                          │
│         │    validación humana)            │                          │
│         └────────┬─────────────────────────┘                          │
│                  │                                                    │
│         ┌────────▼─────────────────────────┐                          │
│         │   AGENTE JUNIOR                  │   ← vive en Visor        │
│         │   (asistente personal de Jhon,   │     futuro: app móvil    │
│         │    único acceso multi-ámbito)    │                          │
│         └──────────────────────────────────┘                          │
│                                                                       │
│         ┌──────────────────────────────────┐                          │
│         │      CENTRO DE CONTROL           │   ← sala de mando        │
│         │  (vista superior que muestra     │     transversal a TODO   │
│         │   estado del ecosistema entero)  │                          │
│         └──────────────────────────────────┘                          │
└───────────────────────────────────────────────────────────────────────┘
```

**El Visor:**
- Recibe info de múltiples canales (WhatsApp + Web + Email + Audio + Proveedores + IA externas)
- Identifica personas (cross-canal)
- Procesa con agentes especializados por **ámbito** (comercial, proveedor, familia, etc.)
- Valida lo crítico con **buzón humano** antes de escribir verdad
- Sincroniza al CRM Zonal lo confirmado
- Permite a Jhon consultar/corregir todo desde un panel
- **Junior** responde a Jhon en lenguaje natural sobre cualquier ámbito

---

## 2. Frase guía permanente

> **WhatsApp conversa.**
> **El visor estructura.**
> **Los agentes procesan.**
> **El humano valida.**
> **El CRM guarda.**
> **El agente junior consulta.**
> **La empresa aprende.**

(De `VISION.md`, Conclusión Operativa.)

---

## 3. Las 8 piezas del ecosistema empresarial

Definidas literalmente en `VISION.md`. Cada pieza tiene función única y NO se mezcla con las otras:

### 3.1 Biblioteca empresarial (cerebro documental)
- Vive en `http://localhost:5500/` (proyecto separado).
- 13 **agentes especialistas por sistema**: Blackout, Screen Solar, Sheer Elegance, Panel Japonés, Enrollables, Verticales, Películas Solares, Toldos, Motores, Domótica, Rieles, Mantenimientos, Garantías.
- Responde **conocimiento técnico**: fichas, precios base, garantías, advertencias, compatibilidades, criterios por clima, recomendaciones por uso.
- **NO decide cierres comerciales. NO confirma pagos. NO actualiza saldos. NO reemplaza al CRM.**

### 3.2 CRM Zonal (verdad estructurada)
- Vive aparte. Sin API por ahora.
- Memoria dura del negocio: clientes, teléfonos, inmuebles, proyectos, cotizaciones, facturas, abonos, saldos, instalaciones, garantías, postventa, recompras, referidos.
- **Offline-first**: funciona aunque la IA falle.
- La IA puede alimentarlo, pero la verdad final está en registros estructurados.

### 3.3 Página web
- Fuente de entrada (formularios, solicitudes de cotización, datos de cliente, producto de interés, ciudad, fotos, mensajes, origen del contacto, intención comercial).
- Todo lo que entre por web debe **reflejarse en CRM** y crear **proyecto o preproyecto**.
- En el Visor: `adapter_web` recibe y normaliza.

### 3.4 Visor WhatsApp PG (este proyecto)
- Consola viva de operación basada en WhatsApp + multi-canal.
- Convierte conversaciones en operación empresarial: eventos, tareas, evidencias, cotizaciones, cambios, alertas, estados, validaciones, datos de CRM, decisiones pendientes.
- **Puente** entre conversación humana y sistema estructurado.

### 3.5 Enjambre de agentes
- Dividido por funciones: extracción objetiva, producto, comercial, técnico, financiero, operativo, garantía, auditoría, supervisor, junior personal.
- **Regla:** el agente propone → el sistema documenta → el humano valida lo crítico → el CRM guarda la verdad.

### 3.6 Agente Junior personal
- Secretario operativo de Jhon. Consultable desde celular.
- Responde: cuánto debe un cliente, último abono, dirección instalación, estado garantía, cotización enviada, sistema vendido, próxima visita, saldo pendiente, cliente pendiente reseña, último mensaje importante.
- **No inventa.** Responde desde CRM, Visor, evidencias y biblioteca.

### 3.7 Audio y transcripción (futuro)
- Capturadora de audio + transcripción + extracción de: cliente, fecha, compromiso, medida, producto, pago, tarea.
- Una llamada comercial importante → evidencia operativa.

### 3.8 Centro de Control (sala de mando)
- **Capa superior** que conecta TODO: biblioteca, CRM, visor, web, WhatsApp, audios, agentes, validaciones, métricas, reportes, alertas.
- En Visor PG: el **Módulo 10 (Gerencial)** + **Junior** + **panel de alertas globales** funcionan juntos como Centro de Control.
- No es solo un dashboard: es la sala de mando del negocio.

---

## 4. Pipeline canónico

```
[Canal externo: WA / Web / Email / Audio / Proveedor / IA externa]
                              ↓
                        Captura cruda
                              ↓
                       Normalización
                              ↓
                          EVENTO_PG (estado=NUEVO)
                              ↓
                  Servicio de Identidad (L1)
                  → resuelve persona_id, proyecto_id, ámbito
                              ↓
                          EVENTO_PG (estado=IDENTIFICADO)
                              ↓
                  Extractor objetivo (L1.5)
                  → extrae datos limpios (nombres, fechas, montos, medidas)
                              ↓
                  Agentes especialistas (L2, por ámbito)
                  → infieren, escriben nuevos EVENTO_PG con confianza
                              ↓
                       Validadores (L3)
                  → anti-contaminación + anti-alucinación + reglas duras
                              ↓
                  Buzón de validación (L5 humano)
                  → Jhon aprueba / rechaza / edita
                              ↓
                  CRM Zonal (verdad final, módulo separado)
                              ↓
                  Junior consulta / Reportes / Operación
```

**Regla irrenunciable:** el Visor NUNCA escribe verdad crítica directamente al CRM. Todo dato que afecte **dinero, producción, instalación, garantía, facturación, responsabilidad técnica, inventario, saldo, descuento, medida final** REQUIERE validación humana antes de cruzar al CRM.

---

# PARTE II — ARQUITECTURA TÉCNICA

## 5. Los 6+1 niveles del sistema

Cada nivel tiene UN propósito claro. Comunican SOLO via `evento_pg` en BD (Realtime de Supabase). **Cero llamadas directas entre módulos.**

### L0 — Adapters (uno por canal)
Recibe del canal, normaliza, escribe `evento_pg` con identificadores crudos. Folder: `adapters/`.

### L1 — Servicio de Identidad (módulo central, no agente)
Resuelve `persona_id`, `proyecto_id`, `inmueble_id`, `ambito`. Re-publica el evento como `IDENTIFICADO`. Folder: `identidad/`.

### L1.5 — Extractor objetivo (capa nueva, agregada del doc del escritorio sección 8.2)
**Entre identidad y agentes interpretativos.** Extrae datos OBJETIVOS sin interpretar:
- nombres, teléfonos, direcciones, medidas (números), fechas, productos mencionados literalmente, valores monetarios.
- Cero inferencia. Cero LLM si se puede con regex/parser.
- **Por qué separado:** los agentes interpretativos consumen datos LIMPIOS, no parsean texto crudo. Mejora calidad y baja costo.
- Folder: `extractor/`.

### L2 — Agentes especialistas (uno por dominio + ámbito)
Cargan **toda la línea de tiempo** de la persona antes de inferir. Escriben nuevos `evento_pg` con confianza marcada. Folder: `agentes/`.

### L3 — Validadores
Aplican garantías ANTES de que un dato cruce al buzón o al CRM:
- **Anti-contaminación** (no menciona otro cliente)
- **Anti-alucinación** (toda inferencia cita evidencia)
- **Confianza obligatoria** (CONFIRMADO / INFERIDO / DUDOSO / ALERTA)
- **Reglas duras** (R-001 a R-013)

### L4 — Supervisor pasivo + Gerente coordinador
**Dos roles distintos:**

- **Supervisor pasivo (monitor):** observa métricas, NO orquesta. Genera alertas si algo se traba.
- **Gerente coordinador (decide políticas):** define EN BD qué tipo de evento dispara qué agente, en qué orden, con qué prioridad. **Es configuración, no llamadas directas.** Reconcilia el "Gerente del enjambre" del doc del escritorio (sección 8.8) con el patrón Event Sourcing: el Gerente es el orquestador de POLÍTICAS, no de PROCESOS. Edita reglas en BD; los agentes siguen escuchando `evento_pg`.

Folder: `supervision/`.

### L5 — Humano (Jhon)
Interfaz Visor:
- Buzón de validación
- Correcciones (las correcciones se guardan en `correcciones` y los agentes las respetan)
- Notas libres por cliente (los agentes las leen ANTES de inferir)
- Dashboards
- Conversación con Junior

---

## 6. Centro de Control (sala de mando)

El Centro de Control NO es un módulo aparte. Es una **vista transversal** que combina tres cosas:

| Componente | Función |
|---|---|
| **Módulo 10 (Gerencial)** del Visor | 7 dashboards (comercial, operativo, financiero, errores, desgaste, productos, reputación) |
| **Junior conversacional** | consulta natural cross-ámbito |
| **Panel de alertas globales** | métricas en vivo del ecosistema, eventos atascados, errores recientes, costo del día |

Vive en una pestaña del Visor con layout específico. Es lo primero que Jhon ve al abrir.

**Anti-pattern:** NO es un dashboard estático. Es operativo: cada widget permite click → drill-down al detalle.

---

## 7. Multi-ámbito

Cada chat (cualquier canal) tiene un campo **`ambito`** que define qué set de agentes lo procesa.

| Ámbito | Para qué | Agentes |
|---|---|---|
| `comercial` | Clientes del negocio | A1, A2, A5, A6, A8, A9, B1, … |
| `proveedor` | Proveedores (telas, motores, etc.) | P1, P2, P3 |
| `personal_familia` | Hija, esposa, padres, hermanos | F1, F2 (futuro) |
| `personal_amigos` | Amigos | (sin agentes por ahora) |
| `personal_otros` | Conocidos no clasificados | (sin agentes por ahora) |
| `interno_equipo` | Instaladores, técnicos, contadora | E1, E2 (futuro) |

### Garantía dura
- Agente comercial JAMÁS ve chats personales (ni siquiera por accidente).
- Agente familia JAMÁS ve datos comerciales.
- Cada agente filtra a nivel de query (`WHERE ambito = X`).
- A nivel de schema: `evento_pg.ambito` es NOT NULL, parte del index.
- Realtime de Supabase ya filtra por ámbito (RLS).

### Cómo se asigna el ámbito
**Modelo MIXTO:**
1. Mini-agente **Clasificador de ámbito** (reglas + LLM) propone ámbito al detectar chat nuevo.
2. Jhon confirma desde el Visor la primera vez.
3. Después el ámbito queda fijo (Jhon puede cambiarlo manualmente desde el Visor).
4. Cambios de ámbito se registran en `chat_ambito_historial` con motivo y timestamp.

### Privacidad
- Chats `personal_*` NO sincronizan al CRM Zonal.
- Solo viven en Supabase del Visor con RLS restrictivo.
- Junior los lee solo para responderle a Jhon.

### Arranque MVP
**Empezamos con `comercial` + `personal_otros` (catch-all temporal).** Otros ámbitos se agregan cuando se necesiten — sin romper nada.

---

## 8. Servicio de Identidad

Vive en `identidad/` como módulo TS (no Edge Function al inicio; migrable después).

### Algoritmo de matching (cascada)

```
INPUT: evento_pg con identificadores crudos
       (ej: { telefono: "+57 322 X", nombre: "Pedro", canal: "whatsapp" })

1. ¿Match exacto por identificador?
   - telefono normalizado (E.164) → match
   - email lowercase → match
   - jid (WhatsApp) → match
   SI: persona_id resuelto. END.

2. ¿Match difuso (>85% similaridad)?
   - mismo nombre + misma ciudad/conjunto/inmueble
   SI: persona_id resuelto, marcar evento como AUTO_MATCH (revertible).

3. ¿Match contextual?
   - Menciona proyecto activo → asociar persona del proyecto.

4. ¿Match dudoso (60-85%)?
   - Marcar AMBIGUO. Pausar procesamiento. Escalar al buzón.

5. NO HAY MATCH → crear persona nueva + proyecto nuevo.

OUTPUT: evento_pg con { persona_id, proyecto_id, ambito, estado: IDENTIFICADO }
```

### Identificadores reconocidos
- `telefono` (normalizado E.164)
- `email` (lowercase)
- `jid` (WhatsApp)
- `cedula` / `nit`
- `nombre + ciudad` (difuso)
- `inmueble_id` (si menciona dirección conocida)

---

## 9. Concatenación inteligente cross-canal

**Regla:** cuando un agente dispara, NUNCA procesa solo el evento nuevo. Carga la **línea de tiempo completa** de la persona/proyecto antes de inferir.

### Ejemplo — Pedro escribe por WA y por email

| Día | Canal | Evento |
|---|---|---|
| Lunes | WhatsApp | "necesito blackout para sala 1.40×1.80" |
| Miércoles | Email | "envíame catálogo de motores" |
| Viernes | Audio | Llamada: pacta visita el sábado |

**Procesamiento:**
1. Lunes: `adapter_whatsapp` → `evento_pg` → Identidad crea `persona_id=pedro` → Agente Comercial carga timeline (1 evento) → infiere "interés blackout".
2. Miércoles: `adapter_email` → `evento_pg` → Identidad hace match difuso → mismo `persona_id=pedro` → Agente Comercial carga timeline (2 eventos: WA + email) → infiere "interés blackout + motor".
3. Viernes: `adapter_audio` → transcripción → `evento_pg` → match → Agente Comercial carga timeline (3 eventos) + Agente Compromisos detecta cita.

**Garantía:** ningún evento se procesa en aislamiento. Cada inferencia tiene contexto cross-canal completo.

---

## 10. Anti-contaminación

Dos niveles de aislamiento garantizados a nivel de schema y código:

### Cross-cliente
- Toda query filtra por `chat_id` o `persona_id`.
- Validador automático rechaza outputs que mencionen otro cliente.
- Tests E2E en CI verifican que A1 sobre Pedro NO contiene datos de María.

### Cross-ámbito
- Cada agente filtra `WHERE ambito = X` siempre.
- `evento_pg.ambito` NOT NULL + index.
- RLS de Supabase filtra a nivel de DB.

### Memoria DUAL (anti-contaminación de aprendizaje)
- **Memoria local** (por persona): observaciones del cliente actual. Vinculada a `persona_id`. JAMÁS se cruza.
- **Memoria global** (por agente, sin nombres): patrones cross-cliente anonimizados. SIN nombres, SIN identificadores. Ej: "clientes que piden 5 cotizaciones priorizan precio".

---

## 11. Junior — el asistente personal

**Único agente con acceso multi-ámbito.** Vive en `agentes/junior/`.

### Contrato funcional (qué debe responder)
Lista del doc del escritorio sección 1.6:
- Cuánto debe un cliente
- Cuál fue el último abono
- Dirección de instalación
- Estado de garantía
- Cotización enviada
- Sistema vendido
- Próxima visita
- Saldo pendiente
- Cliente pendiente de reseña
- Último mensaje importante
- (Multi-ámbito) "¿Mi hija escribió hoy?", "¿el proveedor X confirmó pedido?"

### Comportamiento
- Lee de los 4 enjambres (comercial, proveedor, familia, equipo) según corresponda.
- Responde en lenguaje natural conversacional (español Colombia).
- **NUNCA mezcla datos entre ámbitos en su respuesta.** Responde por separado: "Tenés 3 cosas comerciales y 1 mensaje de tu hija."
- **No inventa.** Si no sabe, dice "no tengo dato" y sugiere dónde mirar.

### Cuándo se construye
**Después del MÓDULO 1 (Núcleo base) completo.** Si lo construyo antes, no tiene de dónde leer.

### Futuro: app móvil
Se diseña con interfaz **API desde el día 1** (endpoint REST/Supabase Edge Function). Cuando hagamos la app móvil, la app consume la misma API que el Visor consume. Cero rehacer.

---

## 12. Biblioteca RAG con 13 agentes especialistas

Biblioteca está en `http://localhost:5500/` (proyecto separado). Tiene 13 agentes especialistas por sistema (ver sección 3.1).

### Cuándo se consulta
Cuando un agente del Visor necesita conocimiento técnico que NO está en el chat.

### Patrón de consulta
```
Agente Comercial detecta "blackout enrollable motorizado"
                          ↓
   Llama integraciones/biblioteca_rag.ts
                          ↓
   GET http://localhost:5500/api/sistema?nombre=blackout_enrollable_motorizado
                          ↓
   Recibe: ficha técnica, precios base, motor compatible, garantía
                          ↓
   Usa esa info para enriquecer la cotización
```

### Cómo el agente del Visor llama al especialista correcto
1. Agente del Visor identifica el SISTEMA (blackout, screen, sheer, etc.).
2. Llama endpoint correspondiente: `/api/sistema/{nombre}/consultar`.
3. Biblioteca enruta al agente especialista interno (Blackout, Screen, etc.).
4. Especialista devuelve respuesta estructurada.

### Cache + fallback
- Respuestas se cachean por 1h (evita hits repetidos).
- Si Biblioteca no responde, agente sigue con info parcial pero marca `confianza=DUDOSO`.

### Cliente HTTP
Vive en `integraciones/biblioteca_rag.ts`.

---

## 13. Schema concreto de `evento_pg`

**Sin este schema, FASE 1 no arranca.** Definido acá para que sea inamovible.

```sql
CREATE TABLE evento_pg (
  id BIGSERIAL PRIMARY KEY,

  -- Origen
  canal TEXT NOT NULL,              -- 'whatsapp' | 'web' | 'email' | 'audio' | 'proveedor' | 'ia_externa'
  canal_msg_id TEXT,                -- ID del mensaje en el canal de origen (idempotencia)

  -- Identidad resuelta (NULL hasta que L1 procese)
  persona_id BIGINT REFERENCES personas(id),
  proyecto_id BIGINT REFERENCES proyectos(id),
  inmueble_id BIGINT REFERENCES inmuebles(id),

  -- Clasificación
  ambito TEXT NOT NULL,             -- 'comercial' | 'proveedor' | 'personal_familia' | ...
  tipo_evento TEXT NOT NULL,        -- 'mensaje_entrante' | 'inferencia' | 'cambio_estado' | 'pago' | ...
  prioridad SMALLINT NOT NULL DEFAULT 5,  -- 1=crítica (pago, cambio medida) → 9=baja (sentimiento)

  -- Estado de procesamiento
  estado TEXT NOT NULL DEFAULT 'NUEVO',
                                    -- NUEVO → IDENTIFICADO → EN_PROCESO → PROCESADO
                                    -- AMBIGUO (pausado, requiere humano)
                                    -- ERROR (falló, va a dead-letter)

  -- Payload
  payload JSONB NOT NULL,           -- contenido normalizado del evento
  evidencia_ids JSONB,              -- {msg_ids: [...], doc_ids: [...]}

  -- Producción del evento
  agente_origen TEXT,               -- NULL si viene de adapter, 'A5' si viene de agente
  evento_padre_id BIGINT REFERENCES evento_pg(id),  -- linaje completo

  -- Confianza (cuando aplica)
  confianza TEXT,                   -- CONFIRMADO | INFERIDO | DUDOSO | ALERTA | RECHAZADO

  -- Marcas operativas
  shadow BOOLEAN NOT NULL DEFAULT false,    -- true = no se materializa, solo se loggea
  costo_usd NUMERIC(10,6) DEFAULT 0,        -- costo LLM acumulado de este evento

  -- Lock/lease para concurrencia
  procesando_por TEXT,              -- worker_id que tomó el evento
  procesando_hasta TIMESTAMPTZ,     -- expira el lease (libera evento si worker murió)

  -- Tiempos
  ts_canal TIMESTAMPTZ NOT NULL,    -- cuándo ocurrió en el canal de origen
  ts_creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ts_procesado TIMESTAMPTZ,

  -- Soft delete
  deleted_at TIMESTAMPTZ,           -- NULL = activo, set = en papelera (purgar a 30d)

  -- Idempotencia
  CONSTRAINT uq_evento_idempotencia UNIQUE (canal, canal_msg_id, agente_origen)
);

-- Indexes críticos
CREATE INDEX idx_evento_pg_pendientes
  ON evento_pg (prioridad ASC, ts_creado ASC)
  WHERE estado IN ('NUEVO', 'IDENTIFICADO') AND deleted_at IS NULL;

CREATE INDEX idx_evento_pg_persona ON evento_pg (persona_id, ts_canal DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_evento_pg_proyecto ON evento_pg (proyecto_id, ts_canal DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_evento_pg_ambito ON evento_pg (ambito, ts_creado DESC) WHERE deleted_at IS NULL;

-- Full-text search sobre payload
CREATE INDEX idx_evento_pg_fts
  ON evento_pg USING GIN (to_tsvector('spanish', payload::text));
```

**Notas:**
- `canal_msg_id` puede ser NULL para eventos generados por agentes (no vienen de canal).
- `evento_padre_id` permite reconstruir el linaje: este evento de inferencia salió de qué mensaje original.
- `procesando_por` + `procesando_hasta` = patrón lease (sección 26).
- `deleted_at` = soft delete (sección 22).

---

## 14. Estados oficiales por dominio (vocabulario controlado)

Listas finitas. Los agentes JAMÁS inventan vocabulario fuera de estos. Validador rechaza.

### Estados de cotización (sección 2.1 doc)
`propuesta` | `negociando` | `intencion_cierre` | `ganada` | `perdida` | `vencida`

### Estados de abono (sección 3.2 doc)
`pendiente_validacion` | `confirmado` | `rechazado` | `inconsistente`

### Estados de producción (sección 5.1 doc)
`pendiente_abono` | `pedido_proveedor` | `en_produccion` | `listo_instalar` | `retenido` | `entregado` | `instalado`

### Estados de visita (sección 5.2 doc)
`programada` | `completa` | `parcial` | `fallida` | `reagendada`

### Causas de garantía (sección 6.1 doc)
`producto` | `instalacion` | `cliente` | `ambiente` | `tercero` | `construccion`

### Tipos de objeción (sección 2.3 doc)
`precio` | `calidad` | `garantia` | `tiempo` | `competencia` | `color` | `diseño` | `instalacion` | `desconfianza` | `comparacion_referido` | `comparacion_homecenter` | `comparacion_otro_proveedor`

### Tipos de medida (sección 4.1 doc)
`suministrada_cliente` | `validada_empresa` | `corregida` | `final_produccion` | `instalada`

### Niveles de confianza
`CONFIRMADO` | `INFERIDO` | `DUDOSO` | `ALERTA` | `RECHAZADO`

### Tipos de evento (en `evento_pg.tipo_evento`)
`mensaje_entrante` | `mensaje_saliente` | `dato_extraido` | `inferencia` | `cambio_estado` | `solicitud_aprobacion` | `contradiccion` | `pago` | `medida` | `garantia` | `variacion` | `tarea` | `alerta` | `evidencia` | `pregunta_humano`

### Sistemas (catálogo Safra)
`blackout` | `screen_solar` | `sheer_elegance` | `panel_japones` | `enrollables` | `verticales` | `peliculas_solares` | `toldos` | `motores` | `domotica` | `rieles` | `cadenillas`

**Implementación:** estos son `CHECK constraint` en BD + enums en TS. Imposible insertar fuera del catálogo.

---

## 15. CQRS ligero (separar escritura de lectura)

**Problema:** si el Visor consulta `evento_pg` directo, con 100k eventos se vuelve lento.

**Solución:** separar:

| Capa | Responsabilidad | Tabla |
|---|---|---|
| **Escritura** | Adapters + agentes escriben eventos crudos | `evento_pg` (append-only) |
| **Lectura** | El Visor consulta vistas pre-calculadas | `vw_clientes_resumen`, `vw_buzon_pendientes`, `vw_timeline_proyecto`, etc. |

### Cómo se mantienen las vistas
- **Vistas materializadas** de Postgres con `REFRESH MATERIALIZED VIEW CONCURRENTLY`.
- Triggers que disparan refresh cuando llegan eventos del tipo correspondiente.
- Para datos calientes (buzón, métricas en vivo): tabla normal con upsert al recibir evento.

### Beneficio
- El Visor responde en <100ms incluso con millones de eventos.
- Event sourcing puro queda como auditoría/replay.

---

## 16. Permisos y multi-usuario

**Hoy: solo Jhon.** Pero el sistema se diseña para multi-usuario desde el schema.

Tabla `usuarios` con roles del doc del escritorio sección 9.1:
- `dueño` (Jhon) — todo
- `administrador` — todo excepto cambiar agentes / prompts
- `asesor` — leer + escribir cotizaciones, no toca dinero confirmado
- `instalador` — leer agenda + checklist + reportar visita
- `contabilidad` — leer + validar abonos / facturas
- `soporte` — leer postventa + responder garantías

**Implementación:** Supabase RLS por `usuario.rol`. Vista del Visor cambia según rol.

**Hoy MVP:** solo Jhon (rol `dueño`). Escalable cuando se necesite.

---

# PARTE III — PATRONES OPERATIVOS

## 17. Cómo agregar canal nuevo

Pongamos: agregar Instagram DM.

1. Crear `adapters/adapter_instagram.ts`.
2. Implementar interfaz mínima:
   ```ts
   interface AdapterCanal {
     nombre: string;            // 'instagram'
     iniciar(): Promise<void>;  // suscribirse al canal
     normalizar(msg: any): EventoPGInput; // convertir al formato canónico
   }
   ```
3. El adapter escribe a `evento_pg` con `canal='instagram'` y identificadores que tenga.
4. Servicio de Identidad ya sabe cómo resolver (no necesita cambios).
5. Agentes existentes ya escuchan `evento_pg` (no necesitan cambios).

**Resultado:** agregaste Instagram sin tocar agentes ni Identidad ni Visor. **Cero acoplamiento.**

---

## 18. Cómo agregar agente nuevo (CHECKLIST OBLIGATORIO)

Heredado del patrón validado en v3 del proyecto anterior. Aplica igual acá.

### Reglas en orden estricto:

1. **NO reinventar Capa 0.** Importar de `agentes/lib/runner.ts` y `agentes/skeleton/`.
2. **Definir `AgenteDefinicion`** con campos obligatorios:
   - `id` corto (ej: `B2`)
   - `nombre` (`B2_auditor_expediente`)
   - `proposito`, `prompt_especifico`
   - `criticidad`: `alta` | `media` | `baja`
   - `outputs.modulo_destino`: tabla destino (`COTIZACIONES`, `MEDIDAS`, etc.)
   - `inputs.filtro_chat_id_obligatorio: true`
   - `reglas_duras_propias`: array de códigos R-XXX
   - `version: 1`
3. **Estructura del `prompt_especifico`:**
   - Misión clara en 1-2 líneas
   - Vocabulario ESTRICTO si el output va a campos con CHECK constraint (sección 14)
   - **Regla de evidencia explícita:** "evidencia_msg_ids debe contener TODOS los msg_id citados. Si no hay evidencia → emite `tipo='observacion'` con `confianza='DUDOSO'`, o `tipo='pregunta_humano'`"
   - Reglas duras del negocio relevantes escritas explícitas
   - Formato de payload JSON con ejemplo
4. **Funciones obligatorias por agente:**
   - `cargarInputsXX(sb, ctx)` — lee tablas que el agente necesita
   - `postProcesarXX(sb, ctx, output, evento_id)` — escribe a tablas-de-negocio CON dedup idempotente
   - `ejecutarXX(sb, apiKey, ctx)` — wrapper que llama `ejecutarAgente()` del runner común
5. **Defensas en post-procesador:**
   - Validar schema real con `\d <tabla>` antes de hacer INSERT
   - Si modifica dato existente: usar `detectarContradiccion()` ANTES del UPDATE
   - R-013#1: si `quien_midio='cliente'` o `'familiar'` → bandera `RIESGO_MEDICION_CLIENTE` automática
   - R-001: NUNCA marcar `GANADO`, `ABONO_RECIBIDO`, `PRODUCCION`, `INSTALADO` sin validación humana
   - Solo escribir a tabla destino si `output.confianza ∈ {CONFIRMADO, INFERIDO}`. DUDOSO/ALERTA quedan en `evento_pg`.
   - Idempotencia: dedup por clave natural (numero_cotizacion, ancho+alto+ambiente, etc.)
6. **Crear runner one-shot** `run_XX_<jid>.mjs` con tope `costoLimiteUsd: 0.05` para test manual.
7. **Modo shadow primero:** correr 7 días en `shadow=true` (sección 20). Validar:
   - Validador acepta el output
   - Anti-contaminación: NO menciona otros clientes
   - Idempotencia: 2da ejecución no duplica
   - Costo dentro del tope
8. **Insertar definición en `agentes_definicion`** después de validar.
9. **Documentar en `MAPA.md`:** costo real, latencia, qué detectó, qué respetó.

### LO QUE JAMÁS SE HACE
- Inventar datos para llenar campos vacíos del payload.
- Marcar CONFIRMADO una observación psicológica (validador la rechaza).
- Hacer queries cross-cliente sin filtro `chat_id` o `persona_id`.
- Llamar a DeepSeek directo sin pasar por `lib/llm.ts` (con retry, timeout, costo).
- Saltarse el validador.
- Romper R-001.
- Mover memoria_local de un cliente a otro.
- Escribir nombres de clientes en `memoria_global_especialista`.

---

## 19. Cómo conectar CRM Zonal

CRM Zonal aún NO tiene API. Diseñamos contrato cuando lo conectemos.

**Cuando esté listo:**
1. CRM Zonal expone endpoint REST (ej: `POST /personas`, `POST /facturas`).
2. Crear `integraciones/crm_zonal.ts` con cliente HTTP.
3. Cuando un dato del Visor sale del Buzón con estado APROBADO → se envía al CRM via cliente.
4. CRM sigue siendo **offline-first** (autoritativo).
5. Sincronización bidireccional: cambios manuales en CRM → webhook al Visor → re-procesa contexto (sección 34).

**Mientras tanto:** Visor opera con su propio Supabase como fuente de verdad temporal.

---

## 20. Modo shadow para agentes nuevos

**Problema:** un agente nuevo puede romper datos si tiene bug sutil.

**Solución:** todo agente nuevo arranca con `shadow=true`:
- Procesa eventos normalmente.
- Genera output normalmente.
- **NO escribe a tablas de negocio.** Solo loggea en `evento_pg` con `shadow=true`.
- Jhon revisa el log: ¿lo que habría hecho era correcto?
- Después de 7 días sin bugs visibles → flag a `shadow=false` y empieza a escribir.

**Costo:** mismo costo de LLM (corre completo). Beneficio: cero riesgo de corromper datos.

---

## 21. Hot reload de prompts

**Patrón validado en v3 del proyecto anterior.** Aplicar igual:

- Prompts viven en tabla `agentes_definicion` (no hardcoded en código TS).
- Visor tiene panel "Editar agente" donde Jhon edita prompt.
- En la siguiente invocación, el agente lee el prompt actualizado de BD.
- **Sin reiniciar workers.**
- Cada cambio crea nueva fila en `agentes_definicion_historial` (rollback posible).

---

## 22. Soft delete + papelera 30 días

**Problema:** errores accidentales (Jhon o agente) borrando algo importante.

**Solución:**
- Tablas críticas tienen `deleted_at TIMESTAMPTZ`.
- "Borrar" = `UPDATE ... SET deleted_at = NOW()`.
- Vistas del Visor filtran `WHERE deleted_at IS NULL`.
- Panel "Papelera" muestra elementos eliminados últimos 30 días.
- Cron diario: `DELETE FROM ... WHERE deleted_at < NOW() - INTERVAL '30 days'`.

**Costo en BD:** bajo. **Beneficio:** anti-error humano.

---

## 23. Tags libres y búsqueda full-text

### Tags libres
- Tabla `tags` con vínculo a `personas`, `proyectos`, `chats`.
- Jhon agrega tags ad-hoc desde el Visor: "VIP", "moroso", "futuro proyecto", "recomendado por X".
- Filtros y búsqueda usan tags.
- **Sin pedir un agente nuevo:** flexibilidad operativa.

### Búsqueda full-text
- Index GIN sobre `evento_pg.payload` (visible en sección 13).
- Panel "Buscar" del Visor: "el cliente que mencionó blackout sala" → resultados en <500ms.
- Búsqueda también sobre `notas_libres`, `correcciones`, `personas.notas`.

---

## 24. Modo "explicación" de cada inferencia

**Problema:** caja negra. Jhon no confía si no ve por qué el agente llegó a la conclusión.

**Solución:** cada inferencia que entra al buzón muestra:
- **Qué dijo el agente** (output)
- **Qué evidencia usó** (msg_ids específicos, citados textualmente)
- **Qué reglas aplicaron** (R-001, R-013#1, etc.)
- **Confianza** (CONFIRMADO / INFERIDO / DUDOSO + por qué)
- **Datos previos del cliente** (qué memoria_local consideró)

UI: panel expandible "¿Por qué esta inferencia?" en cada item del buzón.

---

## 25. Cola de procesamiento priorizada

`evento_pg.prioridad` (1=crítica, 9=baja).

| Prioridad | Tipos de evento |
|---|---|
| 1 | pago, cambio_medida_post_produccion, garantia_nueva, contradiccion_dinero |
| 2 | cotizacion, abono_pendiente, primer_mensaje_cliente_nuevo |
| 3 | seguimiento, pregunta_tecnica |
| 5 | mensaje_general (default) |
| 7 | observacion, sentimiento |
| 9 | métrica_secundaria |

Worker toma eventos `ORDER BY prioridad ASC, ts_creado ASC`. Eventos críticos saltan la fila.

---

## 26. Lock / lease al procesar (concurrencia)

**Problema:** dos workers toman el mismo evento → race condition.

**Solución:** patrón lease.

```sql
-- Tomar evento (solo si nadie lo está procesando o el lease venció)
UPDATE evento_pg
SET procesando_por = $worker_id,
    procesando_hasta = NOW() + INTERVAL '5 minutes',
    estado = 'EN_PROCESO'
WHERE id = (
  SELECT id FROM evento_pg
  WHERE estado IN ('NUEVO', 'IDENTIFICADO')
    AND (procesando_por IS NULL OR procesando_hasta < NOW())
    AND deleted_at IS NULL
  ORDER BY prioridad ASC, ts_creado ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

**`FOR UPDATE SKIP LOCKED`** = atómico. Si worker muere a media → lease expira en 5 min → otro worker lo toma.

---

## 27. Política de retry y dead-letter

**Si un agente falla:**
1. Reintentar 3 veces con backoff exponencial (5s, 30s, 2min).
2. Si las 3 fallan → mover a `evento_pg.estado = 'ERROR'` + insertar en `dead_letter_queue` con stack trace.
3. Panel "Errores" del Visor muestra dead-letter con botón "Reintentar manualmente".
4. **Alerta automática a Jhon** si dead-letter crece a >10 eventos en 1h.

---

## 28. Manejo de chats grupales de WhatsApp

**Problema:** un grupo con cliente + arquitecto + administrador ≠ una persona.

**Solución:**
- Tabla `chats` distingue `tipo='individual'` o `tipo='grupo'`.
- Para grupos: cada mensaje en el grupo se ata al **emisor real** (jid del autor) → resolver `persona_id` por autor, NO por chat.
- El `proyecto_id` puede ser único compartido entre todos los miembros del grupo (ej: "instalación apto Pedro" donde participa el arquitecto).
- Panel del Visor muestra el grupo como timeline con autores diferenciados.
- Anti-contaminación: agente que procesa mensaje del arquitecto NO ve memoria personal de Pedro (filtra por `persona_id` del autor del mensaje).

---

## 29. Merge de personas duplicadas

**Problema:** Identidad crea Pedro1 y Pedro2; tarde se descubre que son la misma persona.

**Solución:**
- Panel del Visor "Fusionar personas".
- Selecciona Pedro1 (sobrevive) + Pedro2 (se fusiona).
- `UPDATE evento_pg SET persona_id = pedro1.id WHERE persona_id = pedro2.id`
- `UPDATE proyectos, inmuebles, ...` igual
- `INSERT INTO personas_merge_log` con razón
- `DELETE FROM personas WHERE id = pedro2.id` (soft delete: `deleted_at = NOW()`)
- Reversible 30 días.

---

## 30. Borrado / "olvidar" un cliente

**Problema:** GDPR-light. Familiar/cliente pide ser olvidado.

**Solución:**
- Panel "Olvidar persona" con confirmación doble.
- Soft delete inicial (30 días).
- Después de 30 días: `HARD DELETE` cascada de `evento_pg`, `personas`, `chats`, `mediciones`, `cotizaciones`, etc.
- Backup separado se purga también después de 30 días.
- Auditoría: log de "fue olvidado" sobrevive (sin datos personales) para compliance.

**Caso especial ámbito `personal_*`:** opción "olvidar" con purga inmediata sin esperar 30 días.

---

## 31. SLA del primer mensaje de cliente nuevo

**Por qué crítico:** primer mensaje = mayor probabilidad de cierre comercial.

**Implementación:**
- Cuando Identidad detecta persona NUEVA en ámbito `comercial`:
  - Marca evento con `tipo='primer_contacto'` + `prioridad=2`.
  - Inicia timer SLA: 15 min en horario hábil (lun-sáb 8-18h), 12h fuera.
  - Si Jhon no responde antes del SLA → notificación push (sección 32) "ALERTA: cliente nuevo sin respuesta".
- Dashboard Comercial muestra SLA cumplidos / incumplidos.

---

# PARTE IV — RESILIENCIA Y OPERACIÓN

## 32. Notificaciones push al celular

**Problema:** Junior es asistente personal, pero sin notificaciones push, Jhon tiene que abrir el Visor para enterarse.

**Solución:**
- **Web Push API** desde el Visor (suscripción del navegador en celular).
- **WhatsApp self** (mandar al WhatsApp del propio Jhon: `+57 322 366 3825` desde un número alterno o un webhook).
- Triggers de notificación:
  - Cliente nuevo sin respuesta (SLA vencido)
  - Garantía sensible nueva
  - Pago confirmado por validar
  - Dead-letter > 10 eventos
  - Junior detecta urgencia (mensaje con palabras clave)

**MVP:** Web Push primero (gratis). WhatsApp self después.

---

## 33. Modo offline-degradado

**Problema:** la luz se va en Girardot. El Visor depende de Supabase (online).

**Solución:**
- Service Worker del Visor cachea últimos 50 clientes activos en IndexedDB.
- Si Supabase no responde:
  - Banner amarillo: "Modo offline. Mostrando datos de hace X horas."
  - Visor lee de IndexedDB.
  - Botones de escritura quedan deshabilitados con mensaje claro.
- Cuando vuelve internet: re-sync automático.

**Extensión Chrome:** sigue capturando localmente (ya guarda en IndexedDB). Cuando vuelve internet → sync con Supabase.

---

## 34. Sincronización backwards desde CRM Zonal

**Problema:** alguien edita en CRM Zonal directamente (ej: contadora corrige factura). El Visor no se entera.

**Solución (cuando CRM tenga API):**
- CRM Zonal expone webhook que dispara en cada cambio.
- Endpoint del Visor (`/webhooks/crm`) recibe el cambio.
- Crea `evento_pg` con `canal='crm_zonal'` + `tipo_evento='cambio_externo'`.
- Agentes correspondientes re-procesan contexto si aplica.
- Vista del Visor se actualiza vía Realtime.

---

## 35. Backups automáticos y restauración probada

**Sin esto, un error mata el proyecto.**

- Supabase Pro tiene backup diario automático (point-in-time recovery 7 días).
- Adicional: cron diario que dump-ea Supabase a Storage (S3-compatible) → retención 90 días.
- **Procedimiento de restauración escrito y PROBADO una vez** antes de meter datos reales.
- Documento: `docs/PROCEDIMIENTO_RESTAURACION.md`.

---

## 36. Costo estimado real (presupuesto API)

**Estimación inicial conservadora:**

| Item | Cantidad mes | Costo unit | Total/mes |
|---|---|---|---|
| Mensajes WA procesados | 3000 | $0.0005 | $1.50 |
| Inferencias agentes (5 por mensaje) | 15000 | $0.0007 | $10.50 |
| Junior queries | 100 | $0.005 | $0.50 |
| Biblioteca queries | 200 | $0.001 | $0.20 |
| **TOTAL estimado** | | | **~$13/mes** |

**Topes hard:**
- Por invocación de agente: `$0.05`
- Diario total: `$5` (configurable). Si se excede → todos los agentes pausan + alerta.
- Antes de correr proceso masivo: estimar `N × $0.002` y reportar a Jhon.

**Métricas en vivo:** dashboard del Visor muestra costo del día / semana / mes.

---

# PARTE V — REGLAS Y DISCIPLINA

## 37. Patrones que NO usamos y por qué

| Patrón | Por qué NO |
|---|---|
| Supervisor único orquestador (llamadas directas) | Acoplamiento alto. Reemplazado por Gerente de POLÍTICAS (BD config) + EVENTO_PG. |
| Llamadas directas entre agentes | Si A5 llama a A8, modificar A8 rompe A5. SOLO `evento_pg`. |
| LLM para todo | Si se puede con código (fechas, agrupar, sumar) → NO se le pide al LLM. |
| Procesamiento automático sin autorización | El v1 viejo escribía 24/7 → llenaba tablas con basura. Nuevo procesa SOLO con autorización. |
| Construir paralelo sin migrar | v1 + v3 conviviendo causaron caos. Solo UN sistema activo a la vez. |
| Mezclar capas (captura+procesamiento+UI en un módulo) | Cada capa tiene un solo propósito. |
| Tablas viejas en paneles nuevos | Cada panel apunta a UNA fuente clara. |
| Botones para arreglar el botón anterior | Si algo no funciona, se rediseña. NO se parcha. |
| Debounce / batching / polling sin pedirlo | "Tiempo real" = Realtime puro. Polling solo como red de seguridad. |

---

## 38. Reglas duras del negocio

### R-001: Cierre real = primer abono validado por humano
"Cliente dijo sí" sin abono ≠ ganada. Es `INTENCION_CIERRE`. Solo abono confirmado por humano marca `GANADA`.

### R-002: Validación humana obligatoria
Toda variación con impacto en dinero, producción, instalación, garantía, facturación, responsabilidad técnica, inventario, saldo, descuento, medida final REQUIERE validación humana antes de cruzar al CRM.

### R-003: Matching cotización↔factura es señal AUXILIAR
Por monto/fecha = INFERIDO. Nunca verdad automática.

### R-004: Vigencia cotizaciones
- Manual: 15 días
- Motorizado / domótica: 7 días
- Especiales: por definir

### R-005: % abono mínimo
- Sin abono confirmado → NO inicia producción
- Manual: 50/50
- Motorizado: 50/40/10
- Especial: por definir

### R-006: Garantías por categoría
- Tela, motor, herrajes, instalación: 12 meses
- Cadenillas / películas: por definir

### R-007: SLA WhatsApp
- Lun-sáb 8AM-6PM: 5-15 min
- Fuera de horario: misma noche o día siguiente antes 10AM

### R-008: Zonas instalación
- Girardot urbano + Ricaurte: incluido
- Melgar: depende
- Bogotá / otras: especial con costos

### R-009: Validación abono
- Foto sola del comprobante NO es CONFIRMADO
- Estado: `pendiente_validacion` → `confirmado` (validación humana o financiera)

### R-010: Cambios post-producción
Permitidos PERO con costo si material está cortado/ensamblado/personalizado.

### R-011: Cancelación
NO devolución completa una vez: material cortado / producción iniciada / pedido especial / motorización / personalización.

### R-012: Tiempos típicos
- Cotización post-medición: mismo día / 24-48h
- Producción manual: 4-8 días
- Producción motorizado: 8-15 días
- Instalación: 1-5 días

### R-013: Reglas de validación adicionales
1. Medidas dadas por cliente → bandera `RIESGO_MEDICION_CLIENTE` automática
2. Blackout en zonas sociales → advertir reflejos TV, sensación encierro
3. Screen solar → priorizar salas, balcones, fachadas calientes
4. Sheer poliéster → NO recomendar en clima caliente Girardot/Melgar para premium
5. Medidas: 4 tipos (suministrada_cliente / validada_empresa / final_produccion / instalada)
6. Cliente recurrente o recomendado → sube prioridad
7. Postventa crítica > venta nueva si afecta reputación
8. Cliente silencioso ≠ cliente perdido
9. Instalación completa ≠ proyecto cerrado (capacitación, ajustes, programación motores)
10. Garantía cerrada ≠ cliente satisfecho

### R-anti-contaminación
- Output de agente que mencione OTRO cliente distinto al actual → RECHAZADO automáticamente
- Memoria local de un cliente NUNCA se cruza a otro
- Memoria global cross-cliente: SIN nombres, SIN datos personales

### R-anti-alucinación
- Toda inferencia DEBE citar evidencia (msg_id, documento_id, evento_id)
- Si no hay evidencia → confianza=DUDOSO o `tipo='pregunta_humano'`
- NUNCA inventar montos, fechas, nombres para llenar campos

### R-costo
- Cada invocación LLM declara su tope de costo
- Si excede → aborta con error claro
- Tope diario configurable por Jhon
- Métricas de costo por agente / por chat visibles en tiempo real

---

## 39. Stack técnico

### Frontend Visor
- **React 18 + TypeScript strict** (sin `any` salvo casos extremos justificados)
- **Vite** (dev server, build)
- **Supabase JS client** (BD + Realtime + Storage)
- **CSS inline** (consistencia, simple, sin frameworks pesados)
- **Service Worker + IndexedDB** (modo offline, sección 33)

### Backend agentes
- **Node + TypeScript** (workers independientes, uno por agente)
- **tsx** para ejecución sin compilación
- **DeepSeek API** (`deepseek-chat`) — cost-effective vs OpenAI
- **Supabase Realtime** para notificaciones cross-módulo
- Migración futura a **Supabase Edge Functions (Deno)** cuando escalemos. La interfaz `evento_pg` ya está, no rompe nada.

### Base de datos
- **Supabase NUEVO proyecto** (PostgreSQL + Realtime + Storage)
- BD del proyecto viejo se borra cuando este esté funcional

### Extensión Chrome
- Reusamos la actual (`C:\Proyectos\WhatsApp_Captura_Safra\`)
- Copiada al folder `extension/` del proyecto nuevo
- Único cambio: apuntar al Supabase NUEVO

### Comunicación entre módulos
- **`evento_pg` en BD + Realtime de Supabase**
- NUNCA llamadas HTTP directas entre módulos del mismo proyecto

### Tests
- **Smoke tests** por módulo (sin gasto API)
- **Tests E2E con Puppeteer** para validación visual del Visor
- **Tests de anti-contaminación automáticos** en CI

---

## 40. Estructura del repositorio

```
C:\Proyectos\Visor_PG\
│
├── VISION.md                  ← copia EXACTA del documento de Jhon (NO se modifica)
├── ARQUITECTURA.md            ← este documento (se actualiza con cada decisión)
├── MAPA.md                    ← progreso fase por fase (se actualiza diario)
├── abrir_visor_pg.bat         ← shortcut para abrir Claude Code en este proyecto
│
├── extension/                 ← Extensión Chrome (copia limpia, apunta a Supabase nuevo)
│
├── visor/                     ← Frontend React + Vite + TS
│   ├── src/
│   │   ├── App.tsx
│   │   ├── panels/            ← módulos visuales (los 11 del doc de visión)
│   │   ├── ui/                ← componentes reutilizables
│   │   ├── lib/
│   │   │   ├── supabase.ts    ← cliente único
│   │   │   ├── realtime.ts    ← suscripciones
│   │   │   └── offline.ts     ← service worker + cache
│   │   └── hooks/
│   ├── public/
│   ├── package.json
│   └── vite.config.ts
│
├── adapters/                  ← Adapter por canal (entrada de información)
│   ├── adapter_whatsapp.ts    ← consume de la extensión, escribe evento_pg
│   ├── adapter_web.ts         ← futuro
│   ├── adapter_email.ts       ← futuro
│   ├── adapter_audio.ts       ← futuro
│   ├── adapter_proveedor.ts   ← futuro
│   └── adapter_ia_externa.ts  ← futuro
│
├── identidad/                 ← Servicio de Identidad (L1)
│   ├── matcher.ts             ← algoritmo de cascada
│   ├── clasificador_ambito.ts ← propone ámbito al detectar chat nuevo
│   ├── merge.ts               ← merge de personas duplicadas (sección 29)
│   └── tests/
│
├── extractor/                 ← Extractor objetivo (L1.5)
│   ├── extractor_telefonos.ts
│   ├── extractor_fechas.ts
│   ├── extractor_medidas.ts
│   ├── extractor_montos.ts
│   └── extractor_productos.ts
│
├── agentes/                   ← Enjambres especializados por ámbito (L2)
│   ├── lib/
│   │   ├── runner.ts          ← orquestador genérico (Capa 0)
│   │   ├── llm.ts             ← cliente DeepSeek con retry/timeout/costo
│   │   ├── memoria.ts         ← memoria DUAL local/global
│   │   └── validador.ts       ← anti-alucinación + anti-contaminación
│   ├── skeleton/
│   │   ├── tipos.ts
│   │   ├── reglas_duras.ts
│   │   └── motor_feedback.ts
│   ├── comercial/
│   │   ├── A1_identidad_cliente.ts
│   │   ├── A5_cotizaciones.ts
│   │   └── ...
│   ├── proveedor/
│   ├── familia/
│   ├── equipo_interno/
│   └── junior/                ← asistente personal de Jhon (multi-ámbito)
│
├── supervision/               ← L4: supervisor pasivo + gerente coordinador
│   ├── supervisor_metricas.ts
│   ├── gerente_politicas.ts
│   └── alertas.ts
│
├── integraciones/             ← Clientes hacia sistemas externos
│   ├── crm_zonal.ts           ← cuando tenga API
│   ├── biblioteca_rag.ts      ← localhost:5500
│   └── notificaciones_push.ts ← Web Push + WhatsApp self
│
├── workers/                   ← Procesos Node de fondo
│   ├── worker_identidad.ts
│   ├── worker_extractor.ts
│   ├── worker_agentes.ts
│   └── worker_supervisor.ts
│
├── supabase/
│   ├── migrations/            ← schemas SQL versionados
│   └── seed.sql               ← datos base (ámbitos, agentes_definicion)
│
├── tests/
│   ├── e2e/                   ← Puppeteer tests del Visor
│   ├── anti_contaminacion/    ← Tests automáticos cross-cliente y cross-ámbito
│   └── smoke/                 ← Smoke tests sin gasto API
│
└── docs/
    ├── DECISIONES.md          ← log de decisiones grandes con motivo
    ├── ESTRUCTURA_BD.md       ← schemas explicados en lenguaje humano
    ├── LECCIONES_PROYECTO_VIEJO.md  ← qué NO repetir
    ├── PROCEDIMIENTO_RESTAURACION.md ← cómo restaurar de backup
    └── SUPABASE.md            ← credenciales del Supabase nuevo (NO commit)
```

---

## 41. Los 11 módulos del Visor (orden de construcción)

| # | Módulo | Submódulos clave | Status |
|---|---|---|---|
| 1 | **Núcleo base** | Bandeja WhatsApp · Identidad · Inmueble · Proyecto · Timeline · evento_pg · Buzón validación | **PRÓXIMO** |
| 2 | Comerciales | Cotizaciones · Comparador · Objeciones · Seguimiento · Referidos · Recompra | — |
| 3 | Financieros | Facturación · Abonos · Matching cot↔factura · Log variaciones · Rentabilidad | — |
| 4 | Técnicos | Medidas · Riesgo · Producto · Advertencias · Compatibilidad · Biblioteca conectada | — |
| 5 | Operativos | Producción · Instalaciones · Agenda · Rutas · Tareas · Checklist · Entrega | — |
| 6 | Postventa | Garantías · Mantenimientos · Satisfacción · Google Reviews · Reclamos sensibles | — |
| 7 | Evidencias | Archivo documental · Evidencia por evento · Transcripción audio · Captura en vivo | — |
| 8 | Agentes | Panel · Extractor · Medidas · Pagos · Cotizaciones · Garantías · Auditor · Gerente · Junior | — |
| 9 | Control y seguridad | Permisos · Auditoría humana · Correcciones · Alertas contradicción · Privacidad · Confianza dato | — |
| 10 | Gerencial (Centro de Control) | Dashboards: comercial · operativo · financiero · errores · desgaste · productos · reputación | — |
| 11 | Núcleo crítico | evento_pg · Buzón · Timeline · Medidas · Cotización ganadora · Log variaciones · Abonos · Evidencias · Visitas · Garantías causa raíz · Junior · Auditoría agentes · Desgaste | — |

**Regla:** NO empezamos un módulo sin haber completado el anterior con tests pasando.

---

## 42. Roadmap de evolución

### Fase 1 (mes 1-2): MVP comercial
- MÓDULO 1 (núcleo) + WhatsApp adapter + agentes comerciales básicos (A1, A5, A6, A8, A9)
- Junior básico con acceso a ámbito comercial

### Fase 2 (mes 3-4): Cobertura comercial completa
- MÓDULOS 2-5 (Comerciales, Financieros, Técnicos, Operativos)
- Buzón de validación robusto

### Fase 3 (mes 5-6): Postventa + Evidencias + Centro de Control
- MÓDULOS 6, 7, 10
- Conexión Biblioteca RAG operativa

### Fase 4 (mes 6+): Multi-ámbito real
- Adapter Web (formularios)
- Adapter Email
- Ámbito proveedor + agentes proveedor
- Ámbito familia + agentes familia
- Ámbito equipo_interno

### Fase 5 (mes 9+): Cross-empresa
- Adapter Audio en tiempo real
- Adapter IA externa
- App móvil para Junior

### Fase 6 (mes 12+): Escalado infraestructural
- Agentes migran a Supabase Edge Functions
- Sharding si volumen lo requiere
- Multi-tenant (si abrimos a otras fábricas)

---

## 43. Tres Supabase distintos en el ecosistema

**RIESGO REAL: confundir credenciales y borrar BD equivocada.**

| Project ref | URL | Usado por |
|---|---|---|
| `olububjdvboiqgmihsmk` | `https://olububjdvboiqgmihsmk.supabase.co` | **WhatsApp_Captura_Safra_Visor (proyecto VIEJO)**, Bibliotecario_Safra, Agente_Junior_Wasap |
| `dnsyyvtznkllneyuopoa` | `https://dnsyyvtznkllneyuopoa.supabase.co` | Sandbox_Enjambre_Precios, Agente_Biblioteca_RAG, Agente_Agenda, Gestor_Precios_Juno, web-cortinas-girardot |
| **`<por crear>`** | `https://<por_crear>.supabase.co` | **Visor_PG (este proyecto)** |

**Antes de aplicar migraciones:** verificar `VITE_SUPABASE_URL` del proyecto. Cada `.env` apunta a UNO solo.

**El CLAUDE.md global menciona `dnsyyvtznkllneyuopoa` como "Supabase compartido" — eso es histórico. Visor_PG va a tener el suyo propio.**

---

## 44. Decisiones de arquitectura (registro)

### 2026-05-07 — Decisiones fundacionales

| # | Decisión | Motivo |
|---|---|---|
| 1 | Proyecto nuevo desde cero (`Visor_PG`) | v1+v3 mezclados causaron caos imposible de revertir |
| 2 | Reusar extensión Chrome (no reescribir) | HKDF + descifrado costaron meses |
| 3 | Supabase NUEVO (proyecto aparte) | Actual tiene basura del v1 + tablas v3 a medio hacer |
| 4 | CRM Zonal y Biblioteca RAG SEPARADOS | Doc de visión los define independientes |
| 5 | Multi-ámbito desde el diseño | Clientes + familia + proveedores + equipo |
| 6 | EVENTO_PG como columna vertebral | Event Sourcing → desacoplamiento total |
| 7 | 6+1 niveles desacoplados (L0-L5, +L1.5 Extractor) | Cada nivel cambia sin romper los demás |
| 8 | Gerente como coordinador de POLÍTICAS, no orquestador | Reconcilia doc del escritorio (sección 8.8) con Event Sourcing |
| 9 | Servicio de Identidad como módulo TS (no Edge Function) | Más simple inicial. Migrable después |
| 10 | Junior con interfaz API desde día 1 | Cuando hagamos app móvil, consume misma API |
| 11 | Empezamos con `comercial` + `personal_otros` (catch-all) | MVP enfocado |
| 12 | Construcción modular: 1 módulo terminado antes del siguiente | Disciplina anti-caos |
| 13 | Tests E2E + anti-contaminación obligatorios | Sin tests, no está listo |
| 14 | DeepSeek como LLM principal | Costo 10× menor que GPT-4 |
| 15 | CQRS ligero (vistas materializadas) | Visor instantáneo aunque haya millones de eventos |
| 16 | Modo shadow para agentes nuevos (7 días) | Cero riesgo de corromper datos al activar |
| 17 | Hot reload de prompts (BD + historial) | Edición sin reiniciar workers |
| 18 | Soft delete + papelera 30 días | Anti-error humano |
| 19 | Lock con lease (`FOR UPDATE SKIP LOCKED`) | Concurrencia de workers |
| 20 | Cola priorizada por `evento_pg.prioridad` | Latencia donde importa |
| 21 | Modo "explicación" en cada inferencia del buzón | Anti-caja-negra, aumenta confianza de Jhon |
| 22 | Notificaciones push (Web Push + WhatsApp self) | Junior sin push no es asistente real |
| 23 | Modo offline-degradado con Service Worker | La luz se va en Girardot |
| 24 | Tope hard de costo: $0.05/invocación, $5/día | "Ojo con el cobro api" |
| 25 | Backups + restauración probada UNA vez antes de datos reales | Sin esto, un error mata el proyecto |
| 26 | **Política de procesamiento IA en 4 capas separadas** (sección 46-52, PARTE VI) | Captura ≠ procesamiento IA. Distinguir gratis (captura, identidad, extractor) de caro (agentes LLM). Control granular |
| 27 | **NO existe botón "Procesar todos los chats"** (R-IA-001) | Anti-quema-saldo. Cada chat procesado es decisión consciente |
| 28 | **Histórico siempre manual single-shot con estimación de costo** (R-IA-002) | Jhon ve costo antes de gastar |
| 29 | **Modo ON tiempo real**: auto-autoriza chats nuevos + procesa histórico completo (A1) | Junior necesita contexto fresco; manual cada autorización destruye la utilidad de Junior |
| 30 | **Tope diario es blando** (alerta, NO kill switch) (R-IA-006) | "Se garantiza que se sigan procesando, solo es cuestión de aumentar el tope a medida que la empresa crece" — Jhon |
| 31 | **Junior monitorea costo con proyección útil** (B3) | Avisa "vas $X, al ritmo terminás en $Y, ¿subo el tope?" — útil, no ruido |
| 32 | **Modo ON aplica a TODOS los ámbitos** (C1, incluso familia) | Operación en vivo unificada. Para excluir: bloquear el chat individual |
| 33 | **Bloqueo manual por chat** (E1) — independiente del bloqueo de WhatsApp | Válvula de escape para spam/ruido. Mensaje sigue capturándose, solo NO se procesa con IA |
| 34 | **Procesar manual auto-autoriza para tiempo real** (R-IA-004) | "Si lo procesaste manual es porque te importa, queda vivo cuando actives ON" |
| 35 | **2026-05-08: simplificación a 3 capas (era 4)** | "Sync a Supabase" deja de existir como capa separada con whitelist. Ahora la captura es 100% local automática y "Procesar" = subir + IA en un click. El whitelist se elimina como concepto |
| 36 | **2026-05-08: módulo "Captura" separado de M1 "Núcleo"** | Captura = vista de los datos locales (extensión IndexedDB) con stats robustos + Procesar/Bloquear. M1 Núcleo = solo chats ya procesados. Tu doc original mezclaba ambos en sub-tab 1.1 |
| 37 | **2026-05-08: bloqueo persiste en Supabase `chats_bloqueados`** | Sobrevive reinstalación de extensión. Tabla pequeña (solo `jid + motivo + ts`), no requiere subir mensajes |
| 38 | **2026-05-08: detector regex de "candidato a NO-cliente"** | Patrones (restaurante, transporte, spam financiero, encuesta, broadcast) marcan chats sospechosos con badge naranja para evitar procesar irrelevancias |
| 39 | **2026-05-08: API extensión↔Visor vía `chrome.runtime.onMessageExternal`** | Endpoints V3_PING, V3_LIST_CHATS, V3_GET_MESSAGES, V3_PROCESS_CHAT, V3_BLOCK_CHAT, V3_UNBLOCK_CHAT, V3_LIST_BLOQUEADOS. El Visor llama vía `chrome.runtime.sendMessage(extId, msg, cb)` |
| 40 | **2026-05-08 F2.1: Capa 0 agentes** (`agentes/lib/{llm,openai,validador,runner}.ts`) | Cliente DeepSeek con tope hard $0.05/inv y retry exponencial; cliente OpenAI Whisper+Vision con cache SHA-256; validador con vocabulario controlado + anti-alucinación + anti-contaminación + reglas duras R-001/R-009/R-013#1; runner con hooks (`cargarContexto`, `construirPrompt`, `validarOutputEspecifico`, `postProcesar`) y modo shadow obligatorio |
| 41 | **2026-05-08 F2.2: Extractor objetivo (L1.5)** corre en worker polling | 14 patrones regex (telefono, email, cedula, nit, direccion, conjunto/torre/apto, medida, monto, fecha, sistema_safra, codigo_cotizacion, url, horario). Cada extracción produce `evento_pg.tipo_evento='dato_extraido'` con confianza CONFIRMADO/INFERIDO/DUDOSO según patrón. Marca `mensajes.metadata.extractor_done=true` para idempotencia. **$0 costo.** Refinado tras smoke (medidas con rango 0.3-8m, montos con señal monetaria, fechas 2020-2030): -45% falsos positivos |
| 42 | **2026-05-08 F2.3: transcripción de media corre en la EXTENSIÓN, NO en el Visor** (sección 47.1) | Razones: la extensión ya descifra HKDF/AES y guarda blobs en IndexedDB con cache SHA-256. Mover bytes a Supabase Storage para procesarlos en un worker del Visor sería gasto y complejidad innecesarios. Mismo modelo del proyecto viejo |
| 43 | **2026-05-08 F2.3: bug raíz `procesarChat()` bypaseaba IA** | El botón "Procesar" subía mensajes raw a Supabase pero NUNCA invocaba `processMediaWithAI()`. Por eso `metadata.ai_text=null` en TODOS los media de los 4 chats reales (26 audios + 48 imágenes). Solución: dejar `procesarChat()` rápido (texto only) + acción separada `transcribirMediaChat()` con confirmación de costo |
| 44 | **2026-05-08 F2.3: reglas duras hardcoded en `clasificarMediaChat`** (heredadas del proyecto viejo) | status@broadcast nunca, sticker nunca, forwarded_many_times nunca, video nunca, **burst >10 imágenes/(chat,rol,minuto)** nunca, document que no sea PDF nunca. Cache: `media.ai_status='processed'` se omite |
| 45 | **2026-05-08 F2.3: read-modify-write del JSONB metadata** | PostgREST no soporta `jsonb_set` vía API. La extensión hace GET + PATCH por mensaje para preservar `internal_id`/`type_original`/etc al agregar `ai_text`/`ai_kind`/`ai_status`. Borra `extractor_done` para forzar re-extracción ahora que hay texto IA real (no thumbnail base64) |
| 46 | **2026-05-08 F2.3.B: Visor empuja keys a la extensión vía `V3_SET_KEYS`** | Elimina el popup manual heredado del proyecto viejo donde Jhon tenía que pegar API keys a mano. El `.env` del Visor es ahora la única fuente de verdad. Variables expuestas al bundle: `VITE_SUPABASE_ANON_KEY`, `VITE_OPENAI_API_KEY`, `VITE_DEEPSEEK_API_KEY` |
| 47 | **2026-05-08 F2.3.B: regla operativa "recargá la extensión"** | Chrome MV3 no recarga extensiones automáticamente al cambiar archivos. Cada vez que Claude modifique `extension/*.js`, avisa a Jhon con la frase fija "🔄 Recargá la extensión" antes de pedirle probar. Cambios al Visor (Vite HMR) NO requieren acción |

---

## 45. Disciplina de desarrollo

### Reglas que el desarrollador (Claude) DEBE cumplir

1. **Mockup primero, backend después.** Cada módulo arranca con mockup visual con datos fake → Jhon valida UX → después yo construyo backend que llene esa UI con datos reales.
2. **Jhon NO revisa SQL/schemas/configs/código backend.** Solo valida lo que VE en pantalla. Si necesito que aplique algo en Supabase (porque solo él tiene la cuenta), le doy instrucciones mínimas de copy-paste.
3. **Cada módulo tiene test E2E real** (Puppeteer, no solo TS check). Sin test, no está listo.
4. **Construir secuencial, no paralelo.** Módulo terminado completo antes de empezar el siguiente.
5. **Aprender del proyecto viejo:** usar como referencia (qué funcionó, qué no), NO como base de copia.
6. **Si me trabo 30 min sin avanzar, parar y preguntar.** NO parchar.
7. **Documentar cada decisión** en `MAPA.md` (qué se hizo, por qué, qué quedó pendiente).
8. **NO romper lo que funciona** para construir lo nuevo. Si lo nuevo requiere romper, parar y consultar.
9. **Costo API visible y controlado** en cada acción. Tope hard.
10. **Disculparse y rectificar** cuando se rompe algo, sin defensa.
11. **"Tiempo real" = Realtime puro.** NO inventar debounce/batching/polling. Si creo que una optimización agrega valor, la PROPONGO antes de implementarla.
12. **Antes de declarar terminado:** correr tests, verificar visualmente, documentar en MAPA.md.

### Cómo retomar si se va la luz

1. Leer `README.md` → contexto del proyecto: qué es, por qué existe, qué se reusa del viejo, qué se descartó, cómo trabajar (5 min).
2. Leer `VISION.md` → entender el qué y el porqué del producto (15-20 min).
3. Leer `ARQUITECTURA.md` → entender cómo se construye técnicamente (30-40 min).
4. Leer `MAPA.md` → ver dónde quedamos y qué falta (5-10 min).
5. Continuar desde la última fase abierta en `MAPA.md`.
6. Si hay duda de criterio → consultar con Jhon antes de actuar.

---

# PARTE VI — POLÍTICA DE PROCESAMIENTO IA

> **CRÍTICO.** Esta parte define cómo se gasta dinero en el sistema. Todo agente IA, todo worker que invoque LLM, toda automatización debe respetarla. Decidida con Jhon el 2026-05-07.

---

## 46. Las 3 capas separadas de costo

> **Cambio 2026-05-08**: el modelo original tenía 4 capas (la 2 era "sync a Supabase" controlada por whitelist).
> Después de probar con Jhon, se simplificó a **3 capas**: la captura local incluye todo automáticamente,
> y el "sync a Supabase + procesar IA" pasa a ser **una sola acción** disparada manualmente con un click ("Procesar"). El concepto de "whitelist" de la extensión se elimina.

El sistema distingue **3 capas independientes**, cada una con su política de costo:

| # | Capa | Qué hace | Dónde viven los datos | Costo | Quién decide |
|---|---|---|---|---|---|
| 1 | **Captura local** | Extensión Chrome lee de WhatsApp Web → IndexedDB del browser | **Local** (extensión) | **$0** | Automático, TODOS los chats |
| 2 | **Procesar (manual)** | Click "Procesar" en módulo Captura → sube ese chat a Supabase + identidad + agentes IA | Supabase | **$$$** | **Manual** con confirmación de costo |
| 3 | **Tiempo real** | Mensajes nuevos a chats YA procesados se sincronizan/procesan automáticamente | Supabase | **$$$** | **Toggle global ON/OFF** |

**Bloqueo (válvula de escape):** chat marcado como bloqueado nunca pasa de Capa 1. El bloqueo persiste en Supabase (tabla `chats_bloqueados`) aunque la extensión se reinstale.

**Identidad y Extractor objetivo (L1, L1.5)** corren cuando un chat pasa por Capa 2. Costo $0 (regex/queries, sin LLM).

**Lo que SÍ cuesta:** invocaciones a DeepSeek hechas por agentes en L2 sobre los mensajes ya en Supabase.

**Identidad (L1) y Extractor objetivo (L1.5) NO entran acá** — son matching y regex, costo $0. Corren siempre.

**Lo que SÍ cuesta:** invocaciones a DeepSeek (o GPT-4 si se usa) hechas por agentes en L2 (cotizaciones, medidas, comerciales, garantías, postventa, etc.).

---

## 47. Modo OFF — control manual estricto (default hoy)

**Estado actual del sistema mientras la empresa no necesite tiempo real:**

- Toggle global "Tiempo real" en **OFF**.
- Los agentes IA (L2) NO se ejecutan automáticamente sobre nada.
- Único disparador: botón **"Procesar"** en el módulo **Captura** (NO en M1 Núcleo — M1 solo muestra lo ya procesado).

### Flujo del botón "Procesar"
1. En el módulo **Captura** ves todos los 500+ chats que la extensión sniffeó (locales en IndexedDB).
2. Click en uno → ves los mensajes (también locales).
3. Click en "▶ Procesar" → modal con:
   - # mensajes total + breakdown por tipo (texto / audio / imagen / video / documento)
   - **Costo estimado** del procesamiento
   - Tope diario actual y disponible
   - Si el chat tiene `no_cliente_score >= 2` → advertencia "posible NO-cliente, ¿estás seguro?"
4. Vos confirmás → la extensión sube TODOS los mensajes a Supabase (`chats` + `mensajes` + `evento_pg` con `estado=NUEVO`) e identidad/agentes los procesan.
5. Tras procesar exitosamente, ese chat queda **autorizado para tiempo real automáticamente** (cuando prendas modo ON, se incluye).

### Reglas
- **NO existe botón "Procesar TODOS los chats".** Lo prohibimos explícitamente. Cada chat es decisión consciente.
- Si un chat tiene 5000 mensajes históricos, se estima el costo y se confirma. No hay límite técnico, hay límite de tu cartera.
- Si te equivocás y procesás uno que no querías → soft delete del proyecto. Los datos quedan disponibles 30 días por si los necesitás.

---

## 47.1 Transcripción de media — la extensión hace IA, NO el Visor (decisión 2026-05-08, F2.3)

**Decisión arquitectónica clave:** la transcripción de audios (Whisper), descripción de imágenes (Vision) y resumen de PDFs (gpt-4o-mini con recorte de 2 páginas) corre **dentro de la extensión Chrome**, NO en un worker del Visor.

### Por qué
- La extensión ya descifra HKDF/AES de WhatsApp y guarda los blobs en IndexedDB local (`media_blobs`).
- Si el Visor lo hiciera, habría que mover bytes binarios a Supabase Storage primero — gasto innecesario.
- El cache SHA-256 ya está implementado en la extensión (`media_processed`): si el mismo archivo aparece en otro chat, no se re-cobra.
- Mismo modelo del proyecto viejo, ya validado.

### Bug raíz que motivó el split

`extension_api.js:procesarChat()` (botón "Procesar" en M0 Captura) **bypaseaba el pipeline IA**: subía mensajes raw a Supabase y marcaba `ia_historico_procesado=true`, pero NUNCA invocaba Whisper/Vision/PDF. Por eso 26 audios + 48 imágenes en BD tenían `metadata.ai_text = null`.

### Solución: dos acciones separadas

| Botón | Dónde | Qué hace | Costo |
|---|---|---|---|
| ▶ **Procesar** | M0 Captura | Sube mensajes a Supabase, identifica persona/proyecto, dispara extractor regex (L1.5). NO toca media. | $0 (texto only, regex) |
| 🎙 **Transcribir media** | M1.6 Transcripciones | Por chat: descarga (si falta) → Whisper / Vision / PDF con cache SHA-256 → UPDATE Supabase con `texto = '🎤 …' / '🖼 [Imagen] …' / '📎 … — RESUMEN: …'` y `metadata.ai_*` | $0.001–$0.05 por chat según volumen |

### Flujo "Transcribir media"

1. M1.6 muestra banner "X chats con media pendiente" agrupado por chat con counts.
2. Click en chat → llama `V3_ESTIMATE_CHAT_MEDIA(jid)` → modal con desglose:
   - Whisper $0.006/min × duración total audios
   - Vision $0.0008/imagen (gpt-4o-mini detail:'low')
   - PDF $0.005/doc (gpt-4o-mini, primeras 2 páginas)
   - Sección "Omitidos por reglas duras" (sin costo)
3. Confirmar → llama `V3_TRANSCRIBE_CHAT_MEDIA(jid)` → la extensión:
   - Pool 3 paralelos
   - Para cada media: descarga (si no tiene `sha256`), `processMediaWithAI()` con cache hit / miss, UPDATE Supabase
   - Read-modify-write del JSONB `metadata` para preservar `internal_id`, `type_original`, etc. Borra `extractor_done` para forzar re-extracción ahora que hay texto real (no thumbnail base64).
4. Modal de progreso, luego refetch de la lista.

### Reglas duras heredadas del proyecto viejo (hardcoded en `clasificarMediaChat`)

NO consultables, son políticas de seguridad/costo:

| Regla | Acción | Razón |
|---|---|---|
| `chat_id` contiene `status@broadcast` | Omitir | Historias de WA, ruido masivo |
| `type === 'sticker'` | Omitir | Sin valor IA, gasto puro |
| `is_forwarded_many_times === true` | Omitir | Reenviado masivo, basura típica |
| `type === 'video'` | Omitir | Whisper no acepta MP4 nativo, Vision no resume video |
| `type === 'image'` y >10 en mismo (chat, rol, minuto) | Omitir las que pasen de 10 | Burst limit anti-spam (subido de 3 a 10 para clientes que mandan ráfagas legítimas de fotos del espacio) |
| `type === 'document'` con mimetype !== `application/pdf` | Omitir | Solo PDF se resume |
| `media.ai_status === 'processed'` | Omitir (cache) | Ya transcrito en corrida anterior |

### Cache SHA-256 (cross-chat dedup)

El cache vive en `media_processed` del IndexedDB de la extensión, indexado por SHA-256 del archivo descifrado. Si el mismo audio/imagen aparece en otro chat (reenvío, duplicado), `processMediaWithAI()` hace cache hit y devuelve el texto sin volver a llamar a OpenAI. **Costo $0 en re-procesamientos.**

### Concurrencia

- `MAX_DOWNLOAD_CONCURRENCY = 6` (descargas son gratis, CDN de WhatsApp)
- `MAX_AI_CONCURRENCY = 3` (no toca rate limit de OpenAI)
- `MAX_ATTEMPTS = 5` con backoff exponencial 2s × 2^n

### Edge case: URL del CDN expirada

WhatsApp borra los archivos del CDN tras ~17 días sin actividad. Si `downloadAndDecryptMedia()` falla con `URL expirada` o `HTTP 410`, la extensión llama a `refreshMediaViaContent()` que pide al content script (en la pestaña de WA Web) que use `Store.Msg.downloadMedia()` para refrescar la URL. Requiere que la pestaña de WhatsApp Web esté abierta y autenticada.

### 3 motivos de fallo distintos en transcripción (decisión F2.3.C, 2026-05-08)

Cuando un media procesable falla, la extensión clasifica el motivo en uno de 3 buckets y lo persiste en Supabase para que la UI lo distinga claramente. **NO mezclar "irrecuperable" con "pendiente":**

| Motivo | Detección | `metadata` resultante | UI Transcripciones |
|---|---|---|---|
| **Irrecuperable CDN** | `downloadAndDecryptMedia` falla con `expirada/HTTP/HMAC` Y `refreshMediaViaContent` también falla | `download_status='lost'`, `download_motivo='cdn_expirado'`, `ai_status='skipped_cdn_lost'`, texto reemplazado por placeholder `🎤/🖼/📎 [No recuperable de WhatsApp · CDN expiró tras >17d]` | 💀 No recuperable (CDN expiró) — gris oscuro |
| **Error temporal** | Mensaje matchea `/timeout|rate.?limit|429|503|ECONNRESET|fetch failed/i` | `ai_status='error_temporal'`, `ai_error=...`, texto NO se modifica | ⚠️ Error temporal (reintentar) — naranja |
| **Error inesperado** | Cualquier otro fallo no clasificado | `ai_status='error_inesperado'`, `ai_error=...`, texto NO se modifica | ❌ Error inesperado — rojo |

**Stats devueltos por `transcribirMediaChat`:**
- `irrecuperables_cdn: number` — total marcados como perdidos
- `errores_temporales: number` — reintentables
- `errores: number` — errores inesperados (bugs reales)
- `errores_inesperados_detalle: [{msg_id, kind, error}]` — para debug

**KPIs y banner aclaratorio** en M1.6 Transcripciones explican cada motivo con su acción recomendada (no recuperable = aceptar, temporal = reintentar más tarde, inesperado = reportar/debuggear).

**Garantía clave:** un media marcado como `irrecuperable_cdn` ya no aparecerá como "pendiente de transcribir" en futuras corridas. La cobertura IA del chat se calcula sobre `total - no_aplica - irrecuperables` (denominador real procesable).

### Endpoints (extensión `extension_api.js`)

```
V3_ESTIMATE_CHAT_MEDIA  { jid }       → { procesables: {audios, imagenes, pdfs},
                                          omitidos: {sticker, status_broadcast, ...},
                                          costo_estimado_usd, desglose_costos,
                                          duracion_audio_seg }

V3_TRANSCRIBE_CHAT_MEDIA { jid }      → { ok, stats: {audios, imagenes, pdfs,
                                          errores, cache_hits, no_existentes_en_supabase,
                                          omitidos_total, detalle_omitidos, chat_id_db} }

V3_SET_KEYS { supabaseKey,            → { ok, tiene_supabase, tiene_openai, tiene_deepseek }
              openaiKey,                  (sync de credenciales desde el Visor;
              deepseekKey }                elimina el popup manual heredado)
```

### Sincronización de credenciales — sin popup manual (decisión 2026-05-08 F2.3.B)

**Fuente única de verdad:** `.env` del Visor. Variables:
- `VITE_SUPABASE_ANON_KEY` — pública por diseño (lleva el Visor cliente)
- `VITE_OPENAI_API_KEY` — necesaria para que el Visor empuje a la extensión
- `VITE_DEEPSEEK_API_KEY` — idem para futuros agentes en la extensión

**Flujo:**
1. Vite carga `.env` → expone `import.meta.env.VITE_*` al bundle
2. `chequearExtension()` (cliente del Visor) hace ping y, si conecta, llama a `sincronizarKeysExtension()` en background
3. `sincronizarKeysExtension()` envía `V3_SET_KEYS` con las 3 keys
4. La extensión hace merge en `chrome.storage.local['ws_settings']` (no sobrescribe keys ausentes con vacío)
5. `getSettings()` ya las lee de ahí, sin cambios

**Consecuencia para Jhon:** nunca más tiene que abrir el popup de la extensión a pegar API keys. El Visor las propaga sólo. El popup viejo queda como fallback opcional (puede borrarse en una pasada de limpieza posterior).

### Regla operativa: cuando se modifica código de la extensión

Chrome MV3 NO recarga automáticamente las extensiones cuando cambian sus archivos. Esto es una limitación de seguridad del browser, no algo del proyecto.

**Cada vez que Claude modifica `extension/*.js`, debe avisar a Jhon con esta frase fija ANTES de pedirle probar:**

> 🔄 **Recargá la extensión:** `chrome://extensions/` → tarjeta "Visor PG" → click en ↻

Esto pasa pocas veces porque la mayoría del trabajo es en el Visor (React + Vite con hot reload automático). Pero cuando pasa, Claude lo flagea explícito.

Cambios al Visor (`visor/src/**`) NO requieren acción de Jhon — Vite recarga solo en localhost:5173.

### Tests garantizados (2026-05-08)

- 17/17 tests funcionales: lógica `clasificarMediaChat` con casos sintéticos + Whisper real (audio TTS Windows, transcribió "Hola, quiero cotizar Blackout para una sala de 3 por 2.40. Es para Girardot.") + Vision real (PNG comprobante, extrajo monto/cuenta/referencia/fecha) + UPDATE Supabase con read-modify-write y revert.
- 21/22 tests E2E con Puppeteer attached al Chrome corriendo en puerto 9222 con la extensión cargada en Modo Desarrollador. Verificó cache SHA-256 (11 hits en 2da corrida, $0 OpenAI). Cleanup completo. El "fallo" único fue threshold mío de "3x más rápida" (salió 2.8x, los UPDATE Supabase son el bottleneck — la cache IA funciona perfecto).

---

## 48. Modo ON — tiempo real automático

**Cuando empieces a operar en vivo (Junior funcionando, gestión activa):**

Toggle global "Tiempo real" en **ON**. A partir de ese momento:

### Comportamiento automático
- **Cualquier mensaje nuevo** que entre por cualquier canal y cualquier ámbito **se procesa con IA en tiempo real** (latencia <5 seg).
- Si el chat **NO estaba autorizado previamente** y es la primera vez que recibe mensaje en modo ON:
  - Se **auto-autoriza** sin pedir confirmación.
  - Se procesa el mensaje nuevo + **TODO su histórico** (independiente del tamaño — A1 confirmado por Jhon).
  - Es decir: el chat "nace en vivo" con contexto completo para que Junior pueda responder informado.
- Aplica a **TODOS los ámbitos** (`comercial`, `proveedor`, `personal_familia`, `personal_amigos`, `personal_otros`, `interno_equipo`) — C1 confirmado por Jhon.
  - **Excepción:** chats en lista de bloqueo (sección 49) NUNCA se procesan, ni siquiera en modo ON.

### Por qué se acepta el costo
Junior es asistente personal en tiempo real. Si tiene que esperar a autorización manual de cada chat, no funciona. El costo se justifica porque la operación lo absorbe.

### Cuándo prendés ON
- **Hoy: NO.** Estás cuidando saldo.
- **Cuando el negocio justifique el costo** (más cierres, más volumen, Junior dando ROI claro). Decisión de Jhon, no automática.

---

## 49. Bloqueo de chats (válvula de escape)

**Independiente del bloqueo de WhatsApp.** Bloquear un chat acá NO bloquea en WhatsApp Web ni viceversa.

### Qué hace el bloqueo
- Chat marcado como bloqueado: **JAMÁS se procesa con IA**. NO sube a Supabase aunque hagas click en "Procesar".
- Captura local sí continúa (queda en IndexedDB de la extensión, costo $0).
- El chat aparece en módulo **Captura** con badge "🚫 bloqueado" y el botón "Procesar" se reemplaza por "Desbloquear".

### Persistencia (decisión 2026-05-08, opción 2)
- El bloqueo se guarda en Supabase tabla **`chats_bloqueados`** (no solo local).
- Sobrevive a reinstalaciones de la extensión, factory reset del browser, etc.
- Schema: `(canal, canal_chat_id, titulo_snapshot, motivo, bloqueado_por, bloqueado_at, desbloqueado_at, desbloqueado_por, desbloqueado_motivo)`. UNIQUE `(canal, canal_chat_id)`.
- La extensión consulta esta tabla con cache de 60s.

### Cómo se bloquea (E1 confirmado)
- Botón "🚫 Bloquear" en cada chat del módulo Captura.
- Motivo obligatorio (si el chat tiene `no_cliente_tags` detectados, se pre-llena).

### Quién se bloquea
- F1 confirmado: solo chats que ya existen en IndexedDB local. No hay lista negra preventiva de teléfonos que aún no escribieron.

### Casos de uso típicos
- Spam recurrente, fitness, financiero
- Restaurantes / domicilios (Guacal Girardot caso real detectado por regex `no_cliente`)
- Ex-clientes ruidosos sin intención comercial
- Conocidos casuales (vecinos, etc.)
- Encuestas, transporte, broadcasts

---

## 50. Schema y configuración

### Tablas (cuando lleguemos a MÓDULO 8)

```sql
-- Extender tabla `chats` existente
ALTER TABLE chats ADD COLUMN ia_autorizado          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chats ADD COLUMN ia_historico_procesado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chats ADD COLUMN ia_bloqueado           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chats ADD COLUMN ia_bloqueado_motivo    TEXT;
ALTER TABLE chats ADD COLUMN ia_bloqueado_at        TIMESTAMPTZ;
ALTER TABLE chats ADD COLUMN ia_bloqueado_por       BIGINT REFERENCES usuarios(id);

-- Configuración global (extender configuracion_sistema existente)
INSERT INTO configuracion_sistema (clave, valor, descripcion) VALUES
  ('ia_modo_global', '"OFF"', 'Toggle global: "OFF" o "ON". Cuando ON, se procesan todos los mensajes nuevos de chats no bloqueados'),
  ('ia_tope_diario_alerta_usd', '5.00', 'Tope diario blando. Al superarlo, Junior alerta pero el procesamiento NO se detiene (B3 — solo alerta)'),
  ('ia_tope_diario_proyeccion_horas', '24', 'Junior usa esta ventana para proyectar gasto del día');

-- Tabla nueva: log de auto-autorizaciones (para auditar)
CREATE TABLE ia_auto_autorizaciones (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES chats(id),
  evento_disparador_id BIGINT REFERENCES evento_pg(id),
  mensajes_historicos_procesados INTEGER,
  costo_total_usd NUMERIC(10,6),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tabla nueva: alertas de costo de Junior
CREATE TABLE ia_alertas_costo (
  id BIGSERIAL PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('tope_superado', 'proyeccion_alta', 'auto_autorizacion_grande')),
  costo_actual_usd NUMERIC(10,6),
  proyeccion_dia_usd NUMERIC(10,6),
  mensaje TEXT NOT NULL,
  vista_por_jhon BOOLEAN NOT NULL DEFAULT false,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Estados posibles de un chat (combinaciones)

| `ia_bloqueado` | `ia_autorizado` | `ia_historico_procesado` | Comportamiento |
|---|---|---|---|
| true | * | * | **NUNCA procesa**, ni en modo ON |
| false | false | false | Default. Solo procesa si Jhon hace click "Procesar este chat" |
| false | true | false | Autorizado, histórico no procesado todavía. Si modo ON: procesa histórico + nuevos |
| false | true | true | Histórico ya procesado. Si modo ON: procesa solo nuevos |

---

## 51. Junior como guardián del costo

Junior NO solo responde consultas — también **monitorea costo y avisa con proyección útil** (B3 confirmado).

### Cuándo Junior te alerta
1. **Tope diario superado** (>$5):
   - Mensaje único: *"Tope de $5 superado. Vas $X.XX. Sigo procesando como definimos."*
2. **Proyección preocupante** (basada en velocidad del día):
   - Si en las primeras 4 horas del día se gastó >25% del tope:
   - Mensaje: *"Llevas $X.XX en 4 horas. Al ritmo actual terminás el día en $Y.YY (Z× el tope). ¿Subo el tope a $Y.YY o seguimos así?"*
3. **Auto-autorización grande** (chat nuevo con >500 mensajes históricos):
   - Mensaje: *"Cliente nuevo NN escribió. Tiene 1200 mensajes históricos. Procesarlos cuesta ~$X.XX. Sigo o pauso?"*

### Cómo te avisa
- Mensaje en el panel **Centro de Control** (badge rojo en sidebar)
- Notificación push (Web Push) — sección 32 del doc
- Cuando esté la integración con WhatsApp self: mensaje al WhatsApp de Jhon

### Lo que Junior NO hace
- **NO sube el tope automáticamente.** Solo propone, decisión es tuya.
- **NO detiene el procesamiento.** Sigue procesando incluso superando el tope (B3).

---

## 52. Reglas duras de costo (R-IA-001 a R-IA-007)

Estas reglas se suman a las del negocio (R-001 a R-013) y son inamovibles:

### R-IA-001: NO existe procesamiento masivo
Prohibido cualquier botón o función que procese >1 chat en una sola acción del usuario sin estimación previa por chat.

### R-IA-002: Estimación obligatoria antes de procesar histórico
Todo "Procesar este chat" muestra modal con: # mensajes, # que requieren IA, costo estimado, tope disponible. Sin confirmación explícita NO procesa.

### R-IA-003: Modo ON auto-autoriza, modo OFF no
- Modo OFF: chat nuevo NO se procesa hasta acción manual.
- Modo ON: chat nuevo se auto-autoriza al recibir primer mensaje + se procesa histórico completo (A1).

### R-IA-004: Procesar manual = autorizar para tiempo real
Cuando procesás manual un chat (modo OFF), ese chat queda con `ia_autorizado=true`. Si después prendés modo ON, sus mensajes nuevos se procesan automáticamente. Lógica: "si lo procesaste manual es porque te importa, queda vivo en tiempo real cuando actives".

### R-IA-005: Bloqueo es opt-out absoluto
`ia_bloqueado=true` → cero procesamiento IA, sin importar ningún otro flag, sin importar modo ON.

### R-IA-006: Tope diario es BLANDO (alerta, no apaga)
Tope diario = umbral de alerta de Junior, NO kill switch. El procesamiento sigue siempre. Decisión de Jhon: *"se garantiza que se sigan procesando, solo es cuestión de aumentar el tope a medida que la empresa crece"*.

### R-IA-007: Auto-autorización SIEMPRE genera log
Cada vez que un chat pasa de no-autorizado a autorizado (sea manual o por modo ON), inserta fila en `ia_auto_autorizaciones` con costo y mensajes procesados. Auditable para que vos veas "qué se autorizó solo y cuánto costó".

---

**Estado actual del sistema (2026-05-07):**
- Modo: OFF (no hay agentes IA todavía — vendrán en MÓDULO 2)
- Tope: $5/día (configurable)
- Workers actuales: solo Identidad y futuro Extractor objetivo, ambos $0
- Implementación de modo ON / botón "Procesar" / bloqueo: **MÓDULO 8 (Agentes)**
- Hasta entonces el costo real es $0

---

**FIN DEL DOCUMENTO. Este archivo se actualiza cuando se toma una decisión de arquitectura nueva o se cambia una existente. Toda actualización deja una entrada en la sección "Decisiones de arquitectura (registro)".**
