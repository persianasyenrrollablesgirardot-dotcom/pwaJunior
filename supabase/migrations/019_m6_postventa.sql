-- F6.1 — Schema MÓDULO 6 Postventa
-- Tablas: garantias + mantenimientos + satisfaccion_postventa + google_reviews + reclamos_sensibles
-- Vista: vw_reputacion (resumen Google Reviews + tasa satisfaccion)

-- ─── 1. garantias (6.1) ─────────────────────────────────────────────
-- FK a causas_garantia (catálogo ya seeded en migración 003: producto,
-- instalacion, cliente, ambiente, tercero, construccion).
CREATE TABLE IF NOT EXISTS garantias (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE SET NULL,
  instalacion_id           BIGINT REFERENCES instalaciones(id) ON DELETE SET NULL,
  persona_id               BIGINT REFERENCES personas(id),
  sistema_safra_codigo     TEXT REFERENCES sistemas_safra(codigo),     -- qué producto falló
  fecha_apertura           DATE NOT NULL DEFAULT CURRENT_DATE,
  causa_codigo             TEXT NOT NULL REFERENCES causas_garantia(codigo),
  responsable              TEXT
    CHECK (responsable IS NULL OR responsable IN ('empresa','cliente','tercero')),
  costo                    NUMERIC(14,2) DEFAULT 0,
  solucion                 TEXT,
  estado                   TEXT NOT NULL DEFAULT 'abierta'
    CHECK (estado IN ('abierta','en_diagnostico','en_reparacion','resuelta','rechazada','cerrada')),
  fecha_cierre             DATE,
  evidencia_urls           TEXT[],
  notas                    TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_garantias_persona  ON garantias(persona_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_garantias_estado   ON garantias(estado)      WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_garantias_causa    ON garantias(causa_codigo) WHERE deleted_at IS NULL;

-- Trigger: auto-rellenar responsable desde causas_garantia.responsable_default
CREATE OR REPLACE FUNCTION trg_garantia_auto_responsable() RETURNS TRIGGER AS $$
DECLARE
  v_resp TEXT;
BEGIN
  IF NEW.responsable IS NULL AND NEW.causa_codigo IS NOT NULL THEN
    SELECT responsable_default INTO v_resp FROM causas_garantia WHERE codigo = NEW.causa_codigo;
    NEW.responsable := v_resp;
  END IF;
  -- Si pasa a resuelta/cerrada/rechazada y no tiene fecha_cierre, ponerla
  IF NEW.estado IN ('resuelta','cerrada','rechazada') AND NEW.fecha_cierre IS NULL THEN
    NEW.fecha_cierre := CURRENT_DATE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_garantias_responsable ON garantias;
CREATE TRIGGER trg_garantias_responsable
  BEFORE INSERT OR UPDATE OF causa_codigo, estado ON garantias
  FOR EACH ROW EXECUTE FUNCTION trg_garantia_auto_responsable();

-- ─── 2. mantenimientos (6.2) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mantenimientos (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE SET NULL,
  persona_id               BIGINT REFERENCES personas(id),
  tipo                     TEXT NOT NULL
    CHECK (tipo IN ('lavado','perfilado','cambio_cadenilla','cambio_control','cambio_tubo','nivelacion','ajuste_soporte','cambio_peso_inferior','otro')),
  fecha_programada         DATE,
  fecha_real               DATE,
  instalador               TEXT,
  costo                    NUMERIC(14,2) DEFAULT 0,
  resultado                TEXT
    CHECK (resultado IS NULL OR resultado IN ('completo','parcial','no_aplicable','pendiente_repuesto','reagendado')),
  notas                    TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_mantenimientos_persona ON mantenimientos(persona_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mantenimientos_tipo    ON mantenimientos(tipo)       WHERE deleted_at IS NULL;

-- ─── 3. satisfaccion_postventa (6.3) ────────────────────────────────
CREATE TABLE IF NOT EXISTS satisfaccion_postventa (
  id                       BIGSERIAL PRIMARY KEY,
  instalacion_id           BIGINT REFERENCES instalaciones(id) ON DELETE SET NULL,
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE SET NULL,
  persona_id               BIGINT REFERENCES personas(id),
  estado_cliente           TEXT NOT NULL
    CHECK (estado_cliente IN ('feliz','confundido','molesto','sin_respuesta','pendiente_ajuste')),
  fecha_check              DATE NOT NULL DEFAULT CURRENT_DATE,
  fuente                   TEXT,                                          -- 'whatsapp' | 'llamada' | 'visita' | 'web' | 'inferido'
  notas                    TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_satis_persona ON satisfaccion_postventa(persona_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_satis_estado  ON satisfaccion_postventa(estado_cliente) WHERE deleted_at IS NULL;

-- ─── 4. google_reviews (6.4) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS google_reviews (
  id                       BIGSERIAL PRIMARY KEY,
  persona_id               BIGINT REFERENCES personas(id),
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE SET NULL,
  apto_para_resena         BOOLEAN NOT NULL DEFAULT false,
  solicitud_enviada_at     TIMESTAMPTZ,
  resena_recibida_at       TIMESTAMPTZ,
  estrellas                SMALLINT CHECK (estrellas IS NULL OR estrellas BETWEEN 1 AND 5),
  comentario               TEXT,
  url_resena               TEXT,
  estado                   TEXT NOT NULL DEFAULT 'no_apto'
    CHECK (estado IN ('no_apto','apto','solicitada','recibida','rechazada_cliente','ignorada')),
  notas                    TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT,
  UNIQUE (persona_id, cotizacion_id)
);

CREATE INDEX IF NOT EXISTS idx_reviews_persona  ON google_reviews(persona_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_estado   ON google_reviews(estado)     WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reviews_estrellas ON google_reviews(estrellas) WHERE deleted_at IS NULL;

-- Trigger: cuando estrellas o comentario cambian a no-null, marcar estado=recibida
CREATE OR REPLACE FUNCTION trg_review_auto_estado() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.estrellas IS NOT NULL AND NEW.estado != 'recibida' THEN
    NEW.estado := 'recibida';
    IF NEW.resena_recibida_at IS NULL THEN NEW.resena_recibida_at := now(); END IF;
  END IF;
  IF NEW.apto_para_resena AND NEW.estado = 'no_apto' THEN
    NEW.estado := 'apto';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reviews_estado ON google_reviews;
CREATE TRIGGER trg_reviews_estado
  BEFORE INSERT OR UPDATE OF estrellas, apto_para_resena ON google_reviews
  FOR EACH ROW EXECUTE FUNCTION trg_review_auto_estado();

-- ─── 5. reclamos_sensibles (6.5) ────────────────────────────────────
CREATE TABLE IF NOT EXISTS reclamos_sensibles (
  id                       BIGSERIAL PRIMARY KEY,
  persona_id               BIGINT REFERENCES personas(id),
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE SET NULL,
  garantia_id              BIGINT REFERENCES garantias(id) ON DELETE SET NULL,
  motivo                   TEXT NOT NULL
    CHECK (motivo IN ('cliente_molesto','garantia_mal_manejada','dano_costoso','publicacion_negativa','mala_resena','incumplimiento','otro')),
  severidad                TEXT NOT NULL DEFAULT 'media'
    CHECK (severidad IN ('baja','media','alta','critica')),
  estado                   TEXT NOT NULL DEFAULT 'abierto'
    CHECK (estado IN ('abierto','en_contencion','escalado','resuelto','cerrado_negativo')),
  escalado_a               TEXT,                                          -- 'jhon' | 'abogado' | 'gerente' | etc.
  fecha_apertura           DATE NOT NULL DEFAULT CURRENT_DATE,
  fecha_resolucion         DATE,
  acciones_tomadas         TEXT,
  resultado                TEXT,
  notas                    TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_reclamos_persona  ON reclamos_sensibles(persona_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reclamos_severidad ON reclamos_sensibles(severidad) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_reclamos_estado    ON reclamos_sensibles(estado)    WHERE deleted_at IS NULL;

-- ─── 6. Triggers updated_at ─────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_garantias_updated_at ON garantias;
CREATE TRIGGER trg_garantias_updated_at BEFORE UPDATE ON garantias FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_mantenimientos_updated_at ON mantenimientos;
CREATE TRIGGER trg_mantenimientos_updated_at BEFORE UPDATE ON mantenimientos FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_satis_updated_at ON satisfaccion_postventa;
CREATE TRIGGER trg_satis_updated_at BEFORE UPDATE ON satisfaccion_postventa FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_reviews_updated_at ON google_reviews;
CREATE TRIGGER trg_reviews_updated_at BEFORE UPDATE ON google_reviews FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_reclamos_updated_at ON reclamos_sensibles;
CREATE TRIGGER trg_reclamos_updated_at BEFORE UPDATE ON reclamos_sensibles FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

-- ─── 7. Vista vw_reputacion ─────────────────────────────────────────
-- Resumen global de Google Reviews + tasa satisfacción
CREATE OR REPLACE VIEW vw_reputacion AS
SELECT
  (SELECT count(*) FROM google_reviews WHERE deleted_at IS NULL AND NOT shadow AND estado = 'recibida')  AS reviews_total,
  (SELECT AVG(estrellas)::NUMERIC(4,2) FROM google_reviews WHERE deleted_at IS NULL AND NOT shadow AND estrellas IS NOT NULL)  AS estrellas_promedio,
  (SELECT count(*) FROM google_reviews WHERE deleted_at IS NULL AND NOT shadow AND estrellas = 5)        AS cinco_estrellas,
  (SELECT count(*) FROM google_reviews WHERE deleted_at IS NULL AND NOT shadow AND estrellas <= 3 AND estrellas IS NOT NULL) AS tres_o_menos,
  (SELECT count(*) FROM google_reviews WHERE deleted_at IS NULL AND NOT shadow AND estado = 'solicitada') AS solicitadas_pendientes,
  (SELECT count(*) FROM google_reviews WHERE deleted_at IS NULL AND NOT shadow AND estado = 'apto')       AS aptos_sin_solicitar,
  (SELECT count(*) FROM satisfaccion_postventa WHERE deleted_at IS NULL AND NOT shadow AND estado_cliente = 'feliz')     AS clientes_felices,
  (SELECT count(*) FROM satisfaccion_postventa WHERE deleted_at IS NULL AND NOT shadow AND estado_cliente = 'molesto')    AS clientes_molestos,
  (SELECT count(*) FROM reclamos_sensibles WHERE deleted_at IS NULL AND NOT shadow AND estado IN ('abierto','en_contencion','escalado'))  AS reclamos_activos,
  (SELECT count(*) FROM reclamos_sensibles WHERE deleted_at IS NULL AND NOT shadow AND severidad IN ('alta','critica') AND estado != 'resuelto') AS reclamos_alta_severidad;

GRANT SELECT ON vw_reputacion TO anon, authenticated;
GRANT ALL ON garantias, mantenimientos, satisfaccion_postventa, google_reviews, reclamos_sensibles TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE garantias_id_seq, mantenimientos_id_seq, satisfaccion_postventa_id_seq, google_reviews_id_seq, reclamos_sensibles_id_seq TO anon, authenticated;

SELECT json_build_object(
  'garantias',              (SELECT count(*) FROM garantias),
  'mantenimientos',         (SELECT count(*) FROM mantenimientos),
  'satisfaccion',           (SELECT count(*) FROM satisfaccion_postventa),
  'google_reviews',         (SELECT count(*) FROM google_reviews),
  'reclamos_sensibles',     (SELECT count(*) FROM reclamos_sensibles)
) AS resultado;
