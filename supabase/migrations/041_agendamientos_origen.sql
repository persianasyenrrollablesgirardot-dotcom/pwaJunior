-- 041 — agendamientos.origen
--
-- Para que el agente de agenda V2 pueda ALIMENTAR el calendario sin pisar las
-- citas manuales: marca sus entradas con origen='agente_v2' y regenera solo las
-- suyas. Las manuales (origen NULL / 'manual') quedan intactas.

ALTER TABLE agendamientos ADD COLUMN IF NOT EXISTS origen TEXT;

CREATE INDEX IF NOT EXISTS idx_agendamientos_origen ON agendamientos(persona_id, origen) WHERE deleted_at IS NULL;
