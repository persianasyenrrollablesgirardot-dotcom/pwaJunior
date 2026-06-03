/**
 * Fusión de personas duplicadas — F7.3 (lado worker).
 *
 * Mueve TODO lo de la persona fusionada a la sobreviviente, completa los datos
 * de identidad que solo tenía la fusionada (jid / teléfono / email), registra el
 * log y deja la fusionada con soft-delete (papelera 30 días). Lo usa el worker
 * cuando Jhon confirma por el chat de Junior que dos clientes son la misma
 * persona.
 *
 * NOTA: M1 Identidad tiene su propia acción "Fusionar" en
 * `visor/src/lib/queries.ts` (fusionarPersonas). Esta versión es la del lado
 * worker y además: mueve `correcciones_humanas` y `junior_instrucciones`, y
 * completa la identidad del sobreviviente. Unificar ambas queda como mejora.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResultadoFusion {
  sobreviviente_id: number;
  fusionada_id: number;
}

/** Tablas con columna persona_id cuyas filas se mueven a la persona sobreviviente.
 *  FIX (2026-05-31): la lista estaba INCOMPLETA — tenía solo 9 tablas (las del
 *  modelo viejo) y NO movía las operativas/V2 (chat_checklist, agendamientos,
 *  tareas, medidas, cotizaciones, tarjeta, garantías, facturas…). Resultado: al
 *  fusionar dos fragmentos de la misma persona, toda la operación quedaba
 *  huérfana bajo la persona borrada → la cascada de cierre no la alcanzaba (caso
 *  Angie @lid 219 + +573185114119 @c.us 137: la garantía sobrevivía al cierre).
 *  Lista completa derivada de information_schema (tablas reales con persona_id,
 *  excluyendo vistas vw_* y modulo_sintesis, que se borra aparte en el paso 2). */
const TABLAS_PERSONA_ID = [
  'evento_pg', 'proyectos', 'rol_persona_inmueble', 'memoria_local',
  'notas_libres', 'correcciones', 'correcciones_humanas', 'buzon_validacion',
  'junior_instrucciones', 'personas_mencionadas', 'agente_invocaciones',
  // operativas / V2 (faltaban):
  'chat_checklist', 'tarjeta', 'tareas', 'agendamientos', 'medidas',
  'cotizaciones', 'cotizacion_objeciones', 'cotizacion_variaciones',
  'abonos', 'facturas', 'costos_proyecto', 'evidencias',
  'garantias', 'reclamos_sensibles', 'instalaciones', 'mantenimientos',
  'produccion_orden', 'satisfaccion_postventa', 'google_reviews',
];

export async function fusionarPersonas(
  sb: SupabaseClient,
  sobrevivienteId: number,
  fusionadaId: number,
  motivo: string,
): Promise<ResultadoFusion> {
  if (sobrevivienteId === fusionadaId) {
    throw new Error('no se puede fusionar una persona consigo misma');
  }

  // 1. Mover todas las referencias persona_id de la fusionada → sobreviviente.
  for (const t of TABLAS_PERSONA_ID) {
    const { error } = await sb.from(t)
      .update({ persona_id: sobrevivienteId })
      .eq('persona_id', fusionadaId);
    if (error) throw new Error(`fusión: mover ${t}: ${error.message}`);
  }

  // 2. La síntesis de la fusionada se descarta — el worker re-sintetiza al
  //    sobreviviente después, ya con los datos unificados.
  await sb.from('modulo_sintesis').delete().eq('persona_id', fusionadaId);

  // 3. Completar la identidad del sobreviviente con lo que solo tenía la
  //    fusionada (típicamente el jid de WhatsApp). Sin esto, el cliente se
  //    volvería a duplicar la próxima vez que escriba.
  const { data: pers } = await sb.from('personas')
    .select('id, jid, telefono_e164, email, ciudad')
    .in('id', [sobrevivienteId, fusionadaId]);
  const sobr = pers?.find(p => p.id === sobrevivienteId);
  const fus = pers?.find(p => p.id === fusionadaId);
  if (sobr && fus) {
    const parche: Record<string, any> = {};
    for (const campo of ['jid', 'telefono_e164', 'email', 'ciudad'] as const) {
      if (!(sobr as any)[campo] && (fus as any)[campo]) parche[campo] = (fus as any)[campo];
    }
    if (Object.keys(parche).length > 0) {
      await sb.from('personas').update(parche).eq('id', sobrevivienteId);
    }
  }

  // 4. Log de la fusión (reversible_hasta = +30 días por default del schema).
  await sb.from('personas_merge_log').insert({
    persona_sobreviviente_id: sobrevivienteId,
    persona_fusionada_id: fusionadaId,
    motivo,
    hecho_por: 1,
  } as any);

  // 5. Soft-delete de la persona fusionada.
  await sb.from('personas')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', fusionadaId);

  // 6. Cerrar todo registro de duplicado pendiente que tocara a la fusionada.
  await sb.from('duplicados_detectados')
    .update({ estado: 'fusionado', resuelto_at: new Date().toISOString() })
    .eq('estado', 'pendiente')
    .or(`persona_nueva_id.eq.${fusionadaId},persona_existente_id.eq.${fusionadaId}`);

  return { sobreviviente_id: sobrevivienteId, fusionada_id: fusionadaId };
}
