/**
 * 7.2 Evidencia por evento — eventos_pg del cliente con su evidencia adjunta.
 *
 * Usa evento_pg.evidencia_ids = [{ msg_ids: [...] }] que se llena en F1.21.
 * Resuelve cada msg_id contra mensajes para mostrar el texto/media.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { supabase } from '../../lib/supabase';

interface EventoConEvidencia {
  id: number;
  tipo_evento: string;
  ts_canal: string;
  payload: any;
  evidencia_ids: any;
  mensajes: { id: number; texto: string | null; tipo: string; media_url: string | null }[];
}

const fmtFecha = (s: string) => new Date(s).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function EvidenciaEventos() {
  const ctx = useContextoActivo();
  const [eventos, setEventos] = useState<EventoConEvidencia[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    (async () => {
      try {
        // Eventos del chat del cliente (vía proyecto)
        const { data: chats } = await supabase.from('chats')
          .select('id, proyecto_id, proyectos!inner(persona_id)')
          .eq('proyectos.persona_id', ctx.personaActivaId);
        const chatIds = (chats ?? []).map((c: any) => c.id);
        if (chatIds.length === 0) { setEventos([]); setCargando(false); return; }

        const { data: evts, error: e1 } = await supabase.from('evento_pg')
          .select('id, tipo_evento, ts_canal, payload, evidencia_ids, chat_id')
          .in('chat_id', chatIds)
          .not('evidencia_ids', 'is', null)
          .is('deleted_at', null)
          .order('ts_canal', { ascending: false })
          .limit(150);
        if (e1) throw e1;

        // Resolver msg_ids de cada evento
        const allMsgIds = new Set<number>();
        for (const e of evts ?? []) {
          const ids = e.evidencia_ids?.msg_ids ?? [];
          for (const id of ids) if (typeof id === 'number') allMsgIds.add(id);
        }

        let mensajesPorId: Record<number, any> = {};
        if (allMsgIds.size > 0) {
          const { data: msgs } = await supabase.from('mensajes')
            .select('id, texto, tipo, media_url')
            .in('id', [...allMsgIds]);
          for (const m of msgs ?? []) mensajesPorId[m.id] = m;
        }

        setEventos((evts ?? []).map((e: any) => ({
          id: e.id, tipo_evento: e.tipo_evento, ts_canal: e.ts_canal,
          payload: e.payload, evidencia_ids: e.evidencia_ids,
          mensajes: (e.evidencia_ids?.msg_ids ?? []).map((id: number) => mensajesPorId[id]).filter(Boolean),
        })));
      } catch (e: any) { setError(e.message); }
      finally { setCargando(false); }
    })();
  }, [ctx.personaActivaId]);

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Eventos con evidencia — {ctx.personaActivaNombre} ({eventos.length})
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Cada evento del sistema apunta a los mensajes WhatsApp que lo originaron. Sirve para auditar inferencias.
      </p>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && eventos.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin eventos con evidencia para {ctx.personaActivaNombre}.
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {eventos.map(e => (
          <div key={e.id} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <strong style={{ fontSize: 13, color: 'var(--accent)' }}>{e.tipo_evento}</strong>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtFecha(e.ts_canal)}</span>
            </div>
            {e.payload?.preview && (
              <div style={{ fontSize: 12, marginBottom: 8 }}>{e.payload.preview}</div>
            )}

            {e.mensajes.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 8, marginTop: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                  📎 Evidencia ({e.mensajes.length} mensaje{e.mensajes.length > 1 ? 's' : ''})
                </div>
                {e.mensajes.map(m => (
                  <div key={m.id} style={{ fontSize: 11, color: 'var(--text)', padding: '4px 0', borderBottom: '1px solid var(--border-soft)' }}>
                    <span style={{ display: 'inline-block', padding: '1px 6px', fontSize: 9, background: 'var(--bg-page)', borderRadius: 3, marginRight: 6, fontWeight: 600 }}>
                      {m.tipo}
                    </span>
                    {m.texto ? m.texto.slice(0, 200) : <em style={{ color: 'var(--text-muted)' }}>(sin texto)</em>}
                    {m.media_url && <a href={m.media_url} target="_blank" rel="noreferrer" style={{ marginLeft: 8, color: 'var(--accent)', fontSize: 10 }}>↗</a>}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
