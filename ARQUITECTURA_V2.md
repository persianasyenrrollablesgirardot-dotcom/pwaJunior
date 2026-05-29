# ARQUITECTURA V2 — Visor PG (propuesta, sin construir aún)

> **Estado:** APROBADA (2026-05-28) — en construcción. Las 5 decisiones abiertas fueron validadas por Jhon.
> **Fecha:** 2026-05-28
> **Decisión tomada por Jhon:** priorizar resultados óptimos + optimización (detección de cambio), asumiendo el gasto adicional.
> **Qué reemplaza:** el modelo actual donde **Junior hace todo** (responde + crea + corrige + agenda + cierra + completa) cargando el contexto de TODOS los clientes en cada llamada.

Jhon valida el **concepto y la experiencia**. La parte de tablas/SQL la maneja Claude (ver Apéndice técnico al final — no necesitás revisarlo).

---

## 1. Por qué V2 (el problema que resuelve)

Diagnóstico real del sistema actual (medido, no supuesto):

1. **Junior carga TODO en cada turno** — vimos `in=41.036 tokens`: mete el contexto de los ~75 chats en cada prompt. El LLM pierde el detalle puntual en el ruido → alucina, es lento y caro.
2. **Junior hace demasiado en un solo JSON** — responder + crear clientes + corregir + agendar + cerrar checklist + completar tareas. Los guards anti-mentira y anti-ráfaga son **parches sobre un agente sobrecargado**.
3. **Bug de `chat_id`** (arreglado el 2026-05-28): Junior emitía el id equivocado por contexto ambiguo → "cerrá el caso" nunca cerró nada vía Junior.
4. **El "bloqueo"**: el worker drena el backlog al arrancar antes de activar el ciclo de Junior, así que el chat queda congelado.

**La causa común:** un solo agente lee todo y escribe todo. V2 separa **leer/sintetizar** de **derivar acciones** de **conversar**.

---

## 2. Principios de diseño

1. **La tarjeta es la única fuente de contexto por chat** (una "vista materializada"). Junior y los agentes leen UNA tarjeta, no 75.
2. **Ensamblar, no resumir.** El agregador copia los hechos estructurados de los 32 agentes **verbatim**; el LLM solo redacta una narrativa corta de "estado general". Lo estructurado no se reescribe → no se alucina.
3. **Cada agente, un solo trabajo.** Menos superficie de error, más barato, debuggeable.
4. **Recuperar-y-razonar, no cargar-y-razonar.** Junior consulta con filtros y sube al LLM solo las 2-3 tarjetas relevantes.
5. **Notas humanas = verdad.** Los agentes las leen ANTES de inferir y nunca las sobrescriben.
6. **Flujo unidireccional con detección de cambio.** Sin loops, sin trabajo redundante (hash por nivel).
7. **Jhon solo habla con Junior.** Junior orquesta; nunca es el dueño de la verdad.

---

## 3. Los componentes

### 3.1 La TARJETA (una por chat)
El corazón del sistema. Contiene:
- **Tipo de contacto:** comercial / familiar / proveedor / publicitario / desconocido.
- **Contexto estructurado:** los hechos por módulo (m1..m8) tal cual los dejaron los 32 agentes — verbatim.
- **Notas libres:** lo que escribís vos (manual o vía Junior). Verdad prioritaria.
- **Narrativa "estado general":** un párrafo corto redactado por el agregador (única parte LLM).
- **Hash de input + versión:** para no recalcular si nada cambió.

### 3.2 El AGREGADOR (1 agente — el que mantiene la tarjeta)
- **Se dispara cuando:** entra un mensaje de WhatsApp (ya extraído por los 32) **o** ingresa una nota libre.
- **Hace:** ensambla el contexto estructurado (determinístico) + redacta la narrativa (1 llamada LLM corta) + calcula el hash.
- **Si el hash no cambió → no hace nada** (idempotente: ahorra plata y evita que el LLM "derive" sin motivo).
- **Si cambió →** escribe la tarjeta y marca los 3 agentes derivados como "por actualizar".
- **NO** escribe en checklist/tareas/agenda. Solo mantiene la tarjeta.

### 3.3 Los TRES agentes estratégicos (derivados)
Cada uno **lee solo su tarjeta** y **escribe en su propia tabla** (nunca en la tarjeta → sin loops):

| Agente | Qué produce | Estados / salida |
|---|---|---|
| **Checklist** | Estado conversacional de la tarjeta | `cerrado` · `espera_jhon` · `espera_cliente` · `sin_responder` |
| **Tareas** | Tareas detectadas en la tarjeta | títulos, tipo, vencimiento, prioridad |
| **Agendamiento** | Qué agendar + calendario | fecha, hora, tipo de visita, calendario actualizado |

> **Corrección importante a tu enum:** separamos **tipo de contacto** (familiar/proveedor/publicitario/comercial) — que vive en la TARJETA — del **estado de conversación** (cerrado/espera/etc.) — que vive en el checklist. Son cosas distintas: un proveedor también puede estar "esperando que conteste". Mezclarlos en una sola lista da problemas.

> **Híbrido reglas + LLM:** parte del trabajo es determinístico (detectar una fecha, ver que falta cobrar el saldo). Esos casos van por reglas; el LLM solo entra para lo ambiguo. Menos costo, menos alucinación.

### 3.4 JUNIOR (interfaz delgada — con quien hablás vos)
- Ya **no** carga todo ni ejecuta acciones masivas.
- **Herramientas** (consulta la BD, no un prompt gigante): ver una tarjeta, listar tarjetas por filtro (tipo/estado), ver tareas, ver agenda, **agregar una nota**.
- Para responder "¿quién espera mi respuesta?" → consulta la tabla de checklist con filtro y sube al LLM solo lo relevante.
- Cuando escribís (o Junior escribe en tu nombre) una **nota** → vuelve a disparar al agregador.
- Al dejar de hacer acciones en lote, **los guards anti-ráfaga dejan de hacer falta**.

---

## 4. El flujo completo (DAG)

```
 WhatsApp entrante ──► [32 agentes extraen] ──┐
                                              ├──► marca TARJETA "por actualizar"
 Nota libre (vos manual / vía Junior) ────────┘
                          │
                          ▼
                   [AGREGADOR]   (coalescing de ráfaga: 1 vez por ventana corta)
                   calcula hash del input
                   ¿cambió?
                    ├── no → STOP (idempotente, no gasta)
                    └── sí → escribe TARJETA + marca los 3 derivados
                          │
            ┌─────────────┼─────────────┐
            ▼             ▼             ▼
       [CHECKLIST]    [TAREAS]    [AGENDAMIENTO]
       compara su hash con el de la tarjeta;
       si igual → STOP; si cambió → re-deriva y escribe SU tabla
            └─────────────┴─────────────┘
                  (no re-disparan al agregador → SIN LOOP)

 JHON ⇄ JUNIOR  ──► consulta tarjeta + 3 tablas (con filtros) ──► responde
                └─► agregar_nota ──► vuelve al tope del DAG
```

**Detección de cambio (la optimización que priorizaste):** hash en dos niveles (tarjeta y cada derivado). Una ráfaga de 12 mensajes en un chat genera **1** re-agregado, no 12. Esto baja el costo a ~1/3 **y** reduce las oportunidades de que el LLM alucine.

**Garantía anti-loop:** los derivados escriben en sus tablas, nunca en la tarjeta; el flujo es unidireccional; el hash hace cada paso idempotente.

---

## 5. Qué se conserva y qué se jubila

**Se conserva:**
- Los prompts de los 32 agentes (funcionan bien en su módulo).
- El principio "nota/corrección humana = verdad prioritaria".
- El Event Sourcing en `evento_pg` y el modelo de lease del worker.

**Se jubila:**
- La emisión monolítica de acciones de Junior (el JSON gigante con 11 arrays).
- Los guards anti-mentira / anti-ráfaga (mayormente innecesarios cuando Junior no actúa en lote).
- La síntesis M1–M7 como paso separado → la **absorbe la tarjeta**.

**Lecciones que se codifican (lo que pediste extraer del comportamiento alucinatorio):**
- Verificar que el id/registro **existe** antes de actuar (el bug de chat_id).
- No reportar como hecho lo que no se escribió en BD (lección anti-mentira).
- Los agentes reciben ids **explícitos y verificados**, nunca los adivinan de un texto.

---

## 6. Costo (con la optimización, ya validado por Jhon)

- **Por actualización de tarjeta** (agregador + 3 derivados): ~$0.013–0.015 USD.
- **Con detección de cambio (modo elegido):** ~$0.8 USD/día en día pico → **~$23 USD/mes (~92.000 COP)**.
- **Aumento neto** sobre el sistema actual (descontando Junior pesado + síntesis M1–M7 que se reemplazan): **~$30–50 USD/mes (~120.000–200.000 COP/mes)**, aceptado.
- Stack sigue en **DeepSeek** (barato). Cambiar de modelo multiplicaría 10–20×.

---

## 7. Plan de construcción (VERTICAL primero, validado por Jhon)

> **Lección aplicada:** validar en vertical, no en horizontal. Una tarjeta completa de punta a punta con datos reales **antes** de escalar a las 75. El riesgo de un rediseño grande es construir las 4 fases y descubrir al final que el concepto no calza.

**Hito 0 — Mockup** (en curso). Tarjeta con datos fake → validás la experiencia.
*Listo cuando:* Jhon dice "sí me sirve".

**Hito 1 — Rebanada vertical sobre UN cliente real (Pedidos Cubides).** Tablas + agregador + los 3 derivados (mínimos) + Junior leyendo esa única tarjeta. Todo end-to-end, con datos reales de un solo chat.
*Listo cuando:* la tarjeta real se arma bien · los 3 derivados salen coherentes · Junior la responde · hay test por **LLM real** sobre fixture · costo/latencia dentro de presupuesto · **Jhon valida la rebanada completa**.

**Hito 2 — Escalar y endurecer a las 75 tarjetas.** Triggers realtime (`evento_pg` + `nota_tarjeta`), coalescing 30s, hash idempotente, backfill de tarjetas existentes, derivados completos (todos los estados, híbrido reglas+LLM).
*Listo cuando:* las 75 tarjetas se mantienen solas y el costo/latencia entra en presupuesto.

**Hito 3 — Junior delgado completo.** Todas las tools de consulta + `agregar_nota`, recuperar-y-razonar (no cargar todo). Test por LLM real.
*Listo cuando:* Junior responde preguntas cruzadas sin cargar todo y Jhon lo valida.

**Hito 4 — Corte.** Jubilar el JSON monolítico de Junior + los guards. El Junior viejo queda en **git como respaldo** (NO se corre en paralelo). Validación final de Jhon.

---

## 8. Decisiones tomadas (validadas por Jhon 2026-05-28)

1. **Tipo de contacto vs estado de conversación: SEPARADOS.** `tipo_contacto` vive en la tarjeta; `estado_conversacion` en el checklist.
2. **Agentes derivados: HÍBRIDOS** (reglas para lo determinístico + LLM solo para lo ambiguo).
3. **Ventana de coalescing: 30s.** El agregador re-arma a lo sumo una vez cada 30s por tarjeta tras una ráfaga.
4. **Notas vía Junior: DIRECTAS.** Entran sin confirmación previa (corrección post-hoc, coherente con la filosofía del Visor).
5. **Datos históricos: NO se borran.** Los casos que nunca cerraron por el bug los reclasifica el checklist nuevo. Sin limpieza destructiva.

---

## 9. Reglas de construcción (lecciones de la experiencia — vinculantes)

Sacadas de lo que se rompió en este proyecto. Aplican a TODOS los hitos.

1. **El riesgo está en las costuras, no en los agentes.** Todos los bugs (cascada con id equivocado, revert incompleto, worker que bloquea a Junior, ARRAY que no verificaba) estuvieron en las uniones. El diseño y los tests se concentran en los **contratos** (qué id recibe cada agente, cuándo se dispara, qué escribe).
2. **Ningún "verde" cuenta si no pasó por el LLM real.** Cada agente lleva un test de fixture que pasa por DeepSeek. Los determinísticos validan mecánica, no comportamiento. *(El test determinístico de cascada estuvo verde días mientras la función estaba rota.)*
3. **Regla del tercer guard.** Si un agente empieza a necesitar guards anti-X, es señal de sobrecarga. Al **tercer** guard se frena y se revisa el contrato; no se agrega un cuarto. *(Junior acumuló anti-mentira + anti-ráfaga + anti-loop = era el síntoma.)*
4. **Toda red de seguridad se prueba.** Si hay "deshacer"/rollback, se testea con la misma seriedad que la función. Sin test, se asume rota. *(El revert tenía un hueco y nadie lo sabía.)*
5. **Diagnosticar antes de tocar.** El síntoma casi nunca es la causa. *("Junior bloqueado" no era Junior, era el drenado de arranque del worker.)*
6. **Refactor, no rewrite.** Se conservan los 32 agentes, el event sourcing y "nota humana = verdad". Solo cambia la costura de orquestación. Reescribir los agentes es la trampa del tercer borrón y cuenta nueva.
7. **Costo y latencia = presupuesto de diseño.** Cada hito mide costo/turno y latencia; si se pasan, es un problema de diseño que se arregla en el hito, no "después".

---

## Apéndice técnico (Claude — no requiere validación de Jhon)

Modelo de datos tentativo:
- `tarjeta(chat_id PK, persona_id, tipo_contacto, contexto_estructurado JSONB, narrativa TEXT, input_hash, version, generado_at, actualizado_at, dirty)`
- `nota_tarjeta(id, chat_id, autor[jhon_manual|jhon_via_junior|sistema], texto, vigente, created_at)` — insertar marca `tarjeta.dirty`
- `checklist_tarjeta(chat_id, estado_conversacion, proximo_paso, compromisos JSONB, derivado_de_hash, actualizado_at)`
- `tarea(... , derivado_de_hash, origen)` y `agendamiento(... , derivado_de_hash, calendario)` — derivadas, escritas solo por su agente.

Triggers: realtime/postgres_changes sobre `evento_pg` (mensaje extraído) y sobre `nota_tarjeta` → marcan `tarjeta.dirty`. El agregador procesa tarjetas dirty con coalescing. Cada derivado compara `derivado_de_hash` contra `tarjeta.input_hash`.
