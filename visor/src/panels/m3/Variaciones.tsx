/**
 * 3.4 Variaciones económicas — log de diferencias entre cotización y factura.
 *
 * Tipos: descuento, cambio_producto, cambio_medida, motor_agregado,
 * ventana_eliminada, instalacion_negociada, cambio_garantia, cambio_cliente.
 *
 * monto_delta: positivo = cliente paga más; negativo = cliente paga menos.
 * Sirve para no perder historia económica entre lo cotizado y lo facturado.
 */
import { useEffect, useMemo, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchVariacionesPorPersona, crearVariacion, actualizarVariacion, eliminarVariacion,
  fetchCotizacionesPorPersona, fetchFacturasPorPersona,
  TIPOS_VARIACION, type TipoVariacion, type Variacion, type Cotizacion, type Factura,
} from '../../lib/queries';

const TIPO_LABEL: Record<TipoVariacion, string> = {
  descuento: 'Descuento',
  cambio_producto: 'Cambio de producto',
  cambio_medida: 'Cambio de medida',
  motor_agregado: 'Motor agregado',
  ventana_eliminada: 'Ventana eliminada',
  instalacion_negociada: 'Instalación negociada',
  cambio_garantia: 'Cambio por garantía',
  cambio_cliente: 'Cambio por cliente',
  otro: 'Otro',
};
const TIPO_COLOR: Record<TipoVariacion, string> = {
  descuento: '#ff9500',
  cambio_producto: '#5856d6',
  cambio_medida: '#5ac8fa',
  motor_agregado: '#34c759',
  ventana_eliminada: '#ff3b30',
  instalacion_negociada: '#5856d6',
  cambio_garantia: '#ff3b30',
  cambio_cliente: '#8e8e93',
  otro: '#8e8e93',
};

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Variaciones() {
  const ctx = useContextoActivo();
  const [variaciones, setVariaciones] = useState<Variacion[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [facturas, setFacturas] = useState<Factura[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Variacion | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try {
      const [v, c, f] = await Promise.all([
        fetchVariacionesPorPersona(ctx.personaActivaId),
        fetchCotizacionesPorPersona(ctx.personaActivaId),
        fetchFacturasPorPersona(ctx.personaActivaId),
      ]);
      setVariaciones(v); setCotizaciones(c); setFacturas(f);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  // Detección automática: si una factura tiene valor_total ≠ cotización asociada y NO hay variación
  // que justifique la diferencia, sugerir crear una.
  const sugerencias = useMemo(() => {
    const out: { factura: Factura; cot: Cotizacion; delta: number }[] = [];
    for (const f of facturas) {
      if (!f.cotizacion_id) continue;
      const cot = cotizaciones.find(c => c.id === f.cotizacion_id);
      if (!cot) continue;
      const delta = Number(f.valor_total) - Number(cot.total);
      if (Math.abs(delta) < 1) continue;  // sin diferencia
      const cubierta = variaciones
        .filter(v => v.cotizacion_id === cot.id || v.factura_id === f.id)
        .reduce((s, v) => s + Number(v.monto_delta), 0);
      if (Math.abs(delta - cubierta) >= 1) {
        out.push({ factura: f, cot, delta: delta - cubierta });
      }
    }
    return out;
  }, [facturas, cotizaciones, variaciones]);

  const stats = {
    total: variaciones.length,
    delta_neto: variaciones.reduce((s, v) => s + Number(v.monto_delta), 0),
    descuentos: variaciones.filter(v => v.tipo === 'descuento').length,
    agregados: variaciones.filter(v => Number(v.monto_delta) > 0).length,
  };

  function mostrarFeedback(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 3000);
  }

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Variaciones de {ctx.personaActivaNombre} ({stats.total})
        </h2>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Registrar variación</button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Diferencias económicas entre cotización y factura. <strong>Positivo</strong> = cliente paga más;{' '}
        <strong>negativo</strong> = cliente paga menos.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="Δ neto"            valor={fmtCop(stats.delta_neto)}  color={stats.delta_neto >= 0 ? 'var(--green)' : 'var(--red)'} />
        <KPI label="↓ Descuentos"      valor={stats.descuentos}          color="var(--orange)" />
        <KPI label="↑ Agregados"       valor={stats.agregados}           color="var(--green)" />
      </div>

      {/* Sugerencias automáticas */}
      {sugerencias.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 8 }}>
            ⚠ Diferencias detectadas sin variación registrada:
          </div>
          {sugerencias.map((s, i) => (
            <div key={i} style={{ fontSize: 12, color: '#78350f', marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <span>
                Factura <strong>{s.factura.numero_factura}</strong> ({fmtCop(Number(s.factura.valor_total))}) vs cotización{' '}
                <strong>{s.cot.numero_cotizacion ?? '#' + s.cot.id}</strong> ({fmtCop(Number(s.cot.total))}):{' '}
                <strong style={{ color: s.delta < 0 ? 'var(--red)' : 'var(--green)' }}>
                  Δ {fmtCop(s.delta)}
                </strong>
              </span>
              <button onClick={() => setCreando(true)} style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, background: '#92400e', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                Registrar
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && variaciones.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin variaciones registradas para {ctx.personaActivaNombre}.
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {variaciones.map(v => {
          const cot = v.cotizacion_id ? cotizaciones.find(c => c.id === v.cotizacion_id) : null;
          const positivo = Number(v.monto_delta) > 0;
          return (
            <button key={v.id} onClick={() => setEditando(v)} style={{ width: '100%', textAlign: 'left', background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <strong style={{ fontSize: 13, color: TIPO_COLOR[v.tipo] }}>{TIPO_LABEL[v.tipo]}</strong>
                <span style={{ fontSize: 14, fontWeight: 700, color: positivo ? 'var(--green)' : 'var(--red)' }}>
                  {positivo ? '+' : ''}{fmtCop(Number(v.monto_delta))}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {fmtFecha(v.fecha)}
                {cot && <> · {cot.numero_cotizacion ?? '#' + cot.id}</>}
                {v.responsable && <> · responsable: <strong>{v.responsable}</strong></>}
              </div>
              {v.motivo && <div style={{ fontSize: 12, marginTop: 6 }}>{v.motivo}</div>}
            </button>
          );
        })}
      </div>

      {(editando || creando) && (
        <ModalVariacion
          variacion={editando}
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

function ModalVariacion({ variacion, cotizaciones, facturas, personaId, onClose, onDone, onError }: {
  variacion: Variacion | null;
  cotizaciones: Cotizacion[];
  facturas: Factura[];
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<Variacion> = variacion ?? {
    cotizacion_id: cotizaciones[0]?.id ?? null,
    factura_id: null,
    persona_id: personaId,
    tipo: 'descuento',
    monto_delta: 0,
    motivo: null,
    fecha: new Date().toISOString().slice(0, 10),
    responsable: 'empresa',
    notas: null,
  };
  const [form, setForm] = useState<Partial<Variacion>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    if (!form.tipo) { onError('Tipo es obligatorio'); return; }
    if (!Number(form.monto_delta)) { onError('Monto Δ no puede ser 0'); return; }
    setAplicando(true);
    try {
      if (variacion) {
        await actualizarVariacion(variacion.id, {
          cotizacion_id: form.cotizacion_id, factura_id: form.factura_id,
          tipo: form.tipo, monto_delta: Number(form.monto_delta),
          motivo: form.motivo, fecha: form.fecha, responsable: form.responsable,
          notas: form.notas,
        });
        onDone('Variación actualizada');
      } else {
        await crearVariacion({
          cotizacion_id: form.cotizacion_id ?? null,
          factura_id: form.factura_id ?? null,
          persona_id: personaId,
          tipo: form.tipo as TipoVariacion,
          monto_delta: Number(form.monto_delta),
          motivo: form.motivo, fecha: form.fecha, responsable: form.responsable,
          notas: form.notas,
        });
        onDone('Variación registrada');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!variacion) return;
    if (!confirm('¿Eliminar esta variación?')) return;
    try { await eliminarVariacion(variacion.id); onDone('Variación eliminada'); }
    catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {variacion ? 'Editar variación' : 'Registrar variación'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <Field label="Tipo *">
            <select value={form.tipo ?? ''} onChange={e => setForm({ ...form, tipo: e.target.value as TipoVariacion })} style={inp}>
              {TIPOS_VARIACION.map(t => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="Monto Δ (COP) — + suma, − resta *">
            <input type="number" step={1} value={form.monto_delta ?? 0} onChange={e => setForm({ ...form, monto_delta: Number(e.target.value) })} style={inp} />
          </Field>
          <Field label="Cotización asociada">
            <select value={form.cotizacion_id ?? ''} onChange={e => setForm({ ...form, cotizacion_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">— Ninguna —</option>
              {cotizaciones.map(c => (
                <option key={c.id} value={c.id}>{c.numero_cotizacion ?? '#' + c.id} · {c.estado}</option>
              ))}
            </select>
          </Field>
          <Field label="Factura asociada">
            <select value={form.factura_id ?? ''} onChange={e => setForm({ ...form, factura_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">— Ninguna —</option>
              {facturas.map(f => (
                <option key={f.id} value={f.id}>{f.numero_factura}</option>
              ))}
            </select>
          </Field>
          <Field label="Fecha">
            <input type="date" value={form.fecha ?? ''} onChange={e => setForm({ ...form, fecha: e.target.value })} style={inp} />
          </Field>
          <Field label="Responsable">
            <select value={form.responsable ?? ''} onChange={e => setForm({ ...form, responsable: (e.target.value || null) as any })} style={inp}>
              <option value="">—</option>
              <option value="empresa">Empresa</option>
              <option value="cliente">Cliente</option>
              <option value="tercero">Tercero</option>
            </select>
          </Field>
        </div>

        <Field label="Motivo (visible en card)">
          <input value={form.motivo ?? ''} onChange={e => setForm({ ...form, motivo: e.target.value || null })} placeholder="ej. Cliente pidió rebaja del 10% por pago anticipado" style={inp} />
        </Field>

        <Field label="Notas (detalles internos)">
          <textarea rows={2} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })}
            placeholder="Cualquier nota interna sobre esta variación." style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {variacion ? <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button> : <span />}
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
