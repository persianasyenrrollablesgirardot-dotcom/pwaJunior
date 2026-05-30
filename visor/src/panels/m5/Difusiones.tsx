/**
 * 5.7 Difusiones — chats tipo 'difusion' (mensajes broadcast del propio Jhon
 * a múltiples destinatarios). Detectado al analizar la LevelDB: hay un chat
 * status@broadcast con actividad significativa que hoy se ignora.
 *
 * Vista global: lista chats con tipo='difusion' + plantillas de respuesta
 * disponibles para usar de base.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { fetchPlantillasRespuesta, type PlantillaRespuesta } from '../../lib/queries';

interface ChatDifusion {
  id: number;
  titulo: string | null;
  canal_chat_id: string | null;
  ambito: string;
  created_at: string;
}

const fmtFecha = (s: string) => new Date(s).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });

export function Difusiones() {
  const [chats, setChats] = useState<ChatDifusion[]>([]);
  const [plantillas, setPlantillas] = useState<PlantillaRespuesta[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [{ data: chatsData }, plant] = await Promise.all([
          supabase.from('chats')
            .select('id, titulo, canal_chat_id, ambito, created_at')
            .eq('tipo', 'difusion')
            .is('deleted_at', null)
            .order('created_at', { ascending: false }),
          fetchPlantillasRespuesta(),
        ]);
        setChats((chatsData ?? []) as ChatDifusion[]);
        setPlantillas(plant);
      } catch (e: any) { setError(e.message); }
      finally { setCargando(false); }
    })();
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Difusiones (broadcast WhatsApp)</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Chats de difusión + biblioteca de plantillas para respuestas automáticas.
        Detectado en captura: <strong>status@broadcast</strong> es uno de los chats con más actividad
        y hasta ahora se ignoraba.
      </p>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {/* Chats de difusión */}
      <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>
        Chats de difusión ({chats.length})
      </h3>
      {chats.length === 0 ? (
        <div style={{ padding: 20, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', marginBottom: 24 }}>
          Sin chats de difusión procesados todavía. Cuando proceses uno desde Captura, aparece acá.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 8, marginBottom: 24 }}>
          {chats.map(c => (
            <div key={c.id} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <strong style={{ fontSize: 13 }}>📢 {c.titulo ?? c.canal_chat_id ?? '(sin título)'}</strong>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtFecha(c.created_at)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{c.canal_chat_id}</div>
            </div>
          ))}
        </div>
      )}

      {/* Plantillas de respuesta */}
      <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>
        Biblioteca de plantillas ({plantillas.length})
      </h3>
      <p style={{ margin: '0 0 12px', fontSize: 11, color: 'var(--text-muted)' }}>
        Auto-respuestas pre-definidas. El agente IA (futuro) puede sugerir cuál usar según el contexto del mensaje entrante.
      </p>
      <div style={{ display: 'grid', gap: 8 }}>
        {plantillas.map(p => (
          <div key={p.id} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <strong style={{ fontSize: 13 }}>{p.codigo}</strong>
              <span style={{ fontSize: 10, padding: '2px 8px', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                {p.tipo}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 6 }}>{p.texto}</div>
            {(p.variables ?? []).length > 0 && (
              <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                Variables: {p.variables!.map(v => `{${v}}`).join(', ')}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
