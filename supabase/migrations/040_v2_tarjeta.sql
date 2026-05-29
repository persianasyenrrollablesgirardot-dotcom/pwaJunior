-- 040 — V2: tarjeta (contexto materializado por chat) + 3 derivados
--
-- Rediseño V2 (ARQUITECTURA_V2.md). AISLADO del modelo viejo: NO toca
-- chat_checklist / tareas / agendamientos existentes — corren en paralelo hasta
-- el corte (Hito 4). Acá viven la tarjeta y las 3 vistas derivadas.
--
--   tarjeta            → contexto materializado por chat (lo arma el AGREGADOR).
--   tarjeta_checklist  → estado de conversación (agente CHECKLIST).
--   tarjeta_tarea      → tareas (agente TAREAS).
--   tarjeta_agenda     → agendamientos (agente AGENDAMIENTO).
--
-- Los derivados se REGENERAN enteros por chat (síntesis, no gestión manual).
-- input_hash en tarjeta + derivado_de_hash en los derivados → idempotencia.

CREATE TABLE IF NOT EXISTS tarjeta (
  chat_id        BIGINT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  persona_id     BIGINT REFERENCES personas(id) ON DELETE SET NULL,
  tipo_contacto  TEXT NOT NULL DEFAULT 'comercial',
  contexto       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{modulo,titulo,sintesis,alerta}] verbatim de los 32
  notas          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- notas humanas (verdad prioritaria)
  narrativa      TEXT,                                 -- "estado general" (única parte LLM)
  input_hash     TEXT,                                 -- hash de (contexto+notas) → idempotencia
  dirty          BOOLEAN NOT NULL DEFAULT TRUE,        -- pendiente de reagregado
  costo_usd      NUMERIC(10,6) NOT NULL DEFAULT 0,
  generado_at    TIMESTAMPTZ,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tarjeta_checklist (
  chat_id             BIGINT PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  estado_conversacion TEXT NOT NULL CHECK (estado_conversacion IN
                        ('cerrado','espera_jhon','espera_cliente','sin_responder')),
  proximo_paso        TEXT,
  derivado_de_hash    TEXT,
  actualizado_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tarjeta_tarea (
  id               BIGSERIAL PRIMARY KEY,
  chat_id          BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  titulo           TEXT NOT NULL,
  prioridad        INT NOT NULL DEFAULT 2,
  derivado_de_hash TEXT,
  creado_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tarjeta_tarea_chat ON tarjeta_tarea(chat_id);

CREATE TABLE IF NOT EXISTS tarjeta_agenda (
  id               BIGSERIAL PRIMARY KEY,
  chat_id          BIGINT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  titulo           TEXT NOT NULL,
  cuando           TEXT,
  lugar            TEXT,
  derivado_de_hash TEXT,
  creado_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tarjeta_agenda_chat ON tarjeta_agenda(chat_id);

-- RLS permisivo (mismo patrón que el resto del esquema)
ALTER TABLE tarjeta           ENABLE ROW LEVEL SECURITY;
ALTER TABLE tarjeta_checklist ENABLE ROW LEVEL SECURITY;
ALTER TABLE tarjeta_tarea     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tarjeta_agenda    ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tarjeta_all ON tarjeta;
CREATE POLICY tarjeta_all ON tarjeta FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS tarjeta_checklist_all ON tarjeta_checklist;
CREATE POLICY tarjeta_checklist_all ON tarjeta_checklist FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS tarjeta_tarea_all ON tarjeta_tarea;
CREATE POLICY tarjeta_tarea_all ON tarjeta_tarea FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS tarjeta_agenda_all ON tarjeta_agenda;
CREATE POLICY tarjeta_agenda_all ON tarjeta_agenda FOR ALL USING (true) WITH CHECK (true);
