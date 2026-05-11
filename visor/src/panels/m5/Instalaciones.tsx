/**
 * 5.2 Instalaciones — CRUD visitas del cliente activo.
 * Resultados: completa, parcial, fallida, reagendada.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchInstalacionesPorPersona, crearInstalacion, actualizarInstalacion, eliminarInstalacion,
  fetchCotizacionesPorPersona, fetchZonas,
  type Instalacion, type Cotizacion, type Zona, type ResultadoInstalacion,
} from '../../lib/queries';

const RESULTADO_LABEL: Record<ResultadoInstalacion, string> = {
  completa: 'Completa', parcial: 'Parcial', fallida: 'Fallida', reagendada: 'Reagendada',
};
const RESULTADO_COLOR: Record<ResultadoInstalacion, string> = {
  completa: '#34c759', parcial: '#ff9500', fallida: '#ff3b30', reagendada: '#5856d6',
};

const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Instalaciones() {
  const ctx = useContextoActivo();
  const [items, setItems] = useState<Instalacion[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [zonas, setZonas] = useState<Zona[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Instalacion | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try {
      const [i, c, z] = await Promise.all([
        fetchInstalacionesPorPersona(ctx.personaActivaId),
        fetchCotizacionesPorPersona(ctx.personaActivaId),
        fetchZonas(),
      ]);
      setItems(i); setCotizaciones(c); setZonas(z);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  function fb(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 3000);
  }

  const stats = {
    total: items.length,
    programadas: items.filter(i => !i.resultado).length,
    completas: items.filter(i => i.resultado === 'completa').length,
    fallidas: items.filter(i => i.resultado === 'fallida').length,
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Instalaciones de {ctx.personaActivaNombre} ({stats.total})
        </h2>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Programar visita</button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Cada cotización puede tener varias visitas (parcial, fallida, reagendada). Click en card para editar.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}
      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="⏳ Programadas" valor={stats.programadas} color="var(--orange)" />
        <KPI label="✓ Completas"    valor={stats.completas}   color="var(--green)" />
        <KPI label="✗ Fallidas"     valor={stats.fallidas}    color="var(--red)" />
      </div>

      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && items.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin instalaciones para {ctx.personaActivaNombre}. Click <strong>"+ Programar visita"</strong>.
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {items.map(i => {
          const cot = i.cotizacion_id ? cotizaciones.find(c => c.id === i.cotizacion_id) : null;
          const zona = i.zona_codigo ? zonas.find(z => z.codigo === i.zona_codigo) : null;
          return (
            <button key={i.id} onClick={() => setEditando(i)}
              style={{
                width: '100%', textAlign: 'left',
                background: 'var(--bg-panel)',
                border: `1px solid ${i.resultado ? RESULTADO_COLOR[i.resultado] : 'var(--border-soft)'}`,
                borderRadius: 8, padding: 14, cursor: 'pointer',
              }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <strong>
                  {fmtFecha(i.fecha_programada)}{i.hora_programada && ` · ${i.hora_programada.slice(0, 5)}`}
                </strong>
                <span style={{ fontSize: 10, fontWeight: 700, color: i.resultado ? RESULTADO_COLOR[i.resultado] : 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {i.resultado ? RESULTADO_LABEL[i.resultado] : 'Programada'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
                {cot && <span>📋 {cot.numero_cotizacion ?? '#' + cot.id}</span>}
                {zona && <span>📍 {zona.nombre}</span>}
                {i.instalador && <span>👷 {i.instalador}</span>}
                {i.recibido_por_cliente && <span style={{ color: 'var(--green)' }}>✓ Recibido</span>}
                {i.resena_pedida && <span style={{ color: 'var(--accent)' }}>⭐ Reseña pedida</span>}
              </div>
              {(i.pendientes || i.incidencias) && (
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  {i.pendientes && <div>⏳ Pendientes: {i.pendientes}</div>}
                  {i.incidencias && <div>⚠ Incidencias: {i.incidencias}</div>}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {(editando || creando) && (
        <ModalInstalacion
          inst={editando}
          cotizaciones={cotizaciones}
          zonas={zonas}
          personaId={ctx.personaActivaId!}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await recargar(); fb('ok', msg); }}
          onError={(msg) => fb('err', msg)}
        />
      )}
    </div>
  );
}

function ModalInstalacion({ inst, cotizaciones, zonas, personaId, onClose, onDone, onError }: {
  inst: Instalacion | null;
  cotizaciones: Cotizacion[];
  zonas: Zona[];
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<Instalacion> = inst ?? {
    cotizacion_id: cotizaciones[0]?.id ?? null,
    persona_id: personaId,
    zona_codigo: 'girardot_urbano',
    fecha_programada: new Date().toISOString().slice(0, 10),
    hora_programada: '08:00',
    instalador: null,
    resultado: null,
    pendientes: null,
    incidencias: null,
    recibido_por_cliente: false,
    saldo_cobrado: null,
    resena_pedida: false,
    notas: null,
  };
  const [form, setForm] = useState<Partial<Instalacion>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    if (!form.fecha_programada) { onError('Fecha programada obligatoria'); return; }
    setAplicando(true);
    try {
      if (inst) {
        await actualizarInstalacion(inst.id, form);
        onDone('Instalación actualizada');
      } else {
        await crearInstalacion({
          cotizacion_id: form.cotizacion_id ?? null,
          persona_id: personaId,
          zona_codigo: form.zona_codigo ?? null,
          fecha_programada: form.fecha_programada!,
          hora_programada: form.hora_programada ?? null,
          instalador: form.instalador ?? null,
          notas: form.notas ?? null,
        });
        onDone('Instalación programada (checklist auto-generado)');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!inst) return;
    if (!confirm('¿Eliminar esta instalación? Soft-delete recuperable.')) return;
    try { await eliminarInstalacion(inst.id); onDone('Instalación eliminada'); }
    catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {inst ? 'Editar instalación' : 'Programar instalación'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <Field label="Cotización">
            <select value={form.cotizacion_id ?? ''} onChange={e => setForm({ ...form, cotizacion_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
              <option value="">— Ninguna —</option>
              {cotizaciones.map(c => (
                <option key={c.id} value={c.id}>{c.numero_cotizacion ?? '#' + c.id} · {c.estado}</option>
              ))}
            </select>
          </Field>
          <Field label="Zona">
            <select value={form.zona_codigo ?? ''} onChange={e => setForm({ ...form, zona_codigo: e.target.value || null })} style={inp}>
              <option value="">—</option>
              {zonas.map(z => <option key={z.codigo} value={z.codigo}>{z.nombre}</option>)}
            </select>
          </Field>
          <Field label="Fecha programada *">
            <input type="date" value={form.fecha_programada ?? ''} onChange={e => setForm({ ...form, fecha_programada: e.target.value })} style={inp} />
          </Field>
          <Field label="Hora programada">
            <input type="time" value={form.hora_programada ?? ''} onChange={e => setForm({ ...form, hora_programada: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Instalador">
            <input value={form.instalador ?? ''} onChange={e => setForm({ ...form, instalador: e.target.value || null })} placeholder="Jhon, Pedro, etc." style={inp} />
          </Field>
          {inst && (
            <Field label="Resultado">
              <select value={form.resultado ?? ''} onChange={e => setForm({ ...form, resultado: (e.target.value || null) as any })} style={inp}>
                <option value="">— Aún programada —</option>
                <option value="completa">✓ Completa</option>
                <option value="parcial">⚠ Parcial</option>
                <option value="fallida">✗ Fallida</option>
                <option value="reagendada">→ Reagendada</option>
              </select>
            </Field>
          )}
          {inst && (
            <>
              <Field label="Fecha real">
                <input type="date" value={form.fecha_real ?? ''} onChange={e => setForm({ ...form, fecha_real: e.target.value || null })} style={inp} />
              </Field>
              <Field label="Saldo cobrado en visita">
                <input type="number" min={0} value={form.saldo_cobrado ?? ''} onChange={e => setForm({ ...form, saldo_cobrado: e.target.value === '' ? null : Number(e.target.value) })} style={inp} />
              </Field>
            </>
          )}
        </div>

        {inst && (
          <>
            <Field label="Pendientes (si quedó parcial)">
              <textarea rows={2} value={form.pendientes ?? ''} onChange={e => setForm({ ...form, pendientes: e.target.value || null })}
                placeholder="ej. Falta motor del comedor por instalar la próxima visita." style={{ ...inp, fontFamily: 'inherit' }} />
            </Field>
            <Field label="Incidencias">
              <textarea rows={2} value={form.incidencias ?? ''} onChange={e => setForm({ ...form, incidencias: e.target.value || null })}
                placeholder="ej. Vano más grande que la medida, cliente no estaba." style={{ ...inp, fontFamily: 'inherit' }} />
            </Field>

            <div style={{ display: 'flex', gap: 16, marginTop: 10, marginBottom: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.recibido_por_cliente ?? false} onChange={e => setForm({ ...form, recibido_por_cliente: e.target.checked })} />
                Recibido por cliente
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
                <input type="checkbox" checked={form.resena_pedida ?? false} onChange={e => setForm({ ...form, resena_pedida: e.target.checked })} />
                Reseña pedida
              </label>
            </div>
          </>
        )}

        <Field label="Notas">
          <textarea rows={2} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })} style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        {!inst && (
          <div style={{ padding: 10, background: 'var(--bg-page)', borderRadius: 6, marginTop: 12, fontSize: 11, color: 'var(--text-muted)' }}>
            ℹ Al crear la instalación se auto-genera el checklist (15 items default según VISION). Lo ves en sub-tab <strong>5.6 Checklist</strong>.
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {inst ? <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button> : <span />}
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
