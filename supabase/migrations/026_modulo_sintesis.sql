-- 026 — Tabla modulo_sintesis
-- Guarda la síntesis redactada por los agentes-analistas, una por (cliente, módulo).
-- El Visor lee esto y muestra UNA conclusión arriba del módulo, en vez de tablas crudas.

CREATE TABLE IF NOT EXISTS modulo_sintesis (
  id              BIGSERIAL PRIMARY KEY,
  persona_id      BIGINT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
  modulo          TEXT NOT NULL,                    -- 'm1','m2',...,'m7'
  sintesis        TEXT,                             -- el análisis redactado
  estado          TEXT,                             -- frase corta de estado
  estado_semaforo TEXT CHECK (estado_semaforo IN ('verde','amarillo','rojo')),
  proximo_paso    TEXT,                             -- acción concreta recomendada
  alerta          TEXT,                             -- solo si hay algo urgente
  generado_por    TEXT,                             -- agente analista (ej. A_SINTESIS_M2)
  modelo          TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  costo_usd       NUMERIC(10,6) NOT NULL DEFAULT 0,
  generado_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (persona_id, modulo)
);

CREATE INDEX IF NOT EXISTS idx_modulo_sintesis_persona ON modulo_sintesis(persona_id);

ALTER TABLE modulo_sintesis ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS modulo_sintesis_all ON modulo_sintesis;
CREATE POLICY modulo_sintesis_all ON modulo_sintesis
  FOR ALL USING (true) WITH CHECK (true);
