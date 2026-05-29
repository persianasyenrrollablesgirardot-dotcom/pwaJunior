-- 042 — tarjeta.es_no_cliente
--
-- Marca en la tarjeta si A2_NOCLIENTE detectó que el chat NO es cliente real
-- (restaurante/spam/transporte/equivocado). El tablero de checklist y el índice
-- de Junior filtran estas tarjetas para no mostrarlas como casos comerciales.
-- Reversible: el dato sigue ahí, solo se oculta.

ALTER TABLE tarjeta ADD COLUMN IF NOT EXISTS es_no_cliente BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE tarjeta ADD COLUMN IF NOT EXISTS no_cliente_subtipo TEXT;
