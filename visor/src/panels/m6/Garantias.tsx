/**
 * 6.1 Garantías — CRUD del cliente activo.
 *
 * Causa codifica responsable_default (catálogo causas_garantia). Trigger SQL
 * auto-rellena responsable desde la causa al insertar.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchGarantiasPorPersona, crearGarantia, actualizarGarantia, eliminarGarantia,
  fetchCausasGarantia, fetchCotizacionesPorPersona, fetchInstalacionesPorPersona,
  fetchSistemasSafra,
  type Garantia, type CausaGarantia, type EstadoGarantia, type ResponsableGarantia,
  type Cotizacion, type Instalacion,
} from '../../lib/queries';

const ESTADOS: { codigo: EstadoGarantia; label: string; color: string }[] = [
  { codigo: 'abierta',         label: 'Abierta',         color: '#ff9500' },
  { codigo: 'en_diagnostico',  label: 'En diagnóstico',  color: '#5856d6' },
  { codigo: 'en_reparacion',   label: 'En reparación',   color: '#5ac8fa' },
  { codigo: 'resuelta',        label: 'Resuelta',        color: '#34c759' },
  { codigo: 'rechazada',       label: 'Rechazada',       color: '#ff3b30' },
  { codigo: 'cerrada',         label: 'Cerrada',         color: '#8e8e93' },
];
const ESTADO_COLOR = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.color]));
const ESTADO_LABEL = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.label]));
const RESPONSABLE_COLOR: Record<string, string> = { empresa: 'var(--red)', cliente: 'var(--accent)', tercero: 'var(--orange)' };

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Garantias() {
  const ctx = useContextoActivo();
  const [items, setItems] = useState<Garantia[]>([]);
  const [causas, setCausas] = useState<CausaGarantia[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [instalaciones, setInstalaciones] = useState<Instalacion[]>([]);
  const [sistemas, setSistemas] = useState<{ codigo: string; nombre: string }[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Garantia | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try {
      const [g, c, cot, inst, sis] = await Promise.all([
        fetchGarantiasPorPersona(ctx.personaActivaId),
        fetchCausasGarantia(),
        fetchCotizacionesPorPersona(ctx.personaActivaId),
        fetchInstalacionesPorPersona(ctx.personaActivaId),
        fetchSistemasSafra(),
      ]);
      setItems(g); setCausas(c); setCotizaciones(cot); setInstalaciones(inst); setSistemas(sis);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  function fb(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg }); setTimeout(() => setFeedback(null), 3000);
  }

  const stats = {
    total: items.length,
    abiertas: items.filter(g => g.estado === 'abierta' || g.estado === 'en_diagnostico' || g.estado === 'en_reparacion').length,
    empresa: items.filter(g => g.responsable === 'empresa').length,
    cliente: items.filter(g => g.responsable === 'cliente').length,
    costo_empresa: items.filter(g => g.responsable === 'empresa').reduce((s, g) => s + Number(g.costo ?? 0), 0),
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Garantías de {ctx.personaActivaNombre} ({stats.total})
        </h2>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Abrir garantía</button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Cada causa determina el responsable por defecto (producto→empresa, cliente→cliente, etc.).
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="⚠ Abiertas"      valor={stats.abiertas} color="var(--orange)" />
        <KPI label="🏢 Empresa"       valor={stats.empresa}  color="var(--red)" />
        <KPI label="👤 Cliente"       valor={stats.cliente}  color="var(--accent)" />
        <KPI label="$ Costo empresa"  valor={fmtCop(stats.costo_empresa)} color="var(--red)" />
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && items.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin garantías para {ctx.personaActivaNombre} (lo cual es bueno).
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {items.map(g => {
          const causa = causas.find(c => c.codigo === g.causa_codigo);
          const sis = g.sistema_safra_codigo ? sistemas.find(s => s.codigo === g.sistema_safra_codigo) : null;
          return (
            <button key={g.id} onClick={() => setEditando(g)} style={{
              width: '100%', textAlign: 'left', background: 'var(--bg-panel)',
              border: `1px solid ${ESTADO_COLOR[g.estado]}`, borderRadius: 8, padding: 14, cursor: 'pointer',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <strong style={{ fontSize: 13 }}>
                  {causa?.nombre ?? g.causa_codigo}
                  {sis && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {sis.nombre}</span>}
                </strong>
                <span style={{ fontSize: 10, fontWeight: 700, color: ESTADO_COLOR[g.estado], textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {ESTADO_LABEL[g.estado]}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                <span>Abierta: {fmtFecha(g.fecha_apertura)}</span>
                {g.responsable && (
                  <span>Resp: <strong style={{ color: RESPONSABLE_COLOR[g.responsable] }}>{g.responsable}</strong></span>
                )}
                {Number(g.costo) > 0 && <span>Costo: {fmtCop(Number(g.costo))}</span>}
                {g.fecha_cierre && <span>Cierre: {fmtFecha(g.fecha_cierre)}</span>}
              </div>
              {g.solucion && <div style={{ fontSize: 12, marginTop: 6 }}>→ {g.solucion}</div>}
            </button>
          );
        })}
      </div>

      {(editando || creando) && (
        <ModalGarantia
          garantia={editando}
          causas={causas}
          cotizaciones={cotizaciones}
          instalaciones={instalaciones}
          sistemas={sistemas}
          personaId={ctx.personaActivaId!}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await recargar(); fb('ok', msg); }}
          onError={(msg) => fb('err', msg)}
        />
      )}
    </div>
  );
}

function ModalGarantia({ garantia, causas, cotizaciones, instalaciones, sistemas, personaId, onClose, onDone, onError }: {
  garantia: Garantia | null;
  causas: CausaGarantia[];
  cotizaciones: Cotizacion[];
  instalaciones: Instalacion[];
  sistemas: { codigo: string; nombre: string }[];
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<Garantia> = garantia ?? {
    persona_id: personaId,
    cotizacion_id: cotizaciones[0]?.id ?? null,
    instalacion_id: null,
    sistema_safra_codigo: null,
    fecha_apertura: new Date().toISOString().slice(0, 10),
    causa_codigo: causas[0]?.codigo ?? 'producto',
    responsable: null,    // se auto-llena por trigger
    costo: 0,
    solucion: null,
    estado: 'abierta',
    notas: null,
  };
  const [form, setForm] = useState<Partial<Garantia>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  // Cuando cambia la causa, mostrar el responsable_default
  const causaSel = causas.find(c => c.codigo === form.causa_codigo);

  async function guardar() {
    if (!form.causa_codigo) { onError('Causa obligatoria'); return; }
    setAplicando(true);
    try {
      if (garantia) {
        await actualizarGarantia(garantia.id, form);
        onDone('Garantía actualizada');
      } else {
        await crearGarantia({
          persona_id: personaId,
          cotizacion_id: form.cotizacion_id ?? null,
          instalacion_id: form.instalacion_id ?? null,
          sistema_safra_codigo: form.sistema_safra_codigo ?? null,
          fecha_apertura: form.fecha_apertura,
          causa_codigo: form.causa_codigo!,
          responsable: form.responsable ?? null,
          costo: Number(form.costo ?? 0),
          solucion: form.solucion,
          estado: form.estado ?? 'abierta',
          notas: form.notas,
        });
        onDone('Garantía abierta');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!garantia) return;
    if (!confirm(`¿Eliminar esta garantía? Soft-delete.`)) return;
    try { await eliminarGarantia(garantia.id); onDone('Garantía eliminada'); }
    catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {garantia ? 'Editar garantía' : 'Abrir garantía'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <Field label="Causa *">
            <select value={form.causa_codigo ?? ''} onChange={e => setForm({ ...form, causa_codigo: e.target.value })} style={inp}>
              {causas.map(c => <option key={c.codigo} value={c.codigo}>{c.nombre}</option>)}
            </select>
          </Field>
          <Field label={`Responsable ${!form.responsable && causaSel ? `(default: ${causaSel.responsable_default})` : ''}`}>
            <select value={form.responsable ?? ''} onChange={e => setForm({ ...form, responsable: (e.target.value || null) as any })} style={inp}>
              <option value="">— Auto ({causaSel?.responsable_default ?? '?'}) —</option>
              <option value="empresa">Empresa</option>
              <option value="cliente">Cliente</option>
              <option value="tercero">Tercero</option>
            </select>
          </Field>
          <Field label="Sistema (producto que falló)">
            <select value={form.sistema_safra_codigo ?? ''} onChange={e => setForm({ ...form, sistema_safra_codigo: e.target.value || null })} style={inp}>
              <option value="">—</option>
              {sistemas.map(s => <option key={s.codigo} value={s.codigo}>{s.nombre}</option>)}
            </select>
          </Field>
          <Field label="Estado">
            <select value={form.estado ?? 'abierta'} onChange={e => setForm({ ...form, estado: e.target.value as EstadoGarantia })} style={inp}>
              {ESTADOS.map(e => <option key={e.codigo} value={e.codigo}>{e.label}</option>)}
            </select>
          </Field>
          <Field label="Fecha apertura">
            <input type="date" value={form.fecha_apertura ?? ''} onChange={e => setForm({ ...form, fecha_apertura: e.target.value })} style={inp} />
          </Field>
          <Field label="Costo (COP)">
            <input type="number" min={0} step={1} value={form.costo ?? 0} onChange={e => setForm({ ...form, costo: Number(e.target.value) })} style={inp} />
          </Field>
          <Field label="Cotización">
            <select value={form.cotizacion_id ?? ''} onChange={e => setForm({ ...form, cotizacion_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">—</option>
              {cotizaciones.map(c => <option key={c.id} value={c.id}>{c.numero_cotizacion ?? '#' + c.id}</option>)}
            </select>
          </Field>
          <Field label="Instalación">
            <select value={form.instalacion_id ?? ''} onChange={e => setForm({ ...form, instalacion_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">—</option>
              {instalaciones.map(i => <option key={i.id} value={i.id}>{i.fecha_programada} · {i.instalador ?? ''}</option>)}
            </select>
          </Field>
        </div>

        <Field label="Solución / acción tomada">
          <textarea rows={2} value={form.solucion ?? ''} onChange={e => setForm({ ...form, solucion: e.target.value || null })}
            placeholder='ej. "Cambio de cadenilla. Repuesto por cuenta de la empresa."' style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        <Field label="Notas internas">
          <textarea rows={2} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })} style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        {causaSel && (
          <div style={{ padding: 8, background: 'var(--bg-page)', borderRadius: 6, marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
            ℹ Causa <strong>{causaSel.nombre}</strong>: responsable por defecto <strong>{causaSel.responsable_default}</strong>. {causaSel.notas}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {garantia ? <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button> : <span />}
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
