-- ============================================================================
-- 002_schema_inicial.sql
-- Schema MÓDULO 1 — Núcleo base del Visor_PG
-- 2026-05-07 — implementa secciones 13, 14, 15, 16 de ARQUITECTURA.md
-- ============================================================================

BEGIN;

-- ============================================================================
-- USUARIOS Y AMBITOS (catálogos base)
-- ============================================================================

CREATE TABLE usuarios (
  id BIGSERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  nombre TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('dueño', 'administrador', 'asesor', 'instalador', 'contabilidad', 'soporte')),
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

INSERT INTO usuarios (email, nombre, rol) VALUES
  ('persianasyenrrollablesgirardot@gmail.com', 'Jhon Cubides', 'dueño');

CREATE TABLE ambitos (
  codigo TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  descripcion TEXT,
  sincroniza_crm BOOLEAN NOT NULL DEFAULT false,
  orden SMALLINT NOT NULL DEFAULT 99
);

INSERT INTO ambitos (codigo, nombre, descripcion, sincroniza_crm, orden) VALUES
  ('comercial',         'Comercial',           'Clientes del negocio',                     true,  1),
  ('proveedor',         'Proveedor',           'Proveedores (telas, motores, etc.)',       false, 2),
  ('personal_familia',  'Personal · Familia',  'Hija, esposa, padres, hermanos',           false, 3),
  ('personal_amigos',   'Personal · Amigos',   'Amigos',                                   false, 4),
  ('personal_otros',    'Personal · Otros',    'Conocidos no clasificados (catch-all)',    false, 5),
  ('interno_equipo',    'Interno · Equipo',    'Instaladores, técnicos, contadora',        false, 6);

-- ============================================================================
-- PERSONAS, INMUEBLES, PROYECTOS
-- ============================================================================

CREATE TABLE personas (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT,
  alias TEXT,
  empresa TEXT,
  rol TEXT,                                    -- comprador, esposa, arquitecto, administrador, instalador, etc.
  telefono_e164 TEXT,                          -- normalizado a E.164: +573223663825
  email TEXT,
  jid TEXT,                                    -- WhatsApp jid completo
  cedula TEXT,
  nit TEXT,
  ciudad TEXT,
  notas TEXT,
  notas_tsv TSVECTOR,                          -- búsqueda full-text sobre notas
  ambito_principal TEXT REFERENCES ambitos(codigo),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_personas_telefono ON personas (telefono_e164) WHERE deleted_at IS NULL;
CREATE INDEX idx_personas_email    ON personas (email)         WHERE deleted_at IS NULL;
CREATE INDEX idx_personas_jid      ON personas (jid)           WHERE deleted_at IS NULL;
CREATE INDEX idx_personas_nombre   ON personas USING GIN (to_tsvector('spanish', COALESCE(nombre,'')||' '||COALESCE(alias,''))) WHERE deleted_at IS NULL;
CREATE INDEX idx_personas_notas_tsv ON personas USING GIN (notas_tsv);

CREATE TABLE inmuebles (
  id BIGSERIAL PRIMARY KEY,
  direccion TEXT,
  ciudad TEXT,
  barrio TEXT,
  conjunto TEXT,
  torre TEXT,
  apartamento TEXT,
  tipo TEXT CHECK (tipo IN ('apartamento','casa','local','oficina','otro') OR tipo IS NULL),
  restricciones_ingreso TEXT,
  administracion_contacto TEXT,
  parqueadero BOOLEAN,
  ascensor BOOLEAN,
  horarios_permitidos TEXT,
  notas TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_inmuebles_ciudad_conjunto ON inmuebles (ciudad, conjunto) WHERE deleted_at IS NULL;

-- Relación N:N entre personas e inmuebles, con rol específico (cliente, esposa, arquitecto, admin, etc.)
CREATE TABLE rol_persona_inmueble (
  id BIGSERIAL PRIMARY KEY,
  persona_id BIGINT NOT NULL REFERENCES personas(id),
  inmueble_id BIGINT NOT NULL REFERENCES inmuebles(id),
  rol TEXT NOT NULL,
  desde TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  hasta TIMESTAMPTZ,
  notas TEXT,
  UNIQUE (persona_id, inmueble_id, rol)
);

CREATE TABLE proyectos (
  id BIGSERIAL PRIMARY KEY,
  persona_id BIGINT NOT NULL REFERENCES personas(id),
  inmueble_id BIGINT REFERENCES inmuebles(id),
  ambito TEXT NOT NULL REFERENCES ambitos(codigo),
  nombre TEXT,                                 -- "Blackout habitaciones", "Recompra cocina", etc.
  estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','en_progreso','ganado','perdido','cerrado','en_garantia','cancelado')),
  origen TEXT,                                 -- 'whatsapp_inbound', 'web_form', 'referido', 'recompra'
  fecha_apertura TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fecha_cierre TIMESTAMPTZ,
  prioridad SMALLINT NOT NULL DEFAULT 5,
  notas TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_proyectos_persona ON proyectos (persona_id, fecha_apertura DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_proyectos_estado  ON proyectos (estado, fecha_apertura DESC)     WHERE deleted_at IS NULL;
CREATE INDEX idx_proyectos_ambito  ON proyectos (ambito, fecha_apertura DESC)     WHERE deleted_at IS NULL;

-- ============================================================================
-- CHATS Y MENSAJES (input crudo de canales)
-- ============================================================================

CREATE TABLE chats (
  id BIGSERIAL PRIMARY KEY,
  canal TEXT NOT NULL CHECK (canal IN ('whatsapp','web','email','audio','proveedor','ia_externa','crm_zonal')),
  canal_chat_id TEXT NOT NULL,                 -- jid en WhatsApp, email_thread_id en email, etc.
  tipo TEXT NOT NULL CHECK (tipo IN ('individual','grupo','difusion')),
  titulo TEXT,                                 -- nombre del chat (visible en cliente)
  ambito TEXT NOT NULL REFERENCES ambitos(codigo),
  ambito_confirmado BOOLEAN NOT NULL DEFAULT false,  -- false = el clasificador lo propuso, Jhon aún no confirma
  proyecto_id BIGINT REFERENCES proyectos(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (canal, canal_chat_id)
);

CREATE INDEX idx_chats_ambito ON chats (ambito, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE chat_ambito_historial (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES chats(id),
  ambito_anterior TEXT,
  ambito_nuevo TEXT NOT NULL REFERENCES ambitos(codigo),
  cambiado_por BIGINT REFERENCES usuarios(id),
  motivo TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mensajes (
  id BIGSERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL REFERENCES chats(id),
  canal_msg_id TEXT NOT NULL,                  -- id del mensaje en el canal (idempotencia)
  autor_jid TEXT,                              -- en grupos: jid del emisor real (≠ chat_id del grupo)
  persona_autor_id BIGINT REFERENCES personas(id),  -- resuelta por Servicio de Identidad
  direccion TEXT NOT NULL CHECK (direccion IN ('entrante','saliente')),
  tipo TEXT NOT NULL CHECK (tipo IN ('texto','imagen','audio','video','documento','ubicacion','contacto','sticker','sistema')),
  texto TEXT,
  media_url TEXT,
  media_mime TEXT,
  media_bytes INTEGER,
  metadata JSONB,                              -- cualquier extra del canal (caption, duration, location, etc.)
  texto_tsv TSVECTOR,                          -- búsqueda full-text
  ts_canal TIMESTAMPTZ NOT NULL,
  ts_creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (chat_id, canal_msg_id)
);

CREATE INDEX idx_mensajes_chat_ts  ON mensajes (chat_id, ts_canal DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_mensajes_persona  ON mensajes (persona_autor_id, ts_canal DESC) WHERE deleted_at IS NULL AND persona_autor_id IS NOT NULL;
CREATE INDEX idx_mensajes_texto_tsv ON mensajes USING GIN (texto_tsv);

-- ============================================================================
-- EVENTO_PG — columna vertebral (sección 13 ARQUITECTURA.md)
-- ============================================================================

CREATE TABLE evento_pg (
  id BIGSERIAL PRIMARY KEY,

  -- Origen
  canal TEXT NOT NULL CHECK (canal IN ('whatsapp','web','email','audio','proveedor','ia_externa','crm_zonal','interno')),
  canal_msg_id TEXT,                           -- NULL para eventos generados por agentes

  -- Identidad resuelta (NULL hasta que L1 procese)
  persona_id BIGINT REFERENCES personas(id),
  proyecto_id BIGINT REFERENCES proyectos(id),
  inmueble_id BIGINT REFERENCES inmuebles(id),
  chat_id BIGINT REFERENCES chats(id),

  -- Clasificación
  ambito TEXT NOT NULL REFERENCES ambitos(codigo),
  tipo_evento TEXT NOT NULL CHECK (tipo_evento IN (
    'mensaje_entrante','mensaje_saliente','dato_extraido','inferencia',
    'cambio_estado','solicitud_aprobacion','contradiccion','pago','medida',
    'garantia','variacion','tarea','alerta','evidencia','pregunta_humano',
    'primer_contacto','cambio_externo','correccion_humana'
  )),
  prioridad SMALLINT NOT NULL DEFAULT 5 CHECK (prioridad BETWEEN 1 AND 9),

  -- Estado de procesamiento
  estado TEXT NOT NULL DEFAULT 'NUEVO' CHECK (estado IN ('NUEVO','IDENTIFICADO','EN_PROCESO','PROCESADO','AMBIGUO','ERROR')),

  -- Payload
  payload JSONB NOT NULL,
  evidencia_ids JSONB,                         -- {msg_ids: [...], doc_ids: [...]}
  payload_tsv TSVECTOR,                        -- FTS sobre payload

  -- Producción del evento
  agente_origen TEXT,                          -- NULL si viene de adapter, 'A5' si viene de agente
  evento_padre_id BIGINT REFERENCES evento_pg(id),

  -- Confianza
  confianza TEXT CHECK (confianza IN ('CONFIRMADO','INFERIDO','DUDOSO','ALERTA','RECHAZADO') OR confianza IS NULL),

  -- Marcas operativas
  shadow BOOLEAN NOT NULL DEFAULT false,
  costo_usd NUMERIC(10,6) NOT NULL DEFAULT 0,

  -- Lock/lease para concurrencia
  procesando_por TEXT,
  procesando_hasta TIMESTAMPTZ,

  -- Tiempos
  ts_canal TIMESTAMPTZ NOT NULL,
  ts_creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ts_procesado TIMESTAMPTZ,

  -- Soft delete
  deleted_at TIMESTAMPTZ,

  -- Idempotencia: mismo mensaje del mismo canal procesado por mismo agente = único
  CONSTRAINT uq_evento_idempotencia UNIQUE (canal, canal_msg_id, agente_origen)
);

CREATE INDEX idx_evento_pg_pendientes
  ON evento_pg (prioridad ASC, ts_creado ASC)
  WHERE estado IN ('NUEVO','IDENTIFICADO') AND deleted_at IS NULL;

CREATE INDEX idx_evento_pg_persona ON evento_pg (persona_id, ts_canal DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_evento_pg_proyecto ON evento_pg (proyecto_id, ts_canal DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_evento_pg_chat ON evento_pg (chat_id, ts_canal DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_evento_pg_ambito ON evento_pg (ambito, ts_creado DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_evento_pg_payload_tsv ON evento_pg USING GIN (payload_tsv);

-- ============================================================================
-- BUZÓN DE VALIDACIÓN
-- ============================================================================

CREATE TABLE buzon_validacion (
  id BIGSERIAL PRIMARY KEY,
  evento_id BIGINT NOT NULL REFERENCES evento_pg(id),
  proyecto_id BIGINT REFERENCES proyectos(id),
  persona_id BIGINT REFERENCES personas(id),
  ambito TEXT NOT NULL REFERENCES ambitos(codigo),
  tipo_decision TEXT NOT NULL,                 -- 'cotizacion_estado', 'abono_confirmado', 'cambio_medida', etc.
  resumen TEXT NOT NULL,
  detalle JSONB NOT NULL,
  evidencia_ids JSONB,
  reglas_aplicadas TEXT[],                     -- ['R-001','R-013#1']
  prioridad SMALLINT NOT NULL DEFAULT 5,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','aprobado','rechazado','editado')),
  resuelto_por BIGINT REFERENCES usuarios(id),
  resuelto_at TIMESTAMPTZ,
  comentario_humano TEXT,
  edicion_aplicada JSONB,
  ts_creado TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_buzon_pendientes ON buzon_validacion (prioridad ASC, ts_creado ASC) WHERE estado = 'pendiente';
CREATE INDEX idx_buzon_persona ON buzon_validacion (persona_id, ts_creado DESC);

-- ============================================================================
-- AGENTES (definición + historial para hot reload)
-- ============================================================================

CREATE TABLE agentes_definicion (
  id BIGSERIAL PRIMARY KEY,
  codigo TEXT UNIQUE NOT NULL,                 -- 'A1', 'A5', 'B1', 'JUNIOR'
  nombre TEXT NOT NULL,                        -- 'A1_identidad_cliente'
  proposito TEXT NOT NULL,
  ambitos TEXT[] NOT NULL,                     -- {'comercial'} o {'comercial','proveedor'}
  criticidad TEXT NOT NULL CHECK (criticidad IN ('alta','media','baja')),
  prompt_especifico TEXT NOT NULL,
  inputs_config JSONB,
  outputs_config JSONB,
  reglas_duras TEXT[],                         -- {'R-001','R-013#1'}
  costo_limite_usd NUMERIC(8,4) NOT NULL DEFAULT 0.05,
  activo BOOLEAN NOT NULL DEFAULT false,
  shadow BOOLEAN NOT NULL DEFAULT true,        -- arranca en shadow por default
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agentes_definicion_historial (
  id BIGSERIAL PRIMARY KEY,
  agente_id BIGINT NOT NULL REFERENCES agentes_definicion(id),
  version INTEGER NOT NULL,
  prompt_especifico TEXT NOT NULL,
  inputs_config JSONB,
  outputs_config JSONB,
  modificado_por BIGINT REFERENCES usuarios(id),
  motivo TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- MEMORIA (DUAL: local por persona + global anonimizada por agente)
-- ============================================================================

CREATE TABLE memoria_local (
  id BIGSERIAL PRIMARY KEY,
  persona_id BIGINT NOT NULL REFERENCES personas(id),
  agente_codigo TEXT NOT NULL,
  tipo TEXT NOT NULL,                          -- 'preferencia','observacion','patron'
  contenido TEXT NOT NULL,
  evidencia_ids JSONB,
  confianza TEXT NOT NULL CHECK (confianza IN ('CONFIRMADO','INFERIDO','DUDOSO')),
  ts_creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ts_actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_memoria_local_persona_agente ON memoria_local (persona_id, agente_codigo);

CREATE TABLE memoria_global_especialista (
  id BIGSERIAL PRIMARY KEY,
  agente_codigo TEXT NOT NULL,
  patron TEXT NOT NULL,
  evidencia_count INTEGER NOT NULL DEFAULT 1,  -- cuántos casos lo soportan
  ts_creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ts_actualizado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (patron NOT LIKE '%@%' AND patron !~ '\+57\d{10}')  -- guard rail anti-PII
);

-- ============================================================================
-- CORRECCIONES (humano corrige inferencia → agentes la respetan)
-- ============================================================================

CREATE TABLE correcciones (
  id BIGSERIAL PRIMARY KEY,
  evento_origen_id BIGINT REFERENCES evento_pg(id),
  persona_id BIGINT REFERENCES personas(id),
  proyecto_id BIGINT REFERENCES proyectos(id),
  agente_codigo TEXT,
  campo TEXT NOT NULL,
  valor_anterior JSONB,
  valor_nuevo JSONB,
  motivo TEXT,
  corregido_por BIGINT NOT NULL REFERENCES usuarios(id),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_correcciones_persona ON correcciones (persona_id, ts DESC);

-- ============================================================================
-- NOTAS LIBRES (humano agrega contexto que los agentes leen ANTES de inferir)
-- ============================================================================

CREATE TABLE notas_libres (
  id BIGSERIAL PRIMARY KEY,
  persona_id BIGINT REFERENCES personas(id),
  proyecto_id BIGINT REFERENCES proyectos(id),
  contenido TEXT NOT NULL,
  contenido_tsv TSVECTOR,
  visible_para TEXT[] NOT NULL DEFAULT ARRAY['todos'],  -- {'comercial'}, {'todos'}, {'familia'}
  creado_por BIGINT NOT NULL REFERENCES usuarios(id),
  ts_creado TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_notas_persona ON notas_libres (persona_id, ts_creado DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_notas_tsv ON notas_libres USING GIN (contenido_tsv);

-- ============================================================================
-- TAGS LIBRES (Jhon agrega tags ad-hoc — sección 23)
-- ============================================================================

CREATE TABLE tags (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT UNIQUE NOT NULL,
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE tag_asignacion (
  id BIGSERIAL PRIMARY KEY,
  tag_id BIGINT NOT NULL REFERENCES tags(id),
  entidad_tipo TEXT NOT NULL CHECK (entidad_tipo IN ('persona','proyecto','chat','inmueble')),
  entidad_id BIGINT NOT NULL,
  asignado_por BIGINT REFERENCES usuarios(id),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tag_id, entidad_tipo, entidad_id)
);

CREATE INDEX idx_tag_asig_entidad ON tag_asignacion (entidad_tipo, entidad_id);

-- ============================================================================
-- DEAD LETTER QUEUE (sección 27)
-- ============================================================================

CREATE TABLE dead_letter_queue (
  id BIGSERIAL PRIMARY KEY,
  evento_id BIGINT NOT NULL REFERENCES evento_pg(id),
  agente_codigo TEXT,
  intentos INTEGER NOT NULL DEFAULT 1,
  ultimo_error TEXT NOT NULL,
  stack_trace TEXT,
  ts_primer_fallo TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ts_ultimo_fallo TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resuelto_at TIMESTAMPTZ,
  resuelto_por BIGINT REFERENCES usuarios(id)
);

-- ============================================================================
-- PERSONAS MERGE LOG (sección 29)
-- ============================================================================

CREATE TABLE personas_merge_log (
  id BIGSERIAL PRIMARY KEY,
  persona_sobreviviente_id BIGINT NOT NULL REFERENCES personas(id),
  persona_fusionada_id BIGINT NOT NULL,
  motivo TEXT,
  hecho_por BIGINT NOT NULL REFERENCES usuarios(id),
  reversible_hasta TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================================
-- TRIGGERS DE MANTENIMIENTO
-- ============================================================================

-- updated_at automático
CREATE OR REPLACE FUNCTION trg_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER personas_updated_at  BEFORE UPDATE ON personas  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER inmuebles_updated_at BEFORE UPDATE ON inmuebles FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER proyectos_updated_at BEFORE UPDATE ON proyectos FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER chats_updated_at     BEFORE UPDATE ON chats     FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER agentes_def_updated_at BEFORE UPDATE ON agentes_definicion FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER memoria_local_updated_at BEFORE UPDATE ON memoria_local FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
CREATE TRIGGER memoria_global_updated_at BEFORE UPDATE ON memoria_global_especialista FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- TSV automático para FTS
CREATE OR REPLACE FUNCTION trg_personas_tsv() RETURNS TRIGGER AS $$
BEGIN
  NEW.notas_tsv := to_tsvector('spanish', COALESCE(NEW.notas,''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER personas_tsv_upd BEFORE INSERT OR UPDATE ON personas FOR EACH ROW EXECUTE FUNCTION trg_personas_tsv();

CREATE OR REPLACE FUNCTION trg_mensajes_tsv() RETURNS TRIGGER AS $$
BEGIN
  NEW.texto_tsv := to_tsvector('spanish', COALESCE(NEW.texto,''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER mensajes_tsv_upd BEFORE INSERT OR UPDATE ON mensajes FOR EACH ROW EXECUTE FUNCTION trg_mensajes_tsv();

CREATE OR REPLACE FUNCTION trg_evento_pg_tsv() RETURNS TRIGGER AS $$
BEGIN
  NEW.payload_tsv := to_tsvector('spanish', COALESCE(NEW.payload::text,''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER evento_pg_tsv_upd BEFORE INSERT OR UPDATE ON evento_pg FOR EACH ROW EXECUTE FUNCTION trg_evento_pg_tsv();

CREATE OR REPLACE FUNCTION trg_notas_tsv() RETURNS TRIGGER AS $$
BEGIN
  NEW.contenido_tsv := to_tsvector('spanish', COALESCE(NEW.contenido,''));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notas_libres_tsv_upd BEFORE INSERT OR UPDATE ON notas_libres FOR EACH ROW EXECUTE FUNCTION trg_notas_tsv();

-- Versionado de prompts (al UPDATE → guarda histórico)
CREATE OR REPLACE FUNCTION trg_agentes_versionado() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.prompt_especifico IS DISTINCT FROM NEW.prompt_especifico) THEN
    INSERT INTO agentes_definicion_historial (agente_id, version, prompt_especifico, inputs_config, outputs_config, motivo)
    VALUES (OLD.id, OLD.version, OLD.prompt_especifico, OLD.inputs_config, OLD.outputs_config, 'auto-snapshot pre-update');
    NEW.version := OLD.version + 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agentes_def_versionado BEFORE UPDATE ON agentes_definicion FOR EACH ROW EXECUTE FUNCTION trg_agentes_versionado();

-- ============================================================================
-- VISTAS PARA CQRS LIGERO (sección 15)
-- Vistas normales (no materializadas) para empezar; se migrarán a matview cuando crezca volumen
-- ============================================================================

CREATE VIEW vw_clientes_resumen AS
SELECT
  p.id as persona_id,
  p.nombre,
  p.alias,
  p.telefono_e164,
  p.email,
  p.ambito_principal,
  COUNT(DISTINCT pr.id) FILTER (WHERE pr.deleted_at IS NULL) as proyectos_activos,
  MAX(pr.fecha_apertura) as ultimo_proyecto_at,
  (SELECT COUNT(*) FROM evento_pg e WHERE e.persona_id = p.id AND e.deleted_at IS NULL) as eventos_total,
  (SELECT MAX(e.ts_canal) FROM evento_pg e WHERE e.persona_id = p.id AND e.deleted_at IS NULL) as ultimo_evento_at
FROM personas p
LEFT JOIN proyectos pr ON pr.persona_id = p.id AND pr.deleted_at IS NULL
WHERE p.deleted_at IS NULL
GROUP BY p.id;

CREATE VIEW vw_buzon_pendientes AS
SELECT
  b.id,
  b.evento_id,
  b.proyecto_id,
  b.persona_id,
  per.nombre as persona_nombre,
  per.telefono_e164 as persona_telefono,
  pr.nombre as proyecto_nombre,
  b.ambito,
  b.tipo_decision,
  b.resumen,
  b.detalle,
  b.evidencia_ids,
  b.reglas_aplicadas,
  b.prioridad,
  b.ts_creado,
  EXTRACT(EPOCH FROM (NOW() - b.ts_creado))/3600 as horas_pendiente
FROM buzon_validacion b
LEFT JOIN personas per ON per.id = b.persona_id
LEFT JOIN proyectos pr ON pr.id = b.proyecto_id
WHERE b.estado = 'pendiente'
ORDER BY b.prioridad ASC, b.ts_creado ASC;

CREATE VIEW vw_timeline_proyecto AS
SELECT
  e.id,
  e.proyecto_id,
  e.persona_id,
  e.tipo_evento,
  e.payload,
  e.confianza,
  e.evidencia_ids,
  e.agente_origen,
  e.ts_canal,
  e.ts_creado
FROM evento_pg e
WHERE e.deleted_at IS NULL
ORDER BY e.proyecto_id, e.ts_canal ASC;

-- ============================================================================
-- RLS (multi-usuario futuro; por ahora abierto para service_role y anon)
-- ============================================================================

ALTER TABLE personas       ENABLE ROW LEVEL SECURITY;
ALTER TABLE inmuebles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE proyectos      ENABLE ROW LEVEL SECURITY;
ALTER TABLE chats          ENABLE ROW LEVEL SECURITY;
ALTER TABLE mensajes       ENABLE ROW LEVEL SECURITY;
ALTER TABLE evento_pg      ENABLE ROW LEVEL SECURITY;
ALTER TABLE buzon_validacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE memoria_local  ENABLE ROW LEVEL SECURITY;
ALTER TABLE notas_libres   ENABLE ROW LEVEL SECURITY;

-- Política inicial: anon puede leer/escribir todo (MVP solo Jhon).
-- Cuando se agreguen otros roles se cambian estas políticas a granulares por ámbito + rol.
CREATE POLICY mvp_personas_all ON personas FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY mvp_inmuebles_all ON inmuebles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY mvp_proyectos_all ON proyectos FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY mvp_chats_all ON chats FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY mvp_mensajes_all ON mensajes FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY mvp_evento_pg_all ON evento_pg FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY mvp_buzon_all ON buzon_validacion FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY mvp_memoria_local_all ON memoria_local FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY mvp_notas_all ON notas_libres FOR ALL USING (true) WITH CHECK (true);

-- ============================================================================
-- REALTIME PUBLICATION (para que el Visor reciba cambios en vivo)
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE evento_pg;
ALTER PUBLICATION supabase_realtime ADD TABLE buzon_validacion;
ALTER PUBLICATION supabase_realtime ADD TABLE mensajes;
ALTER PUBLICATION supabase_realtime ADD TABLE chats;
ALTER PUBLICATION supabase_realtime ADD TABLE personas;
ALTER PUBLICATION supabase_realtime ADD TABLE proyectos;

-- ============================================================================
-- VERIFICACIÓN FINAL
-- ============================================================================

SELECT
  json_build_object(
    'tablas', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),
    'vistas', (SELECT count(*) FROM information_schema.views WHERE table_schema='public'),
    'triggers', (SELECT count(*) FROM information_schema.triggers WHERE trigger_schema='public'),
    'usuarios_creados', (SELECT count(*) FROM usuarios),
    'ambitos_creados', (SELECT count(*) FROM ambitos)
  ) as resultado;

COMMIT;
