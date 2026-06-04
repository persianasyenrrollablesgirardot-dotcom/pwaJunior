-- 047 — Índice único que faltaba: evita eventos de mensaje DUPLICADOS
--
-- BUG (2026-06-04): tras un re-barrido del historial (reset de ws_v2_state), el
-- content script re-capturó los ~26k mensajes y, con realtime ON, el sync
-- (visor_pg_sync.syncToVisorPG) re-emitió un evento_pg por mensaje en CADA ciclo.
-- Resultado: hasta 502 eventos para un MISMO mensaje · ~23.000 duplicados totales
-- (10.8k IDENTIFICADO sin procesar + 12.3k PROCESADO que ya gastaron DeepSeek).
-- Clavó el pipeline (chat 154: 5148 eventos para 570 mensajes) y quemó plata.
--
-- CAUSA RAÍZ: el código de la extensión (visor_pg_sync.js L546) YA tolera el 409
-- ("INSERT idempotente por UNIQUE canal+canal_msg_id+agente_origen") — pero ese
-- índice NUNCA se creó, y además NULL en agente_origen no choca en un UNIQUE
-- normal (cada NULL es distinto en Postgres). Sin el índice, cada POST insertaba
-- filas nuevas sin conflicto.
--
-- FIX: índice único PARCIAL solo sobre los eventos "envelope" de mensaje
-- (mensaje_entrante/saliente), por (chat_id, canal_msg_id). Así un re-sync del
-- mismo mensaje da 409 → la extensión lo ignora (ya lo maneja) y no duplica.
-- NO toca eventos de agentes (que sí pueden emitir varios por mensaje, distinto
-- agente_origen). WHERE deleted_at IS NULL → no choca con los dups ya soft-deleted.
--
-- Pre-requisito: los duplicados vivos ya fueron soft-deleted (queda 1 por
-- chat+canal_msg_id), si no, la creación del índice fallaría.

CREATE UNIQUE INDEX IF NOT EXISTS evento_pg_mensaje_uniq
  ON evento_pg (chat_id, canal_msg_id)
  WHERE tipo_evento IN ('mensaje_entrante', 'mensaje_saliente')
    AND deleted_at IS NULL
    AND canal_msg_id IS NOT NULL;

SELECT json_build_object(
  'indice_creado', (SELECT count(*) FROM pg_indexes WHERE indexname = 'evento_pg_mensaje_uniq'),
  'eventos_msg_vivos', (SELECT count(*) FROM evento_pg WHERE tipo_evento IN ('mensaje_entrante','mensaje_saliente') AND deleted_at IS NULL),
  'dup_restantes', (SELECT count(*) - count(DISTINCT (chat_id, canal_msg_id)) FROM evento_pg WHERE tipo_evento IN ('mensaje_entrante','mensaje_saliente') AND deleted_at IS NULL AND canal_msg_id IS NOT NULL)
)::text AS r;
