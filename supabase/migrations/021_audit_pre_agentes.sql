-- F8.1 — FIXES PRE-AGENTES (auditoría profunda M1-M7)
-- Aplica 5 CRÍTICOS + 2 IMPORTANTES detectados antes de implementar
-- los agentes IA del enjambre. Migración idempotente.

-- ═══════════════════════════════════════════════════════════════════════
-- CRIT-1. Agregar campos de agente a 3 tablas de negocio
-- ═══════════════════════════════════════════════════════════════════════
-- Permite que agentes (A5 cotizaciones, agente postventa, etc.) inserten
-- filas en estas tablas con shadow=true (invisibles en UI hasta validar
-- vía buzón).

ALTER TABLE cotizacion_items
  ADD COLUMN IF NOT EXISTS agente_origen TEXT,
  ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confianza TEXT CHECK (confianza IS NULL OR confianza IN ('CONFIRMADO','INFERIDO','DUDOSO','ALERTA','RECHAZADO')),
  ADD COLUMN IF NOT EXISTS evento_origen_id BIGINT REFERENCES evento_pg(id) ON DELETE SET NULL;

ALTER TABLE cotizacion_objeciones
  ADD COLUMN IF NOT EXISTS agente_origen TEXT,
  ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS confianza TEXT CHECK (confianza IS NULL OR confianza IN ('CONFIRMADO','INFERIDO','DUDOSO','ALERTA','RECHAZADO')),
  ADD COLUMN IF NOT EXISTS evento_origen_id BIGINT REFERENCES evento_pg(id) ON DELETE SET NULL;

ALTER TABLE checklist_instalacion_items
  ADD COLUMN IF NOT EXISTS agente_origen TEXT,
  ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS evento_origen_id BIGINT REFERENCES evento_pg(id) ON DELETE SET NULL;

-- Índice único para idempotencia agente: 1 fila por (agente, evento_origen)
CREATE UNIQUE INDEX IF NOT EXISTS uq_cot_items_agente_evento
  ON cotizacion_items(agente_origen, evento_origen_id)
  WHERE agente_origen IS NOT NULL AND evento_origen_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cot_obj_agente_evento
  ON cotizacion_objeciones(agente_origen, evento_origen_id)
  WHERE agente_origen IS NOT NULL AND evento_origen_id IS NOT NULL AND deleted_at IS NULL;

-- ═══════════════════════════════════════════════════════════════════════
-- CRIT-2. buzon_validacion polimórfico + RPC aprobar_buzon_atomic
-- ═══════════════════════════════════════════════════════════════════════
-- Hoy el buzón tiene JSONB libre; al aprobar no sabe qué fila levantar a
-- shadow=false. Lo resolvemos con FK polimórfica (entidad_tipo + entidad_id).

ALTER TABLE buzon_validacion
  ADD COLUMN IF NOT EXISTS entidad_tipo TEXT CHECK (entidad_tipo IS NULL OR entidad_tipo IN (
    'cotizacion','cotizacion_item','cotizacion_objecion','cotizacion_variacion',
    'abono','factura','medida','instalacion','tarea','garantia','mantenimiento',
    'satisfaccion','google_review','reclamo','evidencia','costo','produccion_orden'
  )),
  ADD COLUMN IF NOT EXISTS entidad_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_buzon_entidad ON buzon_validacion(entidad_tipo, entidad_id) WHERE entidad_tipo IS NOT NULL;

-- CHECK enum para tipo_decision (impide valores inventados por agentes)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints WHERE constraint_name = 'chk_tipo_decision'
  ) THEN
    ALTER TABLE buzon_validacion ADD CONSTRAINT chk_tipo_decision CHECK (tipo_decision IN (
      'cotizacion_propuesta','cotizacion_item_propuesto','cotizacion_objecion_propuesta',
      'abono_propuesto','factura_propuesta','medida_propuesta','instalacion_propuesta',
      'tarea_propuesta','garantia_propuesta','mantenimiento_propuesto','review_propuesta',
      'reclamo_propuesto','evidencia_propuesta','costo_propuesto','variacion_propuesta',
      'cambio_estado','correccion_humana','pregunta_humano','dato_extraido','otro'
    ));
  END IF;
END $$;

-- RPC atómica: aprueba el buzón Y levanta la entidad correspondiente a shadow=false
CREATE OR REPLACE FUNCTION aprobar_buzon_atomic(
  p_buzon_id BIGINT,
  p_resuelto_por BIGINT DEFAULT 1,
  p_comentario TEXT DEFAULT NULL
) RETURNS JSONB AS $$
DECLARE
  v_buzon RECORD;
  v_tabla TEXT;
  v_rows_afectadas INTEGER := 0;
BEGIN
  SELECT * INTO v_buzon FROM buzon_validacion WHERE id = p_buzon_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Buzón % no encontrado', p_buzon_id;
  END IF;
  IF v_buzon.estado != 'pendiente' THEN
    RAISE EXCEPTION 'Buzón % ya está en estado %', p_buzon_id, v_buzon.estado;
  END IF;

  -- Si tiene entidad polimórfica, levantar shadow=false en esa tabla
  IF v_buzon.entidad_tipo IS NOT NULL AND v_buzon.entidad_id IS NOT NULL THEN
    v_tabla := CASE v_buzon.entidad_tipo
      WHEN 'cotizacion'           THEN 'cotizaciones'
      WHEN 'cotizacion_item'      THEN 'cotizacion_items'
      WHEN 'cotizacion_objecion'  THEN 'cotizacion_objeciones'
      WHEN 'cotizacion_variacion' THEN 'cotizacion_variaciones'
      WHEN 'abono'                THEN 'abonos'
      WHEN 'factura'              THEN 'facturas'
      WHEN 'medida'               THEN 'medidas'
      WHEN 'instalacion'          THEN 'instalaciones'
      WHEN 'tarea'                THEN 'tareas'
      WHEN 'garantia'             THEN 'garantias'
      WHEN 'mantenimiento'        THEN 'mantenimientos'
      WHEN 'satisfaccion'         THEN 'satisfaccion_postventa'
      WHEN 'google_review'        THEN 'google_reviews'
      WHEN 'reclamo'              THEN 'reclamos_sensibles'
      WHEN 'evidencia'            THEN 'evidencias'
      WHEN 'costo'                THEN 'costos_proyecto'
      WHEN 'produccion_orden'     THEN 'produccion_orden'
      ELSE NULL
    END;

    IF v_tabla IS NOT NULL THEN
      EXECUTE format('UPDATE %I SET shadow = false, updated_at = now() WHERE id = $1 AND shadow = true', v_tabla)
        USING v_buzon.entidad_id;
      GET DIAGNOSTICS v_rows_afectadas = ROW_COUNT;
    END IF;
  END IF;

  UPDATE buzon_validacion SET
    estado = 'aprobado',
    resuelto_por = p_resuelto_por,
    resuelto_at = now(),
    comentario_humano = COALESCE(p_comentario, comentario_humano)
  WHERE id = p_buzon_id;

  RETURN jsonb_build_object(
    'ok', true,
    'buzon_id', p_buzon_id,
    'entidad_tipo', v_buzon.entidad_tipo,
    'entidad_id', v_buzon.entidad_id,
    'filas_levantadas', v_rows_afectadas
  );
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION aprobar_buzon_atomic(BIGINT, BIGINT, TEXT) TO anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════
-- CRIT-3. agente_invocaciones + vw_centro_control_agentes + seed
-- ═══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agente_invocaciones (
  id                BIGSERIAL PRIMARY KEY,
  agente_codigo     TEXT NOT NULL,
  evento_id         BIGINT REFERENCES evento_pg(id) ON DELETE SET NULL,
  persona_id        BIGINT REFERENCES personas(id),
  modelo            TEXT,                                  -- 'deepseek-chat', 'gpt-4o-mini', etc.
  tokens_in         INTEGER,
  tokens_out        INTEGER,
  tokens_cached     INTEGER,
  costo_usd         NUMERIC(10,6) NOT NULL DEFAULT 0,
  latencia_ms       INTEGER,
  intentos          SMALLINT NOT NULL DEFAULT 1,
  ok                BOOLEAN NOT NULL,
  error_msg         TEXT,
  resultado_resumen TEXT,
  confianza         TEXT CHECK (confianza IS NULL OR confianza IN ('CONFIRMADO','INFERIDO','DUDOSO','ALERTA','RECHAZADO')),
  shadow            BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agente_inv_codigo_fecha ON agente_invocaciones(agente_codigo, created_at);
CREATE INDEX IF NOT EXISTS idx_agente_inv_evento       ON agente_invocaciones(evento_id) WHERE evento_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agente_inv_persona      ON agente_invocaciones(persona_id) WHERE persona_id IS NOT NULL;

-- Vista de Centro de Control: una fila por agente con métricas del día
CREATE OR REPLACE VIEW vw_centro_control_agentes AS
SELECT
  ad.codigo                                                                                 AS agente_codigo,
  ad.nombre                                                                                 AS agente_nombre,
  ad.activo                                                                                 AS activo,
  ad.shadow                                                                                 AS modo_shadow,
  ad.criticidad,
  ad.costo_limite_usd,
  COALESCE(COUNT(ai.id) FILTER (WHERE ai.created_at::date = CURRENT_DATE), 0)               AS invocaciones_hoy,
  COALESCE(COUNT(ai.id) FILTER (WHERE ai.created_at::date = CURRENT_DATE AND ai.ok), 0)     AS exitos_hoy,
  COALESCE(COUNT(ai.id) FILTER (WHERE ai.created_at::date = CURRENT_DATE AND NOT ai.ok), 0) AS errores_hoy,
  COALESCE(SUM(ai.costo_usd) FILTER (WHERE ai.created_at::date = CURRENT_DATE), 0)::NUMERIC(10,4) AS costo_hoy_usd,
  COALESCE(AVG(ai.latencia_ms) FILTER (WHERE ai.created_at::date = CURRENT_DATE AND ai.ok), 0)::INTEGER AS latencia_promedio_ms,
  MAX(ai.created_at)                                                                        AS ultima_invocacion,
  (SELECT count(*) FROM dead_letter_queue dlq WHERE dlq.agente_codigo = ad.codigo)          AS en_dead_letter_queue
FROM agentes_definicion ad
LEFT JOIN agente_invocaciones ai ON ai.agente_codigo = ad.codigo
GROUP BY ad.codigo, ad.nombre, ad.activo, ad.shadow, ad.criticidad, ad.costo_limite_usd;

GRANT SELECT ON vw_centro_control_agentes TO anon, authenticated;
GRANT ALL ON agente_invocaciones TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE agente_invocaciones_id_seq TO anon, authenticated;

-- Seed inicial de agentes (shadow=true por default, activos=false hasta probar)
INSERT INTO agentes_definicion (codigo, nombre, proposito, ambitos, criticidad, prompt_especifico, reglas_duras, costo_limite_usd, activo, shadow)
VALUES
  ('A1', 'A1_extractor', 'Extrae datos objetivos (nombres, teléfonos, medidas, precios, fechas) de mensajes WhatsApp', ARRAY['comercial']::TEXT[], 'alta',
   'Sos un extractor objetivo. NO inferís intención, NO sacás conclusiones. Solo regex+NER.', ARRAY['R-001']::TEXT[], 0.02, false, true),
  ('A5', 'A5_cotizaciones', 'Detecta intención de cotizar y propone cotización inicial con items inferidos del diálogo', ARRAY['comercial']::TEXT[], 'alta',
   'Sos el agente de cotizaciones. Proponés cotización SHADOW a buzón. Citás evidencia siempre.', ARRAY['R-001','R-013#1']::TEXT[], 0.05, false, true),
  ('A6', 'A6_financiero', 'Detecta confirmaciones de pago/abono en mensajes y propone abonos al buzón', ARRAY['comercial']::TEXT[], 'alta',
   'Sos el agente financiero. Mensaje "ya te transferí X" → propones abono SHADOW con comprobante.', ARRAY['R-001','R-009']::TEXT[], 0.03, false, true),
  ('JUNIOR', 'JUNIOR_secretario', 'Asistente personal de Jhon. Responde consultas sobre clientes desde el celular.', ARRAY['comercial','proveedor']::TEXT[], 'media',
   'Sos el secretario personal de Jhon. Solo respondés desde BD; NO inventás.', ARRAY['R-001']::TEXT[], 0.10, false, true)
ON CONFLICT (codigo) DO NOTHING;

-- ═══════════════════════════════════════════════════════════════════════
-- CRIT-5. R-013#1 enforced también en tabla `medidas`
-- ═══════════════════════════════════════════════════════════════════════

ALTER TABLE medidas
  ADD COLUMN IF NOT EXISTS riesgo_medicion BOOLEAN NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION trg_riesgo_medicion_medidas() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.quien_midio IS NOT NULL AND NEW.quien_midio != 'tecnico' THEN
    NEW.riesgo_medicion := true;
  ELSE
    NEW.riesgo_medicion := false;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_medidas_riesgo ON medidas;
CREATE TRIGGER trg_medidas_riesgo
  BEFORE INSERT OR UPDATE OF quien_midio ON medidas
  FOR EACH ROW EXECUTE FUNCTION trg_riesgo_medicion_medidas();

-- Backfill: marcar riesgo en medidas existentes que no son técnico
UPDATE medidas SET riesgo_medicion = true
WHERE quien_midio IS NOT NULL AND quien_midio != 'tecnico' AND riesgo_medicion = false;

-- ═══════════════════════════════════════════════════════════════════════
-- IMP-1. Trigger trg_recalc_cotizacion_abonos: early-return en shadow
-- ═══════════════════════════════════════════════════════════════════════
-- Hoy el trigger se dispara incluso para abonos shadow=true (aunque no los
-- cuenta en SUM). Esto causa updates inútiles a cotizaciones.updated_at +
-- notificaciones Realtime sin razón.

CREATE OR REPLACE FUNCTION trg_recalc_cotizacion_abonos() RETURNS TRIGGER AS $$
DECLARE
  v_cot_id BIGINT;
  v_sum NUMERIC(14,2);
  v_total NUMERIC(14,2);
BEGIN
  -- Early-return si solo se tocaron filas shadow
  IF TG_OP = 'INSERT' AND NEW.shadow THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(NEW.shadow, false) AND COALESCE(OLD.shadow, false) THEN RETURN NEW; END IF;
  IF TG_OP = 'DELETE' AND OLD.shadow THEN RETURN OLD; END IF;

  v_cot_id := COALESCE(NEW.cotizacion_id, OLD.cotizacion_id);
  IF v_cot_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  SELECT COALESCE(SUM(monto), 0) INTO v_sum
  FROM abonos
  WHERE cotizacion_id = v_cot_id
    AND deleted_at IS NULL
    AND estado_validacion != 'rechazado'
    AND NOT shadow;

  SELECT total INTO v_total FROM cotizaciones WHERE id = v_cot_id;

  UPDATE cotizaciones SET
    abono_monto = v_sum,
    saldo = COALESCE(v_total, 0) - v_sum,
    updated_at = now()
  WHERE id = v_cot_id;

  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- ═══════════════════════════════════════════════════════════════════════
-- IMP-2. CASCADE → SET NULL en FKs hacia tablas con soft-delete
-- ═══════════════════════════════════════════════════════════════════════
-- Mantengo CASCADE solo para composiciones fuertes (items/objeciones/checklist
-- son INTRÍNSECAMENTE parte del padre y NO tiene sentido huérfanos).
-- Cambio a SET NULL las asociaciones laterales (abono PUEDE existir sin
-- cotización: caso de abono adelantado por proyecto futuro).

-- abonos.cotizacion_id: SET NULL (asociación lateral)
ALTER TABLE abonos DROP CONSTRAINT IF EXISTS abonos_cotizacion_id_fkey;
ALTER TABLE abonos ADD CONSTRAINT abonos_cotizacion_id_fkey
  FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones(id) ON DELETE SET NULL;

-- costos_proyecto.cotizacion_id: SET NULL
ALTER TABLE costos_proyecto DROP CONSTRAINT IF EXISTS costos_proyecto_cotizacion_id_fkey;
ALTER TABLE costos_proyecto ADD CONSTRAINT costos_proyecto_cotizacion_id_fkey
  FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones(id) ON DELETE SET NULL;

-- cotizacion_variaciones.cotizacion_id: SET NULL
ALTER TABLE cotizacion_variaciones DROP CONSTRAINT IF EXISTS cotizacion_variaciones_cotizacion_id_fkey;
ALTER TABLE cotizacion_variaciones ADD CONSTRAINT cotizacion_variaciones_cotizacion_id_fkey
  FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones(id) ON DELETE SET NULL;

-- instalaciones.cotizacion_id: SET NULL
ALTER TABLE instalaciones DROP CONSTRAINT IF EXISTS instalaciones_cotizacion_id_fkey;
ALTER TABLE instalaciones ADD CONSTRAINT instalaciones_cotizacion_id_fkey
  FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones(id) ON DELETE SET NULL;

-- produccion_orden.cotizacion_id: SET NULL
ALTER TABLE produccion_orden DROP CONSTRAINT IF EXISTS produccion_orden_cotizacion_id_fkey;
ALTER TABLE produccion_orden ADD CONSTRAINT produccion_orden_cotizacion_id_fkey
  FOREIGN KEY (cotizacion_id) REFERENCES cotizaciones(id) ON DELETE SET NULL;

-- Mantengo CASCADE en cotizaciones→proyectos (proyecto borrado es escenario raro pero limpio)

-- ═══════════════════════════════════════════════════════════════════════
-- Verificación final
-- ═══════════════════════════════════════════════════════════════════════
SELECT json_build_object(
  'tablas_con_shadow_agente_origen', (
    SELECT count(DISTINCT c1.table_name) FROM information_schema.columns c1
    WHERE c1.table_schema = 'public' AND c1.column_name = 'shadow'
      AND EXISTS (SELECT 1 FROM information_schema.columns c2
                  WHERE c2.table_name = c1.table_name AND c2.column_name = 'agente_origen')
  ),
  'agentes_definicion_total', (SELECT count(*) FROM agentes_definicion),
  'agentes_invocaciones_total', (SELECT count(*) FROM agente_invocaciones),
  'medidas_con_riesgo', (SELECT count(*) FROM medidas WHERE riesgo_medicion),
  'fks_cascade_restantes', (
    SELECT count(*) FROM information_schema.referential_constraints rc
    JOIN information_schema.table_constraints tc USING (constraint_name)
    JOIN information_schema.constraint_column_usage ccu USING (constraint_name)
    WHERE rc.delete_rule = 'CASCADE' AND tc.table_schema = 'public'
      AND ccu.table_name = 'cotizaciones'
  )
) AS resultado;
