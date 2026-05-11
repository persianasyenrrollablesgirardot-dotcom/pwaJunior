-- F2.4 — Schema MÓDULO 2 Comerciales
-- Tablas: cotizaciones + cotizacion_items + cotizacion_objeciones
-- + vista vw_comerciales_resumen para el panel M2

-- 1. cotizaciones
CREATE TABLE IF NOT EXISTS cotizaciones (
  id                       BIGSERIAL PRIMARY KEY,
  proyecto_id              BIGINT REFERENCES proyectos(id) ON DELETE CASCADE,
  persona_id               BIGINT REFERENCES personas(id),
  ambito                   TEXT NOT NULL DEFAULT 'comercial',
  numero_cotizacion        TEXT,                                    -- ej. 'COT-5742' (puede ser NULL al crear, después se completa)
  fecha                    DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_vencimiento        DATE,
  estado                   TEXT NOT NULL DEFAULT 'propuesta'
    CHECK (estado IN ('propuesta','negociando','intencion_cierre','ganada','perdida','vencida','cancelada')),
  subtotal                 NUMERIC(14,2) NOT NULL DEFAULT 0,
  descuento_pct            NUMERIC(5,2) NOT NULL DEFAULT 0,
  descuento_monto          NUMERIC(14,2) NOT NULL DEFAULT 0,
  iva_monto                NUMERIC(14,2) NOT NULL DEFAULT 0,
  total                    NUMERIC(14,2) NOT NULL DEFAULT 0,
  abono_monto              NUMERIC(14,2),
  abono_fecha              DATE,
  abono_metodo             TEXT,                                    -- 'bancolombia' | 'efectivo' | 'transferencia' | etc.
  abono_referencia         TEXT,
  saldo                    NUMERIC(14,2) NOT NULL DEFAULT 0,
  notas                    TEXT,
  proxima_accion           TEXT,                                    -- 'enviar_factura' | 'confirmar_instalacion' | 'recordar_cliente' | etc.
  proxima_accion_fecha     DATE,
  agente_origen            TEXT,                                    -- NULL si la creó humano; código del agente si la creó IA (ej. 'A5')
  confianza                TEXT
    CHECK (confianza IS NULL OR confianza IN ('CONFIRMADO','INFERIDO','DUDOSO','ALERTA','RECHAZADO')),
  shadow                   BOOLEAN NOT NULL DEFAULT false,           -- true = creada en modo shadow por agente, no se muestra en UI principal
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_cotizaciones_proyecto ON cotizaciones(proyecto_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cotizaciones_persona  ON cotizaciones(persona_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_cotizaciones_estado   ON cotizaciones(estado)      WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_cotizacion_numero ON cotizaciones(numero_cotizacion) WHERE numero_cotizacion IS NOT NULL AND deleted_at IS NULL;

-- 2. cotizacion_items (productos por cotización)
CREATE TABLE IF NOT EXISTS cotizacion_items (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  sistema_safra_codigo     TEXT,                                    -- FK a sistemas_safra.codigo (suelto, no constraint para flexibilidad MVP)
  ambiente                 TEXT,                                    -- 'sala' | 'oficina' | 'dormitorio_principal' | etc.
  ancho_m                  NUMERIC(6,3),
  alto_m                   NUMERIC(6,3),
  area_m2                  NUMERIC(8,3) GENERATED ALWAYS AS (COALESCE(ancho_m,0) * COALESCE(alto_m,0)) STORED,
  cantidad                 INTEGER NOT NULL DEFAULT 1,
  precio_unitario          NUMERIC(14,2) NOT NULL DEFAULT 0,
  monto_total              NUMERIC(14,2) NOT NULL DEFAULT 0,
  color                    TEXT,
  accesorios               JSONB,                                   -- ['motor','riel','tapaluz']
  quien_midio              TEXT
    CHECK (quien_midio IS NULL OR quien_midio IN ('tecnico','cliente','familiar','otro')),
  riesgo_medicion          BOOLEAN NOT NULL DEFAULT false,          -- auto-true cuando quien_midio != 'tecnico' (R-013#1)
  notas                    TEXT,
  orden                    INTEGER NOT NULL DEFAULT 0,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cot_items_cotizacion ON cotizacion_items(cotizacion_id) WHERE deleted_at IS NULL;

-- Trigger: auto-flag riesgo_medicion cuando quien_midio NO es 'tecnico' (R-013#1)
CREATE OR REPLACE FUNCTION trg_riesgo_medicion_cotizacion_item() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quien_midio IS NOT NULL AND NEW.quien_midio != 'tecnico' THEN
    NEW.riesgo_medicion := true;
  ELSE
    NEW.riesgo_medicion := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cot_items_riesgo ON cotizacion_items;
CREATE TRIGGER trg_cot_items_riesgo
  BEFORE INSERT OR UPDATE OF quien_midio ON cotizacion_items
  FOR EACH ROW EXECUTE FUNCTION trg_riesgo_medicion_cotizacion_item();

-- 3. cotizacion_objeciones (registro de "muy caro", "lo pienso", etc.)
CREATE TABLE IF NOT EXISTS cotizacion_objeciones (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT NOT NULL REFERENCES cotizaciones(id) ON DELETE CASCADE,
  persona_id               BIGINT REFERENCES personas(id),
  tipo_objecion_codigo     TEXT NOT NULL,                           -- FK a tipos_objecion.codigo
  texto_cliente            TEXT,                                    -- la frase exacta del cliente si la tenemos
  respuesta_dada           TEXT,                                    -- qué se le respondió
  resultado                TEXT
    CHECK (resultado IS NULL OR resultado IN ('resuelto','persiste','cliente_se_fue','pendiente')),
  ts_objecion              TIMESTAMPTZ NOT NULL DEFAULT now(),
  notas                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_cot_obj_cotizacion ON cotizacion_objeciones(cotizacion_id) WHERE deleted_at IS NULL;

-- 4. Trigger genérico updated_at
CREATE OR REPLACE FUNCTION trg_updated_at_now() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cotizaciones_updated_at ON cotizaciones;
CREATE TRIGGER trg_cotizaciones_updated_at BEFORE UPDATE ON cotizaciones
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_cot_items_updated_at ON cotizacion_items;
CREATE TRIGGER trg_cot_items_updated_at BEFORE UPDATE ON cotizacion_items
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_cot_obj_updated_at ON cotizacion_objeciones;
CREATE TRIGGER trg_cot_obj_updated_at BEFORE UPDATE ON cotizacion_objeciones
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

-- 5. Vista vw_comerciales_resumen — resumen por cliente activo para el panel M2
CREATE OR REPLACE VIEW vw_comerciales_resumen AS
SELECT
  pe.id                                              AS persona_id,
  pe.nombre                                          AS persona_nombre,
  pe.telefono_e164                                   AS persona_telefono,
  COUNT(c.id) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow)                           AS cotizaciones_total,
  COUNT(c.id) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'propuesta')        AS cotizaciones_propuestas,
  COUNT(c.id) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'negociando')       AS cotizaciones_negociando,
  COUNT(c.id) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'ganada')           AS cotizaciones_ganadas,
  COUNT(c.id) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'perdida')          AS cotizaciones_perdidas,
  COUNT(c.id) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'vencida')          AS cotizaciones_vencidas,
  COALESCE(SUM(c.total) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow), 0)             AS monto_propuesto_total,
  COALESCE(SUM(c.total) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'ganada'), 0)  AS monto_ganado_total,
  COALESCE(SUM(c.abono_monto) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow), 0)        AS abonos_total,
  COALESCE(SUM(c.saldo) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow), 0)              AS saldo_pendiente_total,
  MAX(c.updated_at) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow)                                AS ultima_actividad
FROM personas pe
LEFT JOIN cotizaciones c ON c.persona_id = pe.id
WHERE pe.deleted_at IS NULL
GROUP BY pe.id, pe.nombre, pe.telefono_e164;

GRANT SELECT ON vw_comerciales_resumen TO anon, authenticated;
GRANT ALL ON cotizaciones, cotizacion_items, cotizacion_objeciones TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE cotizaciones_id_seq, cotizacion_items_id_seq, cotizacion_objeciones_id_seq TO anon, authenticated;

SELECT
  'cotizaciones' AS tabla, count(*) AS rows FROM cotizaciones
UNION ALL SELECT 'cotizacion_items', count(*) FROM cotizacion_items
UNION ALL SELECT 'cotizacion_objeciones', count(*) FROM cotizacion_objeciones;
