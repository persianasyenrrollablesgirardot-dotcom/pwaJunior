/**
 * 5.5 Tareas — pendientes del cliente activo.
 * Tipos: llamar, enviar_cotizacion, confirmar_pago, pedir_ficha,
 * agendar_instalacion, reclamar_proveedor, pedir_resena, otro.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchTareasPorPersona, crearTarea, actualizarTarea, eliminarTarea,
  TIPOS_TAREA, type TipoTarea, type Tarea,
} from '../../lib/queries';

const TIPO_LABEL: Record<TipoTarea, string> = {
  llamar: '📞 Llamar',
  enviar_cotizacion: '📤 Enviar cotización',
  confirmar_pago: '💵 Confirmar pago',
  pedir_ficha: '📄 Pedir ficha técnica',
  agendar_instalacion: '📅 Agendar instalación',
  reclamar_proveedor: '⚠ Reclamar proveedor',
  pedir_resena: '⭐ Pedir reseña',
  otro: '· Otro',
};

const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }) : '—';

export function Tareas() {
  const ctx = useContextoActivo();
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [verCompletadas, setVerCompletadas] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Tarea | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try { setTareas(await fetchTareasPorPersona(ctx.personaActivaId, verCompletadas)); }
    catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId, verCompletadas]);

  function fb(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 3000);
  }

  async function toggleCompletar(t: Tarea) {
    try {
      await actualizarTarea(t.id, { completada: !t.completada });
      await recargar();
      fb('ok', t.completada ? 'Reabierta' : 'Completada');
    } catch (e: any) { fb('err', e.message); }
  }

  const stats = {
    total: tareas.length,
    pendientes: tareas.filter(t => !t.completada).length,
    completadas: tareas.filter(t => t.completada).length,
    vencidas: tareas.filter(t => !t.completada && t.fecha_vence && t.fecha_vence < new Date().toISOString().slice(0, 10)).length,
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Tareas de {ctx.personaActivaNombre} ({stats.total})
        </h2>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Nueva tarea</button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Pendientes (llamar, enviar, confirmar pago, reclamar proveedor…). Click en card para editar.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <KPI label="⏳ Pendientes" valor={stats.pendientes}  color="var(--orange)" />
        <KPI label="✓ Completadas" valor={stats.completadas} color="var(--green)" />
        <KPI label="⌛ Vencidas"    valor={stats.vencidas}    color="var(--red)" />
        <label style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, cursor: 'pointer' }}>
          <input type="checkbox" checked={verCompletadas} onChange={e => setVerCompletadas(e.target.checked)} />
          Ver completadas
        </label>
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && tareas.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin tareas {verCompletadas ? '' : 'pendientes'} para {ctx.personaActivaNombre}.
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {tareas.map(t => {
          const vencida = !t.completada && t.fecha_vence && t.fecha_vence < new Date().toISOString().slice(0, 10);
          return (
            <div key={t.id} style={{
              background: 'var(--bg-panel)',
              border: `1px solid ${vencida ? 'var(--red)' : t.completada ? 'var(--green)' : 'var(--border-soft)'}`,
              borderRadius: 8, padding: 12,
              opacity: t.completada ? 0.6 : 1,
            }}>
              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={t.completada} onChange={() => toggleCompletar(t)} style={{ marginTop: 2, cursor: 'pointer' }} />
                <button onClick={() => setEditando(t)} style={{ flex: 1, background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer', padding: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <strong style={{ fontSize: 13, textDecoration: t.completada ? 'line-through' : 'none' }}>{t.titulo}</strong>
                    <span style={{ fontSize: 11, color: vencida ? 'var(--red)' : 'var(--text-muted)' }}>
                      {t.fecha_vence ? fmtFecha(t.fecha_vence) : 'Sin fecha'}
                      {t.hora_vence && ` · ${t.hora_vence.slice(0, 5)}`}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {TIPO_LABEL[t.tipo]}
                    {t.asignado_a && <> · 👷 {t.asignado_a}</>}
                    {t.prioridad < 5 && <span style={{ color: 'var(--red)' }}> · ★ prioridad {t.prioridad}</span>}
                    {t.origen !== 'manual' && <span style={{ color: 'var(--accent)' }}> · origen: {t.origen}</span>}
                  </div>
                  {t.descripcion && <div style={{ fontSize: 12, marginTop: 4 }}>{t.descripcion}</div>}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {(editando || creando) && (
        <ModalTarea
          tarea={editando}
          personaId={ctx.personaActivaId!}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await recargar(); fb('ok', msg); }}
          onError={(msg) => fb('err', msg)}
        />
      )}
    </div>
  );
}

function ModalTarea({ tarea, personaId, onClose, onDone, onError }: {
  tarea: Tarea | null;
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<Tarea> = tarea ?? {
    persona_id: personaId,
    titulo: '',
    descripcion: null,
    tipo: 'otro',
    fecha_vence: null,
    hora_vence: null,
    asignado_a: 'jhon',
    prioridad: 5,
    origen: 'manual',
  };
  const [form, setForm] = useState<Partial<Tarea>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    if (!form.titulo?.trim()) { onError('Título obligatorio'); return; }
    setAplicando(true);
    try {
      if (tarea) {
        await actualizarTarea(tarea.id, form);
        onDone('Tarea actualizada');
      } else {
        await crearTarea({
          persona_id: personaId,
          titulo: form.titulo!,
          descripcion: form.descripcion,
          tipo: form.tipo as TipoTarea,
          fecha_vence: form.fecha_vence,
          hora_vence: form.hora_vence,
          asignado_a: form.asignado_a,
          prioridad: form.prioridad ?? 5,
          origen: 'manual',
        });
        onDone('Tarea creada');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!tarea) return;
    if (!confirm('¿Eliminar esta tarea?')) return;
    try { await eliminarTarea(tarea.id); onDone('Tarea eliminada'); }
    catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {tarea ? 'Editar tarea' : 'Nueva tarea'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <Field label="Título *">
          <input value={form.titulo ?? ''} onChange={e => setForm({ ...form, titulo: e.target.value })} placeholder="ej. Llamar para confirmar abono Bancolombia" style={inp} />
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 4 }}>
          <Field label="Tipo">
            <select value={form.tipo ?? 'otro'} onChange={e => setForm({ ...form, tipo: e.target.value as TipoTarea })} style={inp}>
              {TIPOS_TAREA.map(t => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="Asignado a">
            <input value={form.asignado_a ?? ''} onChange={e => setForm({ ...form, asignado_a: e.target.value || null })} placeholder="ej. jhon, instalador Pedro" style={inp} />
          </Field>
          <Field label="Fecha vence">
            <input type="date" value={form.fecha_vence ?? ''} onChange={e => setForm({ ...form, fecha_vence: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Hora vence">
            <input type="time" value={form.hora_vence ?? ''} onChange={e => setForm({ ...form, hora_vence: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Prioridad (1=alta, 10=baja)">
            <input type="number" min={1} max={10} value={form.prioridad ?? 5} onChange={e => setForm({ ...form, prioridad: Number(e.target.value) })} style={inp} />
          </Field>
        </div>

        <Field label="Descripción">
          <textarea rows={2} value={form.descripcion ?? ''} onChange={e => setForm({ ...form, descripcion: e.target.value || null })} style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {tarea ? <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button> : <span />}
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
const modalBox: React.CSSProperties = { background: 'white', borderRadius: 10, padding: 24, width: '90%', maxWidth: 560, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
