/**
 * Patrones regex para extraer datos OBJETIVOS de texto crudo.
 * Sin LLM, $0 costo. Solo regex + parsers locales.
 *
 * Cada patrón tiene:
 *   - tipo: categoría del dato extraído
 *   - regex: el pattern (multi-línea, case-insensitive donde corresponde)
 *   - normalizar: función opcional para limpiar el match
 *
 * Cuando un texto matchea, se devuelve { tipo, valor, valor_raw, msg_id, posicion }.
 */

export type TipoExtraccion =
  | 'telefono'
  | 'email'
  | 'cedula'
  | 'nit'
  | 'direccion'
  | 'conjunto_torre_apto'
  | 'medida'
  | 'monto'
  | 'fecha_relativa'
  | 'fecha_absoluta'
  | 'sistema_safra'
  | 'codigo_cotizacion'
  | 'url'
  | 'horario';

export interface Patron {
  tipo: TipoExtraccion;
  regex: RegExp;
  /** Si retorna null, descarta la extracción (falso positivo). */
  normalizar?: (match: RegExpMatchArray) => { valor: string; meta?: Record<string, any> } | null;
  /** Confianza por defecto del patrón. */
  confianza_default?: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function digitos(s: string): string {
  return s.replace(/\D/g, '');
}

function montoTextoANumero(raw: string): number | null {
  const limpio = raw.toLowerCase().replace(/[$\s.]/g, '').replace(/,/g, '.');
  // ej: "1.500.000" → 1500000, "1,5m" → 1500000, "350k" → 350000
  let multiplicador = 1;
  let str = limpio;
  if (str.endsWith('m') || str.includes('millon')) {
    multiplicador = 1_000_000;
    str = str.replace(/m\b|millones?/g, '').trim();
  } else if (str.endsWith('k') || str.endsWith('mil')) {
    multiplicador = 1_000;
    str = str.replace(/k\b|mil\b/g, '').trim();
  }
  const num = parseFloat(str);
  if (isNaN(num)) return null;
  return Math.round(num * multiplicador);
}

const MESES_ES: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

// ─── Patrones ─────────────────────────────────────────────────────────────

export const PATRONES: Patron[] = [
  // ─── Teléfono Colombia (móvil 3XX o fijo) ───
  {
    tipo: 'telefono',
    regex: /(?:\+?57[\s.-]?)?(?:3\d{2}[\s.-]?\d{3}[\s.-]?\d{4}|3\d{9})/g,
    normalizar: (m) => {
      const d = digitos(m[0]);
      // Debe ser 10 dígitos (3XXX...) o 12 con +57
      const sin57 = d.startsWith('57') && d.length === 12 ? d.slice(2) : d;
      if (sin57.length !== 10 || !sin57.startsWith('3')) return null;
      return { valor: '+57' + sin57 };
    },
    confianza_default: 'INFERIDO',
  },

  // ─── Email ───
  {
    tipo: 'email',
    regex: /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi,
    normalizar: (m) => ({ valor: m[0].toLowerCase() }),
    confianza_default: 'INFERIDO',
  },

  // ─── Cédula colombiana (con keyword cc/cédula) ───
  {
    tipo: 'cedula',
    regex: /\b(?:c\.?c\.?|cedula|cédula|c\/c)[:.\s]*(\d{6,10})\b/gi,
    normalizar: (m) => ({ valor: m[1] }),
    confianza_default: 'INFERIDO',
  },

  // ─── NIT colombiano ───
  {
    tipo: 'nit',
    regex: /\b(?:nit)[:.\s]*(\d{9,10})[-\s]?(\d)?\b/gi,
    normalizar: (m) => ({ valor: m[1] + (m[2] ? '-' + m[2] : '') }),
    confianza_default: 'INFERIDO',
  },

  // ─── Dirección con keyword (Cra/Cl/Av) ───
  {
    tipo: 'direccion',
    regex: /\b(?:c(?:arrera|ra)|c(?:alle|l)|a(?:venida|v)|tv|transversal|dg|diagonal)\.?\s*\d{1,3}[a-z]?\s*#?\s*\d{1,3}\s*-?\s*\d{1,3}/gi,
    normalizar: (m) => ({ valor: m[0].trim().replace(/\s+/g, ' ') }),
    confianza_default: 'INFERIDO',
  },

  // ─── Conjunto / Torre / Apto / Casa ───
  {
    tipo: 'conjunto_torre_apto',
    regex: /\b(?:conjunto|edificio|urbanización|condominio|torre|apartamento|apto\.?|casa|local|oficina)\s+(?:[A-Z][\wáéíóúñ]+(?:\s+[\wáéíóúñ]+){0,3}|\d+[a-z]?)/gi,
    normalizar: (m) => ({ valor: m[0].trim() }),
    confianza_default: 'INFERIDO',
  },

  // ─── Medidas: 2.40 x 1.80 m / 240×180 cm ───
  // Requiere unidad explícita en al menos un lado, o ambos números coherentes (0.5–10 si parecen metros, 50–600 si parecen cm).
  {
    tipo: 'medida',
    regex: /(\d+(?:[,.]?\d+)?)\s*(m|cm|metros?|cms?|mts?)?\s*(?:x|×|por)\s*(\d+(?:[,.]?\d+)?)\s*(m|cm|metros?|cms?|mts?)?/gi,
    normalizar: (m) => {
      const a = parseFloat(m[1].replace(',', '.'));
      const b = parseFloat(m[3].replace(',', '.'));
      if (isNaN(a) || isNaN(b)) return null;
      if (a === 0 || b === 0) return null;  // 0x9 no es medida

      const unidadIzq = m[2]?.toLowerCase();
      const unidadDer = m[4]?.toLowerCase();
      const tieneUnidadExplicita = !!(unidadIzq || unidadDer);

      // Sin unidad explícita: solo aceptar si los números caen en rango de medidas reales
      // (0.30m–8m para persianas/ventanas) o (30cm–800cm)
      let unidad: 'cm' | 'm';
      if (tieneUnidadExplicita) {
        const u = (unidadDer || unidadIzq || 'm').toLowerCase();
        unidad = (u === 'cm' || u === 'cms') ? 'cm' : 'm';
      } else {
        // Heurística estricta sin unidad: rechazar combos sospechosos
        const ambosChicos = a < 10 && b < 10;
        const ambosGrandes = a >= 30 && a <= 800 && b >= 30 && b <= 800;
        if (!ambosChicos && !ambosGrandes) return null;  // 9x6, 7x9 → rechazo
        if (ambosChicos && (a < 0.3 || b < 0.3)) return null;  // 0.1x0.2 absurdo
        unidad = ambosGrandes ? 'cm' : 'm';
      }

      const factor = unidad === 'cm' ? 0.01 : 1;
      const ancho_m = a * factor;
      const alto_m = b * factor;
      // Sanity final: persianas 0.30m–8m
      if (ancho_m < 0.3 || alto_m < 0.3 || ancho_m > 8 || alto_m > 8) return null;

      return {
        valor: `${ancho_m.toFixed(2)}m × ${alto_m.toFixed(2)}m`,
        meta: { ancho_m, alto_m, unidad_original: unidad, unidad_explicita: tieneUnidadExplicita },
      };
    },
    confianza_default: 'INFERIDO',
  },

  // ─── Monto en pesos: $1.500.000 / 1.5M / 350 mil ───
  // Solo acepta si hay señal monetaria explícita: $, "pesos", "cop", o separadores de miles (1.500.000)
  {
    tipo: 'monto',
    regex: /(\$\s*\d[\d.,]*(?:\s*(?:m|mill?ones?|mil|k))?|\d{1,3}(?:[.,]\d{3}){1,3}(?!\d)|\d+(?:[.,]\d+)?\s*(?:millones?|mil\s+(?:pesos|cop)|pesos|cop))/gi,
    normalizar: (m) => {
      const txt = m[0].toLowerCase();
      const tieneSimbolo = txt.includes('$');
      const tienePalabra = /\b(?:millones?|pesos|cop|mil)\b/.test(txt);
      const tieneSeparadorMiles = /\d{1,3}([.,])\d{3}([.,]\d{3})*/.test(m[0]);
      // Requiere al menos UNA señal monetaria
      if (!tieneSimbolo && !tienePalabra && !tieneSeparadorMiles) return null;

      const n = montoTextoANumero(m[0]);
      if (n === null) return null;
      if (n < 5000) return null;          // mínimo razonable para una persiana
      if (n > 50_000_000) return null;    // sanity superior

      return {
        valor: n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 }),
        meta: { monto_cop: n, simbolo: tieneSimbolo, palabra: tienePalabra, separador_miles: tieneSeparadorMiles },
      };
    },
    confianza_default: 'INFERIDO',
  },

  // ─── Fecha relativa ───
  {
    tipo: 'fecha_relativa',
    regex: /\b(?:hoy|mañana|pasado\s+mañana|este\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|el\s+(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)|esta\s+semana|pr[oó]xima\s+semana|fin\s+de\s+semana)\b/gi,
    normalizar: (m) => ({ valor: m[0].toLowerCase().replace(/\s+/g, ' ') }),
    confianza_default: 'DUDOSO',
  },

  // ─── Fecha absoluta dd/mm o dd de mes ───
  {
    tipo: 'fecha_absoluta',
    regex: /\b(\d{1,2})\s*(?:de|\/|-)\s*(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|0?[1-9]|1[0-2])\s*(?:de|\/|-)?\s*(\d{2,4})?\b/gi,
    normalizar: (m) => {
      const dia = parseInt(m[1], 10);
      let mes: number;
      const mesRaw = m[2].toLowerCase();
      if (MESES_ES[mesRaw]) mes = MESES_ES[mesRaw];
      else mes = parseInt(mesRaw, 10);
      if (isNaN(mes) || mes < 1 || mes > 12) return null;
      if (dia < 1 || dia > 31) return null;
      const anio = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10)) : new Date().getFullYear();
      // Sanity: rechazar años fuera del rango operativo del negocio
      if (anio < 2020 || anio > 2030) return null;
      const iso = `${anio}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
      return { valor: iso, meta: { dia, mes, anio } };
    },
    confianza_default: 'INFERIDO',
  },

  // ─── Sistemas Safra ───
  {
    tipo: 'sistema_safra',
    regex: /\b(blackout|black\s*out|screen\s*solar|screen\b|sheer\s*elegance|sheer\b|panel\s*japon[eé]s|enrollable|persiana(?:s)?\s*vertical|pel[ií]cula(?:s)?\s*solar|toldo|dom[oó]tica|riel|cadenilla|tapaluz|motorizad[oa]?|motor\b|sistema\s*guaya)\b/gi,
    normalizar: (m) => {
      const raw = m[0].toLowerCase().replace(/\s+/g, ' ').trim();
      const map: Record<string, string> = {
        'black out': 'blackout', 'screen solar': 'screen_solar', 'screen': 'screen_solar',
        'sheer elegance': 'sheer_elegance', 'sheer': 'sheer_elegance',
        'panel japonés': 'panel_japones', 'panel japones': 'panel_japones',
        'enrollable': 'enrollables', 'persiana vertical': 'verticales', 'persianas vertical': 'verticales',
        'pelicula solar': 'peliculas_solares', 'película solar': 'peliculas_solares',
        'peliculas solares': 'peliculas_solares', 'películas solares': 'peliculas_solares',
        'toldo': 'toldos',
        'domótica': 'domotica', 'domotica': 'domotica',
        'riel': 'rieles', 'cadenilla': 'cadenillas',
        'tapaluz': 'tapaluz', 'motorizado': 'motores', 'motorizada': 'motores', 'motor': 'motores',
        'sistema guaya': 'sistema_guaya',
      };
      const codigo = map[raw] ?? raw;
      return { valor: codigo, meta: { texto_original: m[0] } };
    },
    confianza_default: 'INFERIDO',
  },

  // ─── Código cotización Safra (formato simple, ajustar según realidad) ───
  {
    tipo: 'codigo_cotizacion',
    regex: /\b(?:cot|cotizaci[oó]n)\s*[#:.-]?\s*([A-Z]{2,4}-?\d{2,4}-?\d{1,4})\b/gi,
    normalizar: (m) => ({ valor: m[1].toUpperCase().replace(/[\s]/g, '') }),
    confianza_default: 'INFERIDO',
  },

  // ─── URL ───
  {
    tipo: 'url',
    regex: /https?:\/\/[^\s<>"]+[^\s<>".,)\]}]/gi,
    normalizar: (m) => ({ valor: m[0] }),
    confianza_default: 'CONFIRMADO',
  },

  // ─── Horario simple (8am-5pm, 14:00-18:00) ───
  {
    tipo: 'horario',
    regex: /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|hrs?|h)?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|hrs?|h)?\b/gi,
    normalizar: (m) => ({ valor: m[0].trim() }),
    confianza_default: 'DUDOSO',
  },
];
