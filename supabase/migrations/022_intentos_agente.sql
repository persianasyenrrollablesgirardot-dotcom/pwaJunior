-- F8.2 — Agregar contador de intentos por agente al evento_pg.
-- El runner lo usa para mover a dead_letter_queue tras 3 fallos consecutivos.

ALTER TABLE evento_pg
  ADD COLUMN IF NOT EXISTS intentos_agente SMALLINT NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_evento_pg_intentos_agente
  ON evento_pg(intentos_agente)
  WHERE intentos_agente > 0;

-- Verificación
SELECT column_name FROM information_schema.columns
WHERE table_name = 'evento_pg' AND column_name = 'intentos_agente';
