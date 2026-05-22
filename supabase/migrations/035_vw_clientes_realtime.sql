-- 035 — vw_clientes_resumen_v2: incluir los chats procesados en tiempo real
--
-- El módulo Clientes sale de esta vista, que solo mostraba chats con
-- ia_historico_procesado=true — la marca del "Procesar" MANUAL. Los chats que
-- entran por el modo IA tiempo real NO llevan esa marca (su histórico viejo no
-- se procesa, solo lo nuevo), así que nunca aparecían en Clientes aunque ya
-- tuvieran persona, eventos y síntesis. Ahora la vista también incluye los
-- chats con un proyecto ya resuelto (= cliente identificado por el enjambre),
-- venga del "Procesar" manual o del tiempo real.

CREATE OR REPLACE VIEW vw_clientes_resumen_v2 AS
SELECT
  c.id                            AS chat_id,
  c.titulo                        AS chat_titulo,
  c.canal_chat_id                 AS chat_jid,
  c.ambito                        AS ambito,
  c.ia_costo_acumulado_usd        AS ia_costo_acumulado_usd,
  c.proyecto_id                   AS proyecto_id,
  proy.nombre                     AS proyecto_nombre,
  proy.estado                     AS proyecto_estado,
  proy.persona_id                 AS persona_id,
  p.nombre                        AS persona_nombre,
  p.telefono_e164                 AS persona_telefono,
  p.email                         AS persona_email,
  p.empresa                       AS persona_empresa,
  p.ciudad                        AS persona_ciudad,
  COALESCE(m.total, 0)            AS msgs_total,
  m.max_ts                        AS msgs_ultimo_ts,
  COALESCE(e.total, 0)            AS eventos_total
FROM chats c
LEFT JOIN proyectos proy ON proy.id = c.proyecto_id AND proy.deleted_at IS NULL
LEFT JOIN personas p     ON p.id    = proy.persona_id AND p.deleted_at IS NULL
LEFT JOIN (
  SELECT chat_id, count(*) AS total, max(ts_canal) AS max_ts
  FROM mensajes
  WHERE deleted_at IS NULL
  GROUP BY chat_id
) m ON m.chat_id = c.id
LEFT JOIN (
  SELECT chat_id, count(*) AS total
  FROM evento_pg
  WHERE deleted_at IS NULL
  GROUP BY chat_id
) e ON e.chat_id = c.id
WHERE c.canal = 'whatsapp'
  AND c.deleted_at IS NULL
  AND (c.ia_historico_procesado = true OR c.proyecto_id IS NOT NULL);

GRANT SELECT ON vw_clientes_resumen_v2 TO anon, authenticated;
