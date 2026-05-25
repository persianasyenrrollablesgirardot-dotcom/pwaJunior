-- 037 — agrega 'no_aplica' como cuarto tipo de chat_checklist.
--
-- Cuando el contacto NO es un cliente comercial (es proveedor, contacto
-- personal, equipo interno), el agente A_CHECKLIST no debe inventar pasos
-- de venta / garantía / consulta. Devuelve tipo='no_aplica' con estado
-- 'cerrada' para que la pestaña Checklist no muestre acciones inexistentes.

ALTER TABLE chat_checklist DROP CONSTRAINT IF EXISTS chat_checklist_tipo_check;
ALTER TABLE chat_checklist
  ADD CONSTRAINT chat_checklist_tipo_check
  CHECK (tipo IN ('venta','garantia','consulta','no_aplica'));
