-- 046 — Restauración del chat 342 "Jhon Guerrero" (2026-06-03)
--
-- Arreglo de DATOS puntual (no de esquema). Se versiona como migración a pedido
-- de Jhon para dejar traza en git; es idempotente y de un solo registro.
--
-- Contexto: durante la sesión de fixes de base64/identidad, el chat 342 fue
-- soft-deleted por una acción "Eliminar chat" de la UI (NO por scripts de
-- mantenimiento ni el worker) a las 2026-06-04T01:56:40.638Z (20:56 COT). El
-- cascade marcó en un solo timestamp: 1 chat + 24 mensajes + persona 265 (la
-- sobreviviente de la fusión con 251) + proyecto 180. El chat estaba ACTIVO al
-- inicio de la sesión, así que se restaura limpiando el deleted_at SOLO de las
-- filas de ese cascade exacto (no toca borrados de otras fechas).
--
-- Idempotente: si ya está restaurado (deleted_at NULL), no afecta filas.

UPDATE chats     SET deleted_at = NULL WHERE id = 342      AND deleted_at = '2026-06-04T01:56:40.638Z';
UPDATE mensajes  SET deleted_at = NULL WHERE chat_id = 342 AND deleted_at = '2026-06-04T01:56:40.638Z';
UPDATE personas  SET deleted_at = NULL WHERE id = 265      AND deleted_at = '2026-06-04T01:56:40.638Z';
UPDATE proyectos SET deleted_at = NULL WHERE id = 180      AND deleted_at = '2026-06-04T01:56:40.638Z';

SELECT json_build_object(
  'chat_342_activo',    (SELECT deleted_at IS NULL FROM chats WHERE id = 342),
  'mensajes_activos',   (SELECT count(*) FROM mensajes WHERE chat_id = 342 AND deleted_at IS NULL),
  'persona_265_activa', (SELECT deleted_at IS NULL FROM personas WHERE id = 265),
  'citas',              (SELECT count(*) FROM agendamientos WHERE persona_id = 265 AND deleted_at IS NULL),
  'activas_mismo_jid',  (SELECT count(*) FROM personas WHERE jid = '48967475790015@lid' AND deleted_at IS NULL)
)::text AS r;
