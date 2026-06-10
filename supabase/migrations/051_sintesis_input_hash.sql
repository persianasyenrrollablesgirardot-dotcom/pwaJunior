-- 051 — Hash del input de síntesis por persona (fix del ~40% de re-trabajo).
--
-- sintetizarPersona corre ~8 LLM (M1-M7 + auditor + Junior) cada vez que algo
-- marca la persona (evento, sintesis_pendiente, reconciliador), aunque el
-- contenido no haya cambiado → re-paga LLM y bumpea modulo_sintesis.generado_at,
-- lo que hace que cicloTarjetas reconstruya la tarjeta de gusto.
--
-- Esta columna guarda el SHA-1 del input determinístico de la última síntesis
-- (conversación + notas + correcciones + datos de agentes + ámbito; NO incluye
-- la fecha de hoy). Si en la próxima corrida el hash coincide, se salta la
-- síntesis entera. Se actualiza solo cuando la síntesis termina sin fallos.

alter table personas add column if not exists sintesis_input_hash text;
