-- 053 — Eliminar la tabla muerta `tareas_transversales`.
--
-- Quedó del modelo viejo: las tareas transversales (sin contacto) hoy viven en
-- `tareas` con persona_id=null (junior_v2 las crea/lee/borra ahí). La tabla tenía
-- 0 filas y ningún lector/escritor en el código (solo aparecía en un texto del
-- prompt, ya corregido). Se elimina para no confundir.

drop table if exists tareas_transversales;
