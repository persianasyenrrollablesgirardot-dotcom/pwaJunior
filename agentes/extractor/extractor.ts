/**
 * Extractor objetivo (L1.5).
 * Aplica los PATRONES regex sobre un texto y devuelve las extracciones.
 *
 * Cero LLM. Cero costo API. Idempotente sobre el mismo texto.
 */

import { PATRONES, type TipoExtraccion } from './regex.js';

export interface Extraccion {
  tipo: TipoExtraccion;
  valor: string;
  valor_raw: string;
  msg_id: string;
  posicion: { start: number; end: number };
  confianza: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO';
  meta?: Record<string, any>;
}

/**
 * Extrae todos los datos objetivos de un texto.
 *
 * @param texto Texto crudo (ej. mensaje.texto)
 * @param msg_id Identificador del mensaje (para citar evidencia)
 * @returns Lista de extracciones (vacía si no hay nada)
 */
export function extraer(texto: string | null | undefined, msg_id: string): Extraccion[] {
  if (!texto || typeof texto !== 'string') return [];

  const extracciones: Extraccion[] = [];
  const yaVistos = new Set<string>();  // dedup de (tipo+valor) en el mismo texto

  for (const patron of PATRONES) {
    // Reset lastIndex (crucial con flag /g)
    patron.regex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = patron.regex.exec(texto)) !== null) {
      const matchStr = m[0];
      const start = m.index;
      const end = m.index + matchStr.length;

      const norm = patron.normalizar ? patron.normalizar(m) : { valor: matchStr };
      if (norm === null) continue;  // descartado (falso positivo)

      const llave = `${patron.tipo}::${norm.valor}`;
      if (yaVistos.has(llave)) continue;
      yaVistos.add(llave);

      extracciones.push({
        tipo: patron.tipo,
        valor: norm.valor,
        valor_raw: matchStr,
        msg_id,
        posicion: { start, end },
        confianza: patron.confianza_default ?? 'INFERIDO',
        meta: norm.meta,
      });
    }
  }

  return extracciones;
}

/**
 * Extrae sobre múltiples mensajes y agrupa por tipo.
 * Útil para resumen rápido de un chat completo.
 */
export function extraerLote(mensajes: Array<{ canal_msg_id: string; texto: string | null }>): {
  total: number;
  porTipo: Record<TipoExtraccion, Extraccion[]>;
  porMensaje: Map<string, Extraccion[]>;
} {
  const porTipo = {} as Record<TipoExtraccion, Extraccion[]>;
  const porMensaje = new Map<string, Extraccion[]>();
  let total = 0;

  for (const m of mensajes) {
    const exts = extraer(m.texto, m.canal_msg_id);
    if (exts.length === 0) continue;
    porMensaje.set(m.canal_msg_id, exts);
    total += exts.length;
    for (const e of exts) {
      if (!porTipo[e.tipo]) porTipo[e.tipo] = [];
      porTipo[e.tipo].push(e);
    }
  }

  return { total, porTipo, porMensaje };
}
