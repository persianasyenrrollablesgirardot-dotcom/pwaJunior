// Búsqueda unificada para Captura, Clientes, Tarjeta V2 y el buscador global.
// Un solo parser + matcher para que TODOS los módulos busquen igual: por
// #chat, #persona, teléfono (parcial), nombre, título, jid/LID, email, empresa,
// ciudad. Así, con los pocos datos que uno tenga, se encuentra el mismo contacto
// en cualquier módulo. Ver project_visor_pg.md (buscadores sincronizados).

export interface Query {
  raw: string;
  vacia: boolean;
  textoNorm: string;          // normalizado (sin acentos, lowercase) para includes
  digitos: string;            // solo dígitos del query (teléfono / id numérico)
  idExplicito: number | null; // de "#272", "chat 272", "id231", "persona 231"
  esNumeroPuro: boolean;      // el query es solo dígitos (ej "272")
}

// minúsculas + sin acentos, para que "García" matchee "garcia".
export function norm(s: string | null | undefined): string {
  return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

export function parseQuery(raw: string): Query {
  const r = (raw ?? '').trim();
  if (!r) return { raw: '', vacia: true, textoNorm: '', digitos: '', idExplicito: null, esNumeroPuro: false };
  // "#272", "id231", "chat 272", "persona#231" → id explícito
  const m = r.match(/^(?:#|id|chat|persona)\s*#?\s*(\d+)$/i);
  const idExplicito = m ? Number(m[1]) : null;
  const digitos = r.replace(/\D/g, '');
  const esNumeroPuro = /^\d+$/.test(r);
  return { raw: r, vacia: false, textoNorm: norm(r), digitos, idExplicito, esNumeroPuro };
}

export interface CamposContacto {
  chatId?: number | null;
  personaId?: number | null;
  nombre?: string | null;
  titulo?: string | null;
  telefono?: string | null;
  jid?: string | null;
  email?: string | null;
  empresa?: string | null;
  ciudad?: string | null;
}

const UMBRAL_TEL = 4;   // mínimo de dígitos para buscar por teléfono parcial

// ¿El contacto matchea la query? Cubre id, teléfono parcial, texto y jid.
export function matchContacto(q: Query, c: CamposContacto): boolean {
  if (q.vacia) return true;

  // 1. id explícito (#272, id231…) o número puro corto → chat o persona.
  if (q.idExplicito != null && (c.chatId === q.idExplicito || c.personaId === q.idExplicito)) return true;
  if (q.esNumeroPuro) {
    const n = Number(q.digitos);
    if (c.chatId === n || c.personaId === n) return true;
  }

  // 2. teléfono parcial (>= 4 dígitos): contra el teléfono y contra el jid (@c.us).
  if (q.digitos.length >= UMBRAL_TEL) {
    const telDig = String(c.telefono ?? '').replace(/\D/g, '');
    if (telDig && telDig.includes(q.digitos)) return true;
    const jidDig = String(c.jid ?? '').replace(/\D/g, '');
    if (jidDig && jidDig.includes(q.digitos)) return true;
  }

  // 3. texto libre en campos legibles + jid (LID/@c.us).
  if (q.textoNorm) {
    for (const v of [c.nombre, c.titulo, c.email, c.empresa, c.ciudad, c.jid]) {
      if (v && norm(v).includes(q.textoNorm)) return true;
    }
  }
  return false;
}
