-- ═══════════════════════════════════════════════════════════
-- WhatsApp Captura Safra — Schema de Supabase
-- Correr UNA VEZ en el SQL Editor de tu proyecto Supabase
-- Tablas: ws_captures (capturas crudas) y ws_crm (procesadas)
-- ═══════════════════════════════════════════════════════════

-- ── Tabla de capturas crudas ────────────────────────────────

CREATE TABLE IF NOT EXISTS ws_captures (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact      TEXT NOT NULL,
  phone        TEXT,
  profile_pic  TEXT,
  presence     TEXT,
  last_seen    TEXT,
  is_group     BOOLEAN NOT NULL DEFAULT FALSE,
  date         DATE,
  messages     JSONB NOT NULL DEFAULT '[]',
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed    BOOLEAN NOT NULL DEFAULT FALSE,
  crm_id       UUID
);

-- Por si el date viene como string desde la extensión
ALTER TABLE ws_captures ALTER COLUMN date TYPE TEXT USING date::text;

CREATE INDEX IF NOT EXISTS ws_captures_updated_idx ON ws_captures(updated_at DESC);
CREATE INDEX IF NOT EXISTS ws_captures_contact_idx ON ws_captures(contact, date);

-- ── Tabla de registros CRM organizados ──────────────────────

CREATE TABLE IF NOT EXISTS ws_crm (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contacto        TEXT NOT NULL,
  telefono        TEXT,
  productos       JSONB,
  medidas         TEXT,
  precio_acordado NUMERIC,
  estado          TEXT,
  resumen         TEXT,
  proxima_accion  TEXT,
  prioridad       TEXT,
  fecha           DATE,
  fuente          TEXT DEFAULT 'whatsapp_web',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ws_crm_created_idx ON ws_crm(created_at DESC);

-- ── RLS: permitir operaciones con anon key ──────────────────
-- (El anon key está embebido en la extensión, equivalente a
--  una zona de trabajo interna. Si expones esto a terceros,
--  restringe las policies.)

ALTER TABLE ws_captures ENABLE ROW LEVEL SECURITY;
ALTER TABLE ws_crm      ENABLE ROW LEVEL SECURITY;

-- ws_captures
DROP POLICY IF EXISTS "ws_captures anon all" ON ws_captures;
CREATE POLICY "ws_captures anon all" ON ws_captures
  FOR ALL TO anon USING (true) WITH CHECK (true);

-- ws_crm
DROP POLICY IF EXISTS "ws_crm anon all" ON ws_crm;
CREATE POLICY "ws_crm anon all" ON ws_crm
  FOR ALL TO anon USING (true) WITH CHECK (true);
