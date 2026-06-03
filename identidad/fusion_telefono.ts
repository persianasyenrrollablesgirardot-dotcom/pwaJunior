/**
 * Red de seguridad de identidad — auto-fusión por teléfono compartido.
 *
 * Contexto (2026-05-31): la fragmentación LID↔teléfono ocurre porque WhatsApp
 * entrega a veces el LID de privacidad (`@lid`) y a veces el teléfono real
 * (`@c.us`) para el mismo contacto. La extensión YA resuelve el teléfono de los
 * contactos @lid (visor_pg_sync.corregirContactos escribe personas.telefono_e164)
 * y el matcher (matcher.ts) unifica EN CALIENTE cuando entra un mensaje @c.us
 * cuyo teléfono coincide con una persona @lid existente.
 *
 * El hueco que cubre este ciclo: el caso borde donde quedan DOS registros de
 * persona activos con el MISMO telefono_e164 (p.ej. el teléfono del @lid se
 * parchea DESPUÉS de que ya se creó un registro @c.us aparte, o llegan en un
 * orden que el matcher en caliente no alcanza). Ahí el matcher no vuelve atrás
 * a unirlos → este ciclo lo hace.
 *
 * Política: auto-fusión SOLO por teléfono EXACTO. Un número de teléfono = una
 * persona; es la misma señal que ya usa matcher.ts para asociar en caliente, así
 * que extenderla al caso cross-registro es consistente y de bajo riesgo.
 * Reversible: fusionarPersonas deja personas_merge_log + soft-delete 30 días.
 *
 * NO cubre el caso de "misma persona con DOS números distintos" (p.ej. Angie:
 * +573002514929 @lid vs +573185114119 @c.us) — eso no tiene señal automática y
 * requiere que Jhon lo confirme (fusión manual). Documentado en memoria.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { fusionarPersonas } from './fusionar_personas.js';

const esLid = (jid: string | null): boolean => !!jid && jid.endsWith('@lid');

// Nombre "feo" = placeholder, solo número, o ⏳ identificando → peor candidato a
// sobreviviente que una persona con nombre humano real.
function nombreFeo(nombre: string | null): boolean {
  if (!nombre) return true;
  const n = nombre.trim();
  if (n.startsWith('⏳') || /identificando/i.test(n)) return true;
  return /^\+?\d[\d\s]{5,}$/.test(n);   // "+573185114119", "573185114119"
}

export interface ResultadoFusionTelefono {
  gruposDuplicados: number;
  fusiones: number;
}

export async function cicloFusionPorTelefono(
  sb: SupabaseClient,
  log: (m: string) => void = () => {},
): Promise<ResultadoFusionTelefono> {
  const { data: per, error } = await sb.from('personas')
    .select('id, nombre, jid, telefono_e164, created_at')
    .is('deleted_at', null)
    .not('telefono_e164', 'is', null);
  if (error) { log(`error leyendo personas: ${error.message}`); return { gruposDuplicados: 0, fusiones: 0 }; }
  if (!per?.length) return { gruposDuplicados: 0, fusiones: 0 };

  // Agrupar por teléfono normalizado exacto.
  const grupos = new Map<string, typeof per>();
  for (const p of per) {
    const k = (p.telefono_e164 as string).trim();
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k)!.push(p);
  }

  let gruposDuplicados = 0, fusiones = 0;
  for (const [tel, arr] of grupos) {
    if (arr.length < 2) continue;
    gruposDuplicados++;
    // Sobreviviente: prioriza jid @c.us (identidad de teléfono estable) sobre
    // @lid (opaco); luego nombre humano sobre nombre feo; luego el más antiguo.
    arr.sort((a, b) => {
      const ja = esLid(a.jid) ? 1 : 0, jb = esLid(b.jid) ? 1 : 0;
      if (ja !== jb) return ja - jb;
      const na = nombreFeo(a.nombre) ? 1 : 0, nb = nombreFeo(b.nombre) ? 1 : 0;
      if (na !== nb) return na - nb;
      return (a.id as number) - (b.id as number);
    });
    const sobreviviente = arr[0];
    for (const f of arr.slice(1)) {
      try {
        await fusionarPersonas(sb, sobreviviente.id as number, f.id as number,
          `Auto-fusión por teléfono compartido ${tel} (red de seguridad LID↔teléfono)`);
        await sb.from('personas').update({ sintesis_pendiente: true } as any).eq('id', sobreviviente.id);
        fusiones++;
        log(`teléfono ${tel}: fusión #${f.id} → #${sobreviviente.id} ("${sobreviviente.nombre}")`);
      } catch (e: any) {
        log(`teléfono ${tel}: error fusionando #${f.id}→#${sobreviviente.id}: ${e.message}`);
      }
    }
  }
  return { gruposDuplicados, fusiones };
}
