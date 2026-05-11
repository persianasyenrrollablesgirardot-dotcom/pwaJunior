/**
 * 6.3 Satisfacción post-instalación — quick-action por estado del cliente.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchSatisfaccionPorPersona, crearSatisfaccion, fetchInstalacionesPorPersona,
  type SatisfaccionPostventa, type EstadoSatisfaccion, type Instalacion,
} from '../../lib/queries';

const ESTADOS: { codigo: EstadoSatisfaccion; label: string; icon: string; color: string }[] = [
  { codigo: 'feliz',            label: 'Feliz',            icon: '😊', color: '#34c759' },
  { codigo: 'confundido',       label: 'Confundido',       icon: '🤔', color: '#ff9500' },
  { codigo: 'molesto',          label: 'Molesto',          icon: '😠', color: '#ff3b30' },
  { codigo: 'sin_respuesta',    label: 'Sin respuesta',    icon: '🔇', color: '#8e8e93' },
  { codigo: 'pendiente_ajuste', label: 'Pendiente ajuste', icon: '🔧', color: '#5856d6' },
];
const ESTADO_BY = Object.fromEntries(ESTADOS.map(e => [e.codigo, e]));

const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Satisfaccion() {
  const ctx = useContextoActivo();
  const [items, setItems] = useState<SatisfaccionPostventa[]>([]);
  const [instalaciones, setInstalaciones] = useState<Instalacion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [registrando, setRegistrando] = useState<EstadoSatisfaccion | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true);
    try {
      const [s, i] = await Promise.all([
        fetchSatisfaccionPorPersona(ctx.personaActivaId),
        fetchInstalacionesPorPersona(ctx.personaActivaId),
      ]);
      setItems(s); setInstalaciones(i);
    } catch { /* noop */ }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  function fb(tipo: 'ok' | 'err', msg: string) { setFeedback({ tipo, msg }); setTimeout(() => setFeedback(null), 3000); }

  const ultimo = items[0];

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Satisfacción de {ctx.personaActivaNombre}
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Click en un estado para registrar cómo está el cliente hoy. Instalación terminada ≠ cliente satisfecho.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      {ultimo && (
        <div style={{ background: 'var(--bg-panel)', border: `2px solid ${ESTADO_BY[ultimo.estado_cliente].color}`, borderRadius: 8, padding: 14, marginBottom: 20 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.4, marginBottom: 4 }}>
            Estado actual
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 32 }}>{ESTADO_BY[ultimo.estado_cliente].icon}</span>
            <div>
              <strong style={{ fontSize: 18, color: ESTADO_BY[ultimo.estado_cliente].color }}>
                {ESTADO_BY[ultimo.estado_cliente].label}
              </strong>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {fmtFecha(ultimo.fecha_check)}{ultimo.fuente && ` · ${ultimo.fuente}`}
              </div>
              {ultimo.notas && <div style={{ fontSize: 12, marginTop: 4 }}>{ultimo.notas}</div>}
            </div>
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>
        Registrar estado nuevo
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8, marginBottom: 24 }}>
        {ESTADOS.map(e => (
          <button key={e.codigo} onClick={() => setRegistrando(e.codigo)} style={{
            background: 'var(--bg-panel)', border: `1px solid ${e.color}`, borderRadius: 8,
            padding: 12, cursor: 'pointer', textAlign: 'left',
          }}>
            <div style={{ fontSize: 24, marginBottom: 4 }}>{e.icon}</div>
            <strong style={{ color: e.color, fontSize: 13 }}>{e.label}</strong>
          </button>
        ))}
      </div>

      <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>
        Historial ({items.length})
      </h3>
      {cargando ? <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Cargando…</div> : items.length === 0 ? (
        <div style={{ padding: 20, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin checks de satisfacción registrados.
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {items.map(s => {
            const e = ESTADO_BY[s.estado_cliente];
            return (
              <div key={s.id} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 20 }}>{e.icon}</span>
                <div style={{ flex: 1 }}>
                  <div><strong style={{ color: e.color }}>{e.label}</strong> <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· {fmtFecha(s.fecha_check)}{s.fuente && ` · ${s.fuente}`}</span></div>
                  {s.notas && <div style={{ fontSize: 12, color: 'var(--text)' }}>{s.notas}</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {registrando && (
        <ModalSatisfaccion
          estado={registrando}
          instalaciones={instalaciones}
          personaId={ctx.personaActivaId!}
          onClose={() => setRegistrando(null)}
          onDone={async () => { setRegistrando(null); await recargar(); fb('ok', `Estado "${ESTADO_BY[registrando].label}" registrado`); }}
          onError={(msg) => fb('err', msg)}
        />
      )}
    </div>
  );
}

function ModalSatisfaccion({ estado, instalaciones, personaId, onClose, onDone, onError }: {
  estado: EstadoSatisfaccion;
  instalaciones: Instalacion[];
  personaId: number;
  onClose: () => void;
  onDone: () => void;
  onError: (msg: string) => void;
}) {
  const [fuente, setFuente] = useState<string>('whatsapp');
  const [notas, setNotas] = useState('');
  const [instId, setInstId] = useState<number | null>(instalaciones[0]?.id ?? null);
  const e = ESTADO_BY[estado];

  async function guardar() {
    try {
      await crearSatisfaccion({
        persona_id: personaId,
        instalacion_id: instId,
        estado_cliente: estado,
        fuente,
        notas: notas || null,
      });
      onDone();
    } catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={ev => ev.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <span style={{ fontSize: 32 }}>{e.icon}</span>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: e.color }}>
            Cliente {e.label}
          </h2>
        </div>

        <Field label="Fuente">
          <select value={fuente} onChange={ev => setFuente(ev.target.value)} style={inp}>
            <option value="whatsapp">WhatsApp</option>
            <option value="llamada">Llamada</option>
            <option value="visita">Visita</option>
            <option value="web">Web / formulario</option>
            <option value="inferido">Inferido (no me dijo directo)</option>
          </select>
        </Field>

        <Field label="Instalación asociada">
          <select value={instId ?? ''} onChange={ev => setInstId(ev.target.value ? Number(ev.target.value) : null)} style={inp}>
            <option value="">—</option>
            {instalaciones.map(i => <option key={i.id} value={i.id}>{i.fecha_programada}{i.instalador && ` · ${i.instalador}`}</option>)}
          </select>
        </Field>

        <Field label="Notas">
          <textarea rows={3} value={notas} onChange={ev => setNotas(ev.target.value)}
            placeholder='ej. "Le encantó cómo quedó la sala, pero ya pidió cotización para los dormitorios."' style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={btnSec}>Cancelar</button>
          <button onClick={guardar} style={btnPrim}>✓ Registrar</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      {children}
    </label>
  );
}
const inp: React.CSSProperties = { padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'white', outline: 'none' };
const btnPrim: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' };
const btnSec: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalBox: React.CSSProperties = { background: 'white', borderRadius: 10, padding: 24, width: '90%', maxWidth: 540, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
