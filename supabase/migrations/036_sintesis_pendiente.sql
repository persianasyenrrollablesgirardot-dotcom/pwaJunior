-- 036 — flag para disparar re-síntesis de una persona bajo demanda.
--
-- El Visor lo marca (ej. al reclasificar el ámbito de un contacto en el módulo
-- Clientes) y el worker (cicloSintesisPendiente en worker_pipeline_v2) lo
-- recoge, re-sintetiza al cliente y baja el flag. Así un cambio de
-- clasificación refresca el análisis al instante, sin esperar actividad nueva
-- del chat ni una corrección por el chat de Junior.

ALTER TABLE personas
  ADD COLUMN IF NOT EXISTS sintesis_pendiente BOOLEAN NOT NULL DEFAULT false;

-- Índice parcial: el worker consulta solo las marcadas (normalmente 0).
CREATE INDEX IF NOT EXISTS idx_personas_sintesis_pendiente
  ON personas (id) WHERE sintesis_pendiente = true;
