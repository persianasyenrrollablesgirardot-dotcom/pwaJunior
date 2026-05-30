# Enjambre de agentes IA — Visor PG

**33 agentes** organizados en 9 capas. Cada uno arranca en `shadow=true` (propone al buzón, no escribe a tablas de negocio) y Jhon los promueve a `activo=true, shadow=false` cuando confía en sus resultados.

**Estado al cierre de F2 (2026-05-13):** 32 productivos funcionales + 1 placeholder (A6_BIBLIO depende del futuro Agente_Biblioteca_RAG externo).

## Estructura de carpetas

```
agentes/
├── lib/                       Infraestructura compartida
│   ├── llm.ts                 Cliente DeepSeek (tope $0.05/invocación)
│   ├── openai.ts              Whisper + Vision
│   ├── runner.ts              Ejecuta UN agente (validación, lock, DLQ, métricas)
│   ├── validador.ts           Anti-alucinación + cross-cliente + reglas duras
│   └── pipeline.ts            DAG executor para encadenar varios agentes
├── L1_extraccion/             (5) Extrae hechos objetivos del mensaje
├── L2_routing/                (4) Clasifica + decide qué pipeline correr
├── L3_identidad/              (4) Resuelve quién/dónde antes de cualquier escritura
├── L4_comerciales/            (5) Propone cotizaciones / objeciones / referidos
├── L5_financiero/             (4) Detecta abonos, valida comprobantes, cartera
├── L6_tecnico/                (3) Valida medidas + reglas R-013#1 + biblioteca RAG
├── L7_operativo/              (3) Tareas, rutas, estado de producción
├── L8_postventa/              (4) Garantías, satisfacción, reputación, reclamos
├── L10_junior/                (1) Asistente personal de Jhon
├── extractor/                 Regex extractor (legacy, complementa L1)
├── registro_agentes.ts        Registra hooks en pipeline.ts
└── README.md                  Este archivo
```

L9 supervisor no es agente: `validador.ts` es un módulo TS y R-013#1 es un trigger SQL.

## Lista completa (33 agentes)

| Cód. | Capa | Nombre | Modelo | Tope $/inv | Costo real |
|---|---|---|---|---|---|
| **A1_ENTIDADES** | L1 | Extractor de entidades (nombres, empresa, conjunto, rol) | deepseek-chat | $0.02 | ~$0.0003 |
| **A1_MEDIDAS** | L1 | Extractor de medidas (ancho×alto + ambiente + quien_midio) | deepseek-chat | $0.01 | ~$0.0003 |
| **A1_MONTOS** | L1 | Extractor de montos COP (con contexto: precio/abono/saldo) | deepseek-chat | $0.01 | ~$0.0004 |
| **A1_AUDIO** | L1 | Wrapper de transcripción Whisper (lee `metadata.ai_text`) | lookup | $0 |
| **A1_OCR** | L1 | Wrapper de OCR Vision (lee `ai_text` + clasifica tipo_imagen) | lookup+heuristica | $0 |
| **A2_AMBITO** | L2 | Clasificador de ámbito (comercial/proveedor/personal/interno) | deepseek-chat | $0.01 | ~$0.0005 |
| **A2_INTENCION** | L2 | Clasificador de intención (router del pipeline) | deepseek-chat | $0.01 | ~$0.0003 |
| **A2_NOCLIENTE** | L2 | Detector de no-clientes (restaurante/transporte/spam) | deepseek-chat | $0.01 | ~$0.0004 |
| **A2_ROL** | L2 | Detector de rol del emisor (cliente/familiar/admin/...) | deepseek-chat | $0.01 | ~$0.0003 |
| **A3_IDENTIDAD** | L3 | Detector de duplicados de persona (propone fusión) | deepseek-chat | $0.02 | ~$0.0003 |
| **A3_INMUEBLE** | L3 | Matcheador de conjuntos (324 catálogo) | deepseek-chat | $0.02 | ~$0.001 |
| **A3_GEO** | L3 | Matcheador de zonas (17 zonas + costo_traslado) | deepseek-chat | $0.01 | ~$0.0004 |
| **A3_GRAFO** | L3 | Detector de menciones a terceros (grafo social) | deepseek-chat | $0.02 | ~$0.0004 |
| **A4_COTIZ** | L4 | Propone cotización al buzón (items + medidas + accesorios) | deepseek-chat | $0.05 | ~$0.0005 |
| **A4_OBJECIONES** | L4 | Detector de objeciones (12 tipos + intensidad) | deepseek-chat | $0.02 | ~$0.0003 |
| **A4_RECOMPRA** | L4 | Detector de candidatos a recompra (batch >6m sin actividad) | deepseek-chat | $0.02 | ~$0.0004 |
| **A4_REFERIDOS** | L4 | Detector bidireccional (refiere → / viene-de ←) | deepseek-chat | $0.02 | ~$0.0004 |
| **A4_COMPAT** | L4 | Validador de compatibilidad (reglas_compatibilidad) | deepseek-chat | $0.02 | ~$0.0004 |
| **A5_ABONO** | L5 | Detector de confirmaciones de pago (aplica R-009) | deepseek-chat | $0.03 | ~$0.0004 |
| **A5_COMPROB** | L5 | Validador de comprobantes (OCR + match saldo) | deepseek-chat | $0.03 | ~$0.0005 |
| **A5_CARTERA** | L5 | Detector de cobros pendientes (batch >7d sin actividad) | deepseek-chat | $0.02 | ~$0.0005 |
| **A5_RENTAB** | L5 | Calculador de margen real (alerta si <10%) | deepseek-chat | $0.01 | ~$0.0006 |
| **A6_MEDIDAS** | L6 | Validador técnico de medidas (aplica R-013#1) | deepseek-chat | $0.01 | ~$0.0005 |
| **A6_RIESGO** | L6 | Detector de riesgos técnicos (cruza inmueble+sistema+zona) | deepseek-chat | $0.02 | ~$0.0004 |
| **A6_BIBLIO** | L6 | Placeholder · espera Agente_Biblioteca_RAG externo | — | $0.05 | — |
| **A7_TAREAS** | L7 | Extractor de tareas (llamar/agendar/etc + fecha relativa) | deepseek-chat | $0.02 | ~$0.0003 |
| **A7_ESTADO** | L7 | Responde "cuándo me entregan" desde produccion+instalaciones | deepseek-chat | $0.02 | ~$0.0004 |
| **A7_RUTAS** | L7 | Optimizador de rutas de instalación (batch geográfico) | deepseek-chat | $0.03 | ~$0.0006 |
| **A8_GARANTIA** | L8 | Detector de reportes de falla (propone garantía con causa) | deepseek-chat | $0.03 | ~$0.0005 |
| **A8_SATIS** | L8 | Detector de sentimiento post-instalación (5 estados) | deepseek-chat | $0.01 | ~$0.0004 |
| **A8_REPUT** | L8 | Identifica clientes aptos para reseña Google | deepseek-chat | $0.01 | ~$0.0005 |
| **A8_RECLAMO** | L8 | Detector de reclamos sensibles (escalación crítica) | deepseek-chat | $0.03 | ~$0.0004 |
| **A10_JUNIOR** | L10 | Asistente personal de Jhon (consultas desde el celular) | deepseek-chat | $0.10 | ~$0.0003 |

**Costo promedio por mensaje procesado por el pipeline completo:** ~$0.004 (4-8 agentes corren según routing).

## Pipelines (3 en BD)

| Código | Trigger | Descripción |
|---|---|---|
| `PIPE_MENSAJE_COMERCIAL` | `mensaje_entrante` + `ambito=comercial` + `tipo_mensaje=texto` | Pipeline principal (4 fases). Routing por intención. |
| `PIPE_AUDIO` | `mensaje_entrante` + `tipo_mensaje=audio` | Transcribe → re-procesa como texto |
| `PIPE_IMAGEN` | `mensaje_entrante` + `tipo_mensaje=imagen` | OCR → routing por tipo_imagen (comprobante/medida/garantia) |

### Estructura de `PIPE_MENSAJE_COMERCIAL` (4 fases)

```
extraccion  (paralelo): A1_ENTIDADES, A1_MEDIDAS, A1_MONTOS
clasificar  (serial):   A2_AMBITO → A2_INTENCION → A2_ROL
identidad   (serial):   A3_IDENTIDAD → A3_INMUEBLE → A3_GEO → A3_GRAFO
operativo   (routing por intencion):
              cotizar          → A4_COTIZ + A4_COMPAT
              pagar            → A5_ABONO
              queja            → A8_GARANTIA + A8_RECLAMO
              consulta_estado  → A7_ESTADO
              urgente          → A8_RECLAMO
              saludo           → (nada)
              _default         → A7_TAREAS
```

## Cómo agregar un agente nuevo

1. Crear `agentes/L<N>_<capa>/aX_<nombre>.ts` con la interfaz `AgenteHooks`:
   ```ts
   import type { AgenteHooks } from '../lib/runner.js';
   export const aXHooks: AgenteHooks = {
     async cargarContexto(sb, params) { /* lee BD, devuelve datos */ },
     construirPrompt(datos, agente) { /* devuelve ChatMessage[] */ },
     validarOutputEspecifico(out, datos) { /* throws si inválido */ },
     async postProcesar(sb, out, ctx) { /* escribe a tablas en modo productivo */ },
   };
   ```
2. Para agentes sin LLM (lookup, regex, batch), implementar `procesarSinLLM` en lugar de `construirPrompt`.
3. Registrar en `agentes/registro_agentes.ts`:
   ```ts
   import { aXHooks } from './L<N>_<capa>/aX_<nombre>.js';
   // dentro de registrarTodosLosAgentes:
   registrarAgente('AX_NOMBRE', aXHooks);
   ```
4. Si el código aún no está en `agentes_definicion`, agregarlo via SQL o migración nueva.
5. Si emite `tipo_evento` nuevo, asegurarse que esté en el CHECK de `evento_pg.tipo_evento` (mig 025 agregó: cotizacion, abono, instalacion, mantenimiento, review, reclamo, costo, etc.).

## Promoción shadow → activo

1. Probar en shadow ≥1 semana (idealmente con tráfico real).
2. Revisar M8 "8.3 Invocaciones" — métricas + errores + costos.
3. Revisar M8 "8.4 DLQ" — eventos fallidos que el agente generó.
4. Si métricas son buenas:
   ```sql
   UPDATE agentes_definicion SET activo=true, shadow=false WHERE codigo='AX_NOMBRE';
   ```
5. Próxima invocación corre en modo productivo (postProcesar escribirá a tablas).
6. Si algo sale mal, volver a shadow:
   ```sql
   UPDATE agentes_definicion SET shadow=true WHERE codigo='AX_NOMBRE';
   ```

## Reglas duras del enjambre

- **R-001 anti-alucinación** — todo claim cita evidencia (msg_id, conjunto_id, etc.). El `validador.ts` rechaza outputs sin evidencia válida.
- **R-006 garantías** — cada garantía requiere causa + responsable explícitos.
- **R-009 comprobante de pago** — foto sola NO confirma pago. Texto + monto requerido.
- **R-013#1 medida tomada por cliente** — automáticamente setea `bandera_riesgo='RIESGO_MEDICION_CLIENTE'`. Validador enforced.
- **Anti-contaminación cross-cliente** — el output NO debe mencionar identificadores de otros clientes (nombres, tel, email). Validador escanea y rechaza.
- **Tope de costo** — cada agente tiene `costo_limite_usd`. Si DeepSeek excede, throw y se mueve a DLQ tras 3 reintentos.

## Patrones aprendidos en F2

1. **JSON estructurado para input de agentes downstream.** Cuando un agente depende de campos de un agente upstream (ej. A6_MEDIDAS depende de quien_midio de A1_MEDIDAS), pasar los datos como JSON estructurado (`JSON.stringify`) en lugar de prosa. El LLM respeta los campos como datos a propagar, no como texto a reinterpretar.

2. **Anti-alucinación cross-prompt.** Con prompts similares en batch + cache DeepSeek, el LLM puede mezclar valores de prompts previos. Reforzar: *"SOLO incluí valores que aparezcan LITERALMENTE en el input actual. NUNCA completes campos con valores que recuerdes."*

3. **msg_id completo en prompts.** Si truncás el msg_id (`slice(0, 16)`) en el prompt, el LLM cita el msg_id truncado en `evidencia_msg_ids` → validador rechaza porque no existe. Pasar el msg_id completo siempre.

4. **`tipo_evento` constante por agente.** Cada agente emite SIEMPRE el mismo `tipo_evento` (ej. A4_COMPAT siempre emite `'alerta'`). La severidad va en `confianza` (ALERTA/CONFIRMADO/DUDOSO), no en tipo_evento.

5. **Agentes batch necesitan evento sintético.** Agentes que no responden a un mensaje específico (A4_RECOMPRA, A5_CARTERA, A7_RUTAS, A8_REPUT) requieren un `evento_id` y `msg_id` sintéticos creados por cron/UI antes de invocarse.

6. **Pipeline + skipLock.** Cuando el worker invoca el pipeline, ya tomó el lock global del evento. Los agentes individuales NO deben volver a tomar lock — usan `skipLock=true` y delegan la coordinación al pipeline (especialmente en fases paralelo).

7. **`intentos_agente` no cuenta agentes distintos.** Bajo `skipLock=true`, NO incrementar `evento_pg.intentos_agente`. Cada agente tiene su propio contador en `agente_invocaciones.intentos`. Sin esto, un pipeline de 10 agentes manda el evento a DLQ después del 3ro.

8. **Mapeo de tipos de mensaje.** La extensión guarda `payload.tipo_canonical='text'` (inglés). Los pipelines tienen `trigger_condiciones.tipo_mensaje='texto'` (español). El worker mapea: `text→texto`, `image→imagen`, `audio→audio`, `ptt→audio`.

## Test E2E exitoso (2026-05-13)

Sobre 2 eventos `mensaje_entrante` reales:
- **22 invocaciones** (19 OK · 3 rechazadas por anti-alucinación, pipeline siguió)
- **19 shadow events** generados
- **$0.0086 total** · $0.004/evento promedio
- **4/4 fases** completadas en cada evento
- **Routing dinámico validado:**
  - ev827 "buenas noches claro que si" → intencion=otro → A7_TAREAS
  - ev863 "Cancelo saldo cortinas girardot" → intencion=pagar → A5_ABONO

## Archivos clave

- `agentes/lib/runner.ts` — orquestador genérico de un agente (lock, validación, persistencia)
- `agentes/lib/pipeline.ts` — orquestador de DAG de agentes
- `agentes/lib/validador.ts` — anti-alucinación + cross-cliente + reglas duras
- `agentes/registro_agentes.ts` — registra hooks de los 32 agentes productivos
- `workers/worker_pipeline_v2.ts` — worker que polls evento_pg → busca pipeline → ejecuta
- `visor/src/panels/Modulo8.tsx` — UI M8 Agentes (5 sub-tabs: lista, pipelines, invocaciones, DLQ, correcciones)
- `supabase/migrations/024_enjambre_agentes.sql` — seed inicial de agentes + pipelines
- `supabase/migrations/025_evento_pg_tipos_agentes.sql` — tipos de evento_pg para L4-L8
