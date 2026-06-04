-- 045 — Guard durable anti-base64 en mensajes.texto y evento_pg.payload.preview
--
-- PROBLEMA (raíz, app-wide): para mensajes de MEDIA (imagen/documento/video/
-- ubicación) WhatsApp Web a veces guarda el thumbnail JPEG en base64 dentro de
-- `row.body`. Una versión vieja de la captura (content.v2.js) lo copiaba a
-- `mensajes.texto`. Resultado: ~143 mensajes con ~600–36.000 chars de base64
-- ('/9j/4AAQ…') en texto, que:
--   - los agentes leen como "contenido" → basura al LLM + costo de tokens
--   - contaminan `texto_tsv` (búsqueda) y `evento_pg.payload.preview` + `payload_tsv`
--   - aparecen como "transcripción dañada" en la tarjeta / timeline
--
-- El fix en la extensión (guard `esTipoTextoPuro`) NO basta: la extensión MV3
-- corre código viejo en caliente (no recarga) y SIGUE insertando base64 (filas
-- con id >7000, recientes). El único punto que SIEMPRE se ejecuta es la BD.
--
-- FIX: trigger BEFORE INSERT OR UPDATE que detecta base64 puro de media (por
-- magic-prefix + charset base64 + longitud) y lo anula en origen. Independiente
-- de la extensión y del worker. Se nombra `*_aa_*` para correr ANTES del trigger
-- de tsv (orden alfabético en Postgres) → el índice se calcula sobre texto limpio.
--
-- Texto legítimo NUNCA empieza con esos magic-prefixes como cadena base64 pura
-- de 200+ chars; una transcripción real ("🖼 [Imagen] …") pasa intacta.

-- ─── Detector reusable ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION es_base64_media(t text) RETURNS boolean AS $$
BEGIN
  IF t IS NULL OR length(t) < 200 THEN RETURN false; END IF;
  -- magic-prefix de JPEG / PNG / PDF / GIF / WEBP en base64
  IF t LIKE '/9j/%' OR t LIKE 'iVBOR%' OR t LIKE 'JVBER%'
     OR t LIKE 'R0lGOD%' OR t LIKE 'UklGR%' THEN
    -- y todo el contenido es charset base64 (sin caption real mezclada)
    RETURN t ~ '^[A-Za-z0-9+/=[:space:]]+$';
  END IF;
  RETURN false;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ─── mensajes.texto ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_mensajes_strip_base64() RETURNS TRIGGER AS $$
BEGIN
  IF es_base64_media(NEW.texto) THEN
    NEW.metadata := COALESCE(NEW.metadata, '{}'::jsonb)
      || jsonb_build_object('texto_base64_bloqueado', true,
                            'texto_base64_kind', 'thumbnail_media');
    NEW.texto := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS mensajes_aa_strip_base64 ON mensajes;
CREATE TRIGGER mensajes_aa_strip_base64
  BEFORE INSERT OR UPDATE ON mensajes
  FOR EACH ROW EXECUTE FUNCTION trg_mensajes_strip_base64();

-- ─── evento_pg.payload.preview ───────────────────────────────────────────────
-- El preview se arma del texto del mensaje al crear el evento; si entró base64,
-- lo limpiamos también acá (el preview son ~120 chars → umbral más bajo).
CREATE OR REPLACE FUNCTION trg_evento_strip_base64() RETURNS TRIGGER AS $$
DECLARE prev text;
BEGIN
  prev := NEW.payload->>'preview';
  IF prev IS NOT NULL AND length(prev) >= 60
     AND (prev LIKE '/9j/%' OR prev LIKE 'iVBOR%' OR prev LIKE 'JVBER%'
          OR prev LIKE 'R0lGOD%' OR prev LIKE 'UklGR%')
     AND prev ~ '^[A-Za-z0-9+/=[:space:]]+$' THEN
    NEW.payload := jsonb_set(COALESCE(NEW.payload,'{}'::jsonb), '{preview}', to_jsonb(''::text));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS evento_pg_aa_strip_base64 ON evento_pg;
CREATE TRIGGER evento_pg_aa_strip_base64
  BEFORE INSERT OR UPDATE ON evento_pg
  FOR EACH ROW EXECUTE FUNCTION trg_evento_strip_base64();

-- ─── Backfill idempotente (limpia lo ya almacenado) ──────────────────────────
UPDATE mensajes
SET texto = NULL,
    metadata = COALESCE(metadata,'{}'::jsonb)
      || jsonb_build_object('texto_base64_bloqueado', true, 'texto_base64_kind','thumbnail_media')
WHERE es_base64_media(texto);

UPDATE evento_pg
SET payload = jsonb_set(COALESCE(payload,'{}'::jsonb), '{preview}', to_jsonb(''::text))
WHERE payload->>'preview' IS NOT NULL
  AND length(payload->>'preview') >= 60
  AND (payload->>'preview' LIKE '/9j/%' OR payload->>'preview' LIKE 'iVBOR%'
       OR payload->>'preview' LIKE 'JVBER%' OR payload->>'preview' LIKE 'R0lGOD%'
       OR payload->>'preview' LIKE 'UklGR%')
  AND payload->>'preview' ~ '^[A-Za-z0-9+/=[:space:]]+$';

SELECT json_build_object(
  'mensajes_con_base64_restantes', (SELECT count(*) FROM mensajes WHERE es_base64_media(texto)),
  'eventos_con_base64_restantes', (SELECT count(*) FROM evento_pg
      WHERE length(COALESCE(payload->>'preview','')) >= 60
        AND payload->>'preview' ~ '^(/9j/|iVBOR|JVBER|R0lGOD|UklGR)')
)::text AS r;
