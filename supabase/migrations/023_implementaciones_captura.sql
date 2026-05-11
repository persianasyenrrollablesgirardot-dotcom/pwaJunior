-- F8.5 — Implementaciones detectadas tras analizar 506K strings de la LevelDB
-- de la extensión + integración con proyecto Gestor_Prospectos_Girardot (324
-- conjuntos curados con sector + dirección + estado prospección).
--
-- 7 fixes en una migración:
--   1. plantillas_respuesta (auto-respuestas WA: bienvenida/ausencia/etc.)
--   2. instalaciones.contacto_receptor_id (quien recibe ≠ quien paga)
--   3. cotizaciones.contacto_pagador_id (quien paga ≠ quien firma)
--   4. abonos.metodo CHECK con 'pse' (era 136 menciones en captura)
--   5. tabla conjuntos (mirror de Gestor_Prospectos) + FK en inmuebles
--   6. zonas_instalacion expandido con sectores reales
--   7. personas_mencionadas (terceros nombrados en chat — base para agente A-Geo)

-- ═══════════════════════════════════════════════════════════════════════
-- 1. plantillas_respuesta — biblioteca editable de auto-respuestas WA
-- ═══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS plantillas_respuesta (
  id              BIGSERIAL PRIMARY KEY,
  codigo          TEXT UNIQUE NOT NULL,
  tipo            TEXT NOT NULL CHECK (tipo IN ('bienvenida','ausencia','recibido','cierre','agradecimiento','garantia_recibida','medida_recibida','cita_confirmada','otro')),
  texto           TEXT NOT NULL,
  activo          BOOLEAN NOT NULL DEFAULT true,
  prioridad       SMALLINT NOT NULL DEFAULT 5,
  variables       TEXT[],                                 -- {'nombre','sistema','fecha'} — slots a reemplazar
  notas           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_plantillas_tipo ON plantillas_respuesta(tipo) WHERE activo;

INSERT INTO plantillas_respuesta (codigo, tipo, texto, variables) VALUES
  ('BIENVENIDA-001', 'bienvenida', 'Gracias por comunicarte con Fábrica de Cortinas. En un momento te atendemos. Horario: lun-sáb 8am-6pm.', ARRAY[]::TEXT[]),
  ('AUSENCIA-001',   'ausencia',   'En este momento no estamos disponibles. Tu mensaje quedó registrado y te respondemos apenas podamos. Si es urgente, escribí "URGENTE" en mayúsculas.', ARRAY[]::TEXT[]),
  ('RECIBIDO-FOTO',  'recibido',   'Recibí tu foto, {nombre}. Voy a revisar y te paso una propuesta hoy mismo.', ARRAY['nombre']),
  ('RECIBIDO-MEDIDA','medida_recibida','Recibí las medidas ({medida}). Las valido y te paso cotización para {sistema}.', ARRAY['medida','sistema']),
  ('AGRADECER-001',  'agradecimiento','Mil gracias {nombre}, cualquier duda estamos por acá.', ARRAY['nombre']),
  ('CITA-001',       'cita_confirmada','Confirmado {nombre}. Te visitamos el {fecha} a las {hora} en {direccion}.', ARRAY['nombre','fecha','hora','direccion']),
  ('GARANTIA-001',   'garantia_recibida','Recibido tu reporte de garantía. Lo registramos y un técnico te contacta en máx 24 h.', ARRAY[]::TEXT[])
ON CONFLICT (codigo) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- 2 + 3. Receptor ≠ Pagador (extraído de "Le recibe el sr Manuel")
-- ═══════════════════════════════════════════════════════════════════════
ALTER TABLE instalaciones
  ADD COLUMN IF NOT EXISTS contacto_receptor_id BIGINT REFERENCES personas(id),
  ADD COLUMN IF NOT EXISTS contacto_receptor_nombre_libre TEXT;  -- si no está en personas todavía

ALTER TABLE cotizaciones
  ADD COLUMN IF NOT EXISTS contacto_pagador_id BIGINT REFERENCES personas(id),
  ADD COLUMN IF NOT EXISTS contacto_pagador_nombre_libre TEXT;

COMMENT ON COLUMN instalaciones.contacto_receptor_id IS 'Persona que recibe la instalación (puede ser distinta al pagador o cliente principal). Ej: "Le recibe el sr Manuel"';
COMMENT ON COLUMN cotizaciones.contacto_pagador_id IS 'Persona que efectivamente paga (puede ser distinta al cliente principal). Ej: hijo paga, mamá recibe.';

-- ═══════════════════════════════════════════════════════════════════════
-- 4. abonos.metodo: agregar 'pse' (extraído de "Me confirmas el pse para apagarte")
-- ═══════════════════════════════════════════════════════════════════════
-- Las columnas TEXT no tenían CHECK constraint estricto en abonos.
-- En el código TS sí (METODOS array). Agregamos 'pse' a TS y dejamos BD libre.
-- Acá solo dejamos un comment de catálogo recomendado.

COMMENT ON COLUMN abonos.metodo IS 'Catálogo recomendado: bancolombia | nequi | daviplata | pse | efectivo | transferencia | otro';

-- ═══════════════════════════════════════════════════════════════════════
-- 5. Tabla conjuntos (mirror de Gestor_Prospectos_Girardot.prospectos_conjuntos)
-- ═══════════════════════════════════════════════════════════════════════
-- Replicamos la tabla con campos extendidos. El sync inicial copia los 324
-- desde el otro Supabase. Después se mantiene con un job (o trigger Realtime).
-- inmuebles gana FK conjunto_id para vincular cada inmueble individual al
-- conjunto residencial al que pertenece.

CREATE TABLE IF NOT EXISTS conjuntos (
  id                       BIGSERIAL PRIMARY KEY,
  prospecto_uuid           UUID UNIQUE,                                 -- FK semántica al otro Supabase
  nombre                   TEXT UNIQUE NOT NULL,
  sector                   TEXT NOT NULL,
  direccion                TEXT,
  estado_prospeccion       TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado_prospeccion IN ('pendiente','visitado','cliente','descartado')),
  prioridad                SMALLINT NOT NULL DEFAULT 3 CHECK (prioridad BETWEEN 1 AND 5),
  -- Datos logísticos compartidos (porteria/admin/restricciones se llenan una vez)
  administracion_contacto  TEXT,
  porteria_telefono        TEXT,
  restricciones_ingreso    TEXT,
  horario_acceso           TEXT,
  parqueadero_visitantes   BOOLEAN,
  ascensor                 BOOLEAN,
  -- Datos geo
  zona_codigo              TEXT REFERENCES zonas_instalacion(codigo),
  ciudad                   TEXT,
  -- Meta
  notas                    TEXT,
  last_visit               TIMESTAMPTZ,
  source                   TEXT DEFAULT 'gestor_prospectos',           -- 'gestor_prospectos' | 'manual' | 'captura_wa'
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_conjuntos_sector ON conjuntos(sector) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conjuntos_estado ON conjuntos(estado_prospeccion) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_conjuntos_nombre_search ON conjuntos USING GIN (to_tsvector('spanish', nombre)) WHERE deleted_at IS NULL;

ALTER TABLE inmuebles
  ADD COLUMN IF NOT EXISTS conjunto_id BIGINT REFERENCES conjuntos(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_inmuebles_conjunto ON inmuebles(conjunto_id) WHERE deleted_at IS NULL AND conjunto_id IS NOT NULL;

-- Trigger updated_at
DROP TRIGGER IF EXISTS trg_conjuntos_updated_at ON conjuntos;
CREATE TRIGGER trg_conjuntos_updated_at BEFORE UPDATE ON conjuntos
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

-- Trigger: auto-marcar conjunto como 'cliente' cuando un inmueble se vincula
CREATE OR REPLACE FUNCTION trg_conjunto_marcar_cliente() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.conjunto_id IS NOT NULL THEN
    UPDATE conjuntos
    SET estado_prospeccion = 'cliente',
        last_visit = COALESCE(last_visit, now()),
        updated_at = now()
    WHERE id = NEW.conjunto_id AND estado_prospeccion = 'pendiente';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_inmueble_marca_conjunto_cliente ON inmuebles;
CREATE TRIGGER trg_inmueble_marca_conjunto_cliente
  AFTER INSERT OR UPDATE OF conjunto_id ON inmuebles
  FOR EACH ROW WHEN (NEW.conjunto_id IS NOT NULL)
  EXECUTE FUNCTION trg_conjunto_marcar_cliente();

-- Vista resumen: conjuntos con conteo de clientes activos
CREATE OR REPLACE VIEW vw_conjuntos_resumen AS
SELECT
  c.id, c.nombre, c.sector, c.direccion, c.estado_prospeccion, c.prioridad,
  c.administracion_contacto, c.porteria_telefono, c.zona_codigo, c.ciudad,
  c.last_visit,
  COUNT(DISTINCT i.id) FILTER (WHERE i.deleted_at IS NULL)                                    AS inmuebles_vinculados,
  COUNT(DISTINCT p.id) FILTER (WHERE p.deleted_at IS NULL)                                    AS personas_clientes,
  COUNT(DISTINCT cot.id) FILTER (WHERE cot.deleted_at IS NULL AND NOT cot.shadow AND cot.estado = 'ganada') AS cotizaciones_ganadas,
  COALESCE(SUM(cot.total) FILTER (WHERE cot.deleted_at IS NULL AND NOT cot.shadow AND cot.estado = 'ganada'), 0) AS ingreso_total_conjunto
FROM conjuntos c
LEFT JOIN inmuebles i ON i.conjunto_id = c.id AND i.deleted_at IS NULL
LEFT JOIN proyectos pr ON pr.inmueble_id = i.id AND pr.deleted_at IS NULL
LEFT JOIN personas p ON p.id = pr.persona_id AND p.deleted_at IS NULL
LEFT JOIN cotizaciones cot ON cot.proyecto_id = pr.id
WHERE c.deleted_at IS NULL
GROUP BY c.id;

GRANT SELECT ON vw_conjuntos_resumen TO anon, authenticated;
GRANT ALL ON conjuntos, plantillas_respuesta TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE conjuntos_id_seq, plantillas_respuesta_id_seq TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 6. zonas_instalacion: expandir con sectores reales del Prospectos
-- ═══════════════════════════════════════════════════════════════════════
INSERT INTO zonas_instalacion (codigo, nombre, costo_traslado_incluido, notas, orden) VALUES
  ('ricaurte_penalisa',   'Ricaurte - Peñalisa',   true,  'Sector concentrado de conjuntos premium',          11),
  ('ricaurte_via_melgar', 'Ricaurte - Vía Melgar', true,  'Incluye Cabo Verde, Caranday',                    12),
  ('girardot_el_penon',   'Girardot - El Peñón',   true,  'Zona campestre, condominios alto perfil',          13),
  ('girardot_via_narino', 'Girardot - Vía Nariño', true,  'El Paso, Aqua Park, Los Mangos',                  14),
  ('girardot_norte',      'Girardot - Norte',      true,  'Casaloma, Rosa Blanca, Unicentro',                15),
  ('girardot_urbano',     'Girardot - Urbano',     true,  'Centro y comunas urbanas',                        16),
  ('girardot_via_tocaima','Girardot - Vía Tocaima',true,  'Portachuelo, Chicala',                            17),
  ('flandes_urbano',      'Flandes - Urbano',      false, 'Cruza río Magdalena, ~30 min',                    18),
  ('flandes_via_espinal', 'Flandes - Vía Espinal', false, 'Costo de traslado por evaluar',                   19),
  ('nilo_san_marcos',     'Nilo - San Marcos',     false, 'Vía a Cundinamarca, ~45 min',                     20),
  ('tocaima',             'Tocaima',               false, 'Cabecera municipal Tocaima',                      21),
  ('fusagasuga',          'Fusagasugá',            false, 'Cliente especial, costo extra',                   22)
ON CONFLICT (codigo) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- 7. personas_mencionadas — terceros nombrados en chat (base para agente A-Geo)
-- ═══════════════════════════════════════════════════════════════════════
-- Cuando un cliente menciona a "Marik", "Don Manuel", "Claudia de Lagos",
-- el agente A-Geo (futuro) extraerá la mención y la registra acá. Si el
-- nombre matchea con una persona existente, se vincula. Sirve para construir
-- la red social del cliente (referidos, vecinos, contactos en común).
CREATE TABLE IF NOT EXISTS personas_mencionadas (
  id               BIGSERIAL PRIMARY KEY,
  persona_id       BIGINT REFERENCES personas(id) ON DELETE CASCADE,    -- cliente que MENCIONA
  mensaje_id       BIGINT REFERENCES mensajes(id) ON DELETE SET NULL,
  evento_pg_id     BIGINT REFERENCES evento_pg(id) ON DELETE SET NULL,
  nombre_mencionado TEXT NOT NULL,                                       -- "Marik", "Don Manuel"
  rol_inferido     TEXT,                                                 -- 'tecnico'|'vecino'|'familiar'|'instalador'|'admin'|'referido'|'desconocido'
  persona_referida_id BIGINT REFERENCES personas(id),                    -- si se pudo resolver con quién es
  conjunto_id      BIGINT REFERENCES conjuntos(id),                      -- si se infiere conjunto del contexto
  contexto         TEXT,                                                 -- frase original de donde se extrajo
  agente_origen    TEXT,                                                 -- 'A-Geo' cuando exista
  confianza        TEXT CHECK (confianza IS NULL OR confianza IN ('CONFIRMADO','INFERIDO','DUDOSO','ALERTA','RECHAZADO')),
  shadow           BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mencionadas_persona ON personas_mencionadas(persona_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_mencionadas_referida ON personas_mencionadas(persona_referida_id) WHERE deleted_at IS NULL AND persona_referida_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mencionadas_nombre ON personas_mencionadas USING GIN (to_tsvector('spanish', nombre_mencionado));

DROP TRIGGER IF EXISTS trg_pmenc_updated_at ON personas_mencionadas;
CREATE TRIGGER trg_pmenc_updated_at BEFORE UPDATE ON personas_mencionadas
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

GRANT ALL ON personas_mencionadas TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE personas_mencionadas_id_seq TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- Verificación
-- ═══════════════════════════════════════════════════════════════════════
SELECT json_build_object(
  'plantillas_seed',        (SELECT count(*) FROM plantillas_respuesta),
  'zonas_total',            (SELECT count(*) FROM zonas_instalacion),
  'conjuntos_total',        (SELECT count(*) FROM conjuntos),
  'inmuebles_con_conjunto', (SELECT count(*) FROM inmuebles WHERE conjunto_id IS NOT NULL AND deleted_at IS NULL),
  'personas_mencionadas',   (SELECT count(*) FROM personas_mencionadas)
) AS resultado;
