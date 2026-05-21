-- 029 — Junior: sesiones de chat + memoria persistente
--
-- Sesiones: cada conversación con Junior es independiente (se puede abrir un
-- chat nuevo y volver a los viejos).
-- Memoria: lo que Junior debe recordar SIEMPRE, en cualquier sesión —
-- preferencias de comportamiento y datos que Jhon le enseña.

CREATE TABLE IF NOT EXISTS junior_sesiones (
  id               BIGSERIAL PRIMARY KEY,
  titulo           TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultima_actividad TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE junior_chat
  ADD COLUMN IF NOT EXISTS sesion_id BIGINT REFERENCES junior_sesiones(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_junior_chat_sesion ON junior_chat(sesion_id, created_at);

CREATE TABLE IF NOT EXISTS junior_memoria (
  id          BIGSERIAL PRIMARY KEY,
  tipo        TEXT NOT NULL DEFAULT 'nota' CHECK (tipo IN ('preferencia', 'dato', 'nota')),
  contenido   TEXT NOT NULL,
  vigente     BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_junior_memoria_vigente ON junior_memoria(created_at) WHERE vigente;

-- Sesión inicial para los mensajes que ya existían (si los hay).
INSERT INTO junior_sesiones (titulo) VALUES ('Conversación inicial');
UPDATE junior_chat SET sesion_id = (SELECT id FROM junior_sesiones ORDER BY id LIMIT 1)
  WHERE sesion_id IS NULL;

ALTER TABLE junior_sesiones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS junior_sesiones_all ON junior_sesiones;
CREATE POLICY junior_sesiones_all ON junior_sesiones FOR ALL USING (true) WITH CHECK (true);

ALTER TABLE junior_memoria ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS junior_memoria_all ON junior_memoria;
CREATE POLICY junior_memoria_all ON junior_memoria FOR ALL USING (true) WITH CHECK (true);
