/**
 * Chat con Junior — VERSIÓN V2.
 *
 * Llama al endpoint /api/junior-v2 (responderJuniorTarjeta): Junior lee SOLO las
 * tarjetas relevantes, no las 75. Muestra qué tarjetas leyó y el costo del turno.
 *
 * Historial PERSISTIDO en BD (junior_sesiones + junior_chat, sesión dedicada V2):
 * el hilo sobrevive a recargas y alimenta los follow-ups ("¿y de ese cuánto debe?").
 */
import { useRef, useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { linkifyTelefonos } from '../lib/linkify';

interface Turno {
  rol: 'jhon' | 'junior';
  texto: string;
  meta?: { via_indice: boolean; tarjetas_usadas: number[]; costo_usd: number };
}

const SESION_TITULO = 'Junior V2 — Jhon';

// Sesión V2 dedicada: la más reciente con ese título (o crear una).
async function obtenerSesionId(): Promise<number> {
  const { data } = await supabase.from('junior_sesiones')
    .select('id').eq('titulo', SESION_TITULO).order('id', { ascending: false }).limit(1).maybeSingle();
  if (data?.id) return data.id;
  const { data: nueva } = await supabase.from('junior_sesiones').insert({ titulo: SESION_TITULO } as any).select('id').single();
  return nueva!.id;
}

export function JuniorChat() {
  const [turnos, setTurnos] = useState<Turno[]>([]);
  const [pregunta, setPregunta] = useState('');
  const [cargando, setCargando] = useState(false);
  const [sesionId, setSesionId] = useState<number | null>(null);
  const finRef = useRef<HTMLDivElement>(null);

  useEffect(() => { finRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turnos, cargando]);

  // Cargar el hilo persistido al abrir.
  useEffect(() => {
    (async () => {
      const sid = await obtenerSesionId();
      setSesionId(sid);
      const { data } = await supabase.from('junior_chat')
        .select('rol, mensaje').eq('sesion_id', sid).order('id', { ascending: true });
      setTurnos((data ?? []).filter((m: any) => m.mensaje).map((m: any) => ({
        rol: m.rol === 'junior' ? 'junior' : 'jhon', texto: m.mensaje,
      })));
    })();
  }, []);

  async function persistir(rol: 'usuario' | 'junior', mensaje: string, costo_usd = 0) {
    if (sesionId == null) return;
    await supabase.from('junior_chat').insert({
      rol, mensaje, estado: 'completo', sesion_id: sesionId,
      ...(rol === 'junior' ? { costo_usd, modelo: 'deepseek-chat' } : {}),
    } as any).then(() => {}, () => {});  // best-effort: si falla, el chat sigue en memoria
  }

  async function enviar() {
    const q = pregunta.trim();
    if (!q || cargando) return;
    const historial = turnos.map(t => ({ rol: t.rol, texto: t.texto }));
    setTurnos(t => [...t, { rol: 'jhon', texto: q }]);
    setPregunta(''); setCargando(true);
    await persistir('usuario', q);
    try {
      // Auth: token guardado en localStorage. Si 401, pedir y reintentar UNA vez.
      const intentar = async (token: string | null) => fetch('/api/junior-v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Junior-Token': token } : {}) },
        body: JSON.stringify({ pregunta: q, historial }),
      });
      let res = await intentar(localStorage.getItem('junior_token'));
      if (res.status === 401) {
        const nuevo = prompt('Esta app está protegida. Ingresá la clave:');
        if (!nuevo) { setCargando(false); return; }
        localStorage.setItem('junior_token', nuevo);
        res = await intentar(nuevo);
        if (res.status === 401) {
          localStorage.removeItem('junior_token');
          setTurnos(t => [...t, { rol: 'junior', texto: 'Clave incorrecta. Recargá y volvé a intentar.' }]);
          setCargando(false); return;
        }
      }
      const data = await res.json();
      if (data.error) {
        setTurnos(t => [...t, { rol: 'junior', texto: 'Tuve un problema: ' + data.error }]);
      } else {
        setTurnos(t => [...t, { rol: 'junior', texto: data.respuesta, meta: { via_indice: data.via_indice, tarjetas_usadas: data.tarjetas_usadas, costo_usd: data.costo_usd } }]);
        await persistir('junior', data.respuesta, data.costo_usd);
      }
    } catch (e: any) {
      setTurnos(t => [...t, { rol: 'junior', texto: 'Error de red: ' + e.message }]);
    } finally { setCargando(false); }
  }

  async function nuevaConversacion() {
    if (cargando) return;
    const { data } = await supabase.from('junior_sesiones').insert({ titulo: SESION_TITULO } as any).select('id').single();
    setSesionId(data!.id);
    setTurnos([]);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '8px 24px 0' }}>
        <button onClick={nuevaConversacion} disabled={cargando} style={{
          fontSize: 12, color: 'var(--text-muted)', background: 'transparent',
          border: '1px solid var(--border-soft)', borderRadius: 8, padding: '4px 10px', cursor: 'pointer',
        }}>🗑 Nueva conversación</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 24px' }}>
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
              {t.rol === 'junior' ? linkifyTelefonos(t.texto) : t.texto}
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
