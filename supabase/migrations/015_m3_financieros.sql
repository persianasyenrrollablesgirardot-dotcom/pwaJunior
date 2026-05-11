-- F3.1 — Schema MÓDULO 3 Financieros
-- Tablas: facturas + abonos
-- + trigger que recalcula cotizaciones.abono_monto / saldo desde sum(abonos)
-- + backfill: los abonos inline (cotizaciones.abono_*) pasan a tabla abonos
-- + vista vw_cartera (personas con deuda > 0)

-- 1. facturas
CREATE TABLE IF NOT EXISTS facturas (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE SET NULL,
  proyecto_id              BIGINT REFERENCES proyectos(id) ON DELETE SET NULL,
  persona_id               BIGINT REFERENCES personas(id),
  numero_factura           TEXT NOT NULL,                            -- ej. 'FAC-001' (único cuando no está deleted)
  fecha                    DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_vencimiento        DATE,
  valor_total              NUMERIC(14,2) NOT NULL DEFAULT 0,
  estado                   TEXT NOT NULL DEFAULT 'emitida'
    CHECK (estado IN ('borrador','emitida','enviada','pagada','anulada')),
  notas                    TEXT,
  agente_origen            TEXT,                                     -- igual que cotizaciones
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_facturas_persona    ON facturas(persona_id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facturas_cotizacion ON facturas(cotizacion_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_facturas_estado     ON facturas(estado)        WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_factura_numero ON facturas(numero_factura) WHERE deleted_at IS NULL;

-- 2. abonos (múltiples abonos por cotización; reemplaza cotizaciones.abono_* inline)
CREATE TABLE IF NOT EXISTS abonos (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE CASCADE,
  factura_id               BIGINT REFERENCES facturas(id) ON DELETE SET NULL,
  persona_id               BIGINT REFERENCES personas(id),
  monto                    NUMERIC(14,2) NOT NULL CHECK (monto > 0),
  fecha                    DATE NOT NULL DEFAULT CURRENT_DATE,
  metodo                   TEXT,                                     -- bancolombia | nequi | daviplata | efectivo | transferencia | otro
  referencia               TEXT,                                     -- nro transacción, comprobante, etc.
  comprobante_url          TEXT,                                     -- URL a evidencia (foto del recibo)
  cuenta_receptora         TEXT,                                     -- a qué cuenta entró el dinero
  estado_validacion        TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado_validacion IN ('pendiente','confirmado','rechazado','inconsistente')),
  validado_por             BIGINT,                                   -- usuario que validó
  validado_at              TIMESTAMPTZ,
  notas                    TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_abonos_cotizacion ON abonos(cotizacion_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_abonos_factura    ON abonos(factura_id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_abonos_persona    ON abonos(persona_id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_abonos_estado     ON abonos(estado_validacion) WHERE deleted_at IS NULL;

-- 3. Trigger: cuando un abono cambia (insert/update/delete soft), recalcular
-- cotizaciones.abono_monto y saldo a partir de sum(abonos no rechazados).
CREATE OR REPLACE FUNCTION trg_recalc_cotizacion_abonos() RETURNS TRIGGER AS $$
DECLARE
  v_cot_id BIGINT;
  v_sum NUMERIC(14,2);
  v_total NUMERIC(14,2);
BEGIN
  v_cot_id := COALESCE(NEW.cotizacion_id, OLD.cotizacion_id);
  IF v_cot_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  -- Solo cuentan abonos no eliminados y NO rechazados (pendiente/confirmado/inconsistente sí cuentan)
  SELECT COALESCE(SUM(monto), 0) INTO v_sum
  FROM abonos
  WHERE cotizacion_id = v_cot_id
    AND deleted_at IS NULL
    AND estado_validacion != 'rechazado'
    AND NOT shadow;

  SELECT total INTO v_total FROM cotizaciones WHERE id = v_cot_id;

  UPDATE cotizaciones SET
    abono_monto = v_sum,
    saldo = COALESCE(v_total, 0) - v_sum,
    updated_at = now()
  WHERE id = v_cot_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_abonos_recalc ON abonos;
CREATE TRIGGER trg_abonos_recalc
  AFTER INSERT OR UPDATE OR DELETE ON abonos
  FOR EACH ROW EXECUTE FUNCTION trg_recalc_cotizacion_abonos();

-- 4. Trigger updated_at
DROP TRIGGER IF EXISTS trg_facturas_updated_at ON facturas;
CREATE TRIGGER trg_facturas_updated_at BEFORE UPDATE ON facturas
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_abonos_updated_at ON abonos;
CREATE TRIGGER trg_abonos_updated_at BEFORE UPDATE ON abonos
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

-- 5. BACKFILL: convertir los abonos inline de cotizaciones a filas en abonos
INSERT INTO abonos (cotizacion_id, persona_id, monto, fecha, metodo, referencia, estado_validacion, notas, created_at)
SELECT
  c.id,
  c.persona_id,
  c.abono_monto,
  COALESCE(c.abono_fecha, CURRENT_DATE),
  c.abono_metodo,
  c.abono_referencia,
  'confirmado',                              -- los inline históricos los marcamos confirmados (eran del modo viejo de "1 abono inline")
  'Migrado automáticamente desde cotizaciones.abono_* inline (F3.1)',
  COALESCE(c.created_at, now())
FROM cotizaciones c
WHERE c.abono_monto IS NOT NULL
  AND c.abono_monto > 0
  AND c.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM abonos a WHERE a.cotizacion_id = c.id AND a.notas LIKE 'Migrado automáticamente%');

-- 6. Vista vw_cartera — solo personas con DEUDA real (saldo > 0)
CREATE OR REPLACE VIEW vw_cartera AS
SELECT
  p.id                                              AS persona_id,
  p.nombre                                          AS persona_nombre,
  p.telefono_e164                                   AS persona_telefono,
  p.email                                           AS persona_email,
  p.ciudad                                          AS persona_ciudad,
  COUNT(DISTINCT c.id) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.saldo > 0)                        AS cotizaciones_con_saldo,
  COUNT(DISTINCT f.id) FILTER (WHERE f.deleted_at IS NULL AND NOT f.shadow AND f.estado IN ('emitida','enviada'))   AS facturas_pendientes,
  COALESCE(SUM(c.total)      FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'ganada'), 0)       AS facturado_total,
  COALESCE(SUM(c.abono_monto) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow), 0)                              AS abonado_total,
  COALESCE(SUM(c.saldo)      FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.saldo > 0), 0)               AS deuda_total,
  MAX(c.updated_at)          FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow)                                   AS ultima_actividad
FROM personas p
JOIN cotizaciones c   ON c.persona_id = p.id
LEFT JOIN facturas f  ON f.persona_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.nombre, p.telefono_e164, p.email, p.ciudad
HAVING COALESCE(SUM(c.saldo) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.saldo > 0), 0) > 0;

GRANT SELECT ON vw_cartera TO anon, authenticated;
GRANT ALL ON facturas, abonos TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE facturas_id_seq, abonos_id_seq TO anon, authenticated;

-- Verificación final
SELECT json_build_object(
  'facturas',          (SELECT count(*) FROM facturas),
  'abonos',            (SELECT count(*) FROM abonos),
  'abonos_backfill',   (SELECT count(*) FROM abonos WHERE notas LIKE 'Migrado automáticamente%'),
  'personas_en_cartera', (SELECT count(*) FROM vw_cartera)
) AS resultado;
