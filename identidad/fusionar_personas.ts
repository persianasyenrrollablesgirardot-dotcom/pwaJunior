/**
 * Fusión de personas duplicadas — ATÓMICA (F7.3, lado worker).
 *
 * Mueve TODO lo de la persona fusionada a la sobreviviente, completa los datos
 * de identidad que solo tenía la fusionada (jid / teléfono / email), registra el
 * log y deja la fusionada con soft-delete (papelera 30 días). Lo usa el worker
 * cuando Jhon confirma por el chat de Junior que dos clientes son la misma persona.
 *
 * ATOMICIDAD (fix): toda la lógica vive en la función Postgres
 * `fusionar_persona_atomica` (migración 052), que corre en UNA transacción. Antes
 * esto eran ~30 UPDATE secuenciales sin transacción → si fallaba a mitad, la
 * persona quedaba PARTIDA (mitad bajo cada registro) sin forma limpia de revertir.
 * Ahora: o se fusiona todo, o no se toca nada (ROLLBACK). La función además
 * AUTO-DESCUBRE las tablas con persona_id, así que no hay lista que mantener acá.
 *
 * NOTA: M1 Identidad tiene su propia acción "Fusionar" en
 * `visor/src/lib/queries.ts`. Unificar ambas a esta RPC queda como mejora.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResultadoFusion {
  sobreviviente_id: number;
  fusionada_id: number;
}

export async function fusionarPersonas(
  sb: SupabaseClient,
  sobrevivienteId: number,
  fusionadaId: number,
  motivo: string,
): Promise<ResultadoFusion> {
  if (sobrevivienteId === fusionadaId) {
    throw new Error('no se puede fusionar una persona consigo misma');
  }
  const { error } = await sb.rpc('fusionar_persona_atomica', {
    p_sobreviviente: sobrevivienteId,
    p_fusionada: fusionadaId,
    p_motivo: motivo,
  });
  if (error) throw new Error(`fusión atómica: ${error.message}`);
  return { sobreviviente_id: sobrevivienteId, fusionada_id: fusionadaId };
}
