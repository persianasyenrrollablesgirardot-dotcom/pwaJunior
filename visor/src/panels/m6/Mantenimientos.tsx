/**
 * 6.2 Mantenimientos — registro de servicios post-instalación.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchMantenimientosPorPersona, crearMantenimiento, actualizarMantenimiento, eliminarMantenimiento,
  fetchCotizacionesPorPersona,
  TIPOS_MANTENIMIENTO, type TipoMantenimiento, type ResultadoMantenimiento,
  type Mantenimiento, type Cotizacion,
} from '../../lib/queries';

const TIPO_LABEL: Record<TipoMantenimiento, string> = {
  lavado: 'Lavado',
  perfilado: 'Perfilado',
  cambio_cadenilla: 'Cambio cadenilla',
  cambio_control: 'Cambio control',
  cambio_tubo: 'Cambio tubo',
  nivelacion: 'Nivelación',
  ajuste_soporte: 'Ajuste de soporte',
  cambio_peso_inferior: 'Cambio peso inferior',
  otro: 'Otro',
};
const RESULTADO_COLOR: Record<ResultadoMantenimiento, string> = {
  completo: 'var(--green)', parcial: 'var(--orange)', no_aplicable: 'var(--text-muted)',
  pendiente_repuesto: 'var(--orange)', reagendado: 'var(--accent)',
};

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Mantenimientos() {
  const ctx = useContextoActivo();
  const [items, setItems] = useState<Mantenimiento[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Mantenimiento | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try {
      const [m, c] = await Promise.all([
        fetchMantenimientosPorPersona(ctx.personaActivaId),
        fetchCotizacionesPorPersona(ctx.personaActivaId),
      ]);
      setItems(m); setCotizaciones(c);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  function fb(tipo: 'ok' | 'err', msg: string) { setFeedback({ tipo, msg }); setTimeout(() => setFeedback(null), 3000); }

  const stats = {
    total: items.length,
    pendientes: items.filter(m => !m.resultado).length,
    completos: items.filter(m => m.resultado === 'completo').length,
    monto_total: items.reduce((s, m) => s + Number(m.costo ?? 0), 0),
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Mantenimientos de {ctx.personaActivaNombre} ({stats.total})
        </h2>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Registrar mantenimiento</button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Lavado, perfilado, cambios de partes, ajustes. Mantenimiento es recompra operativa.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="⏳ Pendientes"   valor={stats.pendientes} color="var(--orange)" />
        <KPI label="✓ Completos"     valor={stats.completos}  color="var(--green)" />
        <KPI label="$ Monto total"   valor={fmtCop(stats.monto_total)} color="var(--text)" />
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && items.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin mantenimientos registrados todavía.
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {items.map(m => (
          <button key={m.id} onClick={() => setEditando(m)} style={{
            width: '100%', textAlign: 'left', background: 'var(--bg-panel)',
            border: `1px solid ${m.resultado ? RESULTADO_COLOR[m.resultado] : 'var(--border-soft)'}`,
            borderRadius: 8, padding: 12, cursor: 'pointer',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <strong style={{ fontSize: 13 }}>{TIPO_LABEL[m.tipo]}</strong>
              <span style={{ fontSize: 11, color: m.resultado ? RESULTADO_COLOR[m.resultado] : 'var(--text-muted)', fontWeight: 600 }}>
                {m.resultado ? m.resultado.replace(/_/g, ' ') : 'sin resultado'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)' }}>
              {m.fecha_programada && <span>📅 {fmtFecha(m.fecha_programada)}</span>}
              {m.fecha_real && <span>✓ Real: {fmtFecha(m.fecha_real)}</span>}
              {m.instalador && <span>👷 {m.instalador}</span>}
              {Number(m.costo) > 0 && <span>💰 {fmtCop(Number(m.costo))}</span>}
            </div>
            {m.notas && <div style={{ fontSize: 12, marginTop: 4 }}>{m.notas}</div>}
          </button>
        ))}
      </div>

      {(editando || creando) && (
        <ModalMantenimiento
          mant={editando}
          cotizaciones={cotizaciones}
          personaId={ctx.personaActivaId!}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await recargar(); fb('ok', msg); }}
          onError={(msg) => fb('err', msg)}
        />
      )}
    </div>
  );
}

function ModalMantenimiento({ mant, cotizaciones, personaId, onClose, onDone, onError }: {
  mant: Mantenimiento | null;
  cotizaciones: Cotizacion[];
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<Mantenimiento> = mant ?? {
    persona_id: personaId,
    cotizacion_id: cotizaciones[0]?.id ?? null,
    tipo: 'lavado',
    fecha_programada: new Date().toISOString().slice(0, 10),
    fecha_real: null,
    instalador: null,
    costo: 0,
    resultado: null,
    notas: null,
  };
  const [form, setForm] = useState<Partial<Mantenimiento>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    setAplicando(true);
    try {
      if (mant) {
        await actualizarMantenimiento(mant.id, form);
        onDone('Mantenimiento actualizado');
      } else {
        await crearMantenimiento({
          persona_id: personaId,
          cotizacion_id: form.cotizacion_id ?? null,
          tipo: form.tipo as TipoMantenimiento,
          fecha_programada: form.fecha_programada,
          fecha_real: form.fecha_real,
          instalador: form.instalador,
          costo: Number(form.costo ?? 0),
          resultado: form.resultado,
          notas: form.notas,
        });
        onDone('Mantenimiento registrado');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!mant) return;
    if (!confirm('¿Eliminar este mantenimiento?')) return;
    try { await eliminarMantenimiento(mant.id); onDone('Mantenimiento eliminado'); }
    catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {mant ? 'Editar mantenimiento' : 'Registrar mantenimiento'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 4 }}>
          <Field label="Tipo *">
            <select value={form.tipo ?? 'lavado'} onChange={e => setForm({ ...form, tipo: e.target.value as TipoMantenimiento })} style={inp}>
              {TIPOS_MANTENIMIENTO.map(t => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="Resultado">
            <select value={form.resultado ?? ''} onChange={e => setForm({ ...form, resultado: (e.target.value || null) as any })} style={inp}>
              <option value="">— Sin resultado aún —</option>
              <option value="completo">✓ Completo</option>
              <option value="parcial">⚠ Parcial</option>
              <option value="no_aplicable">— No aplicable</option>
              <option value="pendiente_repuesto">⏳ Pendiente repuesto</option>
              <option value="reagendado">→ Reagendado</option>
            </select>
          </Field>
          <Field label="Fecha programada">
            <input type="date" value={form.fecha_programada ?? ''} onChange={e => setForm({ ...form, fecha_programada: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Fecha real">
            <input type="date" value={form.fecha_real ?? ''} onChange={e => setForm({ ...form, fecha_real: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Instalador">
            <input value={form.instalador ?? ''} onChange={e => setForm({ ...form, instalador: e.target.value || null })} placeholder="Jhon, Pedro, etc." style={inp} />
          </Field>
          <Field label="Costo">
            <input type="number" min={0} value={form.costo ?? 0} onChange={e => setForm({ ...form, costo: Number(e.target.value) })} style={inp} />
          </Field>
          <Field label="Cotización asociada">
            <select value={form.cotizacion_id ?? ''} onChange={e => setForm({ ...form, cotizacion_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">—</option>
              {cotizaciones.map(c => <option key={c.id} value={c.id}>{c.numero_cotizacion ?? '#' + c.id}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Notas">
          <textarea rows={2} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })} style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {mant ? <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button> : <span />}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSec}>Cancelar</button>
            <button onClick={guardar} disabled={aplicando} style={{ ...btnPrim, opacity: aplicando ? 0.5 : 1 }}>
              {aplicando ? 'Guardando…' : '✓ Guardar'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function KPI({ label, valor, color }: { label: string; valor: number | string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 130 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{valor}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 4 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      {children}
    </label>
  );
}
const inp: React.CSSProperties = { padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'white', outline: 'none' };
const btnPrim: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' };
const btnSec: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' };
const btnDanger: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 600, background: 'white', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 6, cursor: 'pointer' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalBox: React.CSSProperties = { background: 'white', borderRadius: 10, padding: 24, width: '90%', maxWidth: 720, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
