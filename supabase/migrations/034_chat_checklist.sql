-- 034 — chat_checklist
--
-- Módulo "Checklist por chat" de Junior. Una fila por chat con el estado de la
-- conversación: de quién es la pelota (sin_responder / te_toca / frio /
-- esperando_cliente / cerrada), el tipo (venta / garantía / consulta) con su
-- checklist de pasos, el próximo paso y los compromisos que el negocio prometió
-- y no cumplió. La mantiene el agente A_CHECKLIST — fila regenerada entera en
-- cada corrida (síntesis, no gestión manual).

CREATE TABLE IF NOT EXISTS chat_checklist (
  id                BIGSERIAL PRIMARY KEY,
  chat_id           BIGINT NOT NULL UNIQUE REFERENCES chats(id) ON DELETE CASCADE,
  persona_id        BIGINT REFERENCES personas(id) ON DELETE SET NULL,
  tipo              TEXT NOT NULL CHECK (tipo IN ('venta','garantia','consulta')),
  estado            TEXT NOT NULL CHECK (estado IN
                      ('sin_responder','te_toca','frio','esperando_cliente','cerrada')),
  proximo_paso      TEXT,
  motivo_cierre     TEXT,
  pasos             JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{label,hecho,responsable}]
  compromisos       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{texto,prometido_at}]
  ultimo_mensaje_ts TIMESTAMPTZ,                          -- ts del último mensaje analizado
  generado_por      TEXT,
  modelo            TEXT,
  costo_usd         NUMERIC(10,6) NOT NULL DEFAULT 0,
  actualizado_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_checklist_estado ON chat_checklist(estado);

ALTER TABLE chat_checklist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chat_checklist_all ON chat_checklist;
CREATE POLICY chat_checklist_all ON chat_checklist FOR ALL USING (true) WITH CHECK (true);
