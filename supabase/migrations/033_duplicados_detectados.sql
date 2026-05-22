-- 033 — duplicados_detectados
--
-- F7.3 cruce asistido. A3_IDENTIDAD detecta posibles personas duplicadas
-- (mismo nombre, distinto teléfono — el caso que F7.2 no resuelve solo). Cada
-- pareja sospechosa queda acá como 'pendiente'. Junior la plantea en el chat y
-- Jhon decide: fusionar (son la misma) o descartar (son distintas).

CREATE TABLE IF NOT EXISTS duplicados_detectados (
  id                   BIGSERIAL PRIMARY KEY,
  persona_nueva_id     BIGINT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  persona_existente_id BIGINT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  motivo               TEXT,
  score                NUMERIC,
  estado               TEXT NOT NULL DEFAULT 'pendiente'
                         CHECK (estado IN ('pendiente','fusionado','descartado')),
  detectado_por        TEXT NOT NULL DEFAULT 'A3_IDENTIDAD',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  resuelto_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_duplicados_estado   ON duplicados_detectados(estado, created_at);
CREATE INDEX IF NOT EXISTS idx_duplicados_personas ON duplicados_detectados(persona_nueva_id, persona_existente_id);

ALTER TABLE duplicados_detectados ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS duplicados_detectados_all ON duplicados_detectados;
CREATE POLICY duplicados_detectados_all ON duplicados_detectados FOR ALL USING (true) WITH CHECK (true);
