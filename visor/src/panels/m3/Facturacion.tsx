/**
 * 3.1 Facturación — CRUD de facturas del cliente activo.
 *
 * Cada factura puede (debería) estar asociada a una cotización ganada.
 * Estado: borrador → emitida → enviada → pagada (o anulada).
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchFacturasPorPersona, crearFactura, actualizarFactura, eliminarFactura,
  fetchCotizacionesPorPersona,
  type Factura, type EstadoFactura, type Cotizacion,
} from '../../lib/queries';

const ESTADOS: { codigo: EstadoFactura; label: string; color: string }[] = [
  { codigo: 'borrador',  label: 'Borrador',   color: '#8e8e93' },
  { codigo: 'emitida',   label: 'Emitida',    color: '#007aff' },
  { codigo: 'enviada',   label: 'Enviada',    color: '#5856d6' },
  { codigo: 'pagada',    label: 'Pagada',     color: '#34c759' },
  { codigo: 'anulada',   label: 'Anulada',    color: '#ff3b30' },
];
const ESTADO_LABEL = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.label]));
const ESTADO_COLOR = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.color]));

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Facturacion() {
  const ctx = useContextoActivo();
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Factura | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try {
      const [f, c] = await Promise.all([
        fetchFacturasPorPersona(ctx.personaActivaId),
        fetchCotizacionesPorPersona(ctx.personaActivaId),
      ]);
      setFacturas(f);
      setCotizaciones(c);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  const stats = {
    total: facturas.length,
    emitidas: facturas.filter(f => f.estado === 'emitida' || f.estado === 'enviada').length,
    pagadas: facturas.filter(f => f.estado === 'pagada').length,
    monto_total: facturas.filter(f => f.estado !== 'anulada').reduce((a, f) => a + Number(f.valor_total), 0),
    monto_pagado: facturas.filter(f => f.estado === 'pagada').reduce((a, f) => a + Number(f.valor_total), 0),
  };

  function mostrarFeedback(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 3000);
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Facturas de {ctx.personaActivaNombre} ({stats.total})
        </h2>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Nueva factura</button>
      </div>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="📨 Emitidas" valor={stats.emitidas}  color="var(--accent)" />
        <KPI label="✓ Pagadas"   valor={stats.pagadas}   color="var(--green)" />
        <KPI label="$ Facturado" valor={fmtCop(stats.monto_total)}  color="var(--text)" />
        <KPI label="$ Pagado"    valor={fmtCop(stats.monto_pagado)} color="var(--green)" />
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && facturas.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13 }}>
          Sin facturas todavía para {ctx.personaActivaNombre}.<br />
          Click en <strong>"+ Nueva factura"</strong> para crear la primera.
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {facturas.map(f => (
          <CardFactura key={f.id} f={f} onClick={() => setEditando(f)} />
        ))}
      </div>

      {(editando || creando) && (
        <ModalFactura
          factura={editando}
          cotizaciones={cotizaciones}
          personaId={ctx.personaActivaId!}
          proyectoId={ctx.proyectoActivoId}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await recargar(); mostrarFeedback('ok', msg); }}
          onError={(msg) => mostrarFeedback('err', msg)}
        />
      )}
    </div>
  );
}

function CardFactura({ f, onClick }: { f: Factura; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', textAlign: 'left', background: 'var(--bg-panel)',
      border: `1px solid ${f.estado === 'pagada' ? 'var(--green)' : f.estado === 'anulada' ? 'var(--red)' : 'var(--border-soft)'}`,
      borderRadius: 8, padding: 14, cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <strong style={{ fontSize: 14 }}>{f.numero_factura}</strong>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: ESTADO_COLOR[f.estado], textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {ESTADO_LABEL[f.estado]}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtFecha(f.fecha)}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
        <span><strong>Valor:</strong> {fmtCop(Number(f.valor_total))}</span>
        {f.cotizacion_id && <span><strong>Cotización:</strong> #{f.cotizacion_id}</span>}
        {f.fecha_vencimiento && <span><strong>Vence:</strong> {fmtFecha(f.fecha_vencimiento)}</span>}
      </div>
      {f.notas && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
          {f.notas.slice(0, 140)}{f.notas.length > 140 ? '…' : ''}
        </div>
      )}
    </button>
  );
}

function ModalFactura({ factura, cotizaciones, personaId, proyectoId, onClose, onDone, onError }: {
  factura: Factura | null;
  cotizaciones: Cotizacion[];
  personaId: number;
  proyectoId: number | null | undefined;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<Factura> = factura ?? {
    cotizacion_id: null,
    proyecto_id: proyectoId ?? null,
    persona_id: personaId,
    numero_factura: '',
    fecha: new Date().toISOString().slice(0, 10),
    fecha_vencimiento: null,
    valor_total: 0,
    estado: 'emitida',
    notas: null,
  };
  const [form, setForm] = useState<Partial<Factura>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  // Cuando seleccionás una cotización, auto-rellenar valor_total con su total
  function seleccionarCotizacion(cotIdStr: string) {
    const cotId = cotIdStr ? Number(cotIdStr) : null;
    const cot = cotId ? cotizaciones.find(c => c.id === cotId) : null;
    setForm(f => ({
      ...f,
      cotizacion_id: cotId,
      valor_total: cot ? Number(cot.total) : f.valor_total ?? 0,
    }));
  }

  async function guardar() {
    if (!form.numero_factura?.trim()) { onError('Número de factura es obligatorio'); return; }
    if (!Number(form.valor_total)) { onError('Valor total debe ser > 0'); return; }
    setAplicando(true);
    try {
      if (factura) {
        await actualizarFactura(factura.id, {
          cotizacion_id: form.cotizacion_id,
          numero_factura: form.numero_factura,
          fecha: form.fecha,
          fecha_vencimiento: form.fecha_vencimiento,
          valor_total: Number(form.valor_total),
          estado: form.estado,
          notas: form.notas,
        });
        onDone('Factura actualizada');
      } else {
        await crearFactura({
          cotizacion_id: form.cotizacion_id ?? null,
          proyecto_id: form.proyecto_id ?? null,
          persona_id: personaId,
          numero_factura: form.numero_factura!,
          fecha: form.fecha,
          fecha_vencimiento: form.fecha_vencimiento ?? null,
          valor_total: Number(form.valor_total),
          estado: form.estado ?? 'emitida',
          notas: form.notas,
        });
        onDone('Factura creada');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!factura) return;
    if (!confirm(`¿Eliminar factura ${factura.numero_factura}? (soft-delete, recuperable)`)) return;
    try { await eliminarFactura(factura.id); onDone('Factura eliminada'); }
    catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {factura ? `Factura ${factura.numero_factura}` : 'Nueva factura'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <Field label="Número factura *">
            <input value={form.numero_factura ?? ''} onChange={e => setForm({ ...form, numero_factura: e.target.value })} placeholder="ej. FAC-001" style={inp} />
          </Field>
          <Field label="Estado">
            <select value={form.estado ?? 'emitida'} onChange={e => setForm({ ...form, estado: e.target.value as EstadoFactura })} style={inp}>
              {ESTADOS.map(e => <option key={e.codigo} value={e.codigo}>{e.label}</option>)}
            </select>
          </Field>
          <Field label="Fecha">
            <input type="date" value={form.fecha ?? ''} onChange={e => setForm({ ...form, fecha: e.target.value })} style={inp} />
          </Field>
          <Field label="Vence">
            <input type="date" value={form.fecha_vencimiento ?? ''} onChange={e => setForm({ ...form, fecha_vencimiento: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Cotización asociada">
            <select value={form.cotizacion_id ?? ''} onChange={e => seleccionarCotizacion(e.target.value)} style={inp}>
              <option value="">— Ninguna (factura suelta) —</option>
              {cotizaciones.map(c => (
                <option key={c.id} value={c.id}>
                  {c.numero_cotizacion ?? '#' + c.id} · {c.estado} · {fmtCop(Number(c.total))}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Valor total (COP) *">
            <input type="number" min={0} step={1} value={form.valor_total ?? 0} onChange={e => setForm({ ...form, valor_total: Number(e.target.value) })} style={inp} />
          </Field>
        </div>

        <Field label="Notas">
          <textarea rows={3} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })}
            placeholder="ej. Factura con descuento del 5% por pago anticipado." style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {factura ? <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button> : <span />}
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
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalBox: React.CSSProperties = { background: 'white', borderRadius: 10, padding: 24, width: '90%', maxWidth: 720, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
