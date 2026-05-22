/**
 * Pestaña Chat del módulo Junior — la conversación de Jhon con su asistente.
 *
 * Jhon escribe → se inserta en `junior_chat` (estado='pendiente'). El worker lo
 * ve, arma el contexto con las síntesis de todos los clientes, y responde.
 * El componente hace polling cada 2s para mostrar la respuesta.
 *
 * Sesiones: cada conversación es independiente. Jhon puede abrir un chat nuevo
 * o volver a uno viejo. El historial que ve Junior es el de la sesión activa.
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

interface Sesion {
  id: number;
  titulo: string | null;
  ultima_actividad: string;
}

const SUGERENCIAS = [
  '¿Qué tengo que hacer hoy?',
  '¿Quién me debe plata?',
  '¿Qué cliente está en riesgo?',
  '¿Cómo va Walter Estancia?',
];

const TITULO_DEFAULT = 'Conversación nueva';

export function JuniorChat() {
  const [sesiones, setSesiones] = useState<Sesion[]>([]);
  const [sesionActiva, setSesionActiva] = useState<number | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [input, setInput] = useState('');
  const [enviando, setEnviando] = useState(false);
  const finRef = useRef<HTMLDivElement>(null);

  /** Carga las sesiones; si no hay ninguna, crea una. Devuelve la más reciente. */
  async function cargarSesiones(): Promise<number | null> {
    const { data } = await supabase
      .from('junior_sesiones')
      .select('id,titulo,ultima_actividad')
      .order('ultima_actividad', { ascending: false });
    let lista = (data as Sesion[]) ?? [];
    if (lista.length === 0) {
      const { data: nueva } = await supabase
        .from('junior_sesiones')
        .insert({ titulo: TITULO_DEFAULT } as any)
        .select('id,titulo,ultima_actividad')
        .single();
      if (nueva) lista = [nueva as Sesion];
    }
    setSesiones(lista);
    return lista[0]?.id ?? null;
  }

  async function cargarMensajes(sid: number) {
    const { data } = await supabase
      .from('junior_chat')
      .select('id,rol,mensaje,estado,created_at')
      .eq('sesion_id', sid)
      .order('created_at', { ascending: true });
    setMensajes((data as Mensaje[]) ?? []);
  }

  useEffect(() => {
    cargarSesiones().then(sid => { if (sid) setSesionActiva(sid); });
  }, []);

  useEffect(() => {
    if (sesionActiva == null) return;
    cargarMensajes(sesionActiva);
    const t = setInterval(() => cargarMensajes(sesionActiva), 2000);
    return () => clearInterval(t);
  }, [sesionActiva]);

  useEffect(() => { finRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [mensajes]);

  const esperando = mensajes.some(m => m.rol === 'usuario' && m.estado === 'pendiente');

  async function nuevaConversacion() {
    const { data: nueva } = await supabase
      .from('junior_sesiones')
      .insert({ titulo: TITULO_DEFAULT } as any)
      .select('id,titulo,ultima_actividad')
      .single();
    if (nueva) {
      setSesiones(s => [nueva as Sesion, ...s]);
      setMensajes([]);
      setSesionActiva((nueva as Sesion).id);
    }
  }

  async function enviar(texto?: string) {
    const t = (texto ?? input).trim();
    if (!t || enviando || esperando || sesionActiva == null) return;
    setEnviando(true);
    setInput('');
    await supabase.from('junior_chat').insert({
      rol: 'usuario', mensaje: t, estado: 'pendiente', sesion_id: sesionActiva,
    } as any);
    // Auto-título: si la sesión todavía no tiene nombre propio, usar este mensaje.
    const ses = sesiones.find(s => s.id === sesionActiva);
    if (ses && (!ses.titulo || ses.titulo === TITULO_DEFAULT)) {
      const titulo = t.length > 42 ? t.slice(0, 42) + '…' : t;
      await supabase.from('junior_sesiones').update({ titulo } as any).eq('id', sesionActiva);
      setSesiones(list => list.map(s => s.id === sesionActiva ? { ...s, titulo } : s));
    }
    await cargarMensajes(sesionActiva);
    setEnviando(false);
  }

  function etiquetaSesion(s: Sesion): string {
    const fecha = new Date(s.ultima_actividad).toLocaleDateString('es-CO', {
      day: '2-digit', month: '2-digit',
    });
    return `${s.titulo || TITULO_DEFAULT} · ${fecha}`;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Barra de sesión */}
      <div style={{
        padding: '8px 24px', borderBottom: '1px solid var(--border-soft)',
        display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
      }}>
        <select
          value={sesionActiva ?? ''}
          onChange={e => setSesionActiva(Number(e.target.value))}
          title="Conversaciones"
          style={{
            maxWidth: 240, padding: '6px 10px', fontSize: 12, borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg-page)',
            color: 'var(--text)', cursor: 'pointer', outline: 'none',
          }}
        >
          {sesiones.map(s => (
            <option key={s.id} value={s.id}>{etiquetaSesion(s)}</option>
          ))}
        </select>
        <button
          onClick={nuevaConversacion}
          title="Nueva conversación"
          style={{
            padding: '6px 12px', fontSize: 12, fontWeight: 600, borderRadius: 8,
            border: '1px solid var(--border)', background: 'var(--bg-panel)',
            color: 'var(--text)', cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >+ Nueva</button>
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
