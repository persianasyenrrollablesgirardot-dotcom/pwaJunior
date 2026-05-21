-- 028 — Correcciones humanas (el ciclo de aprendizaje)
-- Cada hecho/corrección que Jhon le da a Junior por el chat queda acá. Los
-- analistas la leen al re-sintetizar y la tratan como VERDAD PRIORITARIA:
-- el humano manda sobre el agente. Así el conocimiento de Jhon corrige y
-- alimenta al enjambre de forma permanente.

CREATE TABLE IF NOT EXISTS correcciones_humanas (
  id          BIGSERIAL PRIMARY KEY,
  persona_id  BIGINT REFERENCES personas(id) ON DELETE CASCADE,
  modulo      TEXT,                         -- 'm1'..'m7' o null si es general
  hecho       TEXT NOT NULL,                -- el hecho/corrección, en palabras de Jhon
  origen      TEXT NOT NULL DEFAULT 'chat_junior',
  vigente     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_correcciones_persona ON correcciones_humanas(persona_id) WHERE vigente;

ALTER TABLE correcciones_humanas ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS correcciones_humanas_all ON correcciones_humanas;
CREATE POLICY correcciones_humanas_all ON correcciones_humanas
  FOR ALL USING (true) WITH CHECK (true);
