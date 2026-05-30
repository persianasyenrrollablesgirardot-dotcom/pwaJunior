/**
 * 3.5 Rentabilidad real — margen del cliente activo.
 *
 * Margen = venta_total (cotizaciones ganadas) + variaciones_neto − costos_total.
 *
 * Permite registrar costos del proyecto: tela/herrajes, motor, viáticos,
 * visita_extra, retrabajo, garantía_ejecutada, mano_obra, otro.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchRentabilidadPorPersona, fetchCostosPorPersona, fetchCotizacionesPorPersona,
  crearCosto, actualizarCosto, eliminarCosto,
  TIPOS_COSTO, type TipoCosto, type Costo, type ResumenRentabilidad, type Cotizacion,
} from '../../lib/queries';

const TIPO_LABEL: Record<TipoCosto, string> = {
  producto: 'Producto (tela/herrajes)',
  motor: 'Motor',
  viatico: 'Viático',
  visita_extra: 'Visita extra',
  retrabajo: 'Retrabajo',
  garantia_ejecutada: 'Garantía ejecutada',
  mano_obra: 'Mano de obra / instalación',
  otro: 'Otro',
};
const TIPO_COLOR: Record<TipoCosto, string> = {
  producto: '#007aff', motor: '#5ac8fa', viatico: '#ff9500',
  visita_extra: '#ff9500', retrabajo: '#ff3b30', garantia_ejecutada: '#ff3b30',
  mano_obra: '#34c759', otro: '#8e8e93',
};

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Rentabilidad() {
  const ctx = useContextoActivo();
  const [resumen, setResumen] = useState<ResumenRentabilidad | null>(null);
  const [costos, setCostos] = useState<Costo[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Costo | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try {
      const [r, c, q] = await Promise.all([
        fetchRentabilidadPorPersona(ctx.personaActivaId),
        fetchCostosPorPersona(ctx.personaActivaId),
        fetchCotizacionesPorPersona(ctx.personaActivaId),
      ]);
      setResumen(r); setCostos(c); setCotizaciones(q);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  function mostrarFeedback(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 3000);
  }

  const venta = Number(resumen?.venta_total ?? 0);
  const variaciones = Number(resumen?.variaciones_neto ?? 0);
  const costo = Number(resumen?.costo_total ?? 0);
  const margen = Number(resumen?.margen ?? 0);
  const margenPct = venta > 0 ? (margen / venta) * 100 : 0;

  // Agrupar costos por tipo
  const porTipo: Record<string, number> = {};
  for (const c of costos) porTipo[c.tipo] = (porTipo[c.tipo] ?? 0) + Number(c.monto);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Rentabilidad real de {ctx.personaActivaNombre}
        </h2>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Registrar costo</button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Margen = ventas ganadas + variaciones netas − costos del proyecto.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && !resumen && costos.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Aún no hay cotizaciones GANADAS de {ctx.personaActivaNombre}.<br />
          Cuando ganes una, este panel calcula automáticamente el margen.
        </div>
      )}

      {/* KPIs principales */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="$ Venta ganada"     valor={fmtCop(venta)}        color="var(--text)" />
        <KPI label="Δ Variaciones"      valor={fmtCop(variaciones)}  color={variaciones >= 0 ? 'var(--green)' : 'var(--red)'} />
        <KPI label="$ Costos"           valor={fmtCop(costo)}        color="var(--red)" />
        <KPI label={margen >= 0 ? '✓ Margen' : '✗ Pérdida'} valor={fmtCop(margen)}  color={margen >= 0 ? 'var(--green)' : 'var(--red)'} />
        <KPI label="% Margen"           valor={(margenPct).toFixed(1) + '%'} color={margenPct >= 30 ? 'var(--green)' : margenPct >= 10 ? 'var(--orange)' : 'var(--red)'} />
      </div>

      {/* Breakdown por tipo de costo */}
      {Object.keys(porTipo).length > 0 && (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 700, marginBottom: 10 }}>
            Costos por tipo
          </div>
          {Object.entries(porTipo).sort((a, b) => b[1] - a[1]).map(([tipo, monto]) => (
            <div key={tipo} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border-soft)' }}>
              <span style={{ fontSize: 12, color: TIPO_COLOR[tipo as TipoCosto] }}>{TIPO_LABEL[tipo as TipoCosto] ?? tipo}</span>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{fmtCop(Number(monto))}</span>
            </div>
          ))}
        </div>
      )}

      {/* Lista de costos */}
      {costos.length > 0 && (
        <>
          <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)' }}>
            Costos registrados ({costos.length})
          </h3>
          <div style={{ display: 'grid', gap: 8 }}>
            {costos.map(c => (
              <button key={c.id} onClick={() => setEditando(c)} style={{ width: '100%', textAlign: 'left', background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 12, cursor: 'pointer' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <strong style={{ fontSize: 13, color: TIPO_COLOR[c.tipo] }}>{TIPO_LABEL[c.tipo] ?? c.tipo}</strong>
                  <span style={{ fontSize: 13, fontWeight: 700 }}>{fmtCop(Number(c.monto))}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  {fmtFecha(c.fecha)}
                  {c.vendor && <> · {c.vendor}</>}
                </div>
                {c.descripcion && <div style={{ fontSize: 12, marginTop: 4 }}>{c.descripcion}</div>}
              </button>
            ))}
          </div>
        </>
      )}

      {(editando || creando) && (
        <ModalCosto
          costo={editando}
          cotizaciones={cotizaciones}
          personaId={ctx.personaActivaId!}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await recargar(); mostrarFeedback('ok', msg); }}
          onError={(msg) => mostrarFeedback('err', msg)}
        />
      )}
    </div>
  );
}

function ModalCosto({ costo, cotizaciones, personaId, onClose, onDone, onError }: {
  costo: Costo | null;
  cotizaciones: Cotizacion[];
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<Costo> = costo ?? {
    cotizacion_id: cotizaciones[0]?.id ?? null,
    proyecto_id: null,
    persona_id: personaId,
    tipo: 'producto',
    descripcion: null,
    monto: 0,
    fecha: new Date().toISOString().slice(0, 10),
    vendor: null,
    comprobante_url: null,
    notas: null,
  };
  const [form, setForm] = useState<Partial<Costo>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    if (!form.tipo) { onError('Tipo es obligatorio'); return; }
    if (!Number(form.monto) || Number(form.monto) < 0) { onError('Monto debe ser ≥ 0'); return; }
    setAplicando(true);
    try {
      if (costo) {
        await actualizarCosto(costo.id, {
          cotizacion_id: form.cotizacion_id, tipo: form.tipo,
          descripcion: form.descripcion, monto: Number(form.monto),
          fecha: form.fecha, vendor: form.vendor, comprobante_url: form.comprobante_url,
          notas: form.notas,
        });
        onDone('Costo actualizado');
      } else {
        await crearCosto({
          cotizacion_id: form.cotizacion_id ?? null,
          proyecto_id: form.proyecto_id ?? null,
          persona_id: personaId,
          tipo: form.tipo as TipoCosto,
          descripcion: form.descripcion,
          monto: Number(form.monto),
          fecha: form.fecha,
          vendor: form.vendor,
          comprobante_url: form.comprobante_url,
          notas: form.notas,
        });
        onDone('Costo registrado');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!costo) return;
    if (!confirm('¿Eliminar este costo? Va a recalcular el margen.')) return;
    try { await eliminarCosto(costo.id); onDone('Costo eliminado'); }
    catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {costo ? 'Editar costo' : 'Registrar costo'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <Field label="Tipo *">
            <select value={form.tipo ?? ''} onChange={e => setForm({ ...form, tipo: e.target.value as TipoCosto })} style={inp}>
              {TIPOS_COSTO.map(t => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="Monto (COP) *">
            <input type="number" min={0} step={1} value={form.monto ?? 0} onChange={e => setForm({ ...form, monto: Number(e.target.value) })} style={inp} />
          </Field>
          <Field label="Cotización asociada">
            <select value={form.cotizacion_id ?? ''} onChange={e => setForm({ ...form, cotizacion_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">— Ninguna —</option>
              {cotizaciones.map(c => (
                <option key={c.id} value={c.id}>{c.numero_cotizacion ?? '#' + c.id} · {c.estado}</option>
              ))}
            </select>
          </Field>
          <Field label="Fecha">
            <input type="date" value={form.fecha ?? ''} onChange={e => setForm({ ...form, fecha: e.target.value })} style={inp} />
          </Field>
          <Field label="Vendor / proveedor">
            <input value={form.vendor ?? ''} onChange={e => setForm({ ...form, vendor: e.target.value || null })} placeholder="ej. Tejidos Safra SAS, Andrés instalador" style={inp} />
          </Field>
          <Field label="Comprobante URL">
            <input value={form.comprobante_url ?? ''} onChange={e => setForm({ ...form, comprobante_url: e.target.value || null })} placeholder="https://…" style={inp} />
          </Field>
        </div>

        <Field label="Descripción (qué se compró/pagó)">
          <input value={form.descripcion ?? ''} onChange={e => setForm({ ...form, descripcion: e.target.value || null })} placeholder='ej. "Tela blackout beige 4.5m²", "Viático Bogotá $80.000"' style={inp} />
        </Field>

        <Field label="Notas internas">
          <textarea rows={2} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })}
            placeholder="ej. Retrabajo porque la primera medida fue del cliente." style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {costo ? <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button> : <span />}
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
