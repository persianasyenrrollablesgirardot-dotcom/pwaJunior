-- F4.1 — Schema MÓDULO 4 Técnicos
-- Tablas: medidas (con 5 etapas por item) + advertencias_safra + reglas_compatibilidad
-- Vista: vw_riesgos_medidas (alertas automáticas)
-- Seeds: advertencias de la VISION + reglas básicas

-- ─── 1. MEDIDAS (4.1) ───────────────────────────────────────────────────
-- Cada item de cotización puede tener varias medidas en distintas etapas
-- del flujo. La responsabilidad cambia según quién midió.

CREATE TABLE IF NOT EXISTS medidas (
  id                       BIGSERIAL PRIMARY KEY,
  cotizacion_item_id       BIGINT REFERENCES cotizacion_items(id) ON DELETE CASCADE,
  persona_id               BIGINT REFERENCES personas(id),                   -- denormalizado para queries rápidas
  etapa                    TEXT NOT NULL
    CHECK (etapa IN ('cliente','empresa','corregida','produccion','instalada')),
  ancho_m                  NUMERIC(6,3),
  alto_m                   NUMERIC(6,3),
  area_m2                  NUMERIC(8,3) GENERATED ALWAYS AS (COALESCE(ancho_m,0) * COALESCE(alto_m,0)) STORED,
  quien_midio              TEXT,                                             -- nombre real de quien hizo la medida
  fecha                    DATE NOT NULL DEFAULT CURRENT_DATE,
  evidencia_url            TEXT,                                             -- foto del muestreo, video, etc.
  notas                    TEXT,
  agente_origen            TEXT,
  shadow                   BOOLEAN NOT NULL DEFAULT false,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ,
  actualizado_por          BIGINT
);

-- 1 medida por etapa por item (cuando no está eliminada)
CREATE UNIQUE INDEX IF NOT EXISTS uniq_medida_item_etapa ON medidas(cotizacion_item_id, etapa) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_medidas_item    ON medidas(cotizacion_item_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_medidas_persona ON medidas(persona_id)         WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_medidas_etapa   ON medidas(etapa)              WHERE deleted_at IS NULL;

-- ─── 2. ADVERTENCIAS SAFRA (4.4) ────────────────────────────────────────
-- Texto técnico por sistema. Se muestra cuando un cliente tiene ese sistema cotizado.

CREATE TABLE IF NOT EXISTS advertencias_safra (
  id                       BIGSERIAL PRIMARY KEY,
  codigo                   TEXT UNIQUE NOT NULL,                             -- ej. 'BLACKOUT-001'
  sistema_codigo           TEXT REFERENCES sistemas_safra(codigo),           -- NULL = aplica a todos los sistemas
  titulo                   TEXT NOT NULL,
  texto                    TEXT NOT NULL,
  severidad                TEXT NOT NULL DEFAULT 'info'
    CHECK (severidad IN ('info','warning','critico')),
  contexto                 TEXT,                                             -- 'exterior' | 'interior' | 'humedad' | NULL = aplica siempre
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_advertencias_sistema ON advertencias_safra(sistema_codigo) WHERE deleted_at IS NULL;

-- Seed: las advertencias del VISION (sección 4.4) + algunas extra del CRM Zonal
INSERT INTO advertencias_safra (codigo, sistema_codigo, titulo, texto, severidad, contexto) VALUES
  ('BLACKOUT-001',  'blackout',      'Blackout NO da oscuridad absoluta',           'Sin tapaluces laterales, el blackout deja filtración de luz por los costados. Para oscuridad total ofrecer tapaluces o sistema guaya.', 'warning', NULL),
  ('SCREEN-001',    'screen_solar',  'Screen no bloquea visión nocturna',          'De día funciona como espejo (no se ve hacia adentro), pero de noche con luz interna SÍ se ve. Avisar al cliente antes de cerrar venta.', 'warning', NULL),
  ('SHEER-001',     'sheer_elegance','Sheer NO equivale a blackout',               'Sheer permite paso de luz aún cerrado. Si el cliente quiere oscuridad, NO es el sistema correcto.', 'critico', NULL),
  ('GUAYA-001',     'enrollables',   'Sistema guaya NO reemplaza tapaluz',         'La guaya guía la cortina pero no sella los costados. Para sello completo se necesita tapaluz o cajón.', 'warning', NULL),
  ('MEDIDA-CLI-001', NULL,           'Medidas tomadas por cliente: RIESGO',        'Cuando el cliente toma las medidas, la responsabilidad por error queda en el cliente (R-013#1). Idealmente, técnico re-mide antes de producir.', 'critico', NULL),
  ('EXT-VIENTO-001', NULL,           'Exterior requiere análisis de viento',       'Toldos, enrollables exteriores y películas en zonas ventosas (Girardot puede tener picos >40 km/h) necesitan refuerzos. Validar con biblioteca técnica.', 'warning', 'exterior'),
  ('HUMEDAD-001',   'blackout',      'Blackout en zonas de humedad',               'En cocinas, baños o zonas costeras, el blackout puede manchar. Recomendar screen lavable o pelicula.', 'info', 'humedad'),
  ('PANEL-001',     'panel_japones', 'Panel Japonés requiere ancho mínimo',        'Necesita al menos 80cm de ancho por panel. Para vanos más angostos, recomendar enrollables.', 'info', NULL),
  ('MOTOR-001',     'motores',       'Motorización agrega 4–6 semanas',            'Pedido de motor genera tiempo extra. Avisar al cliente que la entrega no es la misma que tela sin motorizar.', 'warning', NULL),
  ('VERTICAL-001',  'verticales',    'Verticales requieren altura mínima',         'Para alturas <1.20m las verticales no son la mejor opción (parecen mal proporcionadas). Recomendar enrollables o blackout.', 'info', NULL);

-- ─── 3. REGLAS DE COMPATIBILIDAD (4.5) ──────────────────────────────────
-- Matriz simple: por sistema, qué valores son OK o NO en cada componente.

CREATE TABLE IF NOT EXISTS reglas_compatibilidad (
  id                       BIGSERIAL PRIMARY KEY,
  codigo                   TEXT UNIQUE NOT NULL,                             -- ej. 'BLACKOUT-TELA'
  sistema_codigo           TEXT REFERENCES sistemas_safra(codigo),
  componente               TEXT NOT NULL,                                    -- 'tela' | 'tubo' | 'motor' | 'soporte' | 'cenefa' | 'riel' | 'control'
  valores_ok               TEXT[],                                           -- valores compatibles
  valores_ko               TEXT[],                                           -- valores que NO sirven (advertir)
  regla                    TEXT,                                             -- explicación textual
  severidad                TEXT NOT NULL DEFAULT 'warning'
    CHECK (severidad IN ('info','warning','critico')),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_compat_sistema ON reglas_compatibilidad(sistema_codigo) WHERE deleted_at IS NULL;

-- Seed: reglas básicas
INSERT INTO reglas_compatibilidad (codigo, sistema_codigo, componente, valores_ok, valores_ko, regla, severidad) VALUES
  ('BLACKOUT-TELA',     'blackout',     'tela',    ARRAY['poliester','algodón_revestido'], ARRAY['voile','sheer'],   'Blackout solo con telas opacas. Telas translúcidas NO bloquean luz.', 'critico'),
  ('BLACKOUT-MOTOR',    'blackout',     'motor',   ARRAY['radio','wifi','manual'],          ARRAY[]::TEXT[],          'Blackout es compatible con casi cualquier motor.',                     'info'),
  ('SCREEN-TELA',       'screen_solar', 'tela',    ARRAY['screen_3','screen_5','screen_10'], ARRAY['blackout','sheer'],'Screen requiere tela de apertura calibrada (3%, 5% o 10%). Blackout no es screen.', 'critico'),
  ('PANEL-TUBO',        'panel_japones','tubo',    ARRAY['riel_panel'],                     ARRAY['tubo_enrollable'], 'Panel Japonés usa riel específico, NO tubo enrollable.',              'critico'),
  ('VERTICAL-CONTROL',  'verticales',   'control', ARRAY['cuerda','cadena','varilla'],      ARRAY['cuerda_simple'],   'Verticales requieren control con apertura + rotación.',                'warning'),
  ('TOLDO-MOTOR',       'toldos',       'motor',   ARRAY['motor_tubular_exterior'],         ARRAY['motor_interior'],  'Toldos requieren motor con IP44 mínimo (exterior).',                   'critico'),
  ('MOTOR-CONTROL',     'motores',      'control', ARRAY['radio','wifi','control_pared'],   ARRAY[]::TEXT[],          'Los motores requieren al menos un tipo de control.',                   'info');

-- ─── 4. VISTA vw_riesgos_medidas (4.2) ──────────────────────────────────
-- Detecta automáticamente medidas con problemas

CREATE OR REPLACE VIEW vw_riesgos_medidas AS
SELECT
  m.id                                              AS medida_id,
  m.cotizacion_item_id,
  m.persona_id,
  ci.cotizacion_id,
  c.numero_cotizacion,
  ci.sistema_safra_codigo,
  ci.ambiente,
  m.etapa,
  m.ancho_m,
  m.alto_m,
  m.area_m2,
  m.quien_midio,
  m.fecha,
  -- Detecciones automáticas
  CASE
    WHEN m.ancho_m IS NULL OR m.alto_m IS NULL                                       THEN 'incompleta'
    WHEN m.ancho_m <= 0 OR m.alto_m <= 0                                             THEN 'negativa_o_cero'
    WHEN m.alto_m > m.ancho_m * 3                                                    THEN 'alto_ancho_invertido_probable'
    WHEN m.etapa = 'cliente' AND ci.quien_midio = 'cliente'                          THEN 'cliente_midio_riesgo_alto'
    WHEN m.area_m2 > 25                                                              THEN 'area_excesiva'
    WHEN m.area_m2 < 0.3                                                             THEN 'area_muy_pequena'
    ELSE NULL
  END                                               AS tipo_riesgo,
  CASE
    WHEN m.ancho_m IS NULL OR m.alto_m IS NULL                                       THEN 'critico'
    WHEN m.ancho_m <= 0 OR m.alto_m <= 0                                             THEN 'critico'
    WHEN m.alto_m > m.ancho_m * 3                                                    THEN 'warning'
    WHEN m.etapa = 'cliente' AND ci.quien_midio = 'cliente'                          THEN 'warning'
    WHEN m.area_m2 > 25                                                              THEN 'warning'
    WHEN m.area_m2 < 0.3                                                             THEN 'info'
    ELSE NULL
  END                                               AS severidad
FROM medidas m
JOIN cotizacion_items ci ON ci.id = m.cotizacion_item_id
JOIN cotizaciones c      ON c.id  = ci.cotizacion_id
WHERE m.deleted_at IS NULL
  AND ci.deleted_at IS NULL
  AND c.deleted_at IS NULL
  AND NOT m.shadow
  AND NOT c.shadow;

-- ─── 5. Vista vw_medidas_etapas — pivote para ver las 5 etapas de un item lado a lado
CREATE OR REPLACE VIEW vw_medidas_etapas AS
SELECT
  ci.id                                              AS item_id,
  ci.cotizacion_id,
  c.persona_id,
  ci.sistema_safra_codigo,
  ci.ambiente,
  ci.ancho_m  AS ancho_cotizado,
  ci.alto_m   AS alto_cotizado,
  MAX(CASE WHEN m.etapa = 'cliente'    THEN m.ancho_m END) AS ancho_cliente,
  MAX(CASE WHEN m.etapa = 'cliente'    THEN m.alto_m  END) AS alto_cliente,
  MAX(CASE WHEN m.etapa = 'empresa'    THEN m.ancho_m END) AS ancho_empresa,
  MAX(CASE WHEN m.etapa = 'empresa'    THEN m.alto_m  END) AS alto_empresa,
  MAX(CASE WHEN m.etapa = 'corregida'  THEN m.ancho_m END) AS ancho_corregida,
  MAX(CASE WHEN m.etapa = 'corregida'  THEN m.alto_m  END) AS alto_corregida,
  MAX(CASE WHEN m.etapa = 'produccion' THEN m.ancho_m END) AS ancho_produccion,
  MAX(CASE WHEN m.etapa = 'produccion' THEN m.alto_m  END) AS alto_produccion,
  MAX(CASE WHEN m.etapa = 'instalada'  THEN m.ancho_m END) AS ancho_instalada,
  MAX(CASE WHEN m.etapa = 'instalada'  THEN m.alto_m  END) AS alto_instalada
FROM cotizacion_items ci
JOIN cotizaciones c ON c.id = ci.cotizacion_id
LEFT JOIN medidas m ON m.cotizacion_item_id = ci.id AND m.deleted_at IS NULL AND NOT m.shadow
WHERE ci.deleted_at IS NULL
  AND c.deleted_at IS NULL
GROUP BY ci.id, ci.cotizacion_id, c.persona_id, ci.sistema_safra_codigo, ci.ambiente, ci.ancho_m, ci.alto_m;

-- ─── 6. Triggers updated_at
DROP TRIGGER IF EXISTS trg_medidas_updated_at ON medidas;
CREATE TRIGGER trg_medidas_updated_at BEFORE UPDATE ON medidas
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_advertencias_updated_at ON advertencias_safra;
CREATE TRIGGER trg_advertencias_updated_at BEFORE UPDATE ON advertencias_safra
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

DROP TRIGGER IF EXISTS trg_compat_updated_at ON reglas_compatibilidad;
CREATE TRIGGER trg_compat_updated_at BEFORE UPDATE ON reglas_compatibilidad
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

GRANT SELECT ON vw_riesgos_medidas, vw_medidas_etapas TO anon, authenticated;
GRANT ALL ON medidas, advertencias_safra, reglas_compatibilidad TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE medidas_id_seq, advertencias_safra_id_seq, reglas_compatibilidad_id_seq TO anon, authenticated;

SELECT json_build_object(
  'medidas',         (SELECT count(*) FROM medidas),
  'advertencias',    (SELECT count(*) FROM advertencias_safra),
  'reglas_compat',   (SELECT count(*) FROM reglas_compatibilidad),
  'riesgos_view',    (SELECT count(*) FROM vw_riesgos_medidas)
) AS resultado;
