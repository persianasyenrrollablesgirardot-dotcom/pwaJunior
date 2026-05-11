-- ============================================================================
-- 004_schema_ia.sql — Política de procesamiento IA (PARTE VI ARQUITECTURA.md)
-- Sección 50 del doc: schema y configuración de las 4 capas
-- ============================================================================

BEGIN;

-- 1. Flags por chat (las 4 capas se materializan acá)
ALTER TABLE chats ADD COLUMN IF NOT EXISTS ia_autorizado          BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS ia_historico_procesado BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS ia_bloqueado           BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS ia_bloqueado_motivo    TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS ia_bloqueado_at        TIMESTAMPTZ;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS ia_bloqueado_por       BIGINT REFERENCES usuarios(id);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS ia_costo_acumulado_usd NUMERIC(10,6) NOT NULL DEFAULT 0;

-- Índice útil para filtros de la Bandeja
CREATE INDEX IF NOT EXISTS idx_chats_ia_estado
  ON chats (ia_bloqueado, ia_autorizado, ia_historico_procesado)
  WHERE deleted_at IS NULL;

-- 2. Log de auto-autorizaciones (para auditar cuando modo ON auto-autoriza)
CREATE TABLE IF NOT EXISTS ia_auto_autorizaciones (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES chats(id),
  evento_disparador_id BIGINT REFERENCES evento_pg(id),
  origen TEXT NOT NULL CHECK (origen IN ('manual', 'modo_on_mensaje_nuevo', 'sistema')),
  mensajes_historicos_procesados INTEGER NOT NULL DEFAULT 0,
  costo_total_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. Alertas de costo emitidas por Junior
CREATE TABLE IF NOT EXISTS ia_alertas_costo (
  id BIGSERIAL PRIMARY KEY,
  tipo TEXT NOT NULL CHECK (tipo IN ('tope_superado', 'proyeccion_alta', 'auto_autorizacion_grande')),
  costo_actual_usd NUMERIC(10,6),
  proyeccion_dia_usd NUMERIC(10,6),
  mensaje TEXT NOT NULL,
  vista_por_jhon BOOLEAN NOT NULL DEFAULT false,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alertas_no_vistas
  ON ia_alertas_costo (ts DESC)
  WHERE vista_por_jhon = false;

-- 4. Configuración global (extender)
INSERT INTO configuracion_sistema (clave, valor, descripcion) VALUES
  ('ia_modo_global',                   '"OFF"', 'Toggle global. "OFF" = solo procesamiento manual. "ON" = tiempo real automático para todos los chats no bloqueados'),
  ('ia_tope_diario_alerta_usd',        '5.00',  'Tope diario blando. Junior alerta al superar pero NO detiene procesamiento (R-IA-006)'),
  ('ia_tope_diario_proyeccion_horas',  '24',    'Ventana para que Junior proyecte gasto del día'),
  ('ia_costo_estimado_por_mensaje_texto_usd', '0.0007', 'Estimación promedio por mensaje de texto procesado (DeepSeek)'),
  ('ia_costo_estimado_por_mensaje_media_usd', '0.005',  'Estimación por mensaje con media (Vision/Whisper)')
ON CONFLICT (clave) DO NOTHING;

-- 5. Vista útil para la Bandeja: estado IA de cada chat resumido
CREATE OR REPLACE VIEW vw_chats_estado_ia AS
SELECT
  c.id,
  c.canal,
  c.canal_chat_id,
  c.tipo,
  c.titulo,
  c.ambito,
  c.ambito_confirmado,
  c.proyecto_id,
  c.ia_autorizado,
  c.ia_historico_procesado,
  c.ia_bloqueado,
  c.ia_bloqueado_motivo,
  c.ia_costo_acumulado_usd,
  CASE
    WHEN c.ia_bloqueado THEN 'bloqueado'
    WHEN c.ia_historico_procesado THEN 'procesado'
    WHEN c.ia_autorizado AND NOT c.ia_historico_procesado THEN 'autorizado_pendiente'
    ELSE 'crudo'
  END AS ia_estado,
  (SELECT COUNT(*) FROM mensajes m WHERE m.chat_id = c.id AND m.deleted_at IS NULL) AS mensajes_total,
  (SELECT m.texto FROM mensajes m WHERE m.chat_id = c.id AND m.deleted_at IS NULL ORDER BY m.ts_canal DESC LIMIT 1) AS ultimo_mensaje_texto,
  (SELECT m.tipo FROM mensajes m WHERE m.chat_id = c.id AND m.deleted_at IS NULL ORDER BY m.ts_canal DESC LIMIT 1) AS ultimo_mensaje_tipo,
  (SELECT m.ts_canal FROM mensajes m WHERE m.chat_id = c.id AND m.deleted_at IS NULL ORDER BY m.ts_canal DESC LIMIT 1) AS ultimo_mensaje_ts,
  c.created_at,
  c.updated_at
FROM chats c
WHERE c.deleted_at IS NULL;

COMMIT;

SELECT json_build_object(
  'columnas_ia_chats', (SELECT json_agg(column_name ORDER BY column_name) FROM information_schema.columns WHERE table_name='chats' AND column_name LIKE 'ia_%'),
  'tablas_ia',         (SELECT json_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'ia_%'),
  'config_ia',         (SELECT json_agg(clave ORDER BY clave) FROM configuracion_sistema WHERE clave LIKE 'ia_%'),
  'vista_estado',      (SELECT EXISTS (SELECT 1 FROM information_schema.views WHERE table_schema='public' AND table_name='vw_chats_estado_ia'))
) AS resultado;
