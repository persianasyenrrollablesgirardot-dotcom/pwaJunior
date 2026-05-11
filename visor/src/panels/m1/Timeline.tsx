import { useState, useEffect } from 'react';
import { formatTs, confianzaColor, type EventoPG, type Proyecto, type Persona } from '../../lib/fakeData';

const TIPO_ICONO: Record<string, string> = {
  mensaje_entrante: '📩',
  mensaje_saliente: '📤',
  inferencia: '🧠',
  medida: '📐',
  tarea: '✓',
  pago: '💰',
  cambio_estado: '🔄',
  garantia: '🛡',
  alerta: '⚠',
};

interface Props {
  eventos: EventoPG[];
  proyectos: Proyecto[];
  personas: Persona[];
}

export function Timeline({ eventos, proyectos, personas }: Props) {
  const [proyectoId, setProyectoId] = useState<number | null>(proyectos[0]?.id ?? null);

  useEffect(() => {
    if (proyectos.length > 0 && !proyectos.find(p => p.id === proyectoId)) {
      setProyectoId(proyectos[0].id);
    }
  }, [proyectos, proyectoId]);

  if (proyectos.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        Sin proyectos para mostrar timeline.
      </div>
    );
  }

  const proyecto = proyectos.find(p => p.id === proyectoId);
  const persona = proyecto ? personas.find(p => p.id === proyecto.persona_id) : null;
  const evtsDelProyecto = eventos.filter(e => e.proyecto_id === proyectoId);

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Timeline · {proyecto?.nombre ?? '?'}</h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
            {persona?.nombre ?? '—'} · línea de tiempo cronológica
          </div>
        </div>
        <select value={proyectoId ?? ''} onChange={e => setProyectoId(Number(e.target.value))} style={{ padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
          {proyectos.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </div>

      {evtsDelProyecto.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          Sin eventos para este proyecto todavía.
        </div>
      ) : (
        <div style={{ position: 'relative', paddingLeft: 24 }}>
          <div style={{ position: 'absolute', left: 7, top: 6, bottom: 6, width: 2, background: 'var(--border-soft)' }} />
          {evtsDelProyecto.map((e) => (
            <div key={e.id} style={{ position: 'relative', marginBottom: 16 }}>
              <div style={{
                position: 'absolute',
                left: -22,
                top: 4,
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: confianzaColor(e.confianza),
                border: '3px solid var(--bg-page)',
              }} />
              <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 14 }}>{TIPO_ICONO[e.tipo_evento] ?? '•'}</span>
                  <span style={{ fontSize: 12, fontWeight: 600 }}>{e.tipo_evento.replace('_', ' ')}</span>
                  {e.agente_origen && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>via {e.agente_origen}</span>
                  )}
                  {e.confianza && (
                    <span style={{
                      fontSize: 10,
                      fontWeight: 600,
                      color: confianzaColor(e.confianza),
                      border: `1px solid ${confianzaColor(e.confianza)}`,
                      padding: '1px 6px',
                      borderRadius: 8,
                    }}>
                      {e.confianza}
                    </span>
                  )}
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{formatTs(e.ts_canal)}</span>
                </div>
                <div style={{ fontSize: 13 }}>{e.payload_resumen}</div>
                {e.evidencia_msg_ids.length > 0 && (
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6 }}>
                    Evidencia: {e.evidencia_msg_ids.map(id => `msg #${id}`).join(', ')}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
