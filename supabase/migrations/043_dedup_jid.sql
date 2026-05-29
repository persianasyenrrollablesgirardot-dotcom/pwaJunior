-- 043 — DEDUP por jid: prevención + función de fusión.
--
-- CAUSA RAÍZ: el matcher (identidad/matcher.ts) hace match por jid y reutiliza
-- la persona; pero dos eventos del MISMO jid procesados en paralelo (antes de
-- que exista la persona) crean DOS personas iguales (race). Quedaron pares como
-- #134/#137 y #125/#139 (mismo jid). La data quedó repartida entre el gemelo
-- borrado y el activo.
--
-- 1) PREVENCIÓN: índice único parcial sobre jid de personas ACTIVAS → la BD
--    rechaza crear un segundo activo con el mismo jid. El matcher captura el
--    conflicto y reusa la persona existente (crearPersonaDesdeJid resiliente).
-- 2) fusionar_persona(survivor, dup): reasigna TODAS las FK de dup→survivor
--    (conflict-safe en las tablas con UNIQUE por persona) y soft-deletea dup.
--    Transaccional: o se hace todo, o nada.

-- ─── 1. Prevención ───────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS personas_jid_activa_uniq
  ON personas (jid)
  WHERE deleted_at IS NULL AND jid IS NOT NULL;

-- ─── 2. Función de fusión ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fusionar_persona(p_survivor BIGINT, p_dup BIGINT)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_survivor = p_dup THEN RAISE EXCEPTION 'survivor (%) = dup (%)', p_survivor, p_dup; END IF;
  IF NOT EXISTS (SELECT 1 FROM personas WHERE id = p_survivor) THEN RAISE EXCEPTION 'survivor % no existe', p_survivor; END IF;

  -- Conflict-safe: modulo_sintesis UNIQUE(persona_id, modulo) — el survivor gana.
  DELETE FROM modulo_sintesis d WHERE d.persona_id = p_dup
    AND EXISTS (SELECT 1 FROM modulo_sintesis s WHERE s.persona_id = p_survivor AND s.modulo = d.modulo);
  UPDATE modulo_sintesis SET persona_id = p_survivor WHERE persona_id = p_dup;

  -- Conflict-safe: rol_persona_inmueble UNIQUE(persona_id, inmueble_id, rol).
  DELETE FROM rol_persona_inmueble d WHERE d.persona_id = p_dup
    AND EXISTS (SELECT 1 FROM rol_persona_inmueble s WHERE s.persona_id = p_survivor
                AND s.inmueble_id IS NOT DISTINCT FROM d.inmueble_id AND s.rol = d.rol);
  UPDATE rol_persona_inmueble SET persona_id = p_survivor WHERE persona_id = p_dup;

  -- Reasignaciones simples (sin UNIQUE por persona → no chocan).
  UPDATE abonos               SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE agendamientos        SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE agente_invocaciones  SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE buzon_validacion     SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE chat_checklist       SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE correcciones         SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE correcciones_humanas SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE costos_proyecto      SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE cotizacion_objeciones  SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE cotizacion_variaciones SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE cotizaciones         SET persona_id        = p_survivor WHERE persona_id = p_dup;
  UPDATE cotizaciones         SET contacto_pagador_id = p_survivor WHERE contacto_pagador_id = p_dup;
  UPDATE evento_pg            SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE evidencias           SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE facturas             SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE garantias            SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE google_reviews       SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE instalaciones        SET persona_id          = p_survivor WHERE persona_id = p_dup;
  UPDATE instalaciones        SET contacto_receptor_id = p_survivor WHERE contacto_receptor_id = p_dup;
  UPDATE junior_instrucciones SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE mantenimientos       SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE medidas              SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE memoria_local        SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE mensajes             SET persona_autor_id = p_survivor WHERE persona_autor_id = p_dup;
  UPDATE notas_libres         SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE personas             SET referido_por_persona_id = p_survivor WHERE referido_por_persona_id = p_dup;
  UPDATE personas_mencionadas SET persona_id          = p_survivor WHERE persona_id = p_dup;
  UPDATE personas_mencionadas SET persona_referida_id = p_survivor WHERE persona_referida_id = p_dup;
  UPDATE produccion_orden     SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE proyectos            SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE reclamos_sensibles   SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE satisfaccion_postventa SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE tareas               SET persona_id = p_survivor WHERE persona_id = p_dup;
  UPDATE tarjeta              SET persona_id = p_survivor WHERE persona_id = p_dup;

  -- Cerrar propuestas de fusión pendientes que toquen el dup.
  UPDATE duplicados_detectados SET estado = 'descartado'
    WHERE estado = 'pendiente' AND (persona_nueva_id = p_dup OR persona_existente_id = p_dup);

  -- Marca de borrado del duplicado (reversible: basta con limpiar deleted_at).
  UPDATE personas SET deleted_at = now() WHERE id = p_dup AND deleted_at IS NULL;
END; $$;
