/**
 * A7_RUTAS — optimizador de rutas de instalación.
 *
 * BATCH-ORIENTED como A4_RECOMPRA y A5_CARTERA: no responde a un mensaje
 * específico. Toma las instalaciones programadas en los próximos N días y
 * propone una agrupación geográfica óptima.
 *
 * Reglas:
 *   - Agrupa instalaciones por zona_codigo.
 *   - Dentro de cada zona, ordena por proximidad lógica (mismo conjunto > mismo
 *     sector > misma ciudad).
 *   - Si una instalación queda en zona muy distinta, propone día separado.
 *   - Estima duración por sistemas (motor ~90min, simple ~60min).
 *   - Propone hora_sugerida realista (no antes de 8am, no después de 5pm,
 *     buffer entre visitas).
 *
 * Output: tipo_evento='tarea', con propuesta de plan ruta para cada día.
 * Cuando Jhon aprueba, las tareas concretas se crean en la tabla `tareas` y
 * las instalaciones obtienen su hora_programada definitiva.
 *
 * Tope $0.03/invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks } from '../lib/runner.js';
import type { ChatMessage } from '../lib/llm.js';
import { ValidacionError, resolverMsgId } from '../lib/validador.js';

interface InstalacionProgramada {
  id: number;
  cotizacion_id: number;
  persona_id: number;
  persona_nombre: string | null;
  fecha_programada: string;
  hora_programada: string | null;
  zona_codigo: string | null;
  zona_nombre: string | null;
  ciudad: string | null;
  conjunto: string | null;
  sistemas_resumen: string[];
}

interface DatosA7Rutas {
  instalaciones_proximas: InstalacionProgramada[];
  dias_horizonte: number;
  fecha_hoy: string;
  evento_msg_id: string;            // msg_id del evento batch que disparó el agente
}

interface InstalacionEnRuta {
  instalacion_id: number;
  hora_sugerida: string;          // HH:MM
  duracion_estimada_min: number;
  notas_orden: string | null;
}

interface RutaDiaOutput {
  dia_sugerido: string;             // YYYY-MM-DD
  zona_principal: string | null;
  zona_principal_nombre: string | null;
  instalaciones_ordenadas: InstalacionEnRuta[];
  duracion_total_estimada_min: number;
  notas: string | null;
}

interface InstalacionSueltaOutput {
  instalacion_id: number;
  razon: string;
  sugerencia: string;
}

const HORIZONTE_DIAS_DEFAULT = 14;

export const a7RutasHooks: AgenteHooks<DatosA7Rutas> = {
  async cargarContexto(sb, params) {
    const hoy = new Date().toISOString().slice(0, 10);

    // msg_id del evento que disparó el batch (necesario para evidencia)
    const { data: evt } = await sb.from('evento_pg')
      .select('evidencia_ids')
      .eq('id', params.evento_id)
      .single();
    const eventoMsgId: string = (evt?.evidencia_ids as any)?.msg_ids?.[0] ?? `batch_a7_rutas_${hoy}`;
    const fin = new Date();
    fin.setDate(fin.getDate() + HORIZONTE_DIAS_DEFAULT);
    const finISO = fin.toISOString().slice(0, 10);

    const { data: insts, error } = await sb.from('instalaciones')
      .select(`id, cotizacion_id, persona_id, fecha_programada, hora_programada, zona_codigo,
               personas!instalaciones_persona_id_fkey(nombre),
               cotizacion_items(sistema_safra_codigo)`)
      .gte('fecha_programada', hoy)
      .lte('fecha_programada', finISO)
      .is('deleted_at', null)
      .is('fecha_real', null)            // solo pendientes
      .order('fecha_programada', { ascending: true })
      .limit(50);
    if (error) throw new ValidacionError('R-contexto', `error cargando instalaciones: ${error.message}`);

    // Para cada instalación, traer info de proyecto + inmueble + zona
    const instalacionesProximas: InstalacionProgramada[] = [];
    const cotIds = (insts ?? []).map((i: any) => i.cotizacion_id).filter(Boolean);
    let proyectoMap = new Map<number, { conjunto: string | null; ciudad: string | null; zona_codigo: string | null }>();
    if (cotIds.length > 0) {
      // Conseguir proyecto_id de las cotizaciones
      const { data: cots } = await sb.from('cotizaciones')
        .select('id, proyecto_id')
        .in('id', cotIds);
      const proyectoIds = (cots ?? []).map((c: any) => c.proyecto_id).filter(Boolean);
      if (proyectoIds.length > 0) {
        const { data: inms } = await sb.from('inmuebles')
          .select(`proyecto_id, conjunto, ciudad,
                   conjuntos(zona_codigo)`)
          .in('proyecto_id', proyectoIds)
          .is('deleted_at', null);
        const inmPorProyecto = new Map<number, any>();
        for (const inm of inms ?? []) inmPorProyecto.set(inm.proyecto_id, inm);
        for (const c of cots ?? []) {
          const inm = inmPorProyecto.get(c.proyecto_id);
          if (inm) {
            proyectoMap.set(c.id, {
              conjunto: inm.conjunto,
              ciudad: inm.ciudad,
              zona_codigo: (inm as any).conjuntos?.zona_codigo ?? null,
            });
          }
        }
      }
    }

    // Nombre de zonas
    const { data: zonas } = await sb.from('zonas_instalacion').select('codigo, nombre');
    const zonaNombreMap = new Map<string, string>((zonas ?? []).map((z: any) => [z.codigo, z.nombre]));

    for (const i of insts ?? []) {
      const proyInfo = proyectoMap.get(i.cotizacion_id);
      const zonaCodFinal = i.zona_codigo ?? proyInfo?.zona_codigo ?? null;
      const sistemas = Array.from(new Set(
        ((i as any).cotizacion_items ?? [])
          .map((ci: any) => ci.sistema_safra_codigo).filter(Boolean)
      )) as string[];
      instalacionesProximas.push({
        id: i.id,
        cotizacion_id: i.cotizacion_id,
        persona_id: i.persona_id,
        persona_nombre: (i as any).personas?.nombre ?? null,
        fecha_programada: i.fecha_programada,
        hora_programada: i.hora_programada,
        zona_codigo: zonaCodFinal,
        zona_nombre: zonaCodFinal ? (zonaNombreMap.get(zonaCodFinal) ?? null) : null,
        ciudad: proyInfo?.ciudad ?? null,
        conjunto: proyInfo?.conjunto ?? null,
        sistemas_resumen: sistemas,
      });
    }

    return {
      instalaciones_proximas: instalacionesProximas,
      dias_horizonte: HORIZONTE_DIAS_DEFAULT,
      fecha_hoy: hoy,
      evento_msg_id: eventoMsgId,
    };
  },

  construirPrompt(datos, agente) {
    const instStr = datos.instalaciones_proximas.length === 0
      ? '(no hay instalaciones programadas en los próximos días)'
      : JSON.stringify(datos.instalaciones_proximas, null, 2);

    const system: ChatMessage = {
      role: 'system',
      content: `${agente.prompt_especifico}

Sos A7_RUTAS. Optimizás logística de instalaciones de la próxima semana.

OBJETIVO:
  - Reducir tiempo en ruta agrupando geográficamente.
  - No agendar dos instalaciones lejanas el mismo día sin necesidad.
  - Respetar fechas ya programadas (no las muevas sin razón fuerte).
  - Proponer hora dentro de ventana laboral (8am – 5pm).

REGLAS DE AGRUPACIÓN:
  1. Mismo día y zona → ruta única, ordenadas por proximidad
     (mismo conjunto > mismo sector > misma ciudad).
  2. Instalaciones en zonas distintas → mismo día solo si quedan ≤2 zonas
     CERCANAS (ej. girardot_norte + girardot_urbano OK).
  3. Zonas lejanas en el mismo día → separar o marcar como "instalacion_suelta_dificil".
  4. Si una instalación ya tiene hora_programada fija → respetarla.

DURACIÓN ESTIMADA:
  - 1 sistema simple (blackout, enrollables, screen sin motor): ~60 min
  - 1 sistema con motor o panel_japones / verticales: ~90 min
  - +30 min por sistema adicional en la misma visita
  - Toldo: ~120 min (más complejo)
  - Buffer de viaje entre instalaciones: 20-30 min mismo conjunto, 30-45 min
    misma ciudad, 60+ min entre ciudades.

REGLAS DURAS:
  - hora_sugerida formato "HH:MM" (24h). Entre 08:00 y 17:00.
  - dia_sugerido formato YYYY-MM-DD (≥ ${datos.fecha_hoy}).
  - instalacion_id DEBE estar en la lista de instalaciones_proximas (NO inventes).
  - Cada instalación aparece UNA VEZ entre rutas_propuestas + instalaciones_sueltas_dificiles.
  - duracion_total_estimada_min ≈ suma de duraciones + buffers (puede diferir hasta ±20 min).
  - evidencia_msg_ids: este agente es batch — usá el msg_id del evento batch
    que te disparó: ["${datos.evento_msg_id}"].

CÁLCULO MECÁNICO de "confianza" (NO opinión — derivación determinista del estado):
  - Sin instalaciones próximas (lista vacía) → DUDOSO + rutas=[] + sueltas=[]
  - Con ≥1 instalación próxima                → INFERIDO (plan razonable con info disponible)
  - NUNCA uses CONFIRMADO: este es un plan SUGERIDO; el humano confirma.

INSTALACIONES PRÓXIMAS (${datos.instalaciones_proximas.length} en próximos ${datos.dias_horizonte} días):
${instStr}

Salida JSON EXACTA:
{
  "tipo_evento": "tarea",
  "confianza": "INFERIDO",
  "payload": {
    "rutas_propuestas": [
      {
        "dia_sugerido": "2026-05-15",
        "zona_principal": "girardot_norte",
        "zona_principal_nombre": "Girardot - Norte",
        "instalaciones_ordenadas": [
          { "instalacion_id": 100, "hora_sugerida": "09:00", "duracion_estimada_min": 90, "notas_orden": "Primer turno: mismo conjunto que la siguiente." },
          { "instalacion_id": 101, "hora_sugerida": "11:00", "duracion_estimada_min": 60, "notas_orden": "Mismo conjunto." }
        ],
        "duracion_total_estimada_min": 180,
        "notas": "Dos instalaciones en Casaloma, una atrás de otra."
      }
    ],
    "instalaciones_sueltas_dificiles": [
      { "instalacion_id": 200, "razon": "Zona Fusagasugá, lejos del resto del plan", "sugerencia": "Programar día exclusivo o evaluar costo de traslado." }
    ],
    "resumen": "Plan de 3 días: 5 instalaciones agrupadas en Girardot Norte (lunes), Ricaurte (miércoles), 1 suelta a Fusagasugá."
  },
  "evidencia_msg_ids": ["${datos.evento_msg_id}"],
  "reglas_aplicadas": ["R-001"]
}`,
    };

    const user: ChatMessage = {
      role: 'user',
      content: `Hoy es ${datos.fecha_hoy}. Generá el plan de rutas de los próximos ${datos.dias_horizonte} días
sobre las instalaciones listadas arriba.`,
    };

    return [system, user];
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    if (!Array.isArray(p?.rutas_propuestas)) {
      throw new ValidacionError('R-esquema', 'rutas_propuestas debe ser array');
    }
    if (!Array.isArray(p?.instalaciones_sueltas_dificiles)) {
      throw new ValidacionError('R-esquema', 'instalaciones_sueltas_dificiles debe ser array');
    }

    // Coherencia mecánica: confianza derivada del estado real
    const sinInstalaciones = datos.instalaciones_proximas.length === 0;
    const esperada = sinInstalaciones ? 'DUDOSO' : 'INFERIDO';

    if (out.confianza === 'CONFIRMADO') {
      throw new ValidacionError('R-confianza', 'A7_RUTAS nunca usa CONFIRMADO (plan sugerido)');
    }
    if (out.confianza !== esperada) {
      throw new ValidacionError('R-confianza',
        `confianza=${out.confianza} pero ${sinInstalaciones ? 'sin' : 'con'} instalaciones próximas exige ${esperada}`);
    }
    if (sinInstalaciones && (p.rutas_propuestas.length > 0 || p.instalaciones_sueltas_dificiles.length > 0)) {
      throw new ValidacionError('R-coherencia',
        'sin instalaciones próximas: rutas y sueltas deben estar vacías');
    }

    const idsValidos = new Set<number>(datos.instalaciones_proximas.map(i => i.id));
    const idsUsados = new Set<number>();

    for (const ruta of p.rutas_propuestas as RutaDiaOutput[]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ruta.dia_sugerido)) {
        throw new ValidacionError('R-esquema', `dia_sugerido formato inválido: ${ruta.dia_sugerido}`);
      }
      if (ruta.dia_sugerido < datos.fecha_hoy) {
        throw new ValidacionError('R-esquema',
          `dia_sugerido ${ruta.dia_sugerido} es anterior a hoy (${datos.fecha_hoy})`);
      }
      if (!Array.isArray(ruta.instalaciones_ordenadas) || ruta.instalaciones_ordenadas.length === 0) {
        throw new ValidacionError('R-esquema', 'ruta sin instalaciones_ordenadas');
      }
      for (const ord of ruta.instalaciones_ordenadas) {
        if (!idsValidos.has(ord.instalacion_id)) {
          throw new ValidacionError('R-anti-alucinacion',
            `instalacion_id=${ord.instalacion_id} no está en la lista de instalaciones próximas`);
        }
        if (idsUsados.has(ord.instalacion_id)) {
          throw new ValidacionError('R-coherencia',
            `instalacion_id=${ord.instalacion_id} aparece duplicada en el plan`);
        }
        idsUsados.add(ord.instalacion_id);
        if (!/^\d{2}:\d{2}$/.test(ord.hora_sugerida)) {
          throw new ValidacionError('R-esquema', `hora_sugerida formato inválido: ${ord.hora_sugerida}`);
        }
        const [hh, mm] = ord.hora_sugerida.split(':').map(Number);
        if (hh < 8 || hh > 17 || (hh === 17 && mm > 0)) {
          throw new ValidacionError('R-esquema',
            `hora_sugerida ${ord.hora_sugerida} fuera de ventana laboral [08:00, 17:00]`);
        }
        if (typeof ord.duracion_estimada_min !== 'number' || ord.duracion_estimada_min < 30 || ord.duracion_estimada_min > 480) {
          throw new ValidacionError('R-esquema',
            `duracion_estimada_min fuera de rango razonable: ${ord.duracion_estimada_min}`);
        }
      }
    }

    for (const sue of p.instalaciones_sueltas_dificiles as InstalacionSueltaOutput[]) {
      if (!idsValidos.has(sue.instalacion_id)) {
        throw new ValidacionError('R-anti-alucinacion',
          `instalacion suelta id=${sue.instalacion_id} no está en la lista`);
      }
      if (idsUsados.has(sue.instalacion_id)) {
        throw new ValidacionError('R-coherencia',
          `instalacion_id=${sue.instalacion_id} aparece en ruta Y en suelta — debe ser solo una`);
      }
      idsUsados.add(sue.instalacion_id);
      if (typeof sue.razon !== 'string' || sue.razon.trim().length === 0) {
        throw new ValidacionError('R-esquema', 'instalacion suelta sin razon');
      }
    }

    // R-anti-alucinacion: normalizar evidencia_msg_ids tolerando prefijos LLM
    if (datos.evento_msg_id && Array.isArray(out.evidencia_msg_ids)) {
      const disponibles = new Set<string>([datos.evento_msg_id]);
      const resueltos: string[] = [];
      for (const cit of out.evidencia_msg_ids) {
        if (!cit) continue;
        const real = resolverMsgId(cit, disponibles);
        if (real) resueltos.push(real);
      }
      out.evidencia_msg_ids = resueltos.length > 0 ? resueltos : [datos.evento_msg_id];
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // En shadow: nada. En productivo, al aprobar Jhon, las rutas se traducen
    // a actualizaciones de instalaciones.hora_programada + tareas de "ir a"
    // por cada día.
    return;
  },
};
