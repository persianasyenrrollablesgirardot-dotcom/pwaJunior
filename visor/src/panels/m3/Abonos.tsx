/**
 * 3.2 Abonos — CRUD de abonos del cliente activo.
 *
 * Cada abono se asocia a una cotización (obligatorio para que el trigger SQL
 * recalcule el saldo). Estado de validación: pendiente → confirmado / rechazado /
 * inconsistente. Solo NO-rechazados cuentan para el saldo de la cotización.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchAbonosPorPersona, crearAbono, actualizarAbono, eliminarAbono,
  fetchCotizacionesPorPersona, fetchFacturasPorPersona,
  type Abono, type EstadoValidacionAbono, type Cotizacion, type Factura,
} from '../../lib/queries';

const ESTADOS: { codigo: EstadoValidacionAbono; label: string; color: string }[] = [
  { codigo: 'pendiente',     label: 'Pendiente',     color: '#ff9500' },
  { codigo: 'confirmado',    label: 'Confirmado',    color: '#34c759' },
  { codigo: 'rechazado',     label: 'Rechazado',     color: '#ff3b30' },
  { codigo: 'inconsistente', label: 'Inconsistente', color: '#5856d6' },
];
const ESTADO_LABEL = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.label]));
const ESTADO_COLOR = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.color]));

const METODOS = ['bancolombia', 'nequi', 'daviplata', 'efectivo', 'transferencia', 'otro'];

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Abonos() {
  const ctx = useContextoActivo();
  const [abonos, setAbonos] = useState<Abono[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Abono | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try {
      const [a, c, f] = await Promise.all([
        fetchAbonosPorPersona(ctx.personaActivaId),
        fetchCotizacionesPorPersona(ctx.personaActivaId),
        fetchFacturasPorPersona(ctx.personaActivaId),
      ]);
      setAbonos(a);
      setCotizaciones(c);
      setFacturas(f);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  const stats = {
    total: abonos.length,
    pendientes: abonos.filter(a => a.estado_validacion === 'pendiente').length,
    confirmados: abonos.filter(a => a.estado_validacion === 'confirmado').length,
    rechazados: abonos.filter(a => a.estado_validacion === 'rechazado').length,
    monto_confirmado: abonos.filter(a => a.estado_validacion === 'confirmado').reduce((s, a) => s + Number(a.monto), 0),
    monto_pendiente:  abonos.filter(a => a.estado_validacion === 'pendiente').reduce((s, a) => s + Number(a.monto), 0),
  };

  function mostrarFeedback(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 3000);
  }

  async function cambiarEstado(abono: Abono, nuevo: EstadoValidacionAbono) {
    try {
      await actualizarAbono(abono.id, { estado_validacion: nuevo });
      await recargar();
      mostrarFeedback('ok', `Abono marcado como "${ESTADO_LABEL[nuevo]}"`);
    } catch (e: any) { mostrarFeedback('err', e.message); }
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Abonos de {ctx.personaActivaNombre} ({stats.total})
        </h2>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Registrar abono</button>
      </div>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="⏳ Pendientes"        valor={stats.pendientes}  color="var(--orange)" />
        <KPI label="✓ Confirmados"        valor={stats.confirmados} color="var(--green)" />
        <KPI label="✗ Rechazados"         valor={stats.rechazados}  color="var(--red)" />
        <KPI label="$ Confirmado"         valor={fmtCop(stats.monto_confirmado)} color="var(--green)" />
        <KPI label="$ Pendiente valid."   valor={fmtCop(stats.monto_pendiente)}  color="var(--orange)" />
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && abonos.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13 }}>
          Sin abonos todavía para {ctx.personaActivaNombre}.<br />
          Click en <strong>"+ Registrar abono"</strong> para empezar.
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {abonos.map(a => (
          <CardAbono key={a.id} a={a} cotizaciones={cotizaciones} onClick={() => setEditando(a)} onChangeEstado={(nuevo) => cambiarEstado(a, nuevo)} />
        ))}
      </div>

      {(editando || creando) && (
        <ModalAbono
          abono={editando}
          cotizaciones={cotizaciones}
          facturas={facturas}
          personaId={ctx.personaActivaId!}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await recargar(); mostrarFeedback('ok', msg); }}
          onError={(msg) => mostrarFeedback('err', msg)}
        />
      )}
    </div>
  );
}

function CardAbono({ a, cotizaciones, onClick, onChangeEstado }: {
  a: Abono;
  cotizaciones: Cotizacion[];
  onClick: () => void;
  onChangeEstado: (nuevo: EstadoValidacionAbono) => void;
}) {
  const cot = a.cotizacion_id ? cotizaciones.find(c => c.id === a.cotizacion_id) : null;
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: `1px solid ${a.estado_validacion === 'confirmado' ? 'var(--green)' : a.estado_validacion === 'rechazado' ? 'var(--red)' : 'var(--border-soft)'}`,
      borderRadius: 8, padding: 14,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <button onClick={onClick} style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 0, textAlign: 'left' }}>
          <strong style={{ fontSize: 15 }}>{fmtCop(Number(a.monto))}</strong>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 10 }}>
            {fmtFecha(a.fecha)} · {a.metodo ?? '—'}
          </span>
        </button>
        <span style={{ fontSize: 10, fontWeight: 700, color: ESTADO_COLOR[a.estado_validacion], textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {ESTADO_LABEL[a.estado_validacion]}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        {cot && <span>📋 {cot.numero_cotizacion ?? '#' + cot.id} ({cot.estado})</span>}
        {a.referencia && <span><strong>Ref:</strong> {a.referencia}</span>}
        {a.cuenta_receptora && <span><strong>Cuenta:</strong> {a.cuenta_receptora}</span>}
      </div>

      {a.notas && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8, lineHeight: 1.4, fontStyle: 'italic' }}>
          {a.notas}
        </div>
      )}

      {a.estado_validacion === 'pendiente' && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => onChangeEstado('confirmado')} style={miniBtnOk}>✓ Confirmar</button>
          <button onClick={() => onChangeEstado('rechazado')} style={miniBtnDanger}>✗ Rechazar</button>
          <button onClick={() => onChangeEstado('inconsistente')} style={miniBtnWarn}>⚠ Inconsistente</button>
        </div>
      )}
    </div>
  );
}

function ModalAbono({ abono, cotizaciones, facturas, personaId, onClose, onDone, onError }: {
  abono: Abono | null;
  cotizaciones: Cotizacion[];
  facturas: Factura[];
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  // Cotización default: la primera con saldo > 0
  const cotDefault = cotizaciones.find(c => Number(c.saldo) > 0)?.id ?? cotizaciones[0]?.id ?? null;
  const inicial: Partial<Abono> = abono ?? {
    cotizacion_id: cotDefault,
    factura_id: null,
    persona_id: personaId,
    monto: 0,
    fecha: new Date().toISOString().slice(0, 10),
    metodo: null,
    referencia: null,
    comprobante_url: null,
    cuenta_receptora: null,
    estado_validacion: 'pendiente',
    notas: null,
  };
  const [form, setForm] = useState<Partial<Abono>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    if (!Number(form.monto) || Number(form.monto) <= 0) { onError('Monto debe ser > 0'); return; }
    if (!form.cotizacion_id) { onError('Asociá el abono a una cotización (para que actualice el saldo)'); return; }
    setAplicando(true);
    try {
      if (abono) {
        await actualizarAbono(abono.id, {
          cotizacion_id: form.cotizacion_id,
          factura_id: form.factura_id,
          monto: Number(form.monto),
          fecha: form.fecha,
          metodo: form.metodo,
          referencia: form.referencia,
          comprobante_url: form.comprobante_url,
          cuenta_receptora: form.cuenta_receptora,
          estado_validacion: form.estado_validacion,
          notas: form.notas,
        });
        onDone('Abono actualizado');
      } else {
        await crearAbono({
          cotizacion_id: form.cotizacion_id ?? null,
          factura_id: form.factura_id ?? null,
          persona_id: personaId,
          monto: Number(form.monto),
          fecha: form.fecha,
          metodo: form.metodo,
          referencia: form.referencia,
          comprobante_url: form.comprobante_url,
          cuenta_receptora: form.cuenta_receptora,
          estado_validacion: form.estado_validacion ?? 'pendiente',
          notas: form.notas,
        });
        onDone('Abono creado');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!abono) return;
    if (!confirm(`¿Eliminar este abono de ${fmtCop(Number(abono.monto))}? Va a recalcular el saldo de la cotización.`)) return;
    try { await eliminarAbono(abono.id); onDone('Abono eliminado'); }
    catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {abono ? 'Editar abono' : 'Registrar abono'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <Field label="Cotización *">
            <select value={form.cotizacion_id ?? ''} onChange={e => setForm({ ...form, cotizacion_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">— Seleccioná —</option>
              {cotizaciones.map(c => (
                <option key={c.id} value={c.id}>
                  {c.numero_cotizacion ?? '#' + c.id} · saldo {fmtCop(Number(c.saldo))}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Factura asociada (opcional)">
            <select value={form.factura_id ?? ''} onChange={e => setForm({ ...form, factura_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">— Ninguna —</option>
              {facturas.map(f => (
                <option key={f.id} value={f.id}>{f.numero_factura} · {fmtCop(Number(f.valor_total))}</option>
              ))}
            </select>
          </Field>
          <Field label="Monto (COP) *">
            <input type="number" min={1} step={1} value={form.monto ?? 0} onChange={e => setForm({ ...form, monto: Number(e.target.value) })} style={inp} />
          </Field>
          <Field label="Fecha">
            <input type="date" value={form.fecha ?? ''} onChange={e => setForm({ ...form, fecha: e.target.value })} style={inp} />
          </Field>
          <Field label="Método de pago">
            <select value={form.metodo ?? ''} onChange={e => setForm({ ...form, metodo: e.target.value || null })} style={inp}>
              <option value="">—</option>
              {METODOS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Field>
          <Field label="Cuenta receptora">
            <input value={form.cuenta_receptora ?? ''} onChange={e => setForm({ ...form, cuenta_receptora: e.target.value || null })} placeholder="ej. Bancolombia 1234-5678" style={inp} />
          </Field>
          <Field label="Referencia / comprobante #">
            <input value={form.referencia ?? ''} onChange={e => setForm({ ...form, referencia: e.target.value || null })} placeholder="ej. 0123456789" style={inp} />
          </Field>
          <Field label="URL evidencia (foto recibo)">
            <input value={form.comprobante_url ?? ''} onChange={e => setForm({ ...form, comprobante_url: e.target.value || null })} placeholder="https://..." style={inp} />
          </Field>
          <Field label="Estado validación">
            <select value={form.estado_validacion ?? 'pendiente'} onChange={e => setForm({ ...form, estado_validacion: e.target.value as EstadoValidacionAbono })} style={inp}>
              {ESTADOS.map(e => <option key={e.codigo} value={e.codigo}>{e.label}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Notas">
          <textarea rows={2} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })}
            placeholder="ej. Cliente envió foto del comprobante por WhatsApp." style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>

        <div style={{ padding: 8, background: 'var(--bg-page)', borderRadius: 6, marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
          ℹ Al guardar, el saldo de la cotización se recalcula automáticamente (trigger SQL). Los rechazados NO suman.
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {abono ? <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button> : <span />}
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

// ─── helpers ────────────────────────────────────────────────────

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
const miniBtnOk: React.CSSProperties = { padding: '3px 8px', fontSize: 10, fontWeight: 600, background: 'var(--green)', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' };
const miniBtnDanger: React.CSSProperties = { padding: '3px 8px', fontSize: 10, fontWeight: 500, background: 'white', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 4, cursor: 'pointer' };
const miniBtnWarn: React.CSSProperties = { padding: '3px 8px', fontSize: 10, fontWeight: 500, background: 'white', color: '#5856d6', border: '1px solid #5856d6', borderRadius: 4, cursor: 'pointer' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalBox: React.CSSProperties = { background: 'white', borderRadius: 10, padding: 24, width: '90%', maxWidth: 720, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
