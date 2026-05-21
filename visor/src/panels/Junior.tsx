/**
 * Módulo Junior — el chat de Jhon con su asistente.
 *
 * Jhon escribe → se inserta en `junior_chat` (estado='pendiente'). El worker lo
 * ve, arma el contexto con las síntesis de todos los clientes, y responde.
 * El componente hace polling cada 2s para mostrar la respuesta.
 */
import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Mensaje {
  id: number;
  rol: 'usuario' | 'junior';
  mensaje: string;
  estado: string;
  created_at: string;
}

const SUGERENCIAS = [
  '¿Qué tengo que hacer hoy?',
  '¿Quién me debe plata?',
  '¿Qué cliente está en riesgo?',
  '¿Cómo va Walter Estancia?',
];

export function Junior() {
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [input, setInput] = useState('');
  const [enviando, setEnviando] = useState(false);
  const finRef = useRef<HTMLDivElement>(null);

  async function cargar() {
    const { data } = await supabase
      .from('junior_chat')
      .select('id,rol,mensaje,estado,created_at')
      .order('created_at', { ascending: true });
    setMensajes((data as Mensaje[]) ?? []);
  }

  useEffect(() => { cargar(); }, []);
  useEffect(() => {
    const t = setInterval(cargar, 2000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { finRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [mensajes]);

  const esperando = mensajes.some(m => m.rol === 'usuario' && m.estado === 'pendiente');

  async function enviar(texto?: string) {
    const t = (texto ?? input).trim();
    if (!t || enviando || esperando) return;
    setEnviando(true);
    setInput('');
    await supabase.from('junior_chat').insert({ rol: 'usuario', mensaje: t, estado: 'pendiente' } as any);
    await cargar();
    setEnviando(false);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '16px 24px 12px', borderBottom: '1px solid var(--border-soft)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%', background: 'var(--accent)',
            color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
          }}>🤖</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Junior</h1>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
              Tu asistente. Conoce el estado de todos tus clientes.
            </p>
          </div>
        </div>
      </div>

      {/* Mensajes */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        {mensajes.length === 0 && (
          <div style={{ maxWidth: 520, margin: '40px auto', textAlign: 'center' }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🤖</div>
            <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 6px' }}>Hablá con Junior</h2>
            <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 18px', lineHeight: 1.5 }}>
              Preguntale lo que quieras sobre tus clientes y tu negocio.
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center' }}>
              {SUGERENCIAS.map(s => (
                <button key={s} onClick={() => enviar(s)}
                  style={{
                    padding: '7px 12px', fontSize: 12, borderRadius: 16,
                    border: '1px solid var(--border)', background: 'var(--bg-panel)',
                    color: 'var(--text)', cursor: 'pointer',
                  }}>{s}</button>
              ))}
            </div>
          </div>
        )}

        {mensajes.map(m => {
          const esUsuario = m.rol === 'usuario';
          return (
            <div key={m.id} style={{
              display: 'flex', justifyContent: esUsuario ? 'flex-end' : 'flex-start', marginBottom: 12,
            }}>
              <div style={{
                maxWidth: '72%', padding: '10px 14px', borderRadius: 12, fontSize: 13, lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                background: esUsuario ? 'var(--accent)' : 'var(--bg-panel)',
                color: esUsuario ? 'white' : 'var(--text)',
                border: esUsuario ? 'none' : '1px solid var(--border-soft)',
                borderBottomRightRadius: esUsuario ? 3 : 12,
                borderBottomLeftRadius: esUsuario ? 12 : 3,
              }}>
                {!esUsuario && (
                  <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', marginBottom: 3 }}>
                    🤖 Junior
                  </div>
                )}
                {m.mensaje}
              </div>
            </div>
          );
        })}

        {esperando && (
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: 12 }}>
            <div style={{
              padding: '10px 14px', borderRadius: 12, fontSize: 13, fontStyle: 'italic',
              background: 'var(--bg-panel)', color: 'var(--text-muted)', border: '1px solid var(--border-soft)',
            }}>
              Junior está pensando…
            </div>
          </div>
        )}
        <div ref={finRef} />
      </div>

      {/* Input */}
      <div style={{ padding: '12px 24px 16px', borderTop: '1px solid var(--border-soft)' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') enviar(); }}
            placeholder="Preguntale algo a Junior…"
            disabled={esperando}
            style={{
              flex: 1, padding: '10px 14px', fontSize: 13, borderRadius: 8,
              border: '1px solid var(--border)', background: 'var(--bg-page)',
              outline: 'none', color: 'var(--text)',
            }}
          />
          <button
            onClick={() => enviar()}
            disabled={!input.trim() || esperando}
            style={{
              padding: '10px 18px', fontSize: 13, fontWeight: 600, borderRadius: 8, border: 'none',
              background: (!input.trim() || esperando) ? 'var(--border)' : 'var(--accent)',
              color: 'white', cursor: (!input.trim() || esperando) ? 'default' : 'pointer',
            }}
          >Enviar</button>
        </div>
      </div>
    </div>
  );
}
