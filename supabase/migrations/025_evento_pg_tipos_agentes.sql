-- 025 — Agregar tipos de evento que los agentes L4-L8 van a emitir.
--
-- El CHECK original de evento_pg.tipo_evento (002_schema_inicial.sql) no incluye:
--   cotizacion, cotizacion_item, cotizacion_objecion, abono, instalacion,
--   mantenimiento, review, reclamo, costo, dato_extraido
--
-- El runner.ts (TIPO_EVENTO_A_DECISION) y validador.ts (TIPOS_EVENTO) ya los
-- esperan, pero el INSERT en evento_pg fallaba con violation del CHECK cuando
-- un agente intentaba emitir uno. Esta migración los habilita.
--
-- También sincroniza validador.ts: este SQL define la "fuente de verdad" del
-- enum; el código TS debe espejear.

DO $$
BEGIN
  -- Drop CHECK si existe
  IF EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name LIKE '%evento_pg_tipo_evento_check%'
  ) THEN
    ALTER TABLE evento_pg DROP CONSTRAINT IF EXISTS evento_pg_tipo_evento_check;
  END IF;

  -- Recrear con set ampliado
  ALTER TABLE evento_pg ADD CONSTRAINT evento_pg_tipo_evento_check
    CHECK (tipo_evento IN (
      -- originales (002_schema_inicial)
      'mensaje_entrante','mensaje_saliente','dato_extraido','inferencia',
      'cambio_estado','solicitud_aprobacion','contradiccion','pago','medida',
      'garantia','variacion','tarea','alerta','evidencia','pregunta_humano',
      'primer_contacto','cambio_externo','correccion_humana',
      -- nuevos para L4-L8 agentes
      'cotizacion','cotizacion_item','cotizacion_objecion',
      'abono','instalacion','mantenimiento','review','reclamo','costo'
    ));
END $$;

-- Verificación
SELECT json_build_object(
  'check_actualizado',  true,
  'tipos_total',        (
    SELECT count(*) FROM (
      SELECT regexp_split_to_table(
        regexp_replace(check_clause, '.*IN \((.*)\).*', '\1'),
        E','
      ) AS tipo
      FROM information_schema.check_constraints
      WHERE constraint_name = 'evento_pg_tipo_evento_check'
    ) t
  )
) AS resultado;
