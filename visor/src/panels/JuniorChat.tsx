/**
 * Chat con Junior — VERSIÓN V2.
 *
 * Llama al endpoint /api/junior-v2 (responderJuniorTarjeta): Junior lee SOLO las
 * tarjetas relevantes, no las 75. Muestra qué tarjetas leyó y el costo del turno.
 *
 * Nota: por ahora cada pregunta es independiente (sin historial de conversación
 * en el server). El hilo de follow-ups llega en el Hito 3.
 */
import { useRef, useState, useEffect } from 'react';

interface Turno {
  rol: 'jhon' | 'junior';
  texto: string;
  meta?: { via_indice: boolean; tarjetas_usadas: number[]; costo_usd: number };
}

export function JuniorChat() {
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [pregunta, setPregunta] = useState('');
  const [cargando, setCargando] = useState(false);
  const finRef = useRef<HTMLDivElement>(null);

  useEffect(() => { finRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turnos, cargando]);

  async function enviar() {
    const q = pregunta.trim();
    if (!q || cargando) return;
    setTurnos(t => [...t, { rol: 'jhon', texto: q }]);
    setPregunta(''); setCargando(true);
    try {
      const res = await fetch('/api/junior-v2', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta: q }),
      });
      const data = await res.json();
      if (data.error) {
        setTurnos(t => [...t, { rol: 'junior', texto: 'Tuve un problema: ' + data.error }]);
      } else {
        setTurnos(t => [...t, { rol: 'junior', texto: data.respuesta, meta: { via_indice: data.via_indice, tarjetas_usadas: data.tarjetas_usadas, costo_usd: data.costo_usd } }]);
      }
    } catch (e: any) {
      setTurnos(t => [...t, { rol: 'junior', texto: 'Error de red: ' + e.message }]);
    } finally { setCargando(false); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '18px 24px' }}>
        {turnos.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0', fontSize: 13 }}>
            <div style={{ fontSize: 32, marginBottom: 8 }}>🤖</div>
            Preguntale a Junior. Lee solo las tarjetas que necesita.<br />
            <span style={{ fontSize: 12 }}>ej: <em>"¿qué pasa con Pedidos Cubides?"</em> · <em>"¿quién espera mi respuesta?"</em></span>
          </div>
        )}
        {turnos.map((t, i) => (
          <div key={i} style={{ display: 'flex', justifyContent: t.rol === 'jhon' ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
            <div style={{
              maxWidth: '78%', padding: '10px 14px', borderRadius: 12, fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap',
              background: t.rol === 'jhon' ? 'var(--accent)' : 'var(--bg-panel)',
              color: t.rol === 'jhon' ? 'white' : 'var(--text)',
              border: t.rol === 'jhon' ? 'none' : '1px solid var(--border-soft)',
            }}>
              {t.texto}
              {t.meta && (
                <div style={{ marginTop: 6, fontSize: 10, color: 'var(--text-muted)' }}>
                  {t.meta.via_indice ? '· respondió con el índice' : `· leyó ${t.meta.tarjetas_usadas.length} tarjeta(s): ${t.meta.tarjetas_usadas.map(c => 'chat ' + c).join(', ') || '—'}`}
                  {' · $'}{t.meta.costo_usd.toFixed(4)}
                </div>
              )}
            </div>
          </div>
        ))}
        {cargando && <div style={{ color: 'var(--text-muted)', fontSize: 13, padding: '4px 0' }}>Junior está pensando…</div>}
        <div ref={finRef} />
      </div>

      <div style={{ borderTop: '1px solid var(--border-soft)', padding: '12px 24px', display: 'flex', gap: 8 }}>
        <input value={pregunta} onChange={e => setPregunta(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') enviar(); }}
          placeholder="Escribí tu pregunta y Enter…" disabled={cargando}
          style={{ flex: 1, padding: '10px 14px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14 }} />
        <button onClick={enviar} disabled={cargando || !pregunta.trim()} style={{
          padding: '10px 20px', borderRadius: 8, border: 'none', fontWeight: 600, fontSize: 14,
          background: cargando ? '#9ca3af' : 'var(--accent)', color: 'white',
        }}>{cargando ? '…' : 'Enviar'}</button>
      </div>
    </div>
  );
}
