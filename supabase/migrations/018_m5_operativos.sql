-- F5.1 — Schema MÓDULO 5 Operativos
-- Tablas: produccion_orden + instalaciones + tareas + checklist_template + checklist_instalacion_items
-- Vista: vw_agenda_operativa (instalaciones programadas + tareas pendientes)
-- Seeds: checklist_template (15 items default según VISION 5.6)

-- ─── 1. produccion_orden (5.1) ──────────────────────────────────────
-- Estado de producción por cotización ganada. 1:1 con cotización (pero puede
-- no existir si el cliente no ha pagado o la cot no es ganada).
CREATE TABLE IF NOT EXISTS produccion_orden (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT UNIQUE REFERENCES cotizaciones(id) ON DELETE CASCADE,
  persona_id               BIGINT REFERENCES personas(id),
  estado                   TEXT NOT NULL DEFAULT 'pendiente_abono'
    CHECK (estado IN ('pendiente_abono','pedido_proveedor','en_produccion','listo_para_instalar','retenido','entregado','instalado')),
  fecha_inicio             DATE,
  fecha_estimada_lista     DATE,
  fecha_entrega            DATE,
  vendor                   TEXT,                                     -- a qué proveedor se le pidió
  motivo_retencion         TEXT,                                     -- si estado='retenido', por qué
  notas                    TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_prod_persona ON produccion_orden(persona_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_prod_estado  ON produccion_orden(estado)     WHERE deleted_at IS NULL;

-- ─── 2. instalaciones (5.2) ─────────────────────────────────────────
-- Cada cotización puede generar varias visitas (parciales, fallidas, reagendadas).
CREATE TABLE IF NOT EXISTS instalaciones (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE CASCADE,
  proyecto_id              BIGINT REFERENCES proyectos(id),
  persona_id               BIGINT REFERENCES personas(id),
  zona_codigo              TEXT REFERENCES zonas_instalacion(codigo),
  fecha_programada         DATE NOT NULL,
  hora_programada          TIME,
  fecha_real               DATE,
  hora_real                TIME,
  instalador               TEXT,
  resultado                TEXT
    CHECK (resultado IS NULL OR resultado IN ('completa','parcial','fallida','reagendada')),
  fotos_urls               TEXT[],
  pendientes               TEXT,                                     -- qué quedó por hacer
  incidencias              TEXT,                                     -- problemas encontrados
  recibido_por_cliente     BOOLEAN NOT NULL DEFAULT false,
  firma_cliente_url        TEXT,
  saldo_cobrado            NUMERIC(14,2),                            -- cuánto cobró el instalador en visita
  resena_pedida            BOOLEAN NOT NULL DEFAULT false,
  notas                    TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_inst_persona ON instalaciones(persona_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inst_zona    ON instalaciones(zona_codigo) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inst_fecha   ON instalaciones(fecha_programada) WHERE deleted_at IS NULL;

-- ─── 3. tareas (5.5) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tareas (
  id                       BIGSERIAL PRIMARY KEY,
  persona_id               BIGINT REFERENCES personas(id),
  cotizacion_id            BIGINT REFERENCES cotizaciones(id) ON DELETE SET NULL,
  proyecto_id              BIGINT REFERENCES proyectos(id) ON DELETE SET NULL,
  titulo                   TEXT NOT NULL,
  descripcion              TEXT,
  tipo                     TEXT NOT NULL DEFAULT 'otro'
    CHECK (tipo IN ('llamar','enviar_cotizacion','confirmar_pago','pedir_ficha','agendar_instalacion','reclamar_proveedor','pedir_resena','otro')),
  fecha_vence              DATE,
  hora_vence               TIME,
  completada               BOOLEAN NOT NULL DEFAULT false,
  completada_at            TIMESTAMPTZ,
  asignado_a               TEXT,                                     -- 'jhon' | 'instalador_X' | etc.
  origen                   TEXT NOT NULL DEFAULT 'manual'
    CHECK (origen IN ('manual','chat','agente','sistema')),
  origen_chat_id           BIGINT REFERENCES chats(id),              -- si la tarea nace de un chat
  prioridad                SMALLINT NOT NULL DEFAULT 5 CHECK (prioridad BETWEEN 1 AND 10),
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

CREATE INDEX IF NOT EXISTS idx_tareas_persona ON tareas(persona_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tareas_completada ON tareas(completada, fecha_vence) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tareas_tipo ON tareas(tipo) WHERE deleted_at IS NULL;

-- ─── 4. checklist (5.6) ─────────────────────────────────────────────
-- Catálogo de items del checklist (default según VISION). Editable a futuro.
CREATE TABLE IF NOT EXISTS checklist_template (
  id                       BIGSERIAL PRIMARY KEY,
  codigo                   TEXT UNIQUE NOT NULL,
  fase                     TEXT NOT NULL CHECK (fase IN ('antes','durante','despues')),
  orden                    SMALLINT NOT NULL DEFAULT 99,
  descripcion              TEXT NOT NULL,
  requerido                BOOLEAN NOT NULL DEFAULT true,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ
);

INSERT INTO checklist_template (codigo, fase, orden, descripcion, requerido) VALUES
  -- ANTES (VISION 5.6 Antes)
  ('ANTES-MEDIDAS',     'antes', 1, 'Medidas confirmadas y correctas',         true),
  ('ANTES-PRODUCTO',    'antes', 2, 'Producto correcto en mano (sistema/tela/color/cantidad)', true),
  ('ANTES-ACCESORIOS',  'antes', 3, 'Accesorios completos (rieles, soportes, motores, controles)', true),
  ('ANTES-HERRAMIENTAS','antes', 4, 'Herramientas necesarias en el vehículo',  true),
  ('ANTES-DIRECCION',   'antes', 5, 'Dirección confirmada con cliente',         true),
  ('ANTES-AUTORIZACION','antes', 6, 'Autorización de ingreso (portería/admin)', true),
  -- DURANTE (VISION 5.6 Durante)
  ('DUR-ACCESO',        'durante', 1, 'Acceso al inmueble sin restricción',     true),
  ('DUR-INSTALACION',   'durante', 2, 'Instalación ejecutada correctamente',    true),
  ('DUR-NIVELACION',    'durante', 3, 'Cortinas/persianas niveladas',           true),
  ('DUR-FUNCIONAMIENTO','durante', 4, 'Funcionamiento probado con cliente',     true),
  -- DESPUÉS (VISION 5.6 Después)
  ('DESP-FOTOS',        'despues', 1, 'Fotos de la instalación tomadas',        true),
  ('DESP-EXPLICACION',  'despues', 2, 'Explicación de uso y mantenimiento dada al cliente', true),
  ('DESP-RECIBIDO',     'despues', 3, 'Cliente firmó/recibió conforme',         true),
  ('DESP-SALDO',        'despues', 4, 'Saldo pendiente cobrado (o acordado)',   false),
  ('DESP-RESENA',       'despues', 5, 'Reseña Google solicitada al cliente',    false);

-- Estado por instalación
CREATE TABLE IF NOT EXISTS checklist_instalacion_items (
  id                       BIGSERIAL PRIMARY KEY,
  instalacion_id           BIGINT NOT NULL REFERENCES instalaciones(id) ON DELETE CASCADE,
  template_codigo          TEXT REFERENCES checklist_template(codigo),
  fase                     TEXT NOT NULL CHECK (fase IN ('antes','durante','despues')),
  descripcion              TEXT NOT NULL,                                  -- copia del template (por si cambia el catálogo)
  orden                    SMALLINT NOT NULL DEFAULT 99,
  completado               BOOLEAN NOT NULL DEFAULT false,
  completado_at            TIMESTAMPTZ,
  foto_url                 TEXT,
  notas                    TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  UNIQUE (instalacion_id, template_codigo)
);

CREATE INDEX IF NOT EXISTS idx_chk_instalacion ON checklist_instalacion_items(instalacion_id) WHERE deleted_at IS NULL;

-- Trigger: al crear instalación, auto-rellenar checklist_instalacion_items con los items del template
CREATE OR REPLACE FUNCTION trg_seed_checklist_instalacion() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO checklist_instalacion_items (instalacion_id, template_codigo, fase, descripcion, orden)
  SELECT NEW.id, t.codigo, t.fase, t.descripcion, t.orden
  FROM checklist_template t
  WHERE t.deleted_at IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_seed_checklist ON instalaciones;
CREATE TRIGGER trg_seed_checklist
  AFTER INSERT ON instalaciones
  FOR EACH ROW EXECUTE FUNCTION trg_seed_checklist_instalacion();

-- ─── 5. Triggers updated_at ─────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_prod_updated_at ON produccion_orden;
CREATE TRIGGER trg_prod_updated_at BEFORE UPDATE ON produccion_orden
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_inst_updated_at ON instalaciones;
CREATE TRIGGER trg_inst_updated_at BEFORE UPDATE ON instalaciones
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_tareas_updated_at ON tareas;
CREATE TRIGGER trg_tareas_updated_at BEFORE UPDATE ON tareas
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_chk_template_updated_at ON checklist_template;
CREATE TRIGGER trg_chk_template_updated_at BEFORE UPDATE ON checklist_template
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_chk_items_updated_at ON checklist_instalacion_items;
CREATE TRIGGER trg_chk_items_updated_at BEFORE UPDATE ON checklist_instalacion_items
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

-- ─── 6. Vista vw_agenda_operativa (5.3) ─────────────────────────────
-- Unión de instalaciones programadas + tareas pendientes en una sola lista
-- cronológica. Sirve para "qué hay hoy/esta semana".
CREATE OR REPLACE VIEW vw_agenda_operativa AS
SELECT
  'instalacion'::TEXT                AS tipo,
  i.id                               AS source_id,
  i.persona_id,
  p.nombre                           AS persona_nombre,
  i.cotizacion_id,
  c.numero_cotizacion,
  i.zona_codigo,
  i.fecha_programada                 AS fecha,
  i.hora_programada                  AS hora,
  CONCAT('Instalación ',
    COALESCE(c.numero_cotizacion, '#' || i.cotizacion_id::text),
    CASE WHEN i.instalador IS NOT NULL THEN ' · ' || i.instalador ELSE '' END
  )                                  AS titulo,
  i.resultado                        AS estado,
  5::SMALLINT                        AS prioridad
FROM instalaciones i
JOIN personas p     ON p.id = i.persona_id
LEFT JOIN cotizaciones c ON c.id = i.cotizacion_id
WHERE i.deleted_at IS NULL
  AND NOT i.shadow
  AND i.resultado IS NULL                                    -- solo pendientes

UNION ALL

SELECT
  'tarea'::TEXT                      AS tipo,
  t.id                               AS source_id,
  t.persona_id,
  p.nombre                           AS persona_nombre,
  t.cotizacion_id,
  c.numero_cotizacion,
  NULL                               AS zona_codigo,
  t.fecha_vence                      AS fecha,
  t.hora_vence                       AS hora,
  t.titulo,
  CASE WHEN t.completada THEN 'completada' ELSE 'pendiente' END  AS estado,
  t.prioridad
FROM tareas t
LEFT JOIN personas p     ON p.id = t.persona_id
LEFT JOIN cotizaciones c ON c.id = t.cotizacion_id
WHERE t.deleted_at IS NULL
  AND NOT t.shadow
  AND NOT t.completada;

GRANT SELECT ON vw_agenda_operativa TO anon, authenticated;
GRANT ALL ON produccion_orden, instalaciones, tareas, checklist_template, checklist_instalacion_items TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE produccion_orden_id_seq, instalaciones_id_seq, tareas_id_seq, checklist_template_id_seq, checklist_instalacion_items_id_seq TO anon, authenticated;

SELECT json_build_object(
  'produccion_orden',        (SELECT count(*) FROM produccion_orden),
  'instalaciones',           (SELECT count(*) FROM instalaciones),
  'tareas',                  (SELECT count(*) FROM tareas),
  'checklist_template',      (SELECT count(*) FROM checklist_template),
  'checklist_items',         (SELECT count(*) FROM checklist_instalacion_items),
  'agenda_view',             (SELECT count(*) FROM vw_agenda_operativa)
) AS resultado;
