-- F1.21: trigger para mantener evento_pg.payload.preview sincronizado con mensajes.texto.
--
-- Problema: cuando se transcribe una imagen/audio, mensajes.texto pasa de "[base64
-- corrupto del thumbnail]" a "🖼 [Imagen] descripción IA". Pero los eventos
-- 'mensaje_entrante'/'mensaje_saliente' creados al procesar el chat tienen
-- payload.preview con el texto VIEJO (basura). Timeline/EventoPGVista siguen
-- mostrando esa basura.
--
-- Fix: trigger AFTER UPDATE en mensajes que propaga el cambio a eventos con
-- el canal_msg_id en evidencia_ids.msg_ids.

CREATE OR REPLACE FUNCTION sync_evento_preview_from_mensaje() RETURNS TRIGGER AS $$
BEGIN
  -- Solo si el texto realmente cambió (evita loops y trabajo innecesario)
  IF NEW.texto IS DISTINCT FROM OLD.texto THEN
    UPDATE evento_pg
    SET payload = jsonb_set(
      COALESCE(payload, '{}'::jsonb),
      '{preview}',
      to_jsonb(LEFT(COALESCE(NEW.texto, ''), 120))
    )
    WHERE evidencia_ids IS NOT NULL
      AND evidencia_ids->'msg_ids' ? NEW.canal_msg_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_evento_preview ON mensajes;
CREATE TRIGGER trg_sync_evento_preview
  AFTER UPDATE ON mensajes
  FOR EACH ROW
  EXECUTE FUNCTION sync_evento_preview_from_mensaje();

-- Backfill one-shot: sincronizar todos los previews ya almacenados con el texto
-- actual del mensaje correspondiente (arregla los eventos que ya tienen basura
-- del thumbnail base64).
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

SELECT json_build_object(
  'eventos_actualizados', (SELECT count(*) FROM evento_pg WHERE evidencia_ids IS NOT NULL),
  'sample_preview_pre_post', (
    SELECT json_agg(json_build_object(
      'evento_id', id,
      'tipo_evento', tipo_evento,
      'preview_actual', LEFT(payload->>'preview', 80),
      'msg_ids', evidencia_ids->'msg_ids'
    ))
    FROM evento_pg
    WHERE chat_id IN (SELECT id FROM chats WHERE titulo LIKE '%Jorge%')
    LIMIT 5
  )
)::text AS r;
