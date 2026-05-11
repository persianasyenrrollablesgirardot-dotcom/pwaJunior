/**
 * 2.1 Cotizaciones — CRUD completo del cliente activo.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchCotizacionesPorPersona, fetchItemsPorCotizacion,
  crearCotizacion, actualizarCotizacion, eliminarCotizacion,
  crearItemCotizacion, actualizarItemCotizacion, eliminarItemCotizacion,
  fetchSistemasSafra, type Cotizacion, type CotizacionItem, type EstadoCotizacion,
} from '../../lib/queries';

const ESTADOS: { codigo: EstadoCotizacion; label: string; color: string }[] = [
  { codigo: 'propuesta',         label: 'Propuesta',         color: '#007aff' },
  { codigo: 'negociando',        label: 'Negociando',        color: '#ff9500' },
  { codigo: 'intencion_cierre',  label: 'Intención cierre',  color: '#5856d6' },
  { codigo: 'ganada',            label: 'Ganada',            color: '#34c759' },
  { codigo: 'perdida',           label: 'Perdida',           color: '#8e8e93' },
  { codigo: 'vencida',           label: 'Vencida',           color: '#ff3b30' },
  { codigo: 'cancelada',         label: 'Cancelada',         color: '#6e6e73' },
];
const ESTADO_LABEL = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.label]));
const ESTADO_COLOR = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.color]));

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Cotizaciones() {
  const ctx = useContextoActivo();
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Cotizacion | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try {
      const list = await fetchCotizacionesPorPersona(ctx.personaActivaId);
      setCotizaciones(list);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  async function nueva() {
    if (ctx.personaActivaId == null) return;
    try {
      const c = await crearCotizacion({
        persona_id: ctx.personaActivaId,
        proyecto_id: ctx.proyectoActivoId,
        estado: 'propuesta',
        fecha_vencimiento: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
      });
      await recargar();
      setEditando(c);
      setFeedback({ tipo: 'ok', msg: 'Cotización creada — completá los productos' });
      setTimeout(() => setFeedback(null), 3000);
    } catch (e: any) { setFeedback({ tipo: 'err', msg: e.message }); }
  }

  const stats = {
    total: cotizaciones.length,
    ganadas: cotizaciones.filter(c => c.estado === 'ganada').length,
    propuestas: cotizaciones.filter(c => c.estado === 'propuesta' || c.estado === 'negociando').length,
    vencidas: cotizaciones.filter(c => c.estado === 'vencida').length,
    monto_ganado: cotizaciones.filter(c => c.estado === 'ganada').reduce((a, c) => a + Number(c.total ?? 0), 0),
    saldo_pendiente: cotizaciones.reduce((a, c) => a + Number(c.saldo ?? 0), 0),
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Cotizaciones de {ctx.personaActivaNombre} ({stats.total})
        </h2>
        <button onClick={nueva} style={btnPrim}>+ Nueva cotización</button>
      </div>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      {/* KPIs */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="✓ Ganadas"    valor={stats.ganadas}     color="var(--green)" />
        <KPI label="⏳ Activas"    valor={stats.propuestas}  color="var(--orange)" />
        <KPI label="⌛ Vencidas"  valor={stats.vencidas}    color="var(--red)" />
        <KPI label="$ Ganado"     valor={fmtCop(stats.monto_ganado)} color="var(--green)" />
        <KPI label="$ Saldo pend" valor={fmtCop(stats.saldo_pendiente)} color={stats.saldo_pendiente > 0 ? 'var(--orange)' : 'var(--text-muted)'} />
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && cotizaciones.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13 }}>
          Sin cotizaciones todavía para {ctx.personaActivaNombre}.<br />
          Click en <strong>"+ Nueva cotización"</strong> para crear la primera.
        </div>
      )}

      <div style={{ display: 'grid', gap: 12 }}>
        {cotizaciones.map(c => (
          <CardCotizacion key={c.id} cot={c} onClick={() => setEditando(c)} />
        ))}
      </div>

      {editando && (
        <ModalCotizacion
          cotizacion={editando}
          onClose={() => setEditando(null)}
          onChange={async () => { await recargar(); }}
          onDone={(msg) => { setEditando(null); recargar(); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={(msg) => setFeedback({ tipo: 'err', msg })}
        />
      )}
    </div>
  );
}

function CardCotizacion({ cot, onClick }: { cot: Cotizacion; onClick: () => void }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', textAlign: 'left', background: 'var(--bg-panel)',
      border: `1px solid ${cot.estado === 'ganada' ? 'var(--green)' : cot.estado === 'vencida' ? 'var(--red)' : 'var(--border-soft)'}`,
      borderRadius: 8, padding: 14, cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <div style={{ fontWeight: 700, fontSize: 14 }}>
          {cot.numero_cotizacion ?? '(sin número)'}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: ESTADO_COLOR[cot.estado], textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {ESTADO_LABEL[cot.estado]}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{fmtFecha(cot.fecha)}</span>
        </div>
      </div>
      {cot.notas && (
        <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 8, lineHeight: 1.4 }}>
          {cot.notas.slice(0, 140)}{cot.notas.length > 140 ? '…' : ''}
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
        <span><strong>Total:</strong> {fmtCop(Number(cot.total))}</span>
        {cot.abono_monto != null && Number(cot.abono_monto) > 0 && (
          <span><strong>Abono:</strong> {fmtCop(Number(cot.abono_monto))}</span>
        )}
        {Number(cot.saldo) > 0 && <span><strong>Saldo:</strong> {fmtCop(Number(cot.saldo))}</span>}
        {cot.proxima_accion && (
          <span style={{ marginLeft: 'auto', color: 'var(--accent)' }}>→ {cot.proxima_accion} {cot.proxima_accion_fecha ? `(${fmtFecha(cot.proxima_accion_fecha)})` : ''}</span>
        )}
      </div>
    </button>
  );
}

function ModalCotizacion({ cotizacion, onClose, onChange, onDone, onError }: {
  cotizacion: Cotizacion;
  onClose: () => void;
  onChange: () => Promise<void>;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState<Cotizacion>(cotizacion);
  const [items, setItems] = useState<CotizacionItem[]>([]);
  const [sistemas, setSistemas] = useState<{ codigo: string; nombre: string }[]>([]);
  const [aplicando, setAplicando] = useState(false);
  const [editandoItem, setEditandoItem] = useState<Partial<CotizacionItem> | null>(null);

  useEffect(() => {
    fetchItemsPorCotizacion(cotizacion.id).then(setItems);
    fetchSistemasSafra().then(setSistemas);
  }, [cotizacion.id]);

  async function guardar() {
    setAplicando(true);
    try {
      await actualizarCotizacion(cotizacion.id, {
        numero_cotizacion: form.numero_cotizacion,
        estado: form.estado,
        fecha: form.fecha,
        fecha_vencimiento: form.fecha_vencimiento,
        descuento_pct: form.descuento_pct,
        iva_monto: form.iva_monto,
        abono_monto: form.abono_monto,
        abono_fecha: form.abono_fecha,
        abono_metodo: form.abono_metodo,
        abono_referencia: form.abono_referencia,
        notas: form.notas,
        proxima_accion: form.proxima_accion,
        proxima_accion_fecha: form.proxima_accion_fecha,
      });
      onDone('Cotización guardada');
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!confirm(`¿Eliminar cotización ${form.numero_cotizacion ?? '#' + form.id}? (soft-delete, recuperable)`)) return;
    try { await eliminarCotizacion(cotizacion.id); onDone('Cotización eliminada'); }
    catch (e: any) { onError(e.message); }
  }

  async function agregarItem() {
    setEditandoItem({
      cantidad: 1, precio_unitario: 0, ambiente: '', sistema_safra_codigo: sistemas[0]?.codigo,
      ancho_m: undefined, alto_m: undefined, color: '', quien_midio: 'tecnico',
      orden: items.length,
    });
  }
  async function guardarItem(it: Partial<CotizacionItem>) {
    try {
      if (it.id) {
        await actualizarItemCotizacion(it.id, it);
      } else {
        await crearItemCotizacion(cotizacion.id, it);
      }
      const refreshed = await fetchItemsPorCotizacion(cotizacion.id);
      setItems(refreshed);
      setEditandoItem(null);
      await onChange();
    } catch (e: any) { onError(e.message); }
  }
  async function borrarItem(itemId: number) {
    if (!confirm('¿Eliminar este producto?')) return;
    try {
      await eliminarItemCotizacion(itemId);
      const refreshed = await fetchItemsPorCotizacion(cotizacion.id);
      setItems(refreshed);
      await onChange();
    } catch (e: any) { onError(e.message); }
  }

  const subtotal = items.reduce((a, it) => a + Number(it.monto_total || 0), 0);
  const descuentoMonto = subtotal * (Number(form.descuento_pct ?? 0) / 100);
  const total = subtotal - descuentoMonto + Number(form.iva_monto ?? 0);
  const saldo = total - Number(form.abono_monto ?? 0);

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            Cotización {form.numero_cotizacion ?? '#' + form.id}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10, marginBottom: 16 }}>
          <Field label="Número">
            <input value={form.numero_cotizacion ?? ''} onChange={e => setForm({ ...form, numero_cotizacion: e.target.value || null })} placeholder="ej. COT-5742" style={inp} />
          </Field>
          <Field label="Estado">
            <select value={form.estado} onChange={e => setForm({ ...form, estado: e.target.value as EstadoCotizacion })} style={inp}>
              {ESTADOS.map(e => <option key={e.codigo} value={e.codigo}>{e.label}</option>)}
            </select>
          </Field>
          <Field label="Fecha">
            <input type="date" value={form.fecha} onChange={e => setForm({ ...form, fecha: e.target.value })} style={inp} />
          </Field>
          <Field label="Vence">
            <input type="date" value={form.fecha_vencimiento ?? ''} onChange={e => setForm({ ...form, fecha_vencimiento: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Descuento %">
            <input type="number" min={0} max={100} step={0.1} value={form.descuento_pct} onChange={e => setForm({ ...form, descuento_pct: Number(e.target.value) })} style={inp} />
          </Field>
          <Field label="IVA (COP)">
            <input type="number" min={0} step={1} value={form.iva_monto} onChange={e => setForm({ ...form, iva_monto: Number(e.target.value) })} style={inp} />
          </Field>
        </div>

        {/* PRODUCTOS */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)' }}>
            Productos ({items.length})
          </h3>
          <button onClick={agregarItem} style={btnSec}>+ Agregar producto</button>
        </div>

        <div style={{ marginBottom: 16 }}>
          {items.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center', background: 'var(--bg-page)', border: '1px dashed var(--border)', borderRadius: 6, color: 'var(--text-muted)', fontSize: 12 }}>
              Sin productos. Agregá el primero.
            </div>
          ) : items.map(it => {
            const sistemaNombre = sistemas.find(s => s.codigo === it.sistema_safra_codigo)?.nombre ?? it.sistema_safra_codigo ?? '(sin sistema)';
            return (
              <div key={it.id} style={{ background: 'var(--bg-page)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: 10, marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <strong>{sistemaNombre}</strong>
                    {it.ambiente && <span style={{ color: 'var(--text-muted)' }}> · {it.ambiente}</span>}
                    {it.color && <span style={{ color: 'var(--text-muted)' }}> · {it.color}</span>}
                  </div>
                  <span><strong>{fmtCop(Number(it.monto_total))}</strong></span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                  {it.ancho_m && it.alto_m && <>{Number(it.ancho_m).toFixed(2)}m × {Number(it.alto_m).toFixed(2)}m = {Number(it.area_m2 ?? 0).toFixed(2)}m² · </>}
                  cant: {it.cantidad} · ${Number(it.precio_unitario).toLocaleString('es-CO')}/un
                  {it.quien_midio && <> · midió: <strong>{it.quien_midio}</strong></>}
                  {it.riesgo_medicion && <span style={{ color: 'var(--red)', marginLeft: 4, fontWeight: 600 }}>⚠ RIESGO</span>}
                </div>
                <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                  <button onClick={() => setEditandoItem(it)} style={miniBtnSec}>Editar</button>
                  <button onClick={() => borrarItem(it.id)} style={miniBtnDanger}>Eliminar</button>
                </div>
              </div>
            );
          })}
        </div>

        {/* TOTALES */}
        <div style={{ background: 'var(--bg-page)', padding: 12, borderRadius: 6, marginBottom: 16, fontSize: 13 }}>
          <Linea label="Subtotal" valor={fmtCop(subtotal)} />
          {Number(form.descuento_pct ?? 0) > 0 && <Linea label={`Descuento (${form.descuento_pct}%)`} valor={'−' + fmtCop(descuentoMonto)} color="var(--orange)" />}
          {Number(form.iva_monto ?? 0) > 0 && <Linea label="IVA" valor={fmtCop(Number(form.iva_monto))} />}
          <Linea label="TOTAL" valor={fmtCop(total)} bold />
        </div>

        {/* ABONO */}
        <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4, color: 'var(--text-muted)' }}>Abono</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 16 }}>
          <Field label="Monto"><input type="number" min={0} step={1} value={form.abono_monto ?? ''} onChange={e => setForm({ ...form, abono_monto: e.target.value === '' ? null : Number(e.target.value) })} style={inp} /></Field>
          <Field label="Fecha"><input type="date" value={form.abono_fecha ?? ''} onChange={e => setForm({ ...form, abono_fecha: e.target.value || null })} style={inp} /></Field>
          <Field label="Método">
            <select value={form.abono_metodo ?? ''} onChange={e => setForm({ ...form, abono_metodo: e.target.value || null })} style={inp}>
              <option value="">—</option>
              <option value="bancolombia">Bancolombia</option>
              <option value="nequi">Nequi</option>
              <option value="daviplata">Daviplata</option>
              <option value="efectivo">Efectivo</option>
              <option value="transferencia">Transferencia otra</option>
            </select>
          </Field>
          <Field label="Referencia"><input value={form.abono_referencia ?? ''} onChange={e => setForm({ ...form, abono_referencia: e.target.value || null })} placeholder="ej. ABONO-001" style={inp} /></Field>
        </div>

        {Number(saldo) > 0 && (
          <div style={{ padding: 8, background: '#fff7ed', color: '#9a3412', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>
            <strong>Saldo pendiente: {fmtCop(saldo)}</strong>
          </div>
        )}

        {/* NOTAS + PRÓXIMA ACCIÓN */}
        <Field label="Notas / detalle">
          <textarea rows={3} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })}
            placeholder="Cliente pidió rebaja del 10%, ofrecimos solo en saldo, etc." style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10, marginTop: 10, marginBottom: 16 }}>
          <Field label="Próxima acción">
            <select value={form.proxima_accion ?? ''} onChange={e => setForm({ ...form, proxima_accion: e.target.value || null })} style={inp}>
              <option value="">—</option>
              <option value="confirmar_instalacion">Confirmar instalación</option>
              <option value="enviar_factura">Enviar factura</option>
              <option value="recordar_cliente">Recordar al cliente</option>
              <option value="esperar_decision">Esperar decisión cliente</option>
              <option value="pedir_abono">Pedir abono</option>
              <option value="enviar_recibo">Enviar recibo</option>
              <option value="cierre">Cierre</option>
            </select>
          </Field>
          <Field label="Fecha próxima acción">
            <input type="date" value={form.proxima_accion_fecha ?? ''} onChange={e => setForm({ ...form, proxima_accion_fecha: e.target.value || null })} style={inp} />
          </Field>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btnSec}>Cancelar</button>
            <button onClick={guardar} disabled={aplicando} style={{ ...btnPrim, opacity: aplicando ? 0.5 : 1 }}>
              {aplicando ? 'Guardando…' : '✓ Guardar'}
            </button>
          </div>
        </div>

        {editandoItem && (
          <ModalItem
            item={editandoItem}
            sistemas={sistemas}
            onClose={() => setEditandoItem(null)}
            onSave={guardarItem}
          />
        )}
      </div>
    </div>
  );
}

function ModalItem({ item, sistemas, onClose, onSave }: {
  item: Partial<CotizacionItem>;
  sistemas: { codigo: string; nombre: string }[];
  onClose: () => void;
  onSave: (it: Partial<CotizacionItem>) => Promise<void>;
}) {
  const [form, setForm] = useState<Partial<CotizacionItem>>(item);
  const monto = (Number(form.cantidad) || 1) * (Number(form.precio_unitario) || 0);

  return (
    <div onClick={onClose} style={{ ...overlay, zIndex: 1100 }}>
      <div onClick={e => e.stopPropagation()} style={{ ...modalBox, maxWidth: 540 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700 }}>
          {form.id ? 'Editar producto' : 'Agregar producto'}
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Sistema Safra">
            <select value={form.sistema_safra_codigo ?? ''} onChange={e => setForm({ ...form, sistema_safra_codigo: e.target.value })} style={inp}>
              <option value="">—</option>
              {sistemas.map(s => <option key={s.codigo} value={s.codigo}>{s.nombre}</option>)}
            </select>
          </Field>
          <Field label="Ambiente"><input value={form.ambiente ?? ''} onChange={e => setForm({ ...form, ambiente: e.target.value })} placeholder="sala, oficina, dormitorio…" style={inp} /></Field>
          <Field label="Ancho (m)"><input type="number" step={0.01} value={form.ancho_m ?? ''} onChange={e => setForm({ ...form, ancho_m: e.target.value === '' ? null : Number(e.target.value) })} style={inp} /></Field>
          <Field label="Alto (m)"><input type="number" step={0.01} value={form.alto_m ?? ''} onChange={e => setForm({ ...form, alto_m: e.target.value === '' ? null : Number(e.target.value) })} style={inp} /></Field>
          <Field label="Cantidad"><input type="number" min={1} value={form.cantidad ?? 1} onChange={e => setForm({ ...form, cantidad: Number(e.target.value) })} style={inp} /></Field>
          <Field label="Precio unitario (COP)"><input type="number" min={0} value={form.precio_unitario ?? 0} onChange={e => setForm({ ...form, precio_unitario: Number(e.target.value) })} style={inp} /></Field>
          <Field label="Color"><input value={form.color ?? ''} onChange={e => setForm({ ...form, color: e.target.value })} placeholder="blanco, beige…" style={inp} /></Field>
          <Field label="Quién midió">
            <select value={form.quien_midio ?? ''} onChange={e => setForm({ ...form, quien_midio: (e.target.value || null) as any })} style={inp}>
              <option value="">—</option>
              <option value="tecnico">Técnico (Jhon)</option>
              <option value="cliente">⚠ Cliente</option>
              <option value="familiar">⚠ Familiar</option>
              <option value="otro">⚠ Otro</option>
            </select>
          </Field>
        </div>

        <Field label="Notas">
          <textarea rows={2} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })}
            placeholder="motorizado, riel-blanco, etc." style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>

        {form.quien_midio && form.quien_midio !== 'tecnico' && (
          <div style={{ padding: 8, background: '#fff7ed', color: '#9a3412', borderRadius: 6, fontSize: 11, marginTop: 8 }}>
            ⚠ <strong>R-013#1</strong>: medición tomada por <em>{form.quien_midio}</em> activa bandera RIESGO automático. Si la medida es errada, la responsabilidad es del cliente.
          </div>
        )}

        <div style={{ background: 'var(--bg-page)', padding: 8, borderRadius: 6, marginTop: 12, textAlign: 'right', fontSize: 13 }}>
          <strong>Subtotal: {fmtCop(monto)}</strong>
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={btnSec}>Cancelar</button>
          <button onClick={() => onSave(form)} style={btnPrim}>✓ Guardar producto</button>
        </div>
      </div>
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────

function KPI({ label, valor, color }: { label: string; valor: number | string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 110 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{valor}</div>
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      {children}
    </label>
  );
}
function Linea({ label, valor, bold, color }: { label: string; valor: string; bold?: boolean; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: bold ? 14 : 12, fontWeight: bold ? 700 : 400, color: color ?? (bold ? 'var(--accent)' : 'var(--text)') }}>
      <span>{label}</span><span>{valor}</span>
    </div>
  );
}

const inp: React.CSSProperties = { padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'white', outline: 'none' };
const btnPrim: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' };
const btnSec: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' };
const btnDanger: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 600, background: 'white', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 6, cursor: 'pointer' };
const miniBtnSec: React.CSSProperties = { padding: '3px 8px', fontSize: 10, fontWeight: 500, background: 'var(--bg-panel)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer' };
const miniBtnDanger: React.CSSProperties = { padding: '3px 8px', fontSize: 10, fontWeight: 500, background: 'white', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 4, cursor: 'pointer' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalBox: React.CSSProperties = { background: 'white', borderRadius: 10, padding: 24, width: '90%', maxWidth: 720, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
