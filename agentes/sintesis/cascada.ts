/**
 * Cascada de cierre de checklist.
 *
 * Cuando se cierra el checklist de un chat (caso terminado: vendido+instalado+
 * pagado, o cancelado), esta función:
 *   1. Marca chat_checklist.cerrado_manual=true con el motivo.
 *   2. Completa TODAS las tareas activas de la persona dueña del checklist.
 *   3. Cancela (soft-delete) TODOS los agendamientos futuros de esa persona.
 *
 * Se extrajo del worker para que sea testeable de forma determinística (sin
 * depender del LLM). El worker la llama por cada objeto de cierresChecklist;
 * el test E2E la llama directamente con un chat de prueba.
 *
 * Devuelve el detalle de lo que cascadeó para que el llamador loguee/verifique.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ResultadoCascada {
  ok: boolean;
  motivoSkip?: string;          // por qué no se ejecutó (no había checklist, sin persona_id…)
  personaId?: number;
  tareasCompletadas: number[];  // ids de tareas que pasaron a completada
  agendamientosCancelados: number[]; // ids de agendamientos soft-deleted
}

export async function cascadaCierreChecklist(
  sb: SupabaseClient,
  chatId: number,
  motivo: string,
): Promise<ResultadoCascada> {
  const motivoFinal = (motivo ?? '').trim() || 'Cerrado manualmente por Jhon';
  const ahoraIso = new Date().toISOString();

  // 1. Cerrar el checklist + obtener persona_id en una sola query.
  //    Usamos chat_checklist.persona_id (existe), NO chats.persona_id (no existe).
  const { error, data } = await sb.from('chat_checklist')
    .update({
      tipo: 'no_aplica',
      estado: 'cerrada',
      proximo_paso: null,
      motivo_cierre: motivoFinal,
      cerrado_manual: true,
      actualizado_at: ahoraIso,
    } as any)
    .eq('chat_id', chatId)
    .select('chat_id, persona_id').maybeSingle();

  if (error) return { ok: false, motivoSkip: `update error: ${error.message}`, tareasCompletadas: [], agendamientosCancelados: [] };
  if (!data) return { ok: false, motivoSkip: 'no había fila en chat_checklist', tareasCompletadas: [], agendamientosCancelados: [] };
  if (!data.persona_id) return { ok: true, motivoSkip: 'checklist sin persona_id', tareasCompletadas: [], agendamientosCancelados: [] };

  const personaId = data.persona_id as number;

  // 2. Completar TODAS las tareas activas de la persona.
  const { data: tareasUpd, error: errT } = await sb.from('tareas')
    .update({ completada: true, completada_at: ahoraIso } as any)
    .eq('persona_id', personaId)
    .eq('completada', false)
    .is('deleted_at', null)
    .select('id');
  if (errT) throw new Error(`cascada tareas persona ${personaId}: ${errT.message}`);

  // 3. Cancelar (soft-delete) los agendamientos de la persona — pasados Y futuros.
  //    Caso cerrado = sin agenda vigente. (Antes filtraba fecha>=hoy → una
  //    instalación con fecha pasada quedaba visible en un caso cerrado. Bug
  //    "Instalación casa de Maritza Alameda" 2026-05-31.)
  //    EXCEPCIÓN (2026-06-05, pedido de Jhon): los agendamientos PROTEGIDOS son
  //    compromisos fijos reales (ej. instalación agendada) que pueden generar
  //    sub-tareas; cerrar el caso (o completar una sub-tarea que lo cierre) NO
  //    debe borrar el compromiso fijo. La cascada los respeta.
  const { data: agsUpd, error: errA } = await sb.from('agendamientos')
    .update({ deleted_at: ahoraIso } as any)
    .eq('persona_id', personaId)
    .is('deleted_at', null)
    .neq('protegido', true)
    .select('id');
  if (errA) throw new Error(`cascada agendamientos persona ${personaId}: ${errA.message}`);

  return {
    ok: true,
    personaId,
    tareasCompletadas: (tareasUpd ?? []).map(t => t.id as number),
    agendamientosCancelados: (agsUpd ?? []).map(a => a.id as number),
  };
}
