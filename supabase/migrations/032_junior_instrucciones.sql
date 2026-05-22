-- 032 — junior_instrucciones
--
-- Registro de todo lo que Jhon le instruye a Junior por el chat directo:
-- clientes nuevos, correcciones/novedades y preferencias que le enseña.
-- Es la fuente del módulo "Instrucciones por chat" del visor — como es un
-- visor, lo que se dicta por chat tiene que quedar documentado y visible.

CREATE TABLE IF NOT EXISTS junior_instrucciones (
  id              BIGSERIAL PRIMARY KEY,
  tipo            TEXT NOT NULL CHECK (tipo IN ('nuevo_cliente', 'correccion', 'memoria')),
  resumen         TEXT NOT NULL,
  persona_id      BIGINT REFERENCES personas(id) ON DELETE SET NULL,
  modulo          TEXT,
  sesion_id       BIGINT REFERENCES junior_sesiones(id) ON DELETE SET NULL,
  mensaje_chat_id BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_junior_instrucciones_fecha ON junior_instrucciones(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_junior_instrucciones_persona ON junior_instrucciones(persona_id);

ALTER TABLE junior_instrucciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS junior_instrucciones_all ON junior_instrucciones;
CREATE POLICY junior_instrucciones_all ON junior_instrucciones FOR ALL USING (true) WITH CHECK (true);
