#!/usr/bin/env node
/**
 * Re-procesa los .ldb buscando, para cada JID @c.us, los strings vecinos
 * en el mismo archivo (probablemente del mismo record): titulo del chat,
 * texto de mensajes, productos mencionados.
 *
 * Filtra los 10 candidatos a cliente con mejor evidencia comercial real.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIR = 'C:\\temp\\captura_dump\\chrome-extension_oomdmlhadnonedbdjdcfkpceaijpkelj_0.indexeddb.leveldb';
const files = readdirSync(DIR).filter(f => f.endsWith('.ldb') || f.endsWith('.log'));

function extraerStringsConPos(buf) {
  const out = [];
  let cur = '', start = -1;
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if ((b >= 0x20 && b < 0x7F) || b === 0x09 || b === 0x0A) {
      if (cur === '') start = i;
      cur += String.fromCharCode(b);
      i++;
    } else if (b >= 0xC2 && b <= 0xF4 && i + 1 < buf.length) {
      let len = 1;
      if ((b & 0xE0) === 0xC0) len = 2;
      else if ((b & 0xF0) === 0xE0) len = 3;
      else if ((b & 0xF8) === 0xF0) len = 4;
      if (i + len <= buf.length) {
        try {
          const seg = buf.slice(i, i + len).toString('utf8');
          if (seg && !seg.includes('�')) {
            if (cur === '') start = i;
            cur += seg;
            i += len; continue;
          }
        } catch {}
      }
      if (cur.length >= 3) out.push({ pos: start, s: cur });
      cur = ''; start = -1; i++;
    } else {
      if (cur.length >= 3) out.push({ pos: start, s: cur });
      cur = ''; start = -1; i++;
    }
  }
  if (cur.length >= 3) out.push({ pos: start, s: cur });
  return out;
}

// Reunir todos los strings con su posición/archivo
const allWithPos = [];
for (const f of files) {
  const buf = readFileSync(join(DIR, f));
  const strs = extraerStringsConPos(buf);
  for (const x of strs) allWithPos.push({ file: f, pos: x.pos, s: x.s });
}
console.log(`▸ ${allWithPos.length.toLocaleString()} strings con posición`);

// Para cada jid @c.us, buscar los strings dentro de ±3000 bytes (mismo record IDB)
const jidRe = /\b(\d{10,15})@c\.us\b/g;
const jidsRaw = new Map();   // jid -> { file, pos }[]
for (let i = 0; i < allWithPos.length; i++) {
  const { file, pos, s } = allWithPos[i];
  for (const m of s.matchAll(jidRe)) {
    const jid = `${m[1]}@c.us`;
    if (!jidsRaw.has(jid)) jidsRaw.set(jid, []);
    jidsRaw.get(jid).push({ file, pos: pos + m.index });
  }
}
console.log(`📞 ${jidsRaw.size} jids @c.us únicos`);

// Productos / zonas / patrones a buscar en vecindad
const RE_PROD = /\b(blackout|black\s?out|screen|sheer|persiana\w*|cortina\w*|enrollable\w*|toldo\w*|panel\s*japon\w*|motoriz\w*|tapaluz\w*|riel\w*|veneciana\w*)/gi;
const RE_ZONA = /\b(girardot|ricaurte|melgar|bogot[aá]|tocaima|flandes|nilo|fusagasug[aá]|cundinamarca)\b/gi;
const RE_TIPO_INMUEBLE = /\b(conjunto|condominio|apartamento|apto|casa|finca|piso\s*\d|edificio|torre|cabo\s+verde|sun\s+cariota|el\s+peñ[oó]n|kalamary)/gi;
const RE_DIR = /\b(carrera|calle|cra|cl|av\s|avenida|kil[oó]metro|km)\s*\d/gi;
const RE_PRECIO = /\$\s?\d{1,3}(?:[.\s]\d{3})+|\d{2,4}\s?mil\b|\bcop\s?\d/gi;
const RE_PAGO = /\b(nequi|bancolombia|daviplata|pse|consign|transfer|pagu|abon)/gi;

// Para cada jid, escanear strings en su mismo archivo con posición cercana
const NEIGHBOR_RADIUS = 8000;  // bytes
const contactos = [];
for (const [jid, ocurrencias] of jidsRaw) {
  // Usamos la primera ocurrencia como ancla
  const ocur = ocurrencias[0];
  const sameFile = allWithPos.filter(x => x.file === ocur.file
    && x.pos >= ocur.pos - NEIGHBOR_RADIUS
    && x.pos <= ocur.pos + NEIGHBOR_RADIUS);

  // Buscar texto cerca con score: productos, zonas, etc.
  const productos = new Set();
  const zonas = new Set();
  const inmuebles = new Set();
  const direcciones = new Set();
  const precios = new Set();
  const pagos = new Set();
  const frases = [];
  let saludos = 0, gracias = 0;

  for (const { s } of sameFile) {
    if (s.length > 500) continue;
    for (const m of s.matchAll(RE_PROD)) productos.add(m[1].toLowerCase());
    for (const m of s.matchAll(RE_ZONA)) zonas.add(m[1].toLowerCase());
    for (const m of s.matchAll(RE_TIPO_INMUEBLE)) inmuebles.add(m[1].toLowerCase());
    for (const m of s.matchAll(RE_DIR)) direcciones.add(m[0].toLowerCase().slice(0, 40));
    for (const m of s.matchAll(RE_PRECIO)) precios.add(m[0]);
    for (const m of s.matchAll(RE_PAGO)) pagos.add(m[0].toLowerCase());
    if (/\b(buenos d[ií]as|buenas tardes|buenas noches|hola)\b/i.test(s)) saludos++;
    if (/\bgracias\b/i.test(s)) gracias++;
    // Capturar frases naturales (mensajes)
    if (s.length >= 20 && s.length <= 250 && /\s/.test(s) && /[a-záéíóúñ]/i.test(s)
      && !s.includes('http') && !s.includes('webp') && !s.includes('codecs')
      && (s.match(/[a-záéíóúñ]/gi)?.length ?? 0) / s.length > 0.55) {
      frases.push(s);
    }
  }

  // Buscar titulo: string entre 2 y 40 chars con capitalización tipo "Nombre Apellido"
  // que aparezca DENTRO de 200 bytes del jid (en IDB es típico que `name` esté cerca del id)
  const cercanas = sameFile.filter(x => Math.abs(x.pos - ocur.pos) < 200);
  const tituloCandidatos = cercanas
    .map(x => x.s)
    .filter(s => s.length >= 3 && s.length <= 40 && /^[A-ZÁÉÍÓÚÑa-záéíóúñ0-9 ._-]+$/.test(s) && /[A-ZÁÉÍÓÚÑ]/.test(s));
  const titulo = tituloCandidatos[0] ?? null;

  // Score: producto comercial + frase real + saludo/gracias
  const score =
    productos.size * 3 +
    zonas.size * 2 +
    inmuebles.size * 1 +
    precios.size * 2 +
    pagos.size * 2 +
    Math.min(frases.length, 10) +
    Math.min(saludos, 3) +
    Math.min(gracias, 3);

  contactos.push({
    jid,
    telefono: `+${jid.split('@')[0]}`,
    titulo,
    titulo_candidatos: [...new Set(tituloCandidatos)].slice(0, 5),
    productos: [...productos],
    zonas: [...zonas],
    inmuebles: [...inmuebles],
    direcciones: [...direcciones].slice(0, 3),
    precios: [...precios].slice(0, 5),
    pagos: [...pagos],
    n_frases: frases.length,
    frases_muestra: frases.slice(0, 5),
    saludos, gracias,
    score,
  });
}

// Top 30 por score
contactos.sort((a, b) => b.score - a.score);
console.log(`\n🏆 Top 30 contactos por score comercial:\n`);
for (const c of contactos.slice(0, 30)) {
  console.log(`  [score ${String(c.score).padStart(3)}] ${c.telefono.padEnd(15)} ${(c.titulo || '?').padEnd(28)} prod:${c.productos.length} zona:${c.zonas.length} pago:${c.pagos.length} frases:${c.n_frases}`);
}

writeFileSync('C:\\Proyectos\\Visor_PG\\_contactos_correlados.json', JSON.stringify(contactos.slice(0, 30), null, 2));
console.log('\n📝 _contactos_correlados.json escrito (top 30)');
