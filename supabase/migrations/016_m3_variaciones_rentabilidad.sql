-- F3.5 — Schema 3.4 Variaciones + 3.5 Rentabilidad
-- Tablas: cotizacion_variaciones + costos_proyecto
-- Vista: vw_rentabilidad (venta - sum costos por persona/cotización)

-- 1. cotizacion_variaciones — log de diferencias económicas entre cotización
-- y factura (descuentos, cambios de producto, retrabajos, etc.)
CREATE TABLE IF NOT EXISTS cotizacion_variaciones (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE CASCADE,
  factura_id               BIGINT REFERENCES facturas(id) ON DELETE SET NULL,
  persona_id               BIGINT REFERENCES personas(id),
  tipo                     TEXT NOT NULL,                            -- descuento | cambio_producto | cambio_medida | motor_agregado | ventana_eliminada | instalacion_negociada | cambio_garantia | cambio_cliente | otro
  monto_delta              NUMERIC(14,2) NOT NULL DEFAULT 0,         -- positivo = aumento (cliente paga +), negativo = disminución (cliente paga −)
  motivo                   TEXT,                                     -- explicación de la variación
  fecha                    DATE NOT NULL DEFAULT CURRENT_DATE,
  responsable              TEXT,                                     -- 'empresa' | 'cliente' | 'tercero' | NULL
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  notas                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_variaciones_cotizacion ON cotizacion_variaciones(cotizacion_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_variaciones_persona    ON cotizacion_variaciones(persona_id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_variaciones_tipo       ON cotizacion_variaciones(tipo)          WHERE deleted_at IS NULL;

-- 2. costos_proyecto — egresos por cotización (materia prima, motor, viáticos,
-- visitas extra, retrabajos, garantías ejecutadas, mano de obra).
-- Sirve para calcular rentabilidad real.
CREATE TABLE IF NOT EXISTS costos_proyecto (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE CASCADE,
  proyecto_id              BIGINT REFERENCES proyectos(id) ON DELETE SET NULL,
  persona_id               BIGINT REFERENCES personas(id),
  tipo                     TEXT NOT NULL,                            -- producto | motor | viatico | visita_extra | retrabajo | garantia_ejecutada | mano_obra | otro
  descripcion              TEXT,                                     -- "Tela blackout 4.5m² beige", "Visita extra por medidas mal tomadas", etc.
  monto                    NUMERIC(14,2) NOT NULL CHECK (monto >= 0),
  fecha                    DATE NOT NULL DEFAULT CURRENT_DATE,
  vendor                   TEXT,                                     -- a quién se le pagó (proveedor, instalador externo, etc.)
  comprobante_url          TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  notas                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_costos_cotizacion ON costos_proyecto(cotizacion_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_costos_proyecto   ON costos_proyecto(proyecto_id)   WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_costos_persona    ON costos_proyecto(persona_id)    WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_costos_tipo       ON costos_proyecto(tipo)          WHERE deleted_at IS NULL;

-- 3. Trigger updated_at
DROP TRIGGER IF EXISTS trg_variaciones_updated_at ON cotizacion_variaciones;
CREATE TRIGGER trg_variaciones_updated_at BEFORE UPDATE ON cotizacion_variaciones
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_costos_updated_at ON costos_proyecto;
CREATE TRIGGER trg_costos_updated_at BEFORE UPDATE ON costos_proyecto
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

-- 4. Vista vw_rentabilidad — margen por persona (sumando todas sus
-- cotizaciones GANADAS). Margen = venta_total − sum(costos) − sum(variaciones_negativas).
-- Las variaciones se restan SOLO si son negativas (descuento dado).
-- Cuando son positivas (cliente pagó más por agregado), suman a venta.
CREATE OR REPLACE VIEW vw_rentabilidad AS
SELECT
  p.id                                              AS persona_id,
  p.nombre                                          AS persona_nombre,
  COUNT(DISTINCT c.id) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'ganada')  AS cotizaciones_ganadas,
  COALESCE(SUM(c.total) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'ganada'), 0)  AS venta_total,
  COALESCE((SELECT SUM(monto) FROM costos_proyecto cp
            WHERE cp.persona_id = p.id AND cp.deleted_at IS NULL AND NOT cp.shadow), 0)             AS costo_total,
  COALESCE((SELECT SUM(monto_delta) FROM cotizacion_variaciones v
            WHERE v.persona_id = p.id AND v.deleted_at IS NULL AND NOT v.shadow), 0)                AS variaciones_neto,
  COALESCE(SUM(c.total) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'ganada'), 0)
    + COALESCE((SELECT SUM(monto_delta) FROM cotizacion_variaciones v
                WHERE v.persona_id = p.id AND v.deleted_at IS NULL AND NOT v.shadow), 0)
    - COALESCE((SELECT SUM(monto) FROM costos_proyecto cp
                WHERE cp.persona_id = p.id AND cp.deleted_at IS NULL AND NOT cp.shadow), 0)         AS margen
FROM personas p
LEFT JOIN cotizaciones c ON c.persona_id = p.id
WHERE p.deleted_at IS NULL
GROUP BY p.id, p.nombre
HAVING COUNT(DISTINCT c.id) FILTER (WHERE c.deleted_at IS NULL AND NOT c.shadow AND c.estado = 'ganada') > 0;

GRANT SELECT ON vw_rentabilidad TO anon, authenticated;
GRANT ALL ON cotizacion_variaciones, costos_proyecto TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE cotizacion_variaciones_id_seq, costos_proyecto_id_seq TO anon, authenticated;

SELECT json_build_object(
  'variaciones',       (SELECT count(*) FROM cotizacion_variaciones),
  'costos',            (SELECT count(*) FROM costos_proyecto),
  'personas_con_venta',(SELECT count(*) FROM vw_rentabilidad)
) AS resultado;
