-- 027 — Chat con Junior
-- Conversación entre Jhon y Junior (A10). Jhon escribe (rol='usuario', estado='pendiente'),
-- el worker lo ve, arma contexto con las síntesis de todos los clientes, llama al LLM,
-- y responde (rol='junior'). El Visor lee esta tabla y la muestra como chat.

CREATE TABLE IF NOT EXISTS junior_chat (
  id          BIGSERIAL PRIMARY KEY,
  rol         TEXT NOT NULL CHECK (rol IN ('usuario', 'junior')),
  mensaje     TEXT NOT NULL,
  estado      TEXT NOT NULL DEFAULT 'completo' CHECK (estado IN ('pendiente', 'completo', 'error')),
  costo_usd   NUMERIC(10,6) NOT NULL DEFAULT 0,
  modelo      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_junior_chat_pendiente ON junior_chat(created_at) WHERE estado = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_junior_chat_orden ON junior_chat(created_at);

ALTER TABLE junior_chat ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS junior_chat_all ON junior_chat;
CREATE POLICY junior_chat_all ON junior_chat
  FOR ALL USING (true) WITH CHECK (true);
