-- 030 — Junior: resumen de conversación larga
--
-- Cuando una sesión supera el umbral de mensajes, los más viejos se resumen en
-- vez de descartarse. El resumen se guarda en la sesión; `resumen_msgs` indica
-- cuántos mensajes viejos cubre (para no regenerarlo si no cambió).

ALTER TABLE junior_sesiones ADD COLUMN IF NOT EXISTS resumen TEXT;
ALTER TABLE junior_sesiones ADD COLUMN IF NOT EXISTS resumen_msgs INT NOT NULL DEFAULT 0;
