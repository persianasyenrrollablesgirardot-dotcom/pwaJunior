-- ============================================================================
-- 006_campos_faltantes.sql
-- Agrega campos del doc de visión sección 1.2 / 1.3 + auditoría humana (1.4 9.2)
-- 2026-05-08
-- ============================================================================

BEGIN;

-- 1. Personas: campos del doc visión 1.2 que faltaban
ALTER TABLE personas ADD COLUMN IF NOT EXISTS referido_por_persona_id BIGINT REFERENCES personas(id);
ALTER TABLE personas ADD COLUMN IF NOT EXISTS contacto_alterno_nombre TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS contacto_alterno_telefono TEXT;
ALTER TABLE personas ADD COLUMN IF NOT EXISTS actualizado_por BIGINT REFERENCES usuarios(id);

-- 2. Inmuebles: solo audit
ALTER TABLE inmuebles ADD COLUMN IF NOT EXISTS actualizado_por BIGINT REFERENCES usuarios(id);

-- 3. Proyectos: solo audit
ALTER TABLE proyectos ADD COLUMN IF NOT EXISTS actualizado_por BIGINT REFERENCES usuarios(id);

-- Index para búsqueda de referidos (cliente recurrente, sección 1.2 doc)
CREATE INDEX IF NOT EXISTS idx_personas_referido_por
  ON personas (referido_por_persona_id) WHERE deleted_at IS NULL;

COMMIT;

SELECT (json_build_object(
  'personas_nuevos', (SELECT json_agg(column_name) FROM information_schema.columns WHERE table_name='personas' AND column_name IN ('referido_por_persona_id','contacto_alterno_nombre','contacto_alterno_telefono','actualizado_por')),
  'inmuebles_nuevos', (SELECT json_agg(column_name) FROM information_schema.columns WHERE table_name='inmuebles' AND column_name = 'actualizado_por'),
  'proyectos_nuevos', (SELECT json_agg(column_name) FROM information_schema.columns WHERE table_name='proyectos' AND column_name = 'actualizado_por')
))::text AS r;
