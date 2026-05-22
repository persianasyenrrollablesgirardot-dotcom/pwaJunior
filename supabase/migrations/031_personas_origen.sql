-- 031 — personas.origen
--
-- Distingue clientes que nacieron de un chat de WhatsApp ('whatsapp') de los
-- que Jhon registra a mano por Junior ('manual') — clientes que llegaron al
-- local o contactaron por otro medio. Las personas existentes son todas de
-- WhatsApp (default).

ALTER TABLE personas ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (origen IN ('whatsapp', 'manual'));
