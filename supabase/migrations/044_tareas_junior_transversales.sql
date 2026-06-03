-- 044 — Tareas escritas por Junior + tareas transversales
--
-- CONTEXTO: hasta ahora Junior solo podía crear notas_libres en personas. Cuando
-- Jhon le pedía "creá una tarea para X", quedaba como nota suelta que recién horas
-- después un agente podía (o no) convertir en tarea visible. Resultado:
--   - Jhon pide "dame tareas de Constanza" → no aparece la que acaba de pedir.
--   - Jhon pide "tarea transversal sin contacto" → Junior decía "listo" y no
--     guardaba nada (no había dónde).
--
-- Esta migración da dos cambios:
--
-- 1) tarjeta_tarea.origen — para que Junior pueda INSERT en tarjeta_tarea directo
--    SIN que el próximo pase del agente la pise. El agente (derivarTareas / etc.)
--    regenera SOLO las filas con origen IS NULL o origen='agente'. Las filas con
--    origen='junior' (o futuro 'jhon') quedan intactas. Mismo patrón que
--    041_agendamientos_origen.sql.
--
-- 2) tareas_transversales — tabla nueva para tareas que NO están atadas a un
--    contacto específico ("cortar telas de la señora del conjunto Madeira"
--    cuando Jhon no sabe el nombre). Sin persona_id, sin chat_id. Aparecen
--    bajo su propia sección cuando se pide listado de tareas pendientes.

-- ─── (1) origen en tarjeta_tarea ──────────────────────────────────────────────
ALTER TABLE tarjeta_tarea ADD COLUMN IF NOT EXISTS origen TEXT;

-- Backfill: todo lo existente fue creado por agentes (no hay otro escritor todavía).
UPDATE tarjeta_tarea SET origen = 'agente' WHERE origen IS NULL;

-- Index para que la query del agente "borrar mis tareas" sea rápida.
CREATE INDEX IF NOT EXISTS idx_tarjeta_tarea_origen ON tarjeta_tarea(chat_id, origen);

-- ─── (2) tareas_transversales ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tareas_transversales (
  id            SERIAL PRIMARY KEY,
  titulo        TEXT NOT NULL,
  descripcion   TEXT,
  creado_por    TEXT NOT NULL DEFAULT 'junior',  -- 'junior' | 'jhon'
  completada_at TIMESTAMPTZ,
  creado_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Index para listar solo las pendientes (las completadas raramente se piden).
CREATE INDEX IF NOT EXISTS idx_tareas_transversales_pendientes
  ON tareas_transversales(creado_at DESC)
  WHERE completada_at IS NULL;
