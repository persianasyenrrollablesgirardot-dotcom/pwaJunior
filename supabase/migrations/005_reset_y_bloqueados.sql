-- ============================================================================
-- 005_reset_y_bloqueados.sql
-- 1. Limpiar BD de test (chats, mensajes, eventos, personas, proyectos, etc.)
-- 2. Crear tabla chats_bloqueados (persiste bloqueo aunque se reinstale extensión)
-- ============================================================================

BEGIN;

-- 1. Borrar datos de test (preservar catálogos, usuarios, configuración)
UPDATE chats SET proyecto_id = NULL;       -- romper FK chat→proyecto
DELETE FROM ia_alertas_costo;
DELETE FROM ia_auto_autorizaciones;
DELETE FROM dead_letter_queue;
DELETE FROM correcciones;
DELETE FROM buzon_validacion;
DELETE FROM tag_asignacion;
DELETE FROM tags;
DELETE FROM notas_libres;
DELETE FROM memoria_local;
DELETE FROM memoria_global_especialista;
DELETE FROM rol_persona_inmueble;
DELETE FROM personas_merge_log;
DELETE FROM evento_pg;
DELETE FROM mensajes;
DELETE FROM chat_ambito_historial;
DELETE FROM chats;
DELETE FROM proyectos;
DELETE FROM inmuebles;
DELETE FROM personas;

-- Reset secuencias para que ids vuelvan a 1
ALTER SEQUENCE personas_id_seq RESTART WITH 1;
ALTER SEQUENCE inmuebles_id_seq RESTART WITH 1;
ALTER SEQUENCE proyectos_id_seq RESTART WITH 1;
ALTER SEQUENCE chats_id_seq RESTART WITH 1;
ALTER SEQUENCE mensajes_id_seq RESTART WITH 1;
ALTER SEQUENCE evento_pg_id_seq RESTART WITH 1;
ALTER SEQUENCE buzon_validacion_id_seq RESTART WITH 1;

-- 2. Tabla chats_bloqueados — persiste el flag de bloqueo aunque el chat NO esté en chats
-- (el chat puede vivir solo en IndexedDB de la extensión, pero si Jhon lo bloquea, queremos que el bloqueo sobreviva incluso si reinstala la extensión)
CREATE TABLE IF NOT EXISTS chats_bloqueados (
  id BIGSERIAL PRIMARY KEY,
  canal TEXT NOT NULL CHECK (canal IN ('whatsapp','web','email','audio','proveedor','ia_externa','crm_zonal','interno')),
  canal_chat_id TEXT NOT NULL,             -- jid en WhatsApp, email_thread_id en email, etc.
  titulo_snapshot TEXT,                    -- nombre/título del chat al momento de bloquear (referencia humana)
  motivo TEXT NOT NULL,
  bloqueado_por BIGINT REFERENCES usuarios(id),
  bloqueado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  desbloqueado_at TIMESTAMPTZ,             -- NULL = sigue bloqueado
  desbloqueado_por BIGINT REFERENCES usuarios(id),
  desbloqueado_motivo TEXT,
  UNIQUE (canal, canal_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_chats_bloqueados_activos
  ON chats_bloqueados (canal, canal_chat_id)
  WHERE desbloqueado_at IS NULL;

-- Realtime para que el Visor sepa al instante cuando se bloquea/desbloquea
ALTER PUBLICATION supabase_realtime ADD TABLE chats_bloqueados;

COMMIT;

-- Verificación
SELECT (json_build_object(
  'chats',          (SELECT count(*) FROM chats),
  'mensajes',       (SELECT count(*) FROM mensajes),
  'eventos',        (SELECT count(*) FROM evento_pg),
  'personas',       (SELECT count(*) FROM personas),
  'proyectos',      (SELECT count(*) FROM proyectos),
  'inmuebles',      (SELECT count(*) FROM inmuebles),
  'buzon',          (SELECT count(*) FROM buzon_validacion),
  'bloqueados',     (SELECT count(*) FROM chats_bloqueados),
  'tabla_creada',   (SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'chats_bloqueados'))
))::text AS r;
