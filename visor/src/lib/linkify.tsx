/**
 * Convierte un texto plano en un array de nodos React con los teléfonos
 * (+57XXXxxxxxxx, formato E.164) reemplazados por enlaces a WhatsApp:
 *   https://wa.me/57XXXxxxxxxx
 * que en móvil abre WA app directo, en desktop abre WA Web.
 */
import type { ReactNode } from 'react';

const TEL_REGEX = /(\+\d{10,15})/g;

// Marker técnico de propuestas de borrado del Junior: [#NOTA:51:chat=104] /
// [#TAREA:867:chat=104] / [#TRANSV:3]. Va al final del mensaje para que el
// próximo turno pueda parsearlo y ejecutar el delete confirmado. NO se muestra
// al usuario (es ruido visual): lo strippeamos antes de renderizar.
const MARKER_BORRADO = /\n?\[#(?:NOTA|TAREA|TRANSV):\d+(?::chat=\d+)?\]/g;

export function linkifyTelefonos(texto: string): ReactNode[] {
  // Quitar el marker técnico antes de cualquier otro procesamiento.
  texto = texto.replace(MARKER_BORRADO, '');
  const partes: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TEL_REGEX.lastIndex = 0;
  while ((m = TEL_REGEX.exec(texto)) !== null) {
    if (m.index > last) partes.push(texto.slice(last, m.index));
    const tel = m[1];
    const digits = tel.replace(/\D/g, '');
    partes.push(
      <a
        key={`tel-${partes.length}-${m.index}`}
        href={`https://wa.me/${digits}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Abrir chat en WhatsApp"
        style={{ color: '#25D366', fontWeight: 600, textDecoration: 'none', whiteSpace: 'nowrap' }}
      >
        {tel}
        <span style={{ marginLeft: 4, fontSize: '0.9em' }} aria-hidden="true">💬</span>
      </a>,
    );
    last = m.index + m[0].length;
  }
  if (last < texto.length) partes.push(texto.slice(last));
  return partes;
}
