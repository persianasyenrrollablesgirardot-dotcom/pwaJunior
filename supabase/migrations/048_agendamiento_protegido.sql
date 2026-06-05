-- 048 — Agendamientos PROTEGIDOS (no los borra la cascada de cierre) + pendientes
--
-- Pedido de Jhon (2026-06-05): un agendamiento FIJO (ej. instalación 10-ene 9am)
-- puede generar SUB-tareas/sub-agendamientos (ej. "conseguir una silla para
-- mañana"). Al completar/cerrar la sub, la `cascadaCierreChecklist` borraba TODOS
-- los agendamientos de la persona → se llevaba puesta la instalación fija. Eso es
-- pérdida de un compromiso real.
--
-- Fix de modelo: flag `protegido`. Un agendamiento protegido = compromiso fijo
-- real (fecha+hora confirmadas) que la cascada NUNCA cancela. Las sub-tareas van
-- como `tareas` (no agendamientos), así su completar no toca la agenda fija.
--
-- Además: `pendiente` distingue los "pendientes por agendar" (sin fecha real
-- acordada) de los fijos del calendario. Hoy el detector le inventaba una fecha
-- a todo; ahora puede dejar fecha=NULL + pendiente=true → se muestran agrupados
-- por contacto, fuera del calendario.

ALTER TABLE agendamientos ADD COLUMN IF NOT EXISTS protegido boolean NOT NULL DEFAULT false;
ALTER TABLE agendamientos ADD COLUMN IF NOT EXISTS pendiente  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN agendamientos.protegido IS 'Compromiso fijo real: la cascada de cierre de caso NUNCA lo cancela.';
COMMENT ON COLUMN agendamientos.pendiente  IS 'Pendiente por agendar (sin fecha/hora real acordada): se agrupa por contacto, fuera del calendario fijo.';

-- Índice para filtrar pendientes por persona en la UI.
CREATE INDEX IF NOT EXISTS agendamientos_pendiente_idx ON agendamientos (persona_id) WHERE pendiente = true AND deleted_at IS NULL;

SELECT json_build_object(
  'col_protegido', (SELECT count(*) FROM information_schema.columns WHERE table_name='agendamientos' AND column_name='protegido'),
  'col_pendiente', (SELECT count(*) FROM information_schema.columns WHERE table_name='agendamientos' AND column_name='pendiente')
)::text AS r;
