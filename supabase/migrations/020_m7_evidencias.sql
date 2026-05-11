-- F7.1 — Schema MÓDULO 7 Evidencias
-- Tabla: evidencias (uploads manuales)
-- Vista: vw_evidencias_unificadas (combina TODAS las fuentes de evidencia
-- del sistema: mensajes con media + abonos.comprobante + facturas +
-- garantías.evidencia_urls + instalaciones.fotos_urls + evidencias manuales)

-- ─── 1. evidencias (7.1) — uploads manuales ─────────────────────────
CREATE TABLE IF NOT EXISTS evidencias (
  id                       BIGSERIAL PRIMARY KEY,
  persona_id               BIGINT REFERENCES personas(id),
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE SET NULL,
  instalacion_id           BIGINT REFERENCES instalaciones(id) ON DELETE SET NULL,
  factura_id               BIGINT REFERENCES facturas(id) ON DELETE SET NULL,
  abono_id                 BIGINT REFERENCES abonos(id) ON DELETE SET NULL,
  garantia_id              BIGINT REFERENCES garantias(id) ON DELETE SET NULL,
  evento_pg_id             BIGINT REFERENCES evento_pg(id) ON DELETE SET NULL,
  tipo                     TEXT NOT NULL
    CHECK (tipo IN ('foto','video','audio','comprobante','factura','cotizacion_pdf','pdf','imagen_medida','documento','otro')),
  url                      TEXT NOT NULL,
  mime                     TEXT,
  bytes                    INTEGER,
  descripcion              TEXT,
  capturado_por            TEXT,                                          -- 'jhon' | 'cliente' | 'tecnico_X' | 'sistema' | etc.
  texto_extraido           TEXT,                                          -- transcripción (audio) o OCR (factura)
  fecha                    DATE NOT NULL DEFAULT CURRENT_DATE,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  notas                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_evidencias_persona  ON evidencias(persona_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_evidencias_tipo     ON evidencias(tipo)       WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_evidencias_cot      ON evidencias(cotizacion_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_evidencias_inst     ON evidencias(instalacion_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_evidencias_evento   ON evidencias(evento_pg_id)   WHERE deleted_at IS NULL;

DROP TRIGGER IF EXISTS trg_evidencias_updated_at ON evidencias;
CREATE TRIGGER trg_evidencias_updated_at BEFORE UPDATE ON evidencias
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

-- ─── 2. Vista vw_evidencias_unificadas ──────────────────────────────
-- Combina TODAS las fuentes de evidencia del sistema en una sola lista.
-- "fuente" indica de qué tabla viene cada fila.
CREATE OR REPLACE VIEW vw_evidencias_unificadas AS

-- 1) Evidencias manuales
SELECT
  ('ev-'  || e.id)::TEXT        AS uid,
  'evidencia_manual'::TEXT      AS fuente,
  e.id                          AS source_id,
  e.persona_id,
  e.tipo                        AS tipo,
  e.url,
  e.mime,
  e.descripcion,
  e.capturado_por               AS quien,
  e.texto_extraido,
  e.fecha::TIMESTAMPTZ          AS ts,
  e.cotizacion_id,
  e.instalacion_id,
  e.factura_id,
  e.abono_id,
  e.garantia_id,
  e.evento_pg_id
FROM evidencias e
WHERE e.deleted_at IS NULL AND NOT e.shadow

UNION ALL

-- 2) Mensajes WhatsApp con media
SELECT
  ('msg-' || m.id)::TEXT        AS uid,
  'mensaje_wa'::TEXT            AS fuente,
  m.id                          AS source_id,
  proy.persona_id               AS persona_id,
  (CASE m.tipo
     WHEN 'audio'      THEN 'audio'
     WHEN 'imagen'     THEN 'foto'
     WHEN 'video'      THEN 'video'
     WHEN 'documento'  THEN 'documento'
     ELSE 'otro'
   END)                         AS tipo,
  m.media_url                   AS url,
  m.media_mime                  AS mime,
  COALESCE(m.texto, '(sin texto)') AS descripcion,
  CASE WHEN m.direccion = 'entrante' THEN 'cliente' ELSE 'empresa' END AS quien,
  m.texto                       AS texto_extraido,
  m.ts_canal                    AS ts,
  NULL::BIGINT                  AS cotizacion_id,
  NULL::BIGINT                  AS instalacion_id,
  NULL::BIGINT                  AS factura_id,
  NULL::BIGINT                  AS abono_id,
  NULL::BIGINT                  AS garantia_id,
  NULL::BIGINT                  AS evento_pg_id
FROM mensajes m
JOIN chats c     ON c.id = m.chat_id
LEFT JOIN proyectos proy ON proy.id = c.proyecto_id
WHERE m.deleted_at IS NULL
  AND m.tipo IN ('audio','imagen','video','documento')
  AND m.media_url IS NOT NULL

UNION ALL

-- 3) Comprobantes de abonos
SELECT
  ('abo-' || a.id)::TEXT        AS uid,
  'abono_comprobante'::TEXT     AS fuente,
  a.id                          AS source_id,
  a.persona_id,
  'comprobante'::TEXT           AS tipo,
  a.comprobante_url             AS url,
  NULL                          AS mime,
  ('Abono ' || COALESCE(a.metodo, '?') || ' ref ' || COALESCE(a.referencia, '?')) AS descripcion,
  COALESCE(a.metodo, 'banco')   AS quien,
  NULL                          AS texto_extraido,
  a.created_at                  AS ts,
  a.cotizacion_id,
  NULL::BIGINT                  AS instalacion_id,
  a.factura_id,
  a.id                          AS abono_id,
  NULL::BIGINT                  AS garantia_id,
  NULL::BIGINT                  AS evento_pg_id
FROM abonos a
WHERE a.deleted_at IS NULL AND NOT a.shadow AND a.comprobante_url IS NOT NULL

UNION ALL

-- 4) Fotos de instalaciones (arr -> unnest)
SELECT
  ('inst-' || i.id || '-' || idx)::TEXT  AS uid,
  'instalacion_foto'::TEXT       AS fuente,
  i.id                           AS source_id,
  i.persona_id,
  'foto'::TEXT                   AS tipo,
  url                            AS url,
  NULL                           AS mime,
  ('Foto instalación ' || i.fecha_programada::TEXT) AS descripcion,
  COALESCE(i.instalador, 'instalador') AS quien,
  NULL                           AS texto_extraido,
  COALESCE(i.fecha_real::TIMESTAMPTZ, i.fecha_programada::TIMESTAMPTZ) AS ts,
  i.cotizacion_id,
  i.id                           AS instalacion_id,
  NULL::BIGINT                   AS factura_id,
  NULL::BIGINT                   AS abono_id,
  NULL::BIGINT                   AS garantia_id,
  NULL::BIGINT                   AS evento_pg_id
FROM instalaciones i
CROSS JOIN LATERAL unnest(COALESCE(i.fotos_urls, ARRAY[]::TEXT[])) WITH ORDINALITY AS u(url, idx)
WHERE i.deleted_at IS NULL AND NOT i.shadow

UNION ALL

-- 5) Evidencias de garantías (arr -> unnest)
SELECT
  ('gar-' || g.id || '-' || idx)::TEXT  AS uid,
  'garantia_evidencia'::TEXT     AS fuente,
  g.id                           AS source_id,
  g.persona_id,
  'foto'::TEXT                   AS tipo,
  url                            AS url,
  NULL                           AS mime,
  ('Evidencia garantía ' || g.causa_codigo)  AS descripcion,
  'tecnico'                      AS quien,
  NULL                           AS texto_extraido,
  g.fecha_apertura::TIMESTAMPTZ  AS ts,
  g.cotizacion_id,
  g.instalacion_id,
  NULL::BIGINT                   AS factura_id,
  NULL::BIGINT                   AS abono_id,
  g.id                           AS garantia_id,
  NULL::BIGINT                   AS evento_pg_id
FROM garantias g
CROSS JOIN LATERAL unnest(COALESCE(g.evidencia_urls, ARRAY[]::TEXT[])) WITH ORDINALITY AS u(url, idx)
WHERE g.deleted_at IS NULL AND NOT g.shadow;

GRANT SELECT ON vw_evidencias_unificadas TO anon, authenticated;
GRANT ALL ON evidencias TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE evidencias_id_seq TO anon, authenticated;

SELECT json_build_object(
  'evidencias_manuales', (SELECT count(*) FROM evidencias WHERE deleted_at IS NULL),
  'evidencias_view_total', (SELECT count(*) FROM vw_evidencias_unificadas)
) AS resultado;
