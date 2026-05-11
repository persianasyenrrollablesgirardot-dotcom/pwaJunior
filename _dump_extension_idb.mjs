#!/usr/bin/env node
/**
 * Lee archivos .ldb y .log de Chrome IndexedDB directamente como Buffer.
 * Extrae secuencias UTF-8 legibles y reconstruye registros parseando patrones
 * (jids, números E.164, mensajes texto, titulos de chat).
 *
 * No usa LevelDB API porque Chrome usa idb_cmp1 (comparator custom incompatible).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'C:\\temp\\captura_dump\\chrome-extension_oomdmlhadnonedbdjdcfkpceaijpkelj_0.indexeddb.leveldb';

const files = readdirSync(DIR).filter(f => f.endsWith('.ldb') || f.endsWith('.log'));
console.log(`▸ ${files.length} archivos LevelDB encontrados`);

// Extrae secuencias UTF-8 imprimibles del Buffer
function extraerStrings(buf, minLen = 4) {
  const out = [];
  let cur = '';
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if ((b >= 0x20 && b < 0x7F) || b === 0x09 || b === 0x0A) {
      cur += String.fromCharCode(b);
      i++;
    } else if (b >= 0xC2 && b <= 0xF4 && i + 1 < buf.length) {
      // UTF-8 multibyte
      let len = 1;
      if ((b & 0xE0) === 0xC0) len = 2;
      else if ((b & 0xF0) === 0xE0) len = 3;
      else if ((b & 0xF8) === 0xF0) len = 4;
      if (i + len <= buf.length) {
        try {
          const seg = buf.slice(i, i + len).toString('utf8');
          if (seg && !seg.includes('�')) {
            cur += seg;
            i += len;
            continue;
          }
        } catch {}
      }
      if (cur.length >= minLen) out.push(cur);
      cur = ''; i++;
    } else {
      if (cur.length >= minLen) out.push(cur);
      cur = ''; i++;
    }
  }
  if (cur.length >= minLen) out.push(cur);
  return out;
}

// Cargar todo
let totalBytes = 0;
const allStrings = [];
for (const f of files) {
  const buf = readFileSync(join(DIR, f));
  totalBytes += buf.length;
  allStrings.push(...extraerStrings(buf, 4));
}
console.log(`  ✓ ${(totalBytes / 1024 / 1024).toFixed(1)}MB · ${allStrings.length.toLocaleString()} strings extraídos`);

// ─── Análisis 1: JIDs únicos ─────────────────────────────────────────
const jidSet = new Set();
const jidByType = { 'c.us': new Set(), 's.whatsapp.net': new Set(), 'g.us': new Set(), 'lid': new Set(), broadcast: new Set() };
const jidRe = /\b(\d{8,15})@(c\.us|s\.whatsapp\.net|g\.us|lid|broadcast)\b/g;
for (const s of allStrings) {
  for (const m of s.matchAll(jidRe)) {
    const jid = `${m[1]}@${m[2]}`;
    jidSet.add(jid);
    jidByType[m[2]]?.add(jid);
  }
}
console.log(`\n📞 JIDs únicos: ${jidSet.size}`);
for (const [t, set] of Object.entries(jidByType)) console.log(`  · ${t}: ${set.size}`);

// ─── Análisis 2: Teléfonos COL E.164 ────────────────────────────────
const telSet = new Set();
for (const j of jidSet) {
  const num = j.split('@')[0];
  if (num.startsWith('57') && num.length === 12) telSet.add('+' + num);
  else if (num.startsWith('3') && num.length === 10) telSet.add('+57' + num);
}
console.log(`\n📱 Teléfonos COL únicos: ${telSet.size}`);

// ─── Análisis 3: Patrones de contenido ─────────────────────────────
const PATTERNS = {
  precio_cop:        /\$\s?\d{1,3}(?:[.\s]?\d{3})+|\d{2,5}\.000\b|\$\s?\d{4,}|COP\s?\d+|\d{1,3}\s?mil\b/gi,
  medida:            /\b(\d{1,2}(?:[.,]\d{1,2})?)\s*(?:m|metros?|mts?|cm|centimetros?)\s*(?:x|por|×)\s*(\d{1,2}(?:[.,]\d{1,2})?)/gi,
  medida_simple:     /\b\d{2,4}\s*(?:cm|centimetros)\b/gi,
  saludo:            /\b(buen[oa]s?\s+(?:d[ií]as?|tardes?|noches?)|hola)/gi,
  pregunta_precio:   /\b(cu[aá]nto\s+(?:cuesta|vale|sale)|que\s+precio|precio\s+de)/gi,
  pedir_cotizar:     /\b(cotiz[aá]\w*|cotizaci[oó]n|presupuesto)/gi,
  pedir_visita:      /\b(visita\s+t[eé]cnica|tomar\s+medidas?|ir\s+a\s+(?:la\s+)?casa|programar\s+visita)/gi,
  agradecer:         /\b(gracias|muchas\s+gracias|mil\s+gracias)/gi,
  confirmar_pago:    /\b(transfer[ií]|pagu[eé]|consign[eé]|abon[eé]|nequi|bancolombia|daviplata|pse|comprobante|recib[oo])/gi,
  productos_safra:   /\b(blackout|black\s?out|screen|sheer|persiana\w*|cortina\w*|enrollable\w*|toldo\w*|panel\s*japon\w*|motoriz\w*|tapaluz\w*|riel\w*)/gi,
  zonas:             /\b(girardot|ricaurte|melgar|bogot[aá]|conjunto|condominio|apartamento|apto|casa|finca|piso|edificio|torre)/gi,
  garantia:          /\b(garant[ií]a|reclamaci[oó]n|defect[oa]|no\s+funciona|se\s+ca[yi][oó]|se\s+da[ñn][oó]|mal\s+puest[oa]|mal\s+instalad[oa])/gi,
  urgencia:          /\b(urgente|ya\s+mismo|hoy|para\s+hoy|para\s+ma[ñn]ana|cuando\s+puedan)/gi,
  ubicacion:         /\b(direcci[oó]n|carrera|calle|cra|cl|av\s|avenida|barrio|km)\b/gi,
  email:             /[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  consulta_estado:   /\b(ya\s+est[aá]\s+listo|cu[aá]ndo\s+(?:est[aá]|llegar)|cuando\s+me\s+lo\s+entregan|cuando\s+instal)/gi,
};
const counts = {};
const samples = {};
for (const [name, re] of Object.entries(PATTERNS)) {
  counts[name] = 0;
  samples[name] = [];
  for (const s of allStrings) {
    if (s.length > 500) continue;
    const matches = s.matchAll(re);
    for (const m of matches) {
      counts[name]++;
      if (samples[name].length < 10) {
        const ctx = s.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30).trim();
        if (!samples[name].includes(ctx)) samples[name].push(ctx);
      }
    }
  }
}
console.log('\n🔍 PATRONES DE CONTENIDO:');
for (const [name, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${name.padEnd(20)}: ${n.toString().padStart(5)}`);
}

// ─── Análisis 4: Nombres probables (titulos de chat) ────────────────
const nombresCandidatos = new Set();
// Heurística: secuencias "Nombre Apellido" capitalizadas, 2-4 palabras
const nombreRe = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,15}(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]{2,15}){0,3})\b/g;
const blacklist = new Set([
  'Buenos Días','Buenas Tardes','Buenas Noches','Muchas Gracias','Mil Gracias','Gracias Don',
  'Sí Señor','Si Señor','Estados Unidos','Bogotá','Medellín','Cali','Girardot','Ricaurte','Melgar',
  'Buenos','Buenas','Hola','Listo','Vale','Bueno','Claro','Perfecto',
]);
for (const s of allStrings) {
  if (s.length < 6 || s.length > 100) continue;
  for (const m of s.matchAll(nombreRe)) {
    const nombre = m[1];
    if (blacklist.has(nombre)) continue;
    if (nombre.split(' ').length < 2) continue;
    if (/^[A-Z][a-z]+\s+[A-Z][a-z]+/.test(nombre)) {
      nombresCandidatos.add(nombre);
    }
  }
}
console.log(`\n👤 Nombres candidatos (2+ palabras, capitalizados): ${nombresCandidatos.size}`);

// ─── Análisis 5: Frases largas (probables mensajes WhatsApp) ────────
const frasesUtiles = allStrings.filter(s =>
  s.length >= 20 && s.length <= 300 &&
  /[a-záéíóúñ]/i.test(s) &&
  /\s/.test(s) &&
  !s.includes('http') &&
  !s.includes('webp') &&
  !/^[A-Z_]{5,}$/.test(s) &&
  !/^\{|\[/.test(s) &&
  (s.match(/[a-záéíóúñ]/gi)?.length ?? 0) / s.length > 0.5,
).slice(0, 300);

// Guardar dump
writeFileSync('C:\\Proyectos\\Visor_PG\\_idb_raw.json', JSON.stringify({
  stats: {
    archivos: files.length,
    total_bytes: totalBytes,
    total_strings: allStrings.length,
    jids_unicos: jidSet.size,
    telefonos_col: telSet.size,
    nombres_candidatos: nombresCandidatos.size,
    frases_utiles: frasesUtiles.length,
  },
  jids: [...jidSet],
  telefonos: [...telSet],
  patterns_counts: counts,
  patterns_samples: samples,
  nombres_candidatos: [...nombresCandidatos],
  frases_muestra: frasesUtiles,
}, null, 2));
console.log('\n📝 _idb_raw.json escrito');

// ─── Muestra resumida en consola ───────────────────────────────────
console.log('\n═══ MUESTRA: 10 frases reales del cliente ═══');
for (const f of frasesUtiles.slice(0, 10)) console.log(`  · ${f}`);

console.log('\n═══ MUESTRA: 10 nombres candidatos ═══');
for (const n of [...nombresCandidatos].slice(0, 10)) console.log(`  · ${n}`);
