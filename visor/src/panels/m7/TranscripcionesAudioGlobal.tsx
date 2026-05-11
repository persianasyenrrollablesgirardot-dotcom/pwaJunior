/**
 * 7.3 Transcripción de audio — vista GLOBAL cross-cliente.
 *
 * Lista mensajes tipo='audio' que tienen texto transcrito (F2.3). No requiere
 * cliente activo. Útil para buscar "qué dijo alguien en un audio el mes pasado".
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchTranscripcionesAudioGlobal } from '../../lib/queries';

interface AudioItem {
  id: number;
  chat_id: number;
  texto: string;
  ts_canal: string;
  media_url: string | null;
  persona_nombre: string | null;
}

const fmtFecha = (s: string) => new Date(s).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function TranscripcionesAudioGlobal() {
  const [items, setItems] = useState<AudioItem[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');

  useEffect(() => {
    setCargando(true); setError(null);
    fetchTranscripcionesAudioGlobal()
      .then(setItems)
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, []);

  const filtradas = useMemo(() => {
    if (!busqueda.trim()) return items;
    const q = busqueda.toLowerCase();
    return items.filter(i =>
      (i.texto ?? '').toLowerCase().includes(q) ||
      (i.persona_nombre ?? '').toLowerCase().includes(q),
    );
  }, [items, busqueda]);

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Transcripciones de audio (global) — {items.length}
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Todos los audios transcritos del sistema. Busca por palabra clave o nombre del cliente.
      </p>

      <input
        type="search" value={busqueda} onChange={e => setBusqueda(e.target.value)}
        placeholder='🔍 Buscar palabra en transcripción o nombre de cliente…'
        style={{ width: '100%', maxWidth: 500, padding: '7px 12px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, marginBottom: 16 }}
      />

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && filtradas.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          {items.length === 0 ? 'Sin audios transcritos todavía. La transcripción se hace en M1 Núcleo → Transcripciones via extensión.' : `Sin resultados para "${busqueda}".`}
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {filtradas.map(i => (
          <div key={i.id} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <div>
                <span style={{ fontSize: 18, marginRight: 6 }}>🎙️</span>
                <strong style={{ fontSize: 13 }}>{i.persona_nombre ?? '(sin nombre)'}</strong>
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtFecha(i.ts_canal)}</span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 6 }}>{i.texto}</div>
            {i.media_url && (
              <audio controls src={i.media_url} style={{ width: '100%' }} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
