/**
 * Registro central de hooks de agentes.
 *
 * Cada agente concreto se importa acá y se registra en el pipeline.ts.
 * Si un agente no está registrado, el pipeline lo skipea con NOT_IMPLEMENTED
 * (no rompe el pipeline completo).
 *
 * Al implementar un nuevo agente (ej. a1_medidas.ts), hay que:
 *   1. Importarlo acá
 *   2. Llamar a registrarAgente('A1_MEDIDAS', a1MedidasHooks)
 *   3. (eso es todo — pipeline.ts lo encuentra automáticamente)
 */
import { registrarAgente } from './lib/pipeline.js';

// ─── L1 Extracción ───────────────────────────────────────────────
import { a1EntidadesHooks } from './L1_extraccion/a1_entidades.js';
import { a1MedidasHooks }   from './L1_extraccion/a1_medidas.js';
import { a1MontosHooks }    from './L1_extraccion/a1_montos.js';
import { a1AudioHooks }     from './L1_extraccion/a1_audio.js';
import { a1OcrHooks }       from './L1_extraccion/a1_ocr.js';

// ─── L2 Routing ──────────────────────────────────────────────────
import { a2AmbitoHooks }    from './L2_routing/a2_ambito.js';
import { a2IntencionHooks } from './L2_routing/a2_intencion.js';
import { a2NoClienteHooks } from './L2_routing/a2_nocliente.js';
import { a2RolHooks }       from './L2_routing/a2_rol.js';

// ─── L3 Identidad ────────────────────────────────────────────────
import { a3IdentidadHooks } from './L3_identidad/a3_identidad.js';
import { a3InmuebleHooks }  from './L3_identidad/a3_inmueble.js';
import { a3GeoHooks }       from './L3_identidad/a3_geo.js';
import { a3GrafoHooks }     from './L3_identidad/a3_grafo.js';

// ─── L4 Comerciales ──────────────────────────────────────────────
import { a4CotizHooks }     from './L4_comerciales/a4_cotiz.js';
import { a4ObjecionesHooks } from './L4_comerciales/a4_objeciones.js';
import { a4RecompraHooks }  from './L4_comerciales/a4_recompra.js';
import { a4ReferidosHooks } from './L4_comerciales/a4_referidos.js';
import { a4CompatHooks }    from './L4_comerciales/a4_compat.js';

// ─── L5 Financiero ───────────────────────────────────────────────
import { a5AbonoHooks }     from './L5_financiero/a5_abono.js';
import { a5ComprobHooks }   from './L5_financiero/a5_comprob.js';
import { a5CarteraHooks }   from './L5_financiero/a5_cartera.js';
import { a5RentabHooks }    from './L5_financiero/a5_rentab.js';

// ─── L6 Técnico ──────────────────────────────────────────────────
import { a6MedidasHooks }   from './L6_tecnico/a6_medidas.js';
import { a6RiesgoHooks }    from './L6_tecnico/a6_riesgo.js';

// ─── L7 Operativo ────────────────────────────────────────────────
import { a7TareasHooks }    from './L7_operativo/a7_tareas.js';
import { a7EstadoHooks }    from './L7_operativo/a7_estado.js';
import { a7RutasHooks }     from './L7_operativo/a7_rutas.js';

// ─── L8 Postventa ────────────────────────────────────────────────
import { a8GarantiaHooks }  from './L8_postventa/a8_garantia.js';
import { a8ReclamoHooks }   from './L8_postventa/a8_reclamo.js';
import { a8SatisHooks }     from './L8_postventa/a8_satis.js';
import { a8ReputHooks }     from './L8_postventa/a8_reput.js';

// ─── L10 Junior ──────────────────────────────────────────────────
import { a10JuniorHooks }   from './L10_junior/a10_junior.js';

/**
 * Registra todos los hooks disponibles. Llamar UNA VEZ al arranque del worker.
 *
 * Hoy registra 0 agentes (todos son stubs por implementar). El pipeline
 * funcionará igual: cada agente sin hook se loggea como NOT_IMPLEMENTED y el
 * resto del pipeline continúa.
 */
export function registrarTodosLosAgentes(): void {
  // L1
  registrarAgente('A1_ENTIDADES', a1EntidadesHooks);
  registrarAgente('A1_MEDIDAS',   a1MedidasHooks);
  registrarAgente('A1_MONTOS',    a1MontosHooks);
  registrarAgente('A1_AUDIO',     a1AudioHooks);
  registrarAgente('A1_OCR',       a1OcrHooks);

  // L2
  registrarAgente('A2_AMBITO',    a2AmbitoHooks);
  registrarAgente('A2_INTENCION', a2IntencionHooks);
  registrarAgente('A2_NOCLIENTE', a2NoClienteHooks);
  registrarAgente('A2_ROL',       a2RolHooks);

  // L3
  registrarAgente('A3_IDENTIDAD', a3IdentidadHooks);
  registrarAgente('A3_INMUEBLE',  a3InmuebleHooks);
  registrarAgente('A3_GEO',       a3GeoHooks);
  registrarAgente('A3_GRAFO',     a3GrafoHooks);

  // L4
  registrarAgente('A4_COTIZ',     a4CotizHooks);
  registrarAgente('A4_OBJECIONES', a4ObjecionesHooks);
  registrarAgente('A4_RECOMPRA',  a4RecompraHooks);
  registrarAgente('A4_REFERIDOS', a4ReferidosHooks);
  registrarAgente('A4_COMPAT',    a4CompatHooks);

  // L5
  registrarAgente('A5_ABONO',     a5AbonoHooks);
  registrarAgente('A5_COMPROB',   a5ComprobHooks);
  registrarAgente('A5_CARTERA',   a5CarteraHooks);
  registrarAgente('A5_RENTAB',    a5RentabHooks);

  // L6
  registrarAgente('A6_MEDIDAS',   a6MedidasHooks);
  registrarAgente('A6_RIESGO',    a6RiesgoHooks);

  // L7
  registrarAgente('A7_TAREAS',    a7TareasHooks);
  registrarAgente('A7_ESTADO',    a7EstadoHooks);
  registrarAgente('A7_RUTAS',     a7RutasHooks);

  // L8
  registrarAgente('A8_GARANTIA',  a8GarantiaHooks);
  registrarAgente('A8_RECLAMO',   a8ReclamoHooks);
  registrarAgente('A8_SATIS',     a8SatisHooks);
  registrarAgente('A8_REPUT',     a8ReputHooks);

  // L10
  registrarAgente('A10_JUNIOR',   a10JuniorHooks);

  // Cuando implementes uno, descomentás el import arriba + la línea acá.
}
