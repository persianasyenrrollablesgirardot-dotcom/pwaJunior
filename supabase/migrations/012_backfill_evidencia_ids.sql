-- F1.21: backfill de evidencia_ids para eventos viejos creados antes del fix.
--
-- Los eventos 'mensaje_entrante'/'mensaje_saliente' se crearon UNO por cada mensaje
-- del chat, en el mismo orden de inserción (mismo ts_canal). Matcheamos cada evento
-- con su mensaje correspondiente por (chat_id, ts_canal) y populamos evidencia_ids.

WITH matches AS (
  SELECT DISTINCT ON (e.id)
    e.id              AS evento_id,
    m.canal_msg_id    AS msg_id
  FROM evento_pg e
  INNER JOIN mensajes m
    ON m.chat_id = e.chat_id
   AND m.ts_canal = e.ts_canal
   AND m.deleted_at IS NULL
  WHERE e.tipo_evento IN ('mensaje_entrante', 'mensaje_saliente')
    AND (e.evidencia_ids IS NULL OR e.evidencia_ids->'msg_ids' IS NULL)
)
UPDATE evento_pg e
SET evidencia_ids = jsonb_build_object('msg_ids', jsonb_build_array(matches.msg_id))
FROM matches
WHERE e.id = matches.evento_id;

-- Y ahora re-ejecutar el sync de previews (ahora sí va a matchear)
UPDATE evento_pg e
SET payload = jsonb_set(
  COALESCE(e.payload, '{}'::jsonb),
  '{preview}',
  to_jsonb(LEFT(COALESCE(m.texto, ''), 120))
)
FROM mensajes m
WHERE e.evidencia_ids IS NOT NULL
  AND e.evidencia_ids->'msg_ids' ? m.canal_msg_id
  AND m.deleted_at IS NULL;

SELECT
  (SELECT count(*) FROM evento_pg WHERE evidencia_ids IS NOT NULL AND evidencia_ids->'msg_ids' IS NOT NULL) AS eventos_con_evidencia,
  (SELECT count(*) FROM evento_pg) AS eventos_total,
  (SELECT json_agg(json_build_object(
    'id', id, 'preview', LEFT(payload->>'preview', 60), 'msg_ids', evidencia_ids->'msg_ids'
  )) FROM (SELECT id, payload, evidencia_ids FROM evento_pg WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE '%Jorge%') LIMIT 5) s) AS sample;
