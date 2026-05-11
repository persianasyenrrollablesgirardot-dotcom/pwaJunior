import { useEffect, useState } from 'react';
import { formatTs, confianzaColor, ambitoColor, ambitoLabel, type EventoPG, type Persona } from '../../lib/fakeData';
import { fetchLinajeEvento, fetchEventosHijos, fetchMensajesEvidencia, type MensajeExpandido } from '../../lib/queries';
import { useModo } from '../../lib/modo';

const ESTADO_COLOR: Record<string, string> = {
  NUEVO: '#ff9500', IDENTIFICADO: '#5856d6', EN_PROCESO: '#007aff',
  PROCESADO: '#34c759', AMBIGUO: '#ff3b30', ERROR: '#ff3b30',
};

interface Props { eventos: EventoPG[]; personas: Persona[]; }

export function EventoPGVista({ eventos, personas }: Props) {
  const [modo] = useModo();
  const [filtros, setFiltros] = useState({ estado: '', ambito: '', tipo_evento: '' });
  const [seleccionado, setSeleccionado] = useState<number | null>(null);

  const personaById = (id: number) => personas.find(p => p.id === id);

  const filtrados = eventos.filter(e => {
    if (filtros.estado && e.estado !== filtros.estado) return false;
    if (filtros.ambito && e.ambito !== filtros.ambito) return false;
    if (filtros.tipo_evento && e.tipo_evento !== filtros.tipo_evento) return false;
    return true;
  });

  // Estados únicos para el selector
  const estados = [...new Set(eventos.map(e => e.estado))];
  const ambitos = [...new Set(eventos.map(e => e.ambito))];
  const tipos = [...new Set(eventos.map(e => e.tipo_evento))];

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <div style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>EVENTO_PG · columna vertebral del sistema</h2>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
          Cada mensaje, inferencia o cambio de estado se registra como evento. Click en una fila para ver detalle + linaje completo.
        </div>
      </div>

      {/* Filtros */}
      {eventos.length > 0 && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>Filtros:</span>
          <select value={filtros.estado} onChange={e => setFiltros({...filtros, estado: e.target.value})} style={selStyle}>
            <option value="">Todos los estados</option>
            {estados.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filtros.ambito} onChange={e => setFiltros({...filtros, ambito: e.target.value})} style={selStyle}>
            <option value="">Todos los ámbitos</option>
            {ambitos.map(a => <option key={a} value={a}>{ambitoLabel(a)}</option>)}
          </select>
          <select value={filtros.tipo_evento} onChange={e => setFiltros({...filtros, tipo_evento: e.target.value})} style={selStyle}>
            <option value="">Todos los tipos</option>
            {tipos.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{filtrados.length} de {eventos.length}</span>
        </div>
      )}

      {filtrados.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          {eventos.length === 0 ? 'Sin eventos. Aparecen automáticamente cuando llega un mensaje por la extensión.' : 'Ningún evento con estos filtros.'}
        </div>
      ) : (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-page)', textAlign: 'left' }}>
                <th style={th}>#</th>
                <th style={th}>Tipo</th>
                <th style={th}>Estado</th>
                <th style={th}>Ámbito</th>
                <th style={th}>Persona</th>
                <th style={th}>Resumen</th>
                <th style={th}>Agente</th>
                <th style={th}>Confianza</th>
                <th style={th}>Prio</th>
                <th style={th}>TS</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map(e => {
                const persona = e.persona_id ? personaById(e.persona_id) : null;
                return (
                  <tr key={e.id} onClick={() => setSeleccionado(e.id)} style={{ borderTop: '1px solid var(--border-soft)', cursor: 'pointer' }}>
                    <td style={td}><code style={{ fontSize: 11, color: 'var(--text-muted)' }}>{e.id}</code></td>
                    <td style={td}><span style={{ fontWeight: 500 }}>{e.tipo_evento.replace('_', ' ')}</span></td>
                    <td style={td}>
                      <span style={{ fontSize: 10, fontWeight: 700, color: ESTADO_COLOR[e.estado], textTransform: 'uppercase' }}>{e.estado}</span>
                    </td>
                    <td style={td}><span style={{ fontSize: 10, color: ambitoColor(e.ambito), fontWeight: 600 }}>{ambitoLabel(e.ambito)}</span></td>
                    <td style={td}>{persona?.nombre ?? '—'}</td>
                    <td style={{ ...td, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.payload_resumen}</td>
                    <td style={td}>{e.agente_origen ?? <span style={{ color: 'var(--text-muted)' }}>adapter</span>}</td>
                    <td style={td}>
                      {e.confianza && <span style={{ fontSize: 10, fontWeight: 700, color: confianzaColor(e.confianza) }}>{e.confianza}</span>}
                    </td>
                    <td style={td}>
                      <span style={{ display: 'inline-block', minWidth: 18, textAlign: 'center', fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: e.prioridad <= 2 ? '#ffe5e5' : 'var(--bg-page)', color: e.prioridad <= 2 ? 'var(--red)' : 'var(--text-muted)' }}>{e.prioridad}</span>
                    </td>
                    <td style={{ ...td, fontSize: 11, color: 'var(--text-muted)' }}>{formatTs(e.ts_canal)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {seleccionado != null && (
        <ModalDetalleEvento eventoId={seleccionado} modo={modo} onClose={() => setSeleccionado(null)} />
      )}
    </div>
  );
}

function ModalDetalleEvento({ eventoId, modo, onClose }: { eventoId: number; modo: 'real' | 'demo'; onClose: () => void }) {
  const [linaje, setLinaje] = useState<any[]>([]);
  const [hijos, setHijos] = useState<any[]>([]);
  const [mensajes, setMensajes] = useState<MensajeExpandido[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (modo === 'demo') {
      setLinaje([{ id: eventoId, tipo_evento: 'mensaje_entrante', estado: 'PROCESADO', payload: { preview: 'Demo: cargá modo Real para ver linaje' } }]);
      setCargando(false);
      return;
    }
    Promise.all([fetchLinajeEvento(eventoId), fetchEventosHijos(eventoId)])
      .then(async ([l, h]) => {
        setLinaje(l); setHijos(h);
        // Cargar mensajes citados por evidencia_ids del evento ACTUAL (no de todo el linaje)
        const eventoActual = l.find((e: any) => e.id === eventoId);
        const msgIds: string[] = eventoActual?.evidencia_ids?.msg_ids ?? [];
        if (msgIds.length > 0) {
          const expanded = await fetchMensajesEvidencia(msgIds);
          setMensajes(expanded);
        }
      })
      .catch(() => {})
      .finally(() => setCargando(false));
  }, [eventoId, modo]);

  return (
    <div onClick={onClose} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 12, padding: 24, maxWidth: 720, width: '90%', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.2)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700 }}>Evento #{eventoId} · linaje</h2>
            <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
              Cómo nació este evento (raíz → hoja). Cada flecha muestra `evento_padre_id`.
            </p>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        {cargando && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Cargando linaje…</div>}

        {!cargando && linaje.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 8 }}>
              Linaje ascendente ({linaje.length} {linaje.length === 1 ? 'evento' : 'eventos'})
            </div>
            <div style={{ position: 'relative', paddingLeft: 24 }}>
              <div style={{ position: 'absolute', left: 7, top: 6, bottom: 6, width: 2, background: 'var(--border-soft)' }} />
              {linaje.map((e, idx) => (
                <NodoEvento key={e.id} evt={e} esRaiz={idx === 0} esHoja={idx === linaje.length - 1 && hijos.length === 0} esActual={e.id === eventoId} />
              ))}
            </div>

            {hijos.length > 0 && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginTop: 16, marginBottom: 8 }}>
                  Eventos hijos ({hijos.length})
                </div>
                <div style={{ position: 'relative', paddingLeft: 24 }}>
                  <div style={{ position: 'absolute', left: 7, top: 6, bottom: 6, width: 2, background: 'var(--border-soft)' }} />
                  {hijos.map(h => <NodoEvento key={h.id} evt={h} esHijo />)}
                </div>
              </>
            )}
          </>
        )}

        {!cargando && linaje.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Evento no encontrado.</div>
        )}

        {/* F1.21: mensajes citados expandidos — texto completo + transcripción IA sin truncar */}
        {!cargando && mensajes.length > 0 && (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginTop: 16, marginBottom: 8 }}>
              Mensajes citados ({mensajes.length}) — contenido completo
            </div>
            {mensajes.map(m => (
              <div key={m.id} style={{ background: m.direccion === 'saliente' ? '#dcf8c6' : '#f5f5f7', borderRadius: 8, padding: 12, marginBottom: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
                  <code style={{ fontSize: 10 }}>#{m.id}</code>
                  <span style={{ fontWeight: 600, textTransform: 'uppercase' }}>{m.tipo}</span>
                  <span>{m.direccion === 'saliente' ? '→ saliente' : '← entrante'}</span>
                  {m.ai_kind && (
                    <span style={{ fontSize: 9, padding: '1px 6px', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 4, fontWeight: 600 }}>
                      IA · {m.ai_kind}
                    </span>
                  )}
                  {m.download_status === 'lost' && (
                    <span style={{ fontSize: 9, padding: '1px 6px', background: '#f4f4f5', color: '#52525b', borderRadius: 4, fontWeight: 600 }}>
                      💀 CDN expiró
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 10 }}>
                    {new Date(m.ts_canal).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                {/* Texto formateado guardado (incluye prefijo 🎤 / 🖼 / 📎 si fue transcrito) */}
                {m.texto && (
                  <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {m.texto}
                  </div>
                )}
                {/* Transcripción IA cruda expandida (sin prefijo, sin truncar) */}
                {m.ai_text && m.ai_text !== m.texto && (
                  <details style={{ marginTop: 8 }}>
                    <summary style={{ fontSize: 10, color: 'var(--text-muted)', cursor: 'pointer', fontWeight: 600 }}>
                      Ver transcripción IA cruda ({m.ai_text.length} chars)
                    </summary>
                    <div style={{ marginTop: 6, padding: 8, background: 'rgba(255,255,255,0.6)', borderRadius: 6, fontSize: 12, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                      {m.ai_text}
                    </div>
                  </details>
                )}
                {!m.texto && !m.ai_text && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>(sin texto)</div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

function NodoEvento({ evt, esRaiz, esHoja, esActual, esHijo }: { evt: any; esRaiz?: boolean; esHoja?: boolean; esActual?: boolean; esHijo?: boolean }) {
  const color = confianzaColor(evt.confianza);
  return (
    <div style={{ position: 'relative', marginBottom: 12 }}>
      <div style={{
        position: 'absolute', left: -22, top: 4, width: 16, height: 16,
        borderRadius: '50%', background: color, border: '3px solid var(--bg-page)',
      }} />
      <div style={{
        background: esActual ? 'var(--accent-soft)' : 'var(--bg-page)',
        border: esActual ? '1px solid var(--accent)' : '1px solid var(--border-soft)',
        borderRadius: 8, padding: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
          <code style={{ fontSize: 10, color: 'var(--text-muted)' }}>#{evt.id}</code>
          <span style={{ fontWeight: 600 }}>{evt.tipo_evento}</span>
          {evt.agente_origen && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>via {evt.agente_origen}</span>}
          {evt.estado && <span style={{ fontSize: 10, fontWeight: 700, color: ESTADO_COLOR[evt.estado], textTransform: 'uppercase' }}>{evt.estado}</span>}
          {evt.confianza && <span style={{ fontSize: 10, fontWeight: 700, color }}>{evt.confianza}</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {esRaiz && <span style={{ fontSize: 9, padding: '1px 6px', background: '#fef3c7', color: '#92400e', borderRadius: 4, fontWeight: 600 }}>RAÍZ</span>}
            {esActual && <span style={{ fontSize: 9, padding: '1px 6px', background: 'var(--accent)', color: 'white', borderRadius: 4, fontWeight: 600 }}>ACTUAL</span>}
            {esHoja && <span style={{ fontSize: 9, padding: '1px 6px', background: '#dcfce7', color: '#166534', borderRadius: 4, fontWeight: 600 }}>HOJA</span>}
            {esHijo && <span style={{ fontSize: 9, padding: '1px 6px', background: '#dbeafe', color: '#1e40af', borderRadius: 4, fontWeight: 600 }}>HIJO</span>}
          </span>
        </div>
        {evt.payload?.preview && (
          <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text)' }}>{evt.payload.preview}</div>
        )}
        <details style={{ marginTop: 6 }}>
          <summary style={{ fontSize: 10, color: 'var(--text-muted)', cursor: 'pointer' }}>ver payload completo</summary>
          <pre style={{ margin: '4px 0 0', fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>
            {JSON.stringify(evt.payload, null, 2)}
          </pre>
        </details>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: '10px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 };
const td: React.CSSProperties = { padding: '10px 12px', verticalAlign: 'middle' };
const selStyle: React.CSSProperties = { padding: '5px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'white' };
