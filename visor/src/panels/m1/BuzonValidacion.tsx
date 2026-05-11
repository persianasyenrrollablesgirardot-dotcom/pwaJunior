import { useState, useEffect } from 'react';
import { ambitoColor, ambitoLabel, confianzaColor, type ItemBuzon } from '../../lib/fakeData';
import { aprobarItemBuzon, rechazarItemBuzon, editarYAprobarItemBuzon } from '../../lib/queries';
import { useModo } from '../../lib/modo';

export function BuzonValidacion({ items }: { items: ItemBuzon[] }) {
  const [modo] = useModo();
  const [seleccionado, setSeleccionado] = useState<number | null>(items[0]?.id ?? null);
  const [accion, setAccion] = useState<{ tipo: 'rechazar' | 'editar'; item: ItemBuzon } | null>(null);
  const [aplicando, setAplicando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  useEffect(() => {
    if (items.length > 0 && !items.find(b => b.id === seleccionado)) {
      setSeleccionado(items[0].id);
    }
  }, [items, seleccionado]);

  if (items.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        Buzón vacío. Aquí aparecen las decisiones de los agentes que requieren tu validación humana.
      </div>
    );
  }

  const item = items.find(b => b.id === seleccionado);

  async function aprobar(it: ItemBuzon) {
    if (modo === 'demo') { setFeedback({ tipo: 'ok', msg: 'Aprobado (modo demo, no escribió en BD)' }); return; }
    setAplicando(true);
    try {
      await aprobarItemBuzon(it.id);
      setFeedback({ tipo: 'ok', msg: 'Aprobado y registrado en BD' });
      setTimeout(() => setFeedback(null), 3000);
    } catch (e: any) {
      setFeedback({ tipo: 'err', msg: e.message });
      setAplicando(false);
    }
  }

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      <div style={{ width: 360, borderRight: '1px solid var(--border-soft)', overflow: 'auto', background: 'var(--bg-panel)' }}>
        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600 }}>
            Pendientes ({items.length})
          </span>
        </div>
        {items.map(b => (
          <button
            key={b.id}
            onClick={() => setSeleccionado(b.id)}
            style={{
              width: '100%', textAlign: 'left',
              padding: '12px 16px',
              background: b.id === seleccionado ? 'var(--accent-soft)' : 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--border-soft)',
              borderLeft: `3px solid ${b.prioridad <= 2 ? 'var(--red)' : (b.prioridad <= 3 ? 'var(--orange)' : 'transparent')}`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: ambitoColor(b.ambito) }}>{ambitoLabel(b.ambito)}</span>
              <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>hace {b.horas_pendiente}h</span>
            </div>
            <div style={{ fontSize: 13, fontWeight: 500, marginTop: 4 }}>{b.persona_nombre}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{b.tipo_decision.replace('_', ' ')}</div>
            <div style={{ fontSize: 12, marginTop: 6, color: 'var(--text)' }}>
              {b.resumen.substring(0, 60)}{b.resumen.length > 60 ? '…' : ''}
            </div>
          </button>
        ))}
      </div>

      <div style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        {feedback && (
          <div style={{
            padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
            background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
            color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)',
          }}>
            {feedback.msg}
          </div>
        )}
        {item && (
          <Detalle
            item={item}
            aplicando={aplicando}
            onAprobar={() => aprobar(item)}
            onRechazar={() => setAccion({ tipo: 'rechazar', item })}
            onEditar={() => setAccion({ tipo: 'editar', item })}
          />
        )}
      </div>

      {accion?.tipo === 'rechazar' && (
        <ModalRechazar
          item={accion.item}
          onClose={() => setAccion(null)}
          modo={modo}
          onDone={(msg) => { setAccion(null); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={(msg) => { setAccion(null); setFeedback({ tipo: 'err', msg }); }}
        />
      )}
      {accion?.tipo === 'editar' && (
        <ModalEditar
          item={accion.item}
          onClose={() => setAccion(null)}
          modo={modo}
          onDone={(msg) => { setAccion(null); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={(msg) => { setAccion(null); setFeedback({ tipo: 'err', msg }); }}
        />
      )}
    </div>
  );
}

function Detalle({ item, aplicando, onAprobar, onRechazar, onEditar }: {
  item: ItemBuzon; aplicando: boolean;
  onAprobar: () => void; onRechazar: () => void; onEditar: () => void;
}) {
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 10, fontWeight: 700, color: ambitoColor(item.ambito), border: `1px solid ${ambitoColor(item.ambito)}`, padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase' }}>
              {ambitoLabel(item.ambito)}
            </span>
            <span style={{ fontSize: 10, fontWeight: 700, color: confianzaColor(item.confianza), border: `1px solid ${confianzaColor(item.confianza)}`, padding: '2px 8px', borderRadius: 10 }}>
              {item.confianza}
            </span>
            {item.prioridad <= 2 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: 'white', background: 'var(--red)', padding: '2px 8px', borderRadius: 10, textTransform: 'uppercase' }}>
                Crítico
              </span>
            )}
          </div>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>{item.persona_nombre}</h2>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{item.proyecto_nombre}</div>
        </div>
      </div>

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 8 }}>
          Decisión propuesta {item.agente_origen ? `por ${item.agente_origen}` : ''}
        </div>
        <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 12 }}>{item.resumen}</div>

        <div style={{ background: 'var(--bg-page)', padding: 12, borderRadius: 6, fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Detalle:</div>
          <pre style={{ margin: 0, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {JSON.stringify(item.detalle, null, 2)}
          </pre>
        </div>
      </div>

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 12 }}>
          ¿Por qué esta inferencia?
        </div>

        {item.evidencia_msg_ids.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Evidencia citada</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {item.evidencia_msg_ids.map(id => (
                <span key={id} style={{ fontSize: 11, padding: '2px 8px', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 6 }}>
                  msg #{id}
                </span>
              ))}
            </div>
          </div>
        )}

        {item.reglas_aplicadas.length > 0 && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Reglas aplicadas</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {item.reglas_aplicadas.map(r => (
                <span key={r} style={{ fontSize: 11, padding: '2px 8px', background: '#fff3cd', color: '#856404', borderRadius: 6, fontFamily: 'ui-monospace, monospace' }}>
                  {r}
                </span>
              ))}
            </div>
          </div>
        )}

        <div>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Confianza: <span style={{ color: confianzaColor(item.confianza) }}>{item.confianza}</span></div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {item.confianza === 'INFERIDO' && 'El agente lo dedujo del contexto, no es un dato confirmado por el cliente.'}
            {item.confianza === 'CONFIRMADO' && 'El cliente lo dijo explícitamente.'}
            {item.confianza === 'DUDOSO' && 'No hay evidencia clara, conviene preguntar al cliente.'}
            {item.confianza === 'ALERTA' && 'Hay contradicción con datos previos, requiere atención.'}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={onAprobar} disabled={aplicando} style={{ ...btnGrande, background: 'var(--green)', color: 'white' }}>✓ Aprobar</button>
        <button onClick={onEditar} disabled={aplicando} style={{ ...btnGrande, background: 'var(--bg-page)', border: '1px solid var(--border)', color: 'var(--text)' }}>Editar y aprobar</button>
        <button onClick={onRechazar} disabled={aplicando} style={{ ...btnGrande, background: 'white', border: '1px solid var(--red)', color: 'var(--red)' }}>✕ Rechazar</button>
      </div>
    </div>
  );
}

function ModalRechazar({ item, onClose, modo, onDone, onError }: {
  item: ItemBuzon; onClose: () => void; modo: 'real' | 'demo';
  onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [motivo, setMotivo] = useState('');
  const [aplicando, setAplicando] = useState(false);
  async function confirmar() {
    if (!motivo.trim()) return;
    setAplicando(true);
    try {
      if (modo === 'real') await rechazarItemBuzon(item.id, motivo.trim());
      onDone('Rechazado y registrado');
    } catch (e: any) {
      onError(e.message);
      setAplicando(false);   // F1.22: si falla, reabilitar botón
    }
  }
  return (
    <ModalBase onClose={onClose}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700 }}>Rechazar inferencia</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        El agente {item.agente_origen} propuso: <em>{item.resumen}</em>
      </p>
      <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>Motivo del rechazo:</label>
      <textarea
        value={motivo}
        onChange={e => setMotivo(e.target.value)}
        rows={3}
        placeholder="Ej: el cliente dijo lo contrario en otro mensaje, el agente no consideró el contexto..."
        style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit' }}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={confirmar} disabled={aplicando || !motivo.trim()} style={{ ...btnDanger, opacity: aplicando || !motivo.trim() ? 0.5 : 1 }}>
          {aplicando ? 'Aplicando…' : '✕ Rechazar'}
        </button>
      </div>
    </ModalBase>
  );
}

function ModalEditar({ item, onClose, modo, onDone, onError }: {
  item: ItemBuzon; onClose: () => void; modo: 'real' | 'demo';
  onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [edicion, setEdicion] = useState<string>(JSON.stringify(item.detalle, null, 2));
  const [motivo, setMotivo] = useState('');
  const [aplicando, setAplicando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmar() {
    if (!motivo.trim()) { setError('El motivo es obligatorio'); return; }
    let parsed: Record<string, any>;
    try { parsed = JSON.parse(edicion); }
    catch (e: any) { setError('JSON inválido: ' + e.message); return; }
    setAplicando(true);
    try {
      if (modo === 'real') await editarYAprobarItemBuzon(item.id, parsed, motivo.trim());
      onDone('Editado, aprobado y registrado en correcciones');
    } catch (e: any) {
      onError(e.message);
      setAplicando(false);   // F1.22: si falla, reabilitar botón
    }
  }

  return (
    <ModalBase onClose={onClose}>
      <h2 style={{ margin: '0 0 4px', fontSize: 17, fontWeight: 700 }}>Editar y aprobar</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Corrige los valores antes de aprobar. Los cambios se registran en <code>correcciones</code> — los agentes los respetarán en futuras inferencias.
      </p>
      {error && <div style={{ padding: 10, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>{error}</div>}

      <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 6 }}>Detalle (JSON editable):</label>
      <textarea
        value={edicion}
        onChange={e => setEdicion(e.target.value)}
        rows={10}
        style={{ width: '100%', padding: 10, fontSize: 11, border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'ui-monospace, monospace' }}
      />
      <label style={{ fontSize: 12, fontWeight: 600, display: 'block', marginTop: 12, marginBottom: 6 }}>Motivo de la edición:</label>
      <input
        type="text"
        value={motivo}
        onChange={e => setMotivo(e.target.value)}
        placeholder="Por qué corregís"
        style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6 }}
      />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={confirmar} disabled={aplicando || !motivo.trim()} style={{ ...btnPrim, opacity: aplicando || !motivo.trim() ? 0.5 : 1 }}>
          {aplicando ? 'Aplicando…' : '✓ Editar y aprobar'}
        </button>
      </div>
    </ModalBase>
  );
}

function ModalBase({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'white', borderRadius: 12, padding: 24,
        maxWidth: 560, width: '90%',
        boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
      }}>{children}</div>
    </div>
  );
}

const btnGrande: React.CSSProperties = { padding: '10px 18px', fontSize: 13, fontWeight: 600, border: 'none', borderRadius: 6 };
const btnPrim: React.CSSProperties = { padding: '8px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'white' };
const btnSec: React.CSSProperties = { padding: '8px 12px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' };
const btnDanger: React.CSSProperties = { padding: '8px 14px', fontSize: 12, fontWeight: 600, background: 'white', border: '1px solid var(--red)', borderRadius: 6, color: 'var(--red)' };
