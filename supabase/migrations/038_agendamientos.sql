-- 038 — Módulo de Agendamientos / Calendario
-- Tabla para registrar eventos con fechas, horas y descripciones estructuradas.

CREATE TABLE IF NOT EXISTS agendamientos (
  id           SERIAL PRIMARY KEY,
  persona_id   INT REFERENCES personas(id) ON DELETE SET NULL,
  titulo       VARCHAR(255) NOT NULL,
  tipo         VARCHAR(50) NOT NULL CHECK (tipo IN ('visita_medidas', 'instalacion', 'reunion_proveedor', 'personal', 'otro')),
  fecha        DATE NOT NULL,
  hora_inicio  TIME NOT NULL,
  hora_fin     TIME,
  direccion    TEXT,
  notas        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agendamientos_fecha ON agendamientos(fecha);
CREATE INDEX IF NOT EXISTS idx_agendamientos_persona ON agendamientos(persona_id) WHERE deleted_at IS NULL;

ALTER TABLE agendamientos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agendamientos_all ON agendamientos;
CREATE POLICY agendamientos_all ON agendamientos
  FOR ALL USING (true) WITH CHECK (true);
