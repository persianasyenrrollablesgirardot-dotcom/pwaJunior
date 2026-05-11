# PLAN — MÓDULO 2 Comerciales

> Documento de planificación creado **2026-05-08** ANTES de codear.
> Si algo cambia durante la construcción, se actualiza acá + se agrega entrada en `MAPA.md` + `ARQUITECTURA.md` sección 44.
>
> **Owner**: Jhon Cubides — **Stack**: Node + TypeScript + DeepSeek + OpenAI (Whisper/Vision)

---

## 1. Resumen ejecutivo

MÓDULO 2 es donde **arrancan los agentes IA reales**. Tres aprendizajes de M1 mandan el diseño:

1. **Worker pipeline v2.1 polling funciona** — usar el mismo patrón para los agentes IA.
2. **Realtime se cae frecuentemente** — polling como carril principal, Realtime como aceleración.
3. **La extensión NO transcribe** — el primer agente IA tiene que hacerlo o nada de lo demás entiende contexto.

**Decisión central:** primer agente = **Transcribor** (Whisper + Vision). Después extractor objetivo. Después agentes interpretativos comerciales.

---

## 2. Decisiones tomadas (con motivos)

| # | Decisión | Motivo |
|---|---|---|
| 1 | **Primer agente IA = Transcribor** (Whisper + Vision) | Sin texto de audios/imágenes, los agentes interpretativos están ciegos. La extensión NO transcribe (validado en F1.14.1) |
| 2 | **Segundo agente = Extractor objetivo** (L1.5 de ARQUITECTURA) | Regex puro sobre texto, costo $0. Pre-procesa datos limpios (montos, medidas, fechas, teléfonos) para los agentes LLM |
| 3 | **Tercer agente = A5 Cotizaciones** | Es el caso de uso más visible y tu doc de visión lo lista primero (sección 2.1) |
| 4 | **Worker dedicado por agente, no monolito** | Cada agente cae sin afectar a los otros. Misma arquitectura que `worker_pipeline` |
| 5 | **Polling como carril principal** | Validado en M1 que Realtime cae cada ~30s. Polling cada 5s con batch 20 funciona |
| 6 | **Modo shadow obligatorio 7 días** (R-IA-001 ya documentada) | Cero riesgo de corromper datos al activar agente nuevo |
| 7 | **Costo total visible en TopBar** | Ya implementado, solo conectar agentes IA al `costo_usd` de cada `evento_pg` |
| 8 | **Tope hard de costo por agente $0.05/invocación** (R-costo) | Si excede, aborta + log en `dead_letter_queue` |
| 9 | **API keys: DeepSeek (texto) + OpenAI (Whisper + Vision)** | DeepSeek ~10× más barato que GPT-4 para texto. OpenAI obligatorio para Whisper/Vision |
| 10 | **Stack agentes: Node + TS + tsx**, NO Edge Functions todavía | Mismo patrón que `worker_pipeline` (ya validado). Migración a Edge cuando escale |

---

## 3. Schema M2 (migración `007_modulo_2.sql`)

```sql
-- Cotizaciones (sección 2.1 doc)
CREATE TABLE cotizaciones (
  id BIGSERIAL PRIMARY KEY,
  proyecto_id BIGINT REFERENCES proyectos(id),
  persona_id BIGINT NOT NULL REFERENCES personas(id),
  codigo TEXT,                          -- número de cotización (formato Safra)
  version INTEGER NOT NULL DEFAULT 1,
  estado TEXT NOT NULL CHECK (estado IN ('propuesta','negociando','intencion_cierre','ganada','perdida','vencida')),
  valor_total_cop NUMERIC(12,2),
  vigencia_dias SMALLINT,               -- 15 manual, 7 motorizado (R-004)
  fecha TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_envio TIMESTAMPTZ,
  archivo_enviado_url TEXT,
  asesor_id BIGINT REFERENCES usuarios(id),
  notas TEXT,
  ambito TEXT NOT NULL REFERENCES ambitos(codigo),
  -- Trazabilidad agente
  agente_origen TEXT,                   -- 'A5' si la inferió un agente
  evento_origen_id BIGINT REFERENCES evento_pg(id),
  confianza TEXT CHECK (confianza IN ('CONFIRMADO','INFERIDO','DUDOSO','ALERTA')),
  -- Auditoría
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actualizado_por BIGINT REFERENCES usuarios(id),
  deleted_at TIMESTAMPTZ
);

-- Items por cotización (cada producto/sistema cotizado)
CREATE TABLE cotizacion_items (
  id BIGSERIAL PRIMARY KEY,
  cotizacion_id BIGINT NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  sistema TEXT REFERENCES sistemas_safra(codigo),
  ambiente TEXT,                        -- "sala", "alcoba 1", "comedor"...
  ancho_m NUMERIC(6,2),
  alto_m NUMERIC(6,2),
  cantidad INTEGER NOT NULL DEFAULT 1,
  precio_unit_cop NUMERIC(12,2),
  precio_total_cop NUMERIC(12,2),
  notas TEXT,
  orden SMALLINT NOT NULL DEFAULT 1
);

-- Objeciones detectadas (sección 2.3 doc, vocabulario controlado sección 14 ARQ)
CREATE TABLE objeciones (
  id BIGSERIAL PRIMARY KEY,
  persona_id BIGINT NOT NULL REFERENCES personas(id),
  proyecto_id BIGINT REFERENCES proyectos(id),
  cotizacion_id BIGINT REFERENCES cotizaciones(id),
  tipo TEXT NOT NULL REFERENCES tipos_objecion(codigo),
  contenido TEXT NOT NULL,              -- el snippet del mensaje
  msg_id_evidencia TEXT,
  agente_origen TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seguimientos comerciales (sección 2.4 doc)
CREATE TABLE seguimientos (
  id BIGSERIAL PRIMARY KEY,
  persona_id BIGINT NOT NULL REFERENCES personas(id),
  proyecto_id BIGINT REFERENCES proyectos(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('llamar','enviar_cotizacion','confirmar_pago','reclamar_proveedor','agendar_visita','pedir_resena','seguimiento_general')),
  descripcion TEXT NOT NULL,
  agendado_para TIMESTAMPTZ,
  completado_at TIMESTAMPTZ,
  completado_por BIGINT REFERENCES usuarios(id),
  prioridad SMALLINT NOT NULL DEFAULT 5,
  agente_origen TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Realtime para Visor
ALTER PUBLICATION supabase_realtime ADD TABLE cotizaciones;
ALTER PUBLICATION supabase_realtime ADD TABLE objeciones;
ALTER PUBLICATION supabase_realtime ADD TABLE seguimientos;
```

**Tablas que YA existen y se reusarán**:
- `personas`, `proyectos`, `inmuebles` — contexto de cliente
- `evento_pg` — todos los outputs de agentes pasan por acá
- `buzon_validacion` — para inferencias de confianza < CONFIRMADO
- `correcciones` — los agentes leen esto antes de inferir
- `memoria_local` + `memoria_global_especialista` — DUAL learning
- `agentes_definicion` + historial — versionado de prompts (hot reload)

---

## 4. Primer agente: Transcribor (detallado)

### Por qué es el primero
1. **Ningún otro agente entiende contexto sin esto**: el cliente manda audio "necesito blackout sala", el Transcribor lo convierte a texto, y A5 Cotizaciones lo procesa.
2. **Llena el módulo 1.6 Transcripciones** que hoy está vacío de `ai_text`.
3. **Bajo riesgo conceptual**: solo convierte media → texto. No infiere. No escribe a tablas de negocio.

### Cómo funciona

```
mensajes con tipo IN (audio, imagen, video, documento) y metadata.ai_text IS NULL
                          ↓
                  worker_transcribor (polling cada 10s)
                          ↓
            ┌────────────┼─────────────┐
            ↓            ↓             ↓
       Whisper API   Vision API    PDF/doc text
       (audio/ptt)   (imagen)      (Files API)
            ↓            ↓             ↓
            └────────────┼─────────────┘
                          ↓
       UPDATE mensajes SET metadata.ai_text = '...'
       INSERT evento_pg (tipo='dato_extraido', payload, costo_usd)
```

### Defensas (no opcionales)
- **Tope hard $0.05/invocación** — si Whisper sale más caro, abort
- **Solo procesa media de chats `ia_historico_procesado=true` Y `NOT ia_bloqueado`** — respeta política IA capa 3
- **Idempotencia**: si `ai_text` ya existe, skip (no re-procesa)
- **Modo shadow primero**: 7 días con `shadow=true` que loggea pero no escribe a `metadata.ai_text`. Después flip a `shadow=false`
- **Cache por SHA-256 del media**: si la misma imagen aparece en 2 chats, Vision corre 1 sola vez

### Costos estimados
- Whisper: $0.006 por minuto de audio. Chat con 25 PTT cortos (1 min total) = $0.006
- Vision: $0.005 por imagen (low detail). Chat con 41 imágenes = $0.21
- **Tope diario sugerido: $5** (lo actual). Cuando suba el volumen, Junior alerta.

---

## 5. Segundo agente: Extractor objetivo (L1.5)

**Sin LLM, $0 costo.** Pre-procesa datos crudos para los agentes interpretativos.

### Qué extrae (regex + librerías)
- **Teléfonos** (E.164, normalización Colombia)
- **Direcciones** (calle, carrera, conjunto patrón Girardot/Bogotá)
- **Medidas** (`X,XX m × Y,YY m` o `XXX×YYY cm`)
- **Montos** (`$1.234.000`, `1.5M`, `dos millones`)
- **Fechas** (`mañana`, `el sábado`, `15 de octubre`, `25/10`)
- **Códigos de cotización** (formato Safra: `COT-2026-XXX`)
- **CC/NIT** (formato Colombia)
- **Sistemas mencionados** (regex sobre `sistemas_safra` + sinónimos)

### Output
- `evento_pg` con `tipo_evento='dato_extraido'`
- `payload = { extracciones: [{ campo, valor, confianza, msg_id }] }`
- `confianza='INFERIDO'` (regex no es lectura semántica)

---

## 6. Tercer agente: A5 Cotizaciones

### Cuándo dispara
- Cuando el Extractor detecta `medidas + sistema + ambiente` en una conversación
- O cuando llega un evento_pg de tipo `mensaje_entrante` con palabras clave (`cotizar`, `cotización`, `cuánto vale`, `precio`)

### Qué hace
1. Carga toda la línea de tiempo de la persona (R-anti-contaminación)
2. Lee notas libres + correcciones previas
3. Llama DeepSeek con prompt específico (vocabulario sección 14)
4. Output JSON estructurado: `{cotizacion: {...}, items: [...]}`
5. Pasa por validador (anti-alucinación + reglas R-001-013)
6. Escribe a `cotizaciones` + `cotizacion_items`
7. Si `confianza < CONFIRMADO` → manda al buzón

### Tope de costo
$0.02 por invocación (DeepSeek Chat: ~5K tokens entrada + 1K salida)

---

## 7. Roadmap fases

| Fase | Qué | Estimación | Bloquea? |
|---|---|---|---|
| **A** | Setup infraestructura agentes (`agentes/lib/llm.ts`, `runner.ts`, `validador.ts`) | 1 día | Sí |
| **B** | Schema M2 + seed de `agentes_definicion` | medio día | Sí |
| **C** | Primer agente: Transcribor (con modo shadow) | 1 día | No (puede correr sin)|
| **D** | Segundo agente: Extractor objetivo | 1 día | No |
| **E** | Tercer agente: A5 Cotizaciones | 2-3 días | No |
| **F** | Visor M2 sub-tabs (Cotizaciones, Comparador, Objeciones, Seguimiento, Referidos, Recompra) | 2-3 días | No (puede ir en paralelo a D-E) |
| **G** | Tests E2E con datos reales (Lorena MORALES procesada con audios) | medio día | Cierre |

**Total estimado**: 8-10 días. **Empezar por A → B → C** (en serie). D, E, F en paralelo.

---

## 8. Pre-requisitos ANTES de codear

| # | Pre-requisito | Cómo lo obtenemos |
|---|---|---|
| 1 | API key DeepSeek | Jhon ya tiene en el viejo `.env` (variable `VITE_DEEPSEEK_API_KEY`). Verificar saldo |
| 2 | API key OpenAI (Whisper + Vision) | Pendiente: Jhon abre cuenta o reusa la del viejo. Verificar |
| 3 | Confirmación tope diario inicial | Default $5/día (decisión 24 ARQ) |
| 4 | Decidir: ¿Junior viene en M2 o después? | Doc visión sugiere después de cobertura completa. Lo dejo para M3+ |

---

## 9. Riesgos y mitigaciones

| Riesgo | Mitigación |
|---|---|
| **Whisper devuelve transcripción mala** (audio en español con jerga) | Modo shadow 7 días. Comparar muestras con audio original. Refinar prompt si necesario |
| **Vision se equivoca en imágenes de cotizaciones físicas** | Vision es para descripción general, no OCR fino. Para cotizaciones físicas, usar Vision + prompt específico |
| **Costo se dispara con clientes grandes** | Tope hard por invocación + tope diario. Junior alerta con proyección |
| **Agentes generan falsos positivos** (inferencia incorrecta) | Validador anti-alucinación (R-anti-alucinación). Buzón obligatorio para confianza < CONFIRMADO |
| **Race conditions cuando 5 agentes leen/escriben el mismo proyecto** | Lock optimista en proyecto vía `updated_at` + retry con backoff |
| **Pérdida de eventos durante caída de agente** | Catch-up cada 10s vía polling (mismo patrón que worker_pipeline v2.1) |
| **Bot loop: A5 genera evento que dispara A6 que dispara A5** | `evento_padre_id` + límite max profundidad 5. Detectar ciclos en validador |

---

## 10. Disciplina (lecciones del proyecto viejo)

1. **Mockup primero, backend después** — cada panel del Visor M2 arranca con datos fake
2. **NO escribir a tablas de negocio si confianza < CONFIRMADO** — siempre va al buzón
3. **Cero comunicación directa entre agentes** — solo `evento_pg`
4. **Cada agente con su propio worker** — caída aislada
5. **Modo shadow obligatorio para agente nuevo** (R-IA-001)
6. **Tope hard de costo** por invocación + diario
7. **Tests E2E con datos reales** antes de declarar agente listo

---

## 11. Decisiones que necesito de Jhon ANTES de arrancar

1. **API key OpenAI**: ¿se reusa la del viejo o cuenta nueva?
2. **Tope diario inicial**: ¿$5 o subimos antes de empezar?
3. **¿Empezamos por Fase A (infra) o querés ver mockup del panel comercial primero (Fase F)?**
   - Mi voto: **Fase A primero**. Sin LLM funcional, los mockups son adivinanza.
4. **¿Quién prueba la transcripción real?** Cuando el Transcribor procese a Lorena MORALES (1 ptt + 2 imágenes), vos validas la calidad de Whisper/Vision en español Colombia.

---

**FIN DEL DOCUMENTO. Cuando se inicie Fase A, agregar entrada en `MAPA.md` con `FASE 2.1 — Setup infraestructura agentes`.**
