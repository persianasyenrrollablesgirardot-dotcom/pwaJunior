-- F1.22: arreglos del audit
--
-- 1. RPC atómica para editar+aprobar item del buzón (C3 del audit).
--    Antes: 4 operaciones secuenciales sin transacción → si fallaba a mitad,
--    el buzón quedaba en estado 'editado' sin correcciones registradas y sin
--    evento_pg de auditoría. El agente IA futuro NO respetaría la corrección.

CREATE OR REPLACE FUNCTION editar_y_aprobar_buzon_atomic(
  p_item_id        bigint,
  p_edicion        jsonb,
  p_correcciones   jsonb,    -- array de {campo, valor_original, valor_corregido, motivo}
  p_evento_origen  bigint,
  p_persona_id     bigint,
  p_proyecto_id    bigint,
  p_ambito         text,
  p_resuelto_por   bigint,
  p_comentario     text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  v_correccion        jsonb;
  v_correcciones_ids  bigint[];
  v_correccion_id     bigint;
  v_evento_correccion bigint;
BEGIN
  -- 1. Insertar correcciones en lote
  IF jsonb_array_length(p_correcciones) > 0 THEN
    FOR v_correccion IN SELECT * FROM jsonb_array_elements(p_correcciones)
    LOOP
      INSERT INTO correcciones (
        evento_id, persona_id, proyecto_id, ambito,
        campo, valor_original, valor_corregido, motivo,
        corregido_por, ts_creado
      ) VALUES (
        p_evento_origen, p_persona_id, p_proyecto_id, p_ambito,
        v_correccion->>'campo',
        v_correccion->'valor_original',
        v_correccion->'valor_corregido',
        v_correccion->>'motivo',
        p_resuelto_por, now()
      ) RETURNING id INTO v_correccion_id;
      v_correcciones_ids := array_append(v_correcciones_ids, v_correccion_id);
    END LOOP;
  END IF;

  -- 2. Insertar evento_pg de auditoría 'correccion_humana'
  INSERT INTO evento_pg (
    canal, ambito, tipo_evento, estado, persona_id, proyecto_id,
    evento_padre_id, agente_origen, confianza, prioridad,
    payload, evidencia_ids, ts_canal, ts_creado, costo_usd
  ) VALUES (
    'interno', p_ambito, 'correccion_humana', 'PROCESADO',
    p_persona_id, p_proyecto_id, p_evento_origen,
    'humano', 'CONFIRMADO', 1,
    jsonb_build_object(
      'preview', 'Edición y aprobación humana de buzón #' || p_item_id,
      'edicion', p_edicion,
      'item_buzon_id', p_item_id,
      'correcciones_ids', to_jsonb(v_correcciones_ids)
    ),
    jsonb_build_object('correccion_ids', v_correcciones_ids),
    now(), now(), 0
  ) RETURNING id INTO v_evento_correccion;

  -- 3. Update del buzón (último para que si algo arriba falla, NO se marque resuelto)
  UPDATE buzon_validacion
  SET estado = 'editado',
      resuelto_at = now(),
      resuelto_por = p_resuelto_por,
      comentario_humano = p_comentario,
      edicion_aplicada = p_edicion
  WHERE id = p_item_id;

  RETURN jsonb_build_object(
    'ok', true,
    'evento_correccion_id', v_evento_correccion,
    'correcciones_ids', v_correcciones_ids
  );
END;
$$ LANGUAGE plpgsql;

GRANT EXECUTE ON FUNCTION editar_y_aprobar_buzon_atomic TO anon, authenticated;
