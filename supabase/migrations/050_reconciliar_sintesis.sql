-- 050 — Reconciliador de síntesis huérfanas (fix raíz de "tarjetas en blanco").
--
-- PROBLEMA: la cola de síntesis del worker (personasSintesisPendiente) vive en
-- memoria. Si el worker se reinicia (apagón, crash, hot-reload de Vite) entre que
-- el pipeline marca los eventos PROCESADO y que drenarSintesis corre, la cola se
-- pierde. Como los eventos ya quedaron PROCESADO, el pipeline nunca los relee y
-- nada pone sintesis_pendiente=true → la persona queda sin modulo_sintesis →
-- tarjeta en blanco PERMANENTE.
--
-- SOLUCIÓN (conservadora y a prueba de bucles): devuelve SOLO las personas
-- activas que:
--   (1) tienen al menos un evento PROCESADO,
--   (2) tienen CERO modulo_sintesis (síntoma inequívoco de tarjeta en blanco), y
--   (3) TIENEN contenido sintetizable real — un chat no borrado con al menos un
--       mensaje no borrado (el mismo camino que lee sintetizarPersona).
--
-- La condición (3) es CRÍTICA para no entrar en bucle: hay personas con eventos
-- PROCESADO pero sin chat/mensajes (huérfanas sin proyecto, o eventos fantasma
-- sin fila de mensaje). Esas NUNCA producen módulos → sin (3) el reconciliador
-- las re-marcaría cada ciclo para siempre. No se ven como tarjeta en la UI igual
-- (sin chat = sin tarjeta), así que se excluyen.
--
-- El worker la consulta cada pocos minutos y pone sintesis_pendiente=true;
-- cicloSintesisPendiente (durable) las re-sintetiza y cicloTarjetas arma la
-- tarjeta. IDEMPOTENTE: tras sintetizar ya tienen modulo_sintesis → dejan de
-- aparecer.

create or replace function personas_sintesis_desfasada()
returns table(persona_id bigint)
language sql
stable
as $$
  select p.id
  from personas p
  where p.deleted_at is null
    and coalesce(p.sintesis_pendiente, false) = false
    and not exists (
      select 1 from modulo_sintesis m where m.persona_id = p.id
    )
    and exists (
      select 1
      from evento_pg e
      where e.persona_id = p.id
        and e.estado = 'PROCESADO'
        and e.deleted_at is null
    )
    -- (3) tiene contenido sintetizable real: chat no borrado con mensaje no borrado
    and exists (
      select 1
      from proyectos pr
      join chats c   on c.proyecto_id = pr.id and c.deleted_at is null
      join mensajes m on m.chat_id = c.id and m.deleted_at is null
      where pr.persona_id = p.id
    );
$$;
