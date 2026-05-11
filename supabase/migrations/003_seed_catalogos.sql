-- ============================================================================
-- 003_seed_catalogos.sql
-- Catálogos de referencia para vocabulario controlado del negocio Safra.
-- Nota: ambitos y usuarios ya quedaron seedados en 002_schema_inicial.sql
-- ============================================================================

BEGIN;

-- Catálogo de sistemas (productos Safra)
CREATE TABLE sistemas_safra (
  codigo TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  categoria TEXT NOT NULL CHECK (categoria IN ('cortina','persiana','accesorio','motorizacion','servicio')),
  garantia_meses INTEGER,
  notas TEXT,
  orden SMALLINT NOT NULL DEFAULT 99
);

INSERT INTO sistemas_safra (codigo, nombre, categoria, garantia_meses, orden) VALUES
  ('blackout',           'Blackout',                      'cortina',       12, 1),
  ('screen_solar',       'Screen Solar',                  'cortina',       12, 2),
  ('sheer_elegance',     'Sheer Elegance',                'cortina',       12, 3),
  ('panel_japones',      'Panel Japonés',                 'cortina',       12, 4),
  ('enrollables',        'Enrollables',                   'cortina',       12, 5),
  ('verticales',         'Persianas Verticales',          'persiana',      12, 6),
  ('peliculas_solares',  'Películas Solares',             'accesorio',     NULL, 7),
  ('toldos',             'Toldos',                        'cortina',       12, 8),
  ('motores',            'Motores (motorización)',        'motorizacion',  12, 9),
  ('domotica',           'Domótica',                      'motorizacion',  12, 10),
  ('rieles',             'Rieles',                        'accesorio',     12, 11),
  ('cadenillas',         'Cadenillas',                    'accesorio',     NULL, 12);

-- Catálogo de zonas de instalación (R-008)
CREATE TABLE zonas_instalacion (
  codigo TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  costo_traslado_incluido BOOLEAN NOT NULL DEFAULT false,
  notas TEXT,
  orden SMALLINT NOT NULL DEFAULT 99
);

INSERT INTO zonas_instalacion (codigo, nombre, costo_traslado_incluido, notas, orden) VALUES
  ('girardot_urbano', 'Girardot urbano',  true,  'Incluido en cotización',                    1),
  ('ricaurte',        'Ricaurte',         true,  'Incluido en cotización',                    2),
  ('melgar',          'Melgar',           false, 'Costo extra por evaluar',                   3),
  ('bogota',          'Bogotá',           false, 'Cotización especial con costos',            4),
  ('otros',           'Otras zonas',      false, 'Cotización especial caso por caso',         5);

-- Catálogo de causas de garantía (R-006, sección 14)
CREATE TABLE causas_garantia (
  codigo TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  responsable_default TEXT,
  notas TEXT
);

INSERT INTO causas_garantia (codigo, nombre, responsable_default, notas) VALUES
  ('producto',     'Defecto de producto',         'empresa',  'Tela, motor, herrajes, fabricación'),
  ('instalacion',  'Falla de instalación',        'empresa',  'Soporte mal puesto, nivelación, etc.'),
  ('cliente',      'Causa por cliente',           'cliente',  'Mal uso, daño accidental'),
  ('ambiente',     'Condiciones del ambiente',    'tercero',  'Humedad, exposición, viento'),
  ('tercero',      'Causa por tercero',           'tercero',  'Construcción, otra empresa'),
  ('construccion', 'Defectos de construcción',    'tercero',  'Vano irregular, desalineado');

-- Tipos de objeción comercial (sección 14, módulo 2.3)
CREATE TABLE tipos_objecion (
  codigo TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  notas TEXT
);

INSERT INTO tipos_objecion (codigo, nombre) VALUES
  ('precio', 'Precio'),
  ('calidad', 'Calidad'),
  ('garantia', 'Garantía'),
  ('tiempo', 'Tiempo de entrega'),
  ('competencia', 'Competencia'),
  ('color', 'Color'),
  ('diseño', 'Diseño'),
  ('instalacion', 'Instalación'),
  ('desconfianza', 'Desconfianza'),
  ('comparacion_referido', 'Comparación con referido'),
  ('comparacion_homecenter', 'Comparación con Homecenter'),
  ('comparacion_otro_proveedor', 'Comparación con otro proveedor');

-- Política de costos del sistema (configurable)
CREATE TABLE configuracion_sistema (
  clave TEXT PRIMARY KEY,
  valor JSONB NOT NULL,
  descripcion TEXT,
  actualizado_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO configuracion_sistema (clave, valor, descripcion) VALUES
  ('costo_invocacion_max_usd', '0.05', 'Tope hard por invocación de agente'),
  ('costo_diario_max_usd',     '5.00', 'Tope hard total diario; al exceder, todos los agentes pausan'),
  ('shadow_dias_default',      '7',    'Días que un agente nuevo corre en modo shadow antes de activarse'),
  ('lease_segundos',           '300',  'Duración del lease al procesar evento_pg (5 min)'),
  ('retry_max_intentos',       '3',    'Reintentos antes de mover a dead_letter_queue'),
  ('soft_delete_dias_purga',   '30',   'Días que un registro queda en papelera antes de purga física'),
  ('sla_primer_mensaje_minutos_habil',    '15', 'SLA respuesta primer mensaje en horario hábil'),
  ('sla_primer_mensaje_minutos_no_habil', '720','SLA fuera de horario (12 h)');

-- Verificación
SELECT json_build_object(
  'sistemas_safra', (SELECT count(*) FROM sistemas_safra),
  'zonas_instalacion', (SELECT count(*) FROM zonas_instalacion),
  'causas_garantia', (SELECT count(*) FROM causas_garantia),
  'tipos_objecion', (SELECT count(*) FROM tipos_objecion),
  'configuracion_sistema', (SELECT count(*) FROM configuracion_sistema)
) as resultado;

COMMIT;
