# Visor PG · Persianas Girardot

> **PUNTO DE ENTRADA del proyecto. Si abrís este folder por primera vez (humano o Claude), leé este archivo PRIMERO.**

---

## 1. ¿Qué es esto?

**Visor PG** es la consola viva de operación de **Fábrica de Cortinas Girardot** (negocio de Jhon Cubides en Girardot, Colombia, marca comercial **Safra**).

Convierte conversaciones de WhatsApp (y futuro: web, email, audio, proveedores, IA externas) en **operación empresarial estructurada**: clientes, proyectos, cotizaciones, pagos, instalaciones, garantías, evidencias, decisiones pendientes. Todo conectado bajo un solo cerebro: **EVENTO_PG** como columna vertebral, agentes IA por ámbito, validación humana en buzón antes de tocar el CRM.

Frase guía permanente:
> WhatsApp conversa. El visor estructura. Los agentes procesan. El humano valida. El CRM guarda. El agente junior consulta. La empresa aprende.

---

## 2. ¿Por qué existe?

**Hubo un proyecto anterior que falló:** `C:\Proyectos\WhatsApp_Captura_Safra_Visor`.

Ese visor mezcló dos sistemas (enjambre v1 viejo + v3 nuevo) durante semanas, los datos quedaron divididos entre tablas viejas y nuevas, los paneles leían a veces de uno y a veces del otro, los parches sobre parches generaron caos imposible de revertir. El 2026-05-07, después de 4-5 horas de intentos fallidos, Jhon decidió:

> *"no ala mierda este visor, hagamos un nuevo proyecto nuevo y lo vamos a crear paso por paso, primero vamos a crear con su extension nueva, visor nuevo, agentes nuevos, todo nuevo desde cero"*

Visor PG nació ese día. El proyecto viejo NO se borró — queda como **referencia de lecciones aprendidas y código reusable**.

---

## 3. ¿Qué se REUSA del proyecto viejo?

| Qué | De dónde | Por qué |
|---|---|---|
| **Extensión Chrome** (captura WA Web + descifrado HKDF + AES-256-CBC) | `C:\Proyectos\WhatsApp_Captura_Safra\` → copiada a `extension/` | Costó meses descubrir e implementar. Funciona. Solo se cambió la función de sync para apuntar al schema nuevo |
| **15 lecciones operativas** | `docs/LECCIONES_PROYECTO_VIEJO.md` | Fallar costó tiempo y dinero. No repetir |
| **Patrón de agentes** (Capa 0, validador anti-alucinación, motor de feedback, memoria DUAL local+global) | Documentado en `ARQUITECTURA.md` sección 18 | Estos patrones SÍ funcionaron en el viejo. Se aplican igual acá |
| **13 reglas duras de negocio** (R-001 a R-013) | `ARQUITECTURA.md` sección 38 | Conocimiento de negocio cristalizado, no se inventa de nuevo |
| **Vocabulario controlado de dominio** (estados de cotización, abono, producción, visita, garantía, objeción, medida) | `ARQUITECTURA.md` sección 14 | Catálogos del negocio, ya validados con la realidad operativa de Safra |
| **Supabase con 3 tablas knowledge_*** (del Bibliotecario_Safra) | Mismo proyecto Supabase `olububjdvboiqgmihsmk` | Compartido con otro proyecto de Jhon, no se borra |

---

## 4. ¿Qué se DESCARTÓ del proyecto viejo?

| Qué | Por qué |
|---|---|
| 54 tablas viejas del v1+v3 mezclados | Datos sucios, schemas inconsistentes. Borradas el 2026-05-07 |
| Código del Visor React viejo | Mezclaba capas, paneles leían de fuentes contradictorias, cubierto de parches |
| Worker viejo del enjambre con dos modos | Causaba caos. Reescrito desde cero con el patrón Event Sourcing puro |
| Buzón de procesamiento del viejo | Tenía botones para arreglar bugs de otros botones. UX confusa |
| Lógica de `wa_raw_captures` como tabla intermedia | La extensión ahora escribe directo a `chats`/`mensajes`/`evento_pg` |

---

## 5. Estado actual (2026-05-07)

- ✅ **FASE 0** — fundación + 3 docs base
- ✅ **FASE 1** — bootstrap técnico (schema, Visor mínimo, extensión adaptada, worker pipeline, identidad básica)
- ⏳ **FASE 2** próxima — MÓDULO 1 pulido + agentes comerciales

**Sistemas corriendo:**
- Visor en `http://localhost:5173` (React + Vite + TS)
- Worker pipeline procesando identidad (sin LLM, costo $0)
- Supabase con 21 tablas Visor_PG + 3 knowledge_ (de la Biblioteca)
- Extensión Chrome adaptada (versión 4.0.0 "Visor PG · Captura WhatsApp")

**Modo de procesamiento IA:** OFF — no hay agentes IA todavía, vendrán en MÓDULO 2. Costo actual: $0.

---

## 6. Cómo trabajar en este proyecto

**Orden estricto del flujo:**

```
1. Claude diseña    → propone mockup visual con datos FAKE en Visor
2. Jhon valida UX   → "sí me sirve" / "cambia X"
3. Claude itera     → ajusta mockup hasta aprobación
4. Claude backend   → construye schema + agentes + queries para llenar la UI
5. Claude tests     → E2E con Puppeteer + smoke + anti-contaminación
6. Jhon usa real    → con datos reales del negocio
7. Jhon valida fin  → "funciona" → módulo cerrado, pasa al siguiente
```

**Reglas no negociables del proyecto:**
- Jhon **NO revisa SQL, schemas, configs ni código backend**. Solo valida UX/UI.
- Si Claude se traba >30 min, **parar y preguntar** — NO parchar.
- Construir secuencial: un módulo terminado antes del siguiente. **Cero paralelismo**.
- "**Tiempo real**" = Realtime puro de Supabase. NO inventar debounce/batching/polling sin pedirlo.
- **Mockup primero, backend después** — siempre.
- Antes de tocar lógica nueva: actualizar `MAPA.md`. Después de aplicar: actualizar otra vez.

---

## 7. Orden de lectura de los documentos

| # | Archivo | Cuándo leerlo |
|---|---|---|
| 1 | `README.md` (este) | Primero. Contexto del proyecto. ~5 min |
| 2 | `VISION.md` | Para entender QUÉ se construye y por qué (1429 líneas, escrito por Jhon, intacto). 15-20 min |
| 3 | `ARQUITECTURA.md` | Para entender CÓMO se construye técnicamente. 45+ secciones en 6 partes. 30-40 min |
| 4 | `MAPA.md` | Para ver DÓNDE estamos y qué falta. 5-10 min |
| 5 | `docs/LECCIONES_PROYECTO_VIEJO.md` | Para entender qué NO repetir. 10 min |
| 6 | `docs/SUPABASE.md` | Solo si vas a tocar BD |
| 7 | `docs/VALIDACION_F1.md` | Solo si vas a validar F1 con datos reales |

**Si se va la luz:** este README + `MAPA.md` te dicen exactamente dónde retomar. No hay que adivinar.

---

## 8. Cómo abrir el proyecto

**Opción rápida (recomendada):**
- Doble click en escritorio: **"Visor PG - Claude.lnk"** → abre Claude Code apuntando a este folder con todo el contexto cargado

**Opción manual:**
```bash
cd C:\Proyectos\Visor_PG
claude
```

**Para arrancar el Visor (UI):**
```bash
cd C:\Proyectos\Visor_PG\visor
npm run dev
# → abre http://localhost:5173
```

**Para arrancar el worker (procesa eventos NUEVO → IDENTIFICADO):**
```bash
cd C:\Proyectos\Visor_PG
npm run worker:pipeline
```

**Para aplicar una migración SQL:**
```bash
cd C:\Proyectos\Visor_PG
node apply_migration.mjs supabase/migrations/<archivo>.sql
```

---

## 9. Quién es Jhon (contexto del owner)

- **Jhon Cubides Bonilla** — dueño de Fábrica de Cortinas Girardot
- Ciudad: Girardot, Colombia
- Marca comercial: **Safra**
- WhatsApp owner: `+57 322 366 3825`
- Email: `persianasyenrrollablesgirardot@gmail.com`
- Construye el sistema con Claude Code: él define la **visión** y el **conocimiento del negocio**, Claude hace la **programación**
- LLM principal del sistema: **DeepSeek** (`deepseek-chat`) por costo, GPT-4 solo si necesario
- Stack preferido: React + TypeScript strict + Vite + Supabase + Node workers

---

## 10. Otros proyectos de Jhon (red interconectada)

Visor PG es UNA pieza de un ecosistema más grande:

| Proyecto | Path | Función |
|---|---|---|
| **Visor PG** (este) | `C:\Proyectos\Visor_PG` | Consola viva de operación multi-canal |
| **Bibliotecario_Safra** | (no en disco — hosted en Supabase) | Cerebro documental, fichas técnicas. Tablas `knowledge_*` |
| **Agente_Biblioteca_RAG** | `http://localhost:5500` | Servidor RAG que el Visor consulta para conocimiento técnico |
| **CRM Zonal** | (separado, sin API aún) | Memoria dura del negocio (clientes, facturas, abonos) |
| **web-cortinas-girardot** | `C:\Proyectos\web-cortinas-girardot` | Sitio web con panel admin |
| **Sandbox_Enjambre_Precios** | `C:\Proyectos\Sandbox_Enjambre_Precios` | App de cotización IA con 19 agentes especialistas |
| **WhatsApp_Captura_Safra_Visor** | `C:\Proyectos\WhatsApp_Captura_Safra_Visor` | **PROYECTO VIEJO** — referencia de lecciones, NO se ejecuta |
| **WhatsApp_Captura_Safra** | `C:\Proyectos\WhatsApp_Captura_Safra` | Extensión Chrome viejo. Fuente del código que copiamos a `extension/` |

**Tres Supabase distintos en el ecosistema** — ver `docs/SUPABASE.md` para evitar confusión.

---

## 11. Glosario rápido

| Término | Significado |
|---|---|
| **EVENTO_PG** | Tabla central que actúa como event sourcing. Toda comunicación entre módulos pasa por acá |
| **Ámbito** | Clasificación de chat: `comercial`, `proveedor`, `personal_familia`, `personal_amigos`, `personal_otros`, `interno_equipo` |
| **L0-L5** | Las 6 capas del sistema. L0 Adapters → L1 Identidad → L1.5 Extractor → L2 Agentes → L3 Validadores → L4 Supervisión → L5 Humano |
| **Junior** | Único agente IA con acceso multi-ámbito. Asistente personal de Jhon. Vive en el Visor, futuro: app móvil |
| **Modo OFF / Modo ON** | Política de procesamiento IA. OFF = manual. ON = tiempo real automático. Ver `ARQUITECTURA.md` PARTE VI |
| **Memoria DUAL** | Local por persona (no se cruza) + Global por agente (anonimizada, sin nombres) |
| **Buzón de validación** | Cola humana donde llegan inferencias críticas antes de tocar el CRM |
| **R-XXX** | Reglas duras del negocio. `ARQUITECTURA.md` sección 38 |
| **R-IA-XXX** | Reglas duras de costo IA. `ARQUITECTURA.md` sección 52 |

---

**Última actualización:** 2026-05-07. Si modificás algo estructural del proyecto, actualizá este README también.
