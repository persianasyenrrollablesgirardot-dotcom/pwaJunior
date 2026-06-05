-- 049 — Permitir fecha/hora NULL en agendamientos (desbloquea "pendientes por agendar")
--
-- Bug encontrado en la auditoría 2026-06-05: la migración 048 agregó la columna
-- `pendiente` para los "pendientes por agendar" (intención de cita SIN fecha real
-- acordada), pero `fecha` y `hora_inicio` siguieron siendo NOT NULL (heredado de
-- la migración 038). Por eso el detector_citas inserta el pendiente con
-- fecha=NULL/hora=NULL, el INSERT falla, y el código lo traga en silencio
-- (`if (!error)`). Resultado: 0 pendientes posibles + Junior rompe al "agendar
-- sin hora" (nuevo_agendamiento con hora=null).
--
-- Fix: fecha y hora_inicio pasan a NULLABLE. Un agendamiento PENDIENTE tiene
-- fecha/hora NULL + pendiente=true; un agendamiento FIJO tiene fecha (y opcional
-- hora). La UI ya tolera hora_inicio NULL (JuniorAgendamientos lo condiciona).

ALTER TABLE agendamientos ALTER COLUMN fecha      DROP NOT NULL;
ALTER TABLE agendamientos ALTER COLUMN hora_inicio DROP NOT NULL;

-- Verificación
SELECT json_build_object(
  'fecha_nullable',       (SELECT is_nullable FROM information_schema.columns WHERE table_name='agendamientos' AND column_name='fecha'),
  'hora_inicio_nullable', (SELECT is_nullable FROM information_schema.columns WHERE table_name='agendamientos' AND column_name='hora_inicio')
)::text AS r;
