-- 039 — chat_checklist.cerrado_manual
--
-- Permite que Junior cierre el checklist de un chat por decisión humana
-- ("ya terminamos con este cliente", "caso cerrado y pagado") sin que el
-- agente A_CHECKLIST lo vuelva a regenerar en su próximo ciclo.
--
-- Cuando cerrado_manual=TRUE:
--   - chat_checklist se queda con tipo='no_aplica' + estado='cerrada' fijos
--   - cicloChecklist del worker salta ese chat (no lo manda al LLM)
--   - Si más tarde llega actividad nueva del cliente, Jhon puede reabrir
--     poniendo el flag en FALSE desde el chat de Junior (protocolo opuesto
--     a 'cierresChecklist', queda para más adelante si hace falta).
--
-- NULL en chat_checklist.motivo_cierre ya existía desde la 034; ahora también
-- lo usamos para guardar el motivo dado por Jhon.

ALTER TABLE chat_checklist
  ADD COLUMN IF NOT EXISTS cerrado_manual BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_chat_checklist_cerrado_manual
  ON chat_checklist(cerrado_manual) WHERE cerrado_manual = TRUE;
