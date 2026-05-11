# LECCIONES DEL PROYECTO ANTERIOR

> Contexto: este documento captura todo lo aprendido del proyecto previo `WhatsApp_Captura_Safra_Visor` (que terminó en caos después de 4-5 horas de parches el 2026-05-07).
>
> **El objetivo NO es atacar el proyecto anterior — el objetivo es NO repetir los errores.**
>
> Cada lección viene con: qué pasó, qué aprendimos, cómo lo evitamos en Visor PG.

---

## LECCIÓN 1: NO construir paralelo sin migrar

**Qué pasó:**
- Existía v1 (enjambre viejo) escribiendo a tablas viejas (`chat_fichas`, `cotizaciones_chat`, etc.).
- Construimos v3 (enjambre nuevo) escribiendo a tablas nuevas (`evento_wa`, `wa_processed_messages`, etc.).
- Los dos sistemas convivieron durante semanas.
- **Resultado:** datos divididos, paneles del Visor leyendo a veces de v1 y a veces de v3, imposible saber cuál era la verdad.

**Cómo lo evitamos en Visor PG:**
- **UN solo sistema activo en cada fase.** Si construimos algo nuevo, primero apagamos lo viejo.
- Si lo viejo aún no se puede apagar (en este caso: extensión Chrome se mantiene), está aislado en `extension/` y NO escribe a tablas que también escriba lo nuevo.
- Migración por fases con corte claro: una fase termina cuando lo viejo está apagado y lo nuevo lo reemplazó por completo.

---

## LECCIÓN 2: NO matar lo viejo sin reemplazo completo

**Qué pasó:**
- En cierto momento "limpié v1" sin que v3 cubriera todos los paneles.
- Resultado: paneles del Visor (Capturas, Clientes, Tareas, Agenda) quedaron vacíos.
- Jhon: "elimina el módulo nuevo clientes tiene datos tareas agenda pendientes tienen datos".

**Cómo lo evitamos en Visor PG:**
- **Antes de quitar algo, lo nuevo debe estar escribiendo y siendo visible.**
- Cada panel solo se conecta a la fuente nueva CUANDO la fuente nueva tiene datos verificables.
- Tests E2E con Puppeteer verifican que el panel muestre datos antes de declarar el módulo terminado.

---

## LECCIÓN 3: NO parchar bugs con más botones

**Qué pasó:**
- Bug: capturas duplicadas. Solución parche: agregué botón "Sincronizar TODOS".
- Bug: chat sin contexto. Solución parche: agregué botón "Procesar v3" que llama a la extensión.
- Bug: worker no respeta kill-switch. Solución parche: cache de 60s en lugar de invalidación inmediata.
- **Resultado:** UI llena de botones que nadie sabía qué hacían. Jhon: "me estas llenando de opciones que ni yo se en que te metistes".

**Cómo lo evitamos en Visor PG:**
- **Si algo no funciona, se rediseña — NO se parcha.**
- Cada botón nuevo requiere justificación en `MAPA.md` ("¿por qué este botón? ¿qué problema resuelve?").
- Si la respuesta es "es para arreglar el bug del botón anterior" → no se construye. Se rediseña.

---

## LECCIÓN 4: NO mezclar capas (captura + procesamiento + UI en un módulo)

**Qué pasó:**
- En el viejo había código que mezclaba: leer de IndexedDB de la extensión + procesar con DeepSeek + actualizar el panel del Visor — todo en un mismo archivo.
- Cuando capturó cambió, rompió procesamiento Y UI a la vez.
- Cuando UI cambió, rompió procesamiento.

**Cómo lo evitamos en Visor PG:**
- **6+1 niveles desacoplados estrictos** (sección 5 de ARQUITECTURA.md): L0 Adapters → L1 Identidad → L1.5 Extractor → L2 Agentes → L3 Validadores → L4 Supervisión → L5 Humano.
- Cada nivel comunica SOLO via `evento_pg` en BD.
- **Cero llamadas directas entre módulos.**
- Cambiar UI no toca agentes. Cambiar agentes no toca UI.

---

## LECCIÓN 5: NO automatizar sin autorización del usuario

**Qué pasó:**
- El v1 procesaba 24/7 sin que Jhon pidiera nada. Cuando él abría el Visor, ya había gastado API en chats que no le interesaban.
- Llenó tablas con basura inferida sin contexto.
- Jhon: "ojo con el cobro api no vayas a gastar el saldo".

**Cómo lo evitamos en Visor PG:**
- **Procesamiento solo cuando hay autorización explícita** (Jhon click en botón / chat marcado como `comercial` / regla de prioridad activa).
- **Tope hard de costo:** $0.05 por invocación, $5 diario. Si excede → todo pausa + alerta.
- **Modo shadow** para agentes nuevos (7 días sin escribir, solo loggea).
- Métricas de costo visibles en tiempo real en el Visor.

---

## LECCIÓN 6: SÍ separar identidad del procesamiento

**Qué pasó:**
- En el viejo, cada agente resolvía la identidad por su cuenta (a veces match, a veces creaba duplicado).
- Resultado: Pedro1 + Pedro2 + Pedro3 todos siendo la misma persona.
- Memoria local fragmentada.

**Cómo lo evitamos en Visor PG:**
- **Servicio de Identidad como módulo central** (L1, sección 8 de ARQUITECTURA.md).
- Único punto que decide `persona_id` con cascada de matching.
- Panel de **merge de personas duplicadas** (sección 29) por si Identidad se equivoca.

---

## LECCIÓN 7: SÍ usar Event Sourcing

**Qué pasó:**
- El viejo escribía directo a tablas de negocio sin trail.
- Cuando algo salía mal, no había forma de saber por qué.
- "¿Quién escribió este dato? ¿Cuándo? ¿Con qué evidencia?"

**Cómo lo evitamos en Visor PG:**
- **`evento_pg` como columna vertebral** (sección 13).
- Toda escritura pasa por evento.
- `evento_padre_id` permite reconstruir el linaje completo.
- Modo "explicación" muestra el rastro al usuario (sección 24).

---

## LECCIÓN 8: SÍ tener kill-switch funcional con invalidación inmediata

**Qué pasó:**
- En el viejo agregué kill-switch para apagar v1.
- Pero el worker tenía cache de 60s, así que tardaba 1 minuto en apagar.
- Mientras tanto, escribía datos malos.

**Cómo lo evitamos en Visor PG:**
- Cualquier kill-switch invalida cache **inmediatamente** (subscripción Realtime, no polling).
- Antes de cada invocación de agente, verificar flag desde BD (con cache de máximo 5 segundos).
- Tests verifican que el switch apaga en <10s.

---

## LECCIÓN 9: SÍ tests E2E reales antes de declarar algo terminado

**Qué pasó:**
- En el viejo declaraba módulos "terminados" sin probarlos visualmente.
- Resultado: módulos rotos en producción que Jhon descubría usando.
- Tiempo perdido: regresiones que test E2E habrían atrapado.

**Cómo lo evitamos en Visor PG:**
- **Cada módulo tiene test E2E con Puppeteer** que abre el Visor, simula uso real, verifica resultado.
- Sin test E2E pasando → módulo NO está terminado.
- Tests anti-contaminación corren en CI: garantizan que agente sobre cliente A no menciona cliente B.

---

## LECCIÓN 10: SÍ reusar lo que funciona

**Qué pasó (positivo):**
- HKDF + descifrado de WhatsApp Web nos costó meses de descubrir + implementar.
- Cuando funcionó, fue una victoria enorme.
- Hubiera sido absurdo reescribirlo desde cero.

**Cómo lo aplicamos en Visor PG:**
- **Reusamos extensión Chrome completa** (folder `extension/`).
- Único cambio: apuntar al Supabase nuevo.
- Otros patrones reusados: anti-contaminación, runner común de agentes, motor de feedback, esqueleto de Capa 0, validador anti-alucinación.

---

## LECCIÓN 11: NO inventar arquitectura no pedida

**Qué pasó:**
- Jhon pidió "tiempo real". Yo agregué debounce de 15s + ciclo de 10s "para agrupar ráfagas".
- Generó ~25s de latencia. Jhon: "no responde rápido en tiempo real".

**Cómo lo evitamos en Visor PG:**
- **"Tiempo real" = Realtime puro** (postgres_changes, sin timers artificiales).
- Si creo que una optimización (batch, debounce, cache) agrega valor, la **PROPONGO** primero como opción con tradeoff. NO la implemento por mi cuenta.
- Polling solo como red de seguridad (catch-up cada 60s+), nunca como carril principal.

---

## LECCIÓN 12: NO migración paralela cuando lo viejo no funcionó

**Qué pasó:**
- Propuse "vamos a correr v3 al lado de v1 para comparar resultados".
- Jhon: "no necesito validacion de lo antiguo por que no funcionó".

**Cómo lo evitamos en Visor PG:**
- Cuando un sistema legado falló su objetivo → descartarlo. No mantenerlo "por si acaso".
- Construir el reemplazo directo, sin paralelismo de evaluación.
- **Validación = Jhon usa el sistema con datos reales y reporta lo que esté roto.** Iteramos hasta que diga "funciona".
- Cero métricas automáticas comparando contra el legado.

---

## LECCIÓN 13: SÍ documentar antes de codear

**Qué pasó:**
- Sesión 2026-05-04 Jhon dijo: "me imagino que todo esto debe estar documentado en el mapa por si se va la luz cierto?"
- Cuando se cortó la luz / se cerró sesión, Claude perdía contexto.
- Entonces metía cambios contradictorios con la decisión anterior.

**Cómo lo evitamos en Visor PG:**
- **Antes de codear cambios estructurales:** plan en archivo MD.
- **Después de aplicar cambios:** actualizar `MAPA.md` (qué módulo cambió, por qué).
- **Decisiones de arquitectura:** van en `ARQUITECTURA.md` sección 44 (Decisiones).
- Memoria persistente refleja el estado actual del proyecto.
- Nunca asumir que "Jhon recordará la decisión X" — escribirla.

---

## LECCIÓN 14: Jhon NO revisa SQL/schemas/configs

**Qué pasó:**
- Le pasé schemas SQL para revisar. Jhon: "no me lo muestres porque de eso no sé, lo único que me interesa ver es lo que me muestre el visor".

**Cómo lo evitamos en Visor PG:**
- **Jhon valida solo lo VISUAL.**
- Cuando produzco artefacto técnico (SQL, migración, código backend, config), no le pido revisión. Lo aplico/guardo yo.
- **Pivoto inmediatamente a construir mockup o UI que él SÍ puede validar.**
- **Flujo correcto:** mockup visual con datos fake → Jhon valida UX → luego construyo backend.
- Si necesito que aplique algo en Supabase (porque solo él tiene la cuenta), le doy instrucciones mínimas de copy-paste sin pedirle entender el contenido.

---

## LECCIÓN 15: Si me trabo, parar — NO parchar

**Qué pasó:**
- Cuando un parche fallaba, intentaba otro parche. Y otro. Y otro.
- Jhon, frustrado: "deja de estar parchando, no quiero que sigas con esto por que ya te conozco y me haces perder tiempo".

**Cómo lo evitamos en Visor PG:**
- **30 minutos sin avanzar = parar y preguntar.**
- Re-leer documentación + entender el problema raíz antes de tocar más código.
- Es mejor pausar 5 min y pensar que pasar 2 horas parchando.

---

## RESUMEN ACCIONABLE PARA VISOR PG

| Regla | Cómo se aplica |
|---|---|
| 1 sistema activo a la vez | Migración con corte claro, no paralelismo |
| Mockup primero, backend después | Cada módulo arranca visual con datos fake |
| Modos de la BD encapsulados | Solo `evento_pg` cruza entre niveles |
| Anti-parche | Si algo no funciona, se rediseña |
| Anti-caja-negra | Modo "explicación" en cada inferencia |
| Anti-costo | Topes hard $0.05/invocación, $5/día |
| Anti-error humano | Soft delete 30 días, modo shadow agentes |
| Anti-pérdida-luz | MAPA.md siempre actualizado |
| Anti-confusión-Jhon | Jhon valida solo UI, NO schemas |
| Anti-trabón | 30 min trabado = parar y consultar |

---

**FIN. Si en el futuro este proyecto también falla, este documento debe ampliarse con las nuevas lecciones — sin borrar las viejas.**
