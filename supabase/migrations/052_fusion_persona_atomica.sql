-- 052 — Fusión de personas ATÓMICA (una sola transacción).
--
-- Antes: identidad/fusionar_personas.ts hacía ~30 UPDATE secuenciales sin
-- transacción. Si fallaba a mitad (red, constraint), la persona quedaba PARTIDA:
-- una parte de su operación bajo la sobreviviente y otra bajo la fusionada (que
-- podía quedar soft-deleted o no) → estado inconsistente irreversible a mano.
--
-- Ahora: toda la fusión vive en esta función plpgsql, que corre en UNA sola
-- transacción. Si CUALQUIER paso falla, Postgres hace ROLLBACK completo: o se
-- fusiona TODO, o no se toca NADA. Nunca queda a medias.
--
-- Robustez extra: en vez de una lista hardcodeada de tablas (que se
-- desactualizaba al agregar tablas nuevas con persona_id), AUTO-DESCUBRE todas
-- las tablas base de `public` que tengan una columna `persona_id`. Así, cualquier
-- tabla futura con persona_id se mueve sola en la fusión.

create or replace function fusionar_persona_atomica(
  p_sobreviviente bigint,
  p_fusionada     bigint,
  p_motivo        text
) returns void
language plpgsql
security definer            -- corre con privilegios del owner: la llaman tanto el
set search_path = public   -- worker (service_role) como el Visor (anon), y debe
set statement_timeout = '60s'  -- el anon del Visor tiene timeout corto; mover ~30
as $$                          -- tablas (algunas sin índice en persona_id) lo excede.
declare
  t text;
begin
  if p_sobreviviente = p_fusionada then
    raise exception 'no se puede fusionar una persona consigo misma';
  end if;
  if not exists (select 1 from personas where id = p_sobreviviente) then
    raise exception 'persona sobreviviente % no existe', p_sobreviviente;
  end if;
  if not exists (select 1 from personas where id = p_fusionada) then
    raise exception 'persona fusionada % no existe', p_fusionada;
  end if;

  -- 1. Mover TODA referencia persona_id de la fusionada → sobreviviente, en toda
  --    tabla base de public con esa columna. Excluye:
  --    - personas: es la entidad misma.
  --    - modulo_sintesis: se descarta (se re-sintetiza al sobreviviente).
  --    - personas_merge_log: su persona_id (si tuviera) no debe reescribirse.
  for t in
    select c.table_name
    from information_schema.columns c
    join information_schema.tables tb
      on tb.table_schema = c.table_schema and tb.table_name = c.table_name
    where c.table_schema = 'public'
      and c.column_name = 'persona_id'
      and tb.table_type = 'BASE TABLE'
      and c.table_name not in ('personas', 'modulo_sintesis', 'personas_merge_log')
  loop
    execute format('update public.%I set persona_id = $1 where persona_id = $2', t)
      using p_sobreviviente, p_fusionada;
  end loop;

  -- 2. Descartar la síntesis de la fusionada.
  delete from modulo_sintesis where persona_id = p_fusionada;

  -- 3. Soft-delete de la fusionada ANTES de copiarle la identidad, para no chocar
  --    con el índice único parcial de jid activo (dos activas con el mismo jid).
  update personas set deleted_at = now() where id = p_fusionada;

  -- 4. Completar la identidad del sobreviviente con lo que solo tenía la fusionada
  --    (típicamente el jid de WhatsApp; sin esto el cliente se re-duplica).
  update personas s set
    jid           = coalesce(s.jid, f.jid),
    telefono_e164 = coalesce(s.telefono_e164, f.telefono_e164),
    email         = coalesce(s.email, f.email),
    ciudad        = coalesce(s.ciudad, f.ciudad)
  from personas f
  where s.id = p_sobreviviente and f.id = p_fusionada;

  -- 5. Log (reversible_hasta = +30 días por default del schema).
  insert into personas_merge_log (persona_sobreviviente_id, persona_fusionada_id, motivo, hecho_por)
  values (p_sobreviviente, p_fusionada, p_motivo, 1);

  -- 6. Cerrar los duplicados pendientes que tocaban a la fusionada.
  update duplicados_detectados
     set estado = 'fusionado', resuelto_at = now()
   where estado = 'pendiente'
     and (persona_nueva_id = p_fusionada or persona_existente_id = p_fusionada);
end;
$$;

-- La llaman el worker (service_role) y el Visor (anon/authenticated).
grant execute on function fusionar_persona_atomica(bigint, bigint, text)
  to anon, authenticated, service_role;
