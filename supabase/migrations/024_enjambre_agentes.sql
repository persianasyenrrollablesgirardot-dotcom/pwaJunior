-- F1.A — Enjambre de agentes IA: 33 agentes en 10 capas + tabla de pipelines.
--
-- Capas:
--   L1 Extracción objetiva (5)
--   L2 Routing / clasificación (4)
--   L3 Identidad y contexto (4)
--   L4 Comerciales (5)
--   L5 Financiero (4)
--   L6 Técnico (3)
--   L7 Operativo (3)
--   L8 Postventa (4)
--   L10 Asistente personal (1)
--
-- Total nuevos en seed: 29. Mantengo A1, A5, A6, JUNIOR existentes
-- y normalizo sus códigos a los nuevos (A5 → A4_COTIZ, A6 → A5_ABONO).
-- L9 supervisor: el validador es módulo TS (validador.ts), no agente IA.

-- ═══════════════════════════════════════════════════════════════════════
-- 1. Tabla agente_pipelines (DAG declarativo)
-- ═══════════════════════════════════════════════════════════════════════
-- Un pipeline define una cadena de agentes que se ejecutan sobre un evento.
-- Soporta paralelo (varios agentes a la vez), serial (uno después del otro),
-- y routing condicional (si A2_INTENCION devuelve 'cotizar' → corre A4_COTIZ).
--
-- Forma del JSONB pasos:
--   {
--     "fases": [
--       { "id": "extraccion",   "modo": "paralelo", "agentes": ["A1","A1_MEDIDAS"] },
--       { "id": "clasificar",   "modo": "serial",   "agentes": ["A2_INTENCION"] },
--       { "id": "routing_int",  "modo": "routing",  "switch_on": "intencion",
--         "rutas": { "cotizar": ["A3_IDENTIDAD","A3_INMUEBLE","A4_COTIZ"],
--                    "pagar":   ["A3_IDENTIDAD","A5_ABONO","A5_COMPROB"],
--                    "urgente": ["A8_RECLAMO"] } }
--     ]
--   }

CREATE TABLE IF NOT EXISTS agente_pipelines (
  id                  BIGSERIAL PRIMARY KEY,
  codigo              TEXT UNIQUE NOT NULL,
  descripcion         TEXT,
  trigger_tipo_evento TEXT NOT NULL,                            -- 'mensaje_entrante', 'mensaje_audio', etc.
  trigger_condiciones JSONB,                                     -- filtros adicionales (ambito='comercial', tipo='audio')
  pasos               JSONB NOT NULL,                            -- el DAG
  activo              BOOLEAN NOT NULL DEFAULT false,
  shadow              BOOLEAN NOT NULL DEFAULT true,             -- modo shadow: los outputs van a evento_pg shadow
  prioridad           SMALLINT NOT NULL DEFAULT 5,
  costo_max_estimado_usd NUMERIC(8,4) NOT NULL DEFAULT 0.05,
  version             INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipelines_trigger ON agente_pipelines(trigger_tipo_evento) WHERE activo;

DROP TRIGGER IF EXISTS trg_pipelines_updated_at ON agente_pipelines;
CREATE TRIGGER trg_pipelines_updated_at BEFORE UPDATE ON agente_pipelines
  FOR EACH ROW EXECUTE FUNCTION trg_updated_at_now();

GRANT ALL ON agente_pipelines TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE agente_pipelines_id_seq TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- 2. Renombrar agentes existentes a la nueva nomenclatura
-- ═══════════════════════════════════════════════════════════════════════
-- A1 era 'A1_extractor'. Lo dejamos pero re-rotulamos su rol como entidades.
-- A5 era cotizaciones; lo movemos a código A4_COTIZ.
-- A6 era financiero; lo movemos a A5_ABONO.
-- JUNIOR lo movemos a A10_JUNIOR para consistencia.

UPDATE agentes_definicion SET codigo = 'A4_COTIZ', nombre = 'A4_cotizaciones',
  proposito = 'Detecta intención de cotizar y propone cotización inicial con items inferidos del diálogo'
WHERE codigo = 'A5';

UPDATE agentes_definicion SET codigo = 'A5_ABONO', nombre = 'A5_detector_abono',
  proposito = 'Detecta confirmaciones de pago/abono en mensajes y propone abonos al buzón'
WHERE codigo = 'A6';

UPDATE agentes_definicion SET codigo = 'A10_JUNIOR', nombre = 'A10_junior',
  proposito = 'Asistente personal de Jhon. Responde consultas sobre clientes desde el celular.'
WHERE codigo = 'JUNIOR';

UPDATE agentes_definicion SET codigo = 'A1_ENTIDADES', nombre = 'A1_extractor_entidades',
  proposito = 'Extrae entidades objetivas (nombres, teléfonos, emails, fechas) de mensajes WhatsApp'
WHERE codigo = 'A1';

-- ═══════════════════════════════════════════════════════════════════════
-- 3. Seed de los 29 agentes nuevos (todos activo=false, shadow=true)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO agentes_definicion (codigo, nombre, proposito, ambitos, criticidad, prompt_especifico, reglas_duras, costo_limite_usd, activo, shadow) VALUES

-- L1 Extracción (4 nuevos; A1_ENTIDADES ya existe)
('A1_MEDIDAS',   'A1_extractor_medidas',   'Extrae medidas (ancho × alto en metros) de mensajes texto + transcripciones',
  ARRAY['comercial']::TEXT[], 'alta',
  'Sos extractor de medidas. Regex + NER. NO inferís intención. Output JSON con {ancho_m, alto_m, ambiente, confianza}.',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

('A1_MONTOS',    'A1_extractor_montos',    'Extrae montos (precios, abonos, saldos) en formato COP',
  ARRAY['comercial']::TEXT[], 'alta',
  'Extractor de montos. Normaliza "$850.000", "850 mil", "850K" → 850000. NO infieres si es precio/abono/saldo, solo monto.',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

('A1_AUDIO',     'A1_transcriptor_audio',  'Transcribe audios WhatsApp con Whisper. Devuelve texto + duración + idioma.',
  ARRAY['comercial','proveedor']::TEXT[], 'media',
  'Transcribe sin interpretar. Output: texto literal del audio.',
  ARRAY['R-001']::TEXT[], 0.03, false, true),

('A1_OCR',       'A1_ocr_imagenes',        'Extrae texto de imágenes (comprobantes, facturas, fotos de medidas)',
  ARRAY['comercial','proveedor']::TEXT[], 'media',
  'OCR vía Vision API. NO interpretás contenido, solo extraés texto.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

-- L2 Routing (4)
('A2_AMBITO',    'A2_clasificador_ambito',  'Clasifica chat en comercial / proveedor / personal / spam',
  ARRAY['comercial','proveedor']::TEXT[], 'alta',
  'Clasificador. Devolvés un único valor del enum + confianza.',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

('A2_INTENCION', 'A2_clasificador_intencion', 'Clasifica intención del mensaje: cotizar/pagar/queja/consulta_estado/urgente/saludo',
  ARRAY['comercial']::TEXT[], 'alta',
  'Clasificador router. Salida exacta del enum. Si dudás → "consulta_estado".',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

('A2_NOCLIENTE', 'A2_detector_no_cliente',  'Detecta si el chat es restaurante/transporte/spam/encuesta (no es cliente real)',
  ARRAY['comercial']::TEXT[], 'media',
  'Detector heurístico. Marcá no-cliente solo si hay evidencia clara.',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

('A2_ROL',       'A2_detector_rol_emisor',  'Detecta si el emisor es cliente / vecino / técnico / familiar / admin / proveedor',
  ARRAY['comercial']::TEXT[], 'media',
  'Inferís rol a partir del contenido del mensaje. Default: cliente.',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

-- L3 Identidad (4)
('A3_IDENTIDAD', 'A3_resolver_identidad',  'Matchea jid → persona. Sugiere fusión si detecta duplicado.',
  ARRAY['comercial','proveedor']::TEXT[], 'alta',
  'Resolver persona. Solo proponés fusión si confianza CONFIRMADO (matchee >2 campos: tel+nombre, jid+email...).',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

('A3_INMUEBLE',  'A3_resolver_inmueble',   'Cliente menciona conjunto/dirección → match en tabla conjuntos, autocompleta inmueble',
  ARRAY['comercial']::TEXT[], 'alta',
  'Resolver inmueble. Fuzzy match en tabla conjuntos. Si no hay match exacto, devolvés top-3 candidatos.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

('A3_GEO',       'A3_resolver_geo_zona',   'Mapea sector/ciudad mencionada → zonas_instalacion, calcula costo de traslado',
  ARRAY['comercial']::TEXT[], 'media',
  'Resolver zona geográfica. Default: girardot_urbano si no se infiere.',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

('A3_GRAFO',     'A3_grafo_social',        'Detecta menciones a terceros (Marik, Don Manuel) → registra en personas_mencionadas',
  ARRAY['comercial']::TEXT[], 'media',
  'Extraés nombres de terceros mencionados + rol inferido + contexto. NO creás persona si no la encontrás.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

-- L4 Comerciales (4 nuevos; A4_COTIZ ya renombrado)
('A4_OBJECIONES','A4_detector_objeciones', 'Detecta objeciones del cliente: "está muy caro", "lo pienso", "compito con X"',
  ARRAY['comercial']::TEXT[], 'media',
  'Detectás objeciones con su tipo (precio/calidad/competencia/tiempo) y la frase exacta del cliente.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

('A4_RECOMPRA',  'A4_detector_recompra',   'Cliente ganado hace > 6 meses sin actividad → propone tarea de contacto',
  ARRAY['comercial']::TEXT[], 'baja',
  'Sugerís recompra. Output: lista de candidatos con razón ("instaló blackout hace 8m, puede querer dormitorios").',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

('A4_REFERIDOS', 'A4_detector_referidos',  'Cliente menciona vecino/familiar → propone vincular como referido potencial',
  ARRAY['comercial']::TEXT[], 'media',
  'Detectás referidos potenciales. NO creás persona, solo proponés vínculo si vecino aparece como conocido del cliente.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

('A4_COMPAT',    'A4_validador_compatibilidad', 'Cliente pide config rara → valida vs reglas_compatibilidad, alerta si no funciona',
  ARRAY['comercial']::TEXT[], 'alta',
  'Validás compatibilidad. Si cliente pide combinación no soportada (ej: blackout con tela voile), alertás.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

-- L5 Financiero (3 nuevos; A5_ABONO ya renombrado)
('A5_COMPROB',   'A5_validador_comprobante', 'Foto comprobante de pago → OCR → match con monto y cuenta receptora esperados',
  ARRAY['comercial']::TEXT[], 'alta',
  'Validás comprobante. OCR + match. Si el monto no coincide → ALERTA. NO confirmás abono solo, lo proponés al buzón.',
  ARRAY['R-001','R-009']::TEXT[], 0.03, false, true),

('A5_CARTERA',   'A5_cartera_recordatorio', 'Detecta saldos pendientes > 7d → propone tarea recordatorio',
  ARRAY['comercial']::TEXT[], 'media',
  'Generás recordatorios de cartera. Output: lista clientes + plantilla de mensaje sugerido.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

('A5_RENTAB',    'A5_calculador_rentabilidad', 'Cuando se registra costo, calcula margen real y alerta si margen <10%',
  ARRAY['comercial']::TEXT[], 'baja',
  'Calculás rentabilidad. Si margen < 10% alertás. Si margen negativo, propones revisión urgente.',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

-- L6 Técnico (3)
('A6_MEDIDAS',   'A6_validador_medidas',   'Aplica R-013#1, detecta alto/ancho invertido, medidas tomadas por cliente',
  ARRAY['comercial']::TEXT[], 'alta',
  'Validás cada medida. Si quien_midio != tecnico → marcás riesgo. Si alto > 3×ancho → alertás (invertido probable).',
  ARRAY['R-001','R-013#1']::TEXT[], 0.01, false, true),

('A6_RIESGO',    'A6_riesgo_tecnico',      'Detecta vano irregular, exterior con viento, humedad → genera advertencia',
  ARRAY['comercial']::TEXT[], 'alta',
  'Detectás riesgos técnicos del proyecto. Cruzás contexto inmueble + sistema solicitado + zona geográfica.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

('A6_BIBLIO',    'A6_consultor_biblioteca',  'Cliente pregunta tema técnico → consulta agente especialista en biblioteca RAG',
  ARRAY['comercial']::TEXT[], 'media',
  'Cliente del proyecto RAG (localhost:5500). Recibís pregunta técnica + sistema, devolvés respuesta del especialista.',
  ARRAY['R-001']::TEXT[], 0.05, false, true),

-- L7 Operativo (3)
('A7_TAREAS',    'A7_detector_tareas',     '"llamame mañana", "necesito que vayas el viernes" → crea tarea con fecha inferida',
  ARRAY['comercial']::TEXT[], 'alta',
  'Extraés tareas operativas. Output: {titulo, tipo, fecha_vence, prioridad}. NO creás directo, vas al buzón.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

('A7_RUTAS',     'A7_planificador_rutas',  'Instalaciones próximas + zonas → propone agrupación geográfica óptima',
  ARRAY['comercial']::TEXT[], 'baja',
  'Optimizás ruta semanal. Agrupás por zona, sugerís orden por proximidad.',
  ARRAY['R-001']::TEXT[], 0.03, false, true),

('A7_ESTADO',    'A7_responder_estado',    'Cliente pregunta "cuándo me lo entregan?" → consulta produccion + responde',
  ARRAY['comercial']::TEXT[], 'media',
  'Respondés consultas de estado. Leés produccion_orden + instalaciones. NO inventás fechas si BD no las tiene.',
  ARRAY['R-001']::TEXT[], 0.02, false, true),

-- L8 Postventa (4)
('A8_GARANTIA',  'A8_detector_garantia',   'Cliente reporta falla → abre garantía con causa inferida + responsable default',
  ARRAY['comercial']::TEXT[], 'alta',
  'Detectás reporte de garantía. Inferís causa (producto/instalación/cliente/ambiente). Vas al buzón.',
  ARRAY['R-001','R-006']::TEXT[], 0.03, false, true),

('A8_SATIS',     'A8_detector_satisfaccion', 'Palabras "muy contento" / "muy molesto" / "no respondió" → registra estado_cliente',
  ARRAY['comercial']::TEXT[], 'media',
  'Detectás sentimiento del cliente respecto a la instalación reciente. Output: estado_cliente del enum.',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

('A8_REPUT',     'A8_solicitador_reputacion','Cliente satisfecho + cotización ganada → marca apto + sugiere plantilla envío reseña',
  ARRAY['comercial']::TEXT[], 'baja',
  'Sugerís quién es apto para pedirle reseña Google. Conservador: solo si confianza CONFIRMADO en satisfacción positiva.',
  ARRAY['R-001']::TEXT[], 0.01, false, true),

('A8_RECLAMO',   'A8_detector_reclamo_sensible', 'Urgencia + queja + amenaza pública → escala a Jhon con severidad alta/crítica',
  ARRAY['comercial']::TEXT[], 'alta',
  'Detectás reclamos sensibles. Si urgencia + queja + amenaza ("voy a poner mala reseña", "llamo a la fiscal", "voy a denunciar") → severidad CRÍTICA, escalás INMEDIATO.',
  ARRAY['R-001']::TEXT[], 0.03, false, true)

ON CONFLICT (codigo) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- 4. Seed de pipelines básicos (3 al inicio; se agregan más después)
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO agente_pipelines (codigo, descripcion, trigger_tipo_evento, trigger_condiciones, pasos, activo, shadow) VALUES

('PIPE_MENSAJE_COMERCIAL', 'Pipeline principal para mensajes WhatsApp ámbito comercial',
  'mensaje_entrante', '{"ambito": "comercial", "tipo_mensaje": "texto"}'::jsonb,
  '{
    "fases": [
      { "id": "extraccion",  "modo": "paralelo", "agentes": ["A1_ENTIDADES","A1_MEDIDAS","A1_MONTOS"] },
      { "id": "clasificar",  "modo": "serial",   "agentes": ["A2_AMBITO","A2_INTENCION","A2_ROL"] },
      { "id": "identidad",   "modo": "serial",   "agentes": ["A3_IDENTIDAD","A3_INMUEBLE","A3_GEO","A3_GRAFO"] },
      { "id": "operativo",   "modo": "routing",  "switch_on": "intencion",
        "rutas": {
          "cotizar":          ["A4_COTIZ","A4_COMPAT"],
          "pagar":            ["A5_ABONO"],
          "queja":            ["A8_GARANTIA","A8_RECLAMO"],
          "consulta_estado":  ["A7_ESTADO"],
          "urgente":          ["A8_RECLAMO"],
          "saludo":           [],
          "_default":         ["A7_TAREAS"]
        }
      }
    ]
  }'::jsonb,
  false, true),

('PIPE_AUDIO', 'Audio WA → transcripción → vuelve al pipeline texto',
  'mensaje_entrante', '{"tipo_mensaje": "audio"}'::jsonb,
  '{
    "fases": [
      { "id": "transcribir", "modo": "serial", "agentes": ["A1_AUDIO"] },
      { "id": "post",        "modo": "serial", "agentes": [],
        "comentario": "Tras transcribir, el worker re-procesa el evento como tipo=texto" }
    ]
  }'::jsonb,
  false, true),

('PIPE_IMAGEN', 'Imagen WA → OCR → si parece comprobante, validar; si parece medida, extraer',
  'mensaje_entrante', '{"tipo_mensaje": "imagen"}'::jsonb,
  '{
    "fases": [
      { "id": "ocr",          "modo": "serial",   "agentes": ["A1_OCR"] },
      { "id": "rutear_imagen","modo": "routing", "switch_on": "tipo_imagen",
        "rutas": {
          "comprobante":  ["A5_COMPROB"],
          "medida":       ["A1_MEDIDAS","A6_MEDIDAS"],
          "garantia":     ["A8_GARANTIA"],
          "_default":     []
        }
      }
    ]
  }'::jsonb,
  false, true)

ON CONFLICT (codigo) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- Verificación
-- ═══════════════════════════════════════════════════════════════════════
SELECT json_build_object(
  'agentes_total',       (SELECT count(*) FROM agentes_definicion),
  'agentes_shadow',      (SELECT count(*) FROM agentes_definicion WHERE shadow AND NOT activo),
  'agentes_por_capa', (
    SELECT json_object_agg(capa, n) FROM (
      SELECT substring(codigo, 1, 2) AS capa, count(*) AS n
      FROM agentes_definicion GROUP BY 1 ORDER BY 1
    ) sub
  ),
  'pipelines_total',     (SELECT count(*) FROM agente_pipelines)
) AS resultado;
