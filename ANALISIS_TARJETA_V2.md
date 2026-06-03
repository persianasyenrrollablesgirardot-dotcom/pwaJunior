# Análisis de bugs — Módulo Tarjeta V2 (flujo de cierre + retroalimentación)

**Corrida autónoma iniciada:** 2026-05-31 · SOLO LECTURA (no se modifica nada).
**Pista de Jhon:** deja notas para "cerrar casos" y NO se cierran; y eso NO se refleja en los módulos de Junior al retroalimentar checklist, tareas ni agendamientos.

## Índice de progreso
- [x] Flujo nota → cierre (cascada, derivarChecklist) ✅ (ciclo 1) — CAUSA RAÍZ ENCONTRADA
- [x] Desincronización chat_checklist vs tarjeta_checklist ✅ (ciclo 1)
- [x] Retroalimentación a tarjeta_checklist / tarjeta_tarea / tarjeta_agenda ✅ (ciclo 2)
- [x] Cómo Junior lee/refleja las tarjetas ✅ (ciclo 2)
- [x] Otros bugs del módulo (refresco) ✅ (ciclo 3)
- [x] Resumen priorizado final ✅ (ciclo 3) — **LOOP COMPLETO**

## Hipótesis inicial (a verificar)
`cascadaCierreChecklist` (cascada.ts) cierra **`chat_checklist`** (estado='cerrada'). Pero TarjetaV2 muestra **`tarjeta_checklist.estado_conversacion`** (otra tabla, la llena `derivarChecklist` desde la tarjeta). Posible desincronización: el cierre actualiza una tabla y la UI lee otra.

---

## Hallazgos

### 🔴 ALTO (causa raíz de la pista) — la cascada de cierre quedó HUÉRFANA
- `cascadaCierreChecklist` (cascada.ts) es lo que cierra de verdad: `chat_checklist.estado='cerrada'` + `cerrado_manual=true` + **completa todas las tareas** de la persona + **cancela todos los agendamientos** futuros. Funciona bien.
- **PERO su único disparador (`cierresChecklist`) vive dentro de `cicloJuniorChat`** (worker líneas 709-717 detectan "cerré/cierro checklist / caso cerrado"; línea 1099 corre la cascada).
- **`JUNIOR_VIEJO_ACTIVO = false`** (worker línea 629) → `cicloJuniorChat` NO se agenda (línea 1272) → **la cascada NUNCA se dispara.**
- **Confirmado con datos:** de 16 personas con nota de cierre, `cerrado_manual=true` en **solo 1**. Las notas de cierre NO completan tareas ni cancelan agendamientos.
- **= exactamente la pista de Jhon:** "dejo notas de cerrar casos y no se cierran; no se refleja en checklist/tareas/agendamientos". El mecanismo de cierre se retiró con el Junior viejo y **no se reemplazó en el flujo V2**.
- **Recomendación:** crear un disparador V2 de cierre que detecte la nota ("cerrá/cerrado/listo/terminado/spam") y llame a `cascadaCierreChecklist` (ya existe). Engancharlo en `guardarNota`/`cicloTarjetas` o como un mini-ciclo en el worker. NO depender del Junior viejo.

### 🔴 ALTO — desincronización de 3 checklists
- **`tarjeta_checklist.estado_conversacion`** (lo que muestra TarjetaV2) lo llena `derivarChecklist` desde la tarjeta (narrativa+notas, vía LLM).
- **`chat_checklist.estado`** (viejo) lo cierra la cascada (huérfana) → casi nunca se actualiza.
- **No coinciden.** Ejemplos reales: chat 92 `chat_checklist='sin_responder'` vs `tarjeta='cerrado'`; chat 135 `chat_checklist='te_toca'` vs `tarjeta='cerrado'`. Junior y otros módulos pueden leer la tabla desactualizada.
- **Recomendación:** una sola fuente de verdad del cierre, o que el cierre sincronice ambas + dispare la cascada en un solo punto.

### 🟡 MEDIO — derivarChecklist interpreta la nota de cierre por LLM (inconsistente)
- `derivarChecklist` SÍ tiene la regla "Jhon dejó nota de cierre → cerrado" (derivados.ts línea 46), pero depende del LLM. Falla en casos claros: persona 145 *"ya se cerró negocio"* quedó `espera_jhon`; persona 170 quedó `espera_cliente`. → notas de cierre que ni siquiera cierran el checklist V2.
- Además, aunque cierre `tarjeta_checklist`, **NO ejecuta la cascada** (tareas/agendamientos quedan vivos). El cierre visual del checklist V2 ≠ cierre real del caso.
- **Recomendación:** pre-detectar notas de cierre con regex (determinístico) antes/además del LLM, y que ese cierre dispare la cascada.

### 🔴 ALTO — los derivados (tareas/agenda) NO respetan el cierre del checklist
- Los 3 derivados corren en **paralelo** (`Promise.all([derivarChecklist, derivarTareas, derivarAgenda])` en tarjeta_engine), **independientes**. `derivarChecklist` puede marcar `estado_conversacion='cerrado'`, pero `derivarTareas`/`derivarAgenda` regeneran tareas/agenda de la misma tarjeta **sin saber del cierre**.
- **Confirmado con datos:** de **54** tarjetas con checklist `cerrado`, **12 todavía tienen tareas activas** (y 1 agenda). Ejemplos absurdos: chat 92 cerrado con tarea *"Cerrar cliente sin actividad"*; chat 109 cerrado con *"Retirar a Henry Parra de las listas"*; chat 176 (Pedro) cerrado con 2 tareas + 1 agenda.
- **Junior V2 lee `tarjeta_checklist` + `tarjeta_tarea` + `agendamientos`** (junior_v2.ts) → refleja esas tareas/agenda activas pese al cierre. Por eso "no se refleja bien en Junior".
- **Recomendación:** correr `derivarChecklist` PRIMERO y, si da `cerrado`, forzar `tareas=[]`/`agenda=[]` (o pasarle el estado a los otros dos derivados). Idealmente, el cierre real (cascada) también limpia `tarjeta_tarea`/`tarjeta_agenda`, no solo `tareas`/`agendamientos` (tablas viejas).

### 🟢 VERIFICADO OK (no es bug) — el refresco funciona
- tarjetas `dirty=true`: **0** · personas `sintesis_pendiente=true`: **0** · tarjetas con nota más nueva que su reconstrucción: **0**. El front (TarjetaV2) auto-refresca cada 5s (`cargarLista`/`cargarDerivados`). → **las notas SÍ se reflejan** en la reconstrucción de la tarjeta. El problema NO es de refresco ni de que las notas no impacten: es puramente el **cierre** (cascada + derivados). Descartado este frente.

---

# 🏁 RESUMEN FINAL PRIORIZADO

**La pista de Jhon tiene 3 causas combinadas**, todas en el flujo de CIERRE (no en el refresco, que funciona):

## 🔴 ALTO
1. **La cascada de cierre quedó huérfana.** `cascadaCierreChecklist` (cierra `chat_checklist` + completa tareas + cancela agendamientos) solo se dispara desde `cicloJuniorChat`, que NO corre (`JUNIOR_VIEJO_ACTIVO=false`). Al retirar el Junior viejo, no se puso reemplazo en V2. → notas de cierre no cierran nada. Confirmado: `cerrado_manual=true` 1/16.
2. **Los derivados ignoran el cierre.** `derivarTareas`/`derivarAgenda` corren en paralelo a `derivarChecklist`, sin saber si quedó `cerrado`. Confirmado: 54 casos `cerrado`, 12 con tareas activas (hasta *"Cerrar cliente"* en uno ya cerrado).
3. **Desincronización de 3 checklists:** `tarjeta_checklist` (V2, lo que se ve) ≠ `chat_checklist` (viejo) ≠ tareas/agenda. No hay una única fuente de verdad del cierre.

## 🟡 MEDIO
4. **derivarChecklist cierra por LLM** (inconsistente): notas claras de cierre quedaron `espera_jhon`/`espera_cliente` (persona 145, 170).
5. **La cascada limpia tablas VIEJAS** (`tareas`/`agendamientos`), no las V2 (`tarjeta_tarea`/`tarjeta_agenda`) que muestra la tarjeta.

## ✅ Descartado (funciona)
- Refresco de tarjetas, propagación de notas, auto-refresh del front.

## Solución integral recomendada (un solo punto de cierre)
Crear un **disparador de cierre V2** (mini-ciclo en el worker o en `guardarNota`) que reemplace al del Junior viejo:
1. **Detectar la nota de cierre con regex determinístico** (`cerr|cerrado|listo|terminado|finaliz|spam|ya se atendió|dar de baja`) — no depender solo del LLM.
2. Llamar `cascadaCierreChecklist` (ya existe y funciona).
3. **Sincronizar las 3 capas:** poner `tarjeta_checklist.estado_conversacion='cerrado'` + vaciar `tarjeta_tarea`/`tarjeta_agenda` (V2) además de `tareas`/`agendamientos` (viejas).
4. Que `derivarTareas`/`derivarAgenda` respeten `estado_conversacion='cerrado'` → no regenerar pendientes.
Con eso, una nota de cierre cierra el caso de punta a punta y se refleja en checklist + tareas + agenda + Junior.

### 🟡 MEDIO — la cascada limpia tablas VIEJAS, no las V2
- `cascadaCierreChecklist` completa `tareas` (vieja) y cancela `agendamientos` (canónica), pero **NO toca `tarjeta_tarea` ni `tarjeta_agenda`** (las que muestra TarjetaV2). Aun si la cascada se disparara, la tarjeta V2 seguiría mostrando tareas/agenda. Otra cara de la desincronización viejo/V2.
