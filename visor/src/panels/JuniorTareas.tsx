/**
 * Junior → pestaña Tareas (TRANSVERSALES — sin cliente vinculado).
 *
 * Modelo conceptual:
 *   - Tareas DEL CLIENTE (persona_id != null) → viven en M5 del cliente.
 *     Las generan los agentes (A_SINTESIS_M5, A7_TAREAS) y son pendientes
 *     operativos del flujo de ese cliente. NO aparecen acá.
 *   - Tareas TRANSVERSALES (persona_id IS NULL) → viven acá. Son acciones
 *     personales / cross-cliente / con terceros (proveedores, instaladores,
 *     contadora, etc.). Las creás vos a mano o dictándoselas a Junior por
 *     chat.
 *
 * Junior por chat sí ve AMBAS y te las gestiona — pero acá solo se listan
 * las transversales para que no se mezclen con el flujo de cada cliente.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  fetchTareasTransversales, fetchPersonasMinimo,
  crearTarea, actualizarTarea, eliminarTarea,
  TIPOS_TAREA, type TipoTarea, type Tarea,
} from '../lib/queries';

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

const fmtFecha = (s: string | null | undefined) =>
  s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }) : '—';

type GrupoKey = 'vencidas' | 'hoy' | 'proximos' | 'sin_fecha' | 'completadas';
const GRUPO_META: Record<GrupoKey, { titulo: string; icono: string; color: string }> = {
  vencidas:    { titulo: 'Vencidas',           icono: '🔥', color: '#dc2626' },
  hoy:         { titulo: 'Vencen hoy',         icono: '⏰', color: '#ea580c' },
  proximos:    { titulo: 'Próximos días',      icono: '📅', color: '#2563eb' },
  sin_fecha:   { titulo: 'Sin fecha',          icono: '📌', color: '#6b7280' },
  completadas: { titulo: 'Hechas (recientes)', icono: '✓',  color: '#16a34a' },
};

type Filtro = 'pendientes' | 'todas' | 'hechas';

export function JuniorTareas() {
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [personas, setPersonas] = useState<{ id: number; nombre: string | null }[]>([]);
  const [filtro, setFiltro] = useState<Filtro>('pendientes');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<Tarea | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    setCargando(true); setError(null);
    try {
      const verCompletadas = filtro !== 'pendientes';
      setTareas(await fetchTareasTransversales(verCompletadas));
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [filtro]);
  useEffect(() => { fetchPersonasMinimo().then(setPersonas).catch(() => {}); }, []);

  function fb(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 3500);
  }

  async function toggleCompletar(t: Tarea) {
    try {
      await actualizarTarea(t.id, { completada: !t.completada });
      await recargar();
      fb('ok', t.completada ? 'Reabierta' : 'Marcada como hecha');
    } catch (e: any) { fb('err', e.message); }
  }

  const grupos = useMemo(() => {
    const hoyStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const en7 = new Date(); en7.setDate(en7.getDate() + 7);
    const en7Str = en7.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const g: Record<GrupoKey, Tarea[]> = { vencidas: [], hoy: [], proximos: [], sin_fecha: [], completadas: [] };
    for (const t of tareas) {
      if (filtro === 'hechas' && !t.completada) continue;
      if (filtro === 'pendientes' && t.completada) continue;
      if (t.completada) { g.completadas.push(t); continue; }
      if (!t.fecha_vence) { g.sin_fecha.push(t); continue; }
      if (t.fecha_vence < hoyStr) g.vencidas.push(t);
      else if (t.fecha_vence === hoyStr) g.hoy.push(t);
      else if (t.fecha_vence <= en7Str) g.proximos.push(t);
      else g.sin_fecha.push(t);
    }
    return g;
  }, [tareas, filtro]);

  const totalVisibles = (Object.keys(grupos) as GrupoKey[]).reduce((s, k) => s + grupos[k].length, 0);

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>📋 Tareas transversales ({totalVisibles})</h2>
          <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
            Acciones SIN cliente vinculado: cosas tuyas, con terceros (proveedores, instaladores,
            contadora) o cross-cliente. Las tareas DE cada cliente viven en M5 del cliente.
          </p>
        </div>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Nueva tarea</button>
      </div>

      <div style={{ display: 'flex', gap: 4, marginBottom: 12 }}>
        {(['pendientes', 'hechas', 'todas'] as Filtro[]).map(f => {
          const activo = filtro === f;
          return (
            <button key={f} onClick={() => setFiltro(f)} style={{
              padding: '5px 11px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
              border: `1px solid ${activo ? 'var(--accent)' : 'var(--border)'}`,
              background: activo ? 'var(--accent-soft)' : 'var(--bg-page)',
              color: activo ? 'var(--accent)' : 'var(--text)',
              fontWeight: activo ? 600 : 400,
            }}>{f === 'pendientes' ? 'Por hacer' : f === 'hechas' ? 'Hechas' : 'Todas'}</button>
          );
        })}
      </div>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? '#1a7f37' : 'var(--red)' }}>{feedback.msg}</div>
      )}
      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && totalVisibles === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin tareas transversales {filtro === 'pendientes' ? 'pendientes' : filtro === 'hechas' ? 'hechas' : ''}.
          <br /><br />
          Decile a Junior por el chat algo como <strong>"agendame llamar al proveedor de telas mañana 10am"</strong>
          {' '}o usá <strong>"+ Nueva tarea"</strong>.
        </div>
      )}

      {(Object.keys(grupos) as GrupoKey[]).map(k => {
        const items = grupos[k];
        if (items.length === 0) return null;
        const m = GRUPO_META[k];
        return (
          <div key={k} style={{ marginBottom: 18 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, color: m.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {m.icono} {m.titulo} ({items.length})
            </h3>
            <div style={{ display: 'grid', gap: 6 }}>
              {items.map(t => (
                <TareaRow key={t.id} tarea={t} onToggle={toggleCompletar} onEdit={setEditando} />
              ))}
            </div>
          </div>
        );
      })}

      {(editando || creando) && (
        <ModalTareaTransversal
          tarea={editando}
          personas={personas}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await recargar(); fb('ok', msg); }}
          onError={(msg) => fb('err', msg)}
        />
      )}
    </div>
  );
}

function TareaRow({ tarea, onToggle, onEdit }: {
  tarea: Tarea;
  onToggle: (t: Tarea) => void;
  onEdit: (t: Tarea) => void;
}) {
  const hoyStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const vencida = !tarea.completada && tarea.fecha_vence && tarea.fecha_vence < hoyStr;
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: `1px solid ${vencida ? '#fca5a5' : tarea.completada ? '#bbf7d0' : 'var(--border-soft)'}`,
      borderRadius: 8, padding: '10px 12px',
      opacity: tarea.completada ? 0.65 : 1,
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={tarea.completada} onChange={() => onToggle(tarea)} style={{ marginTop: 3, cursor: 'pointer', flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
            <button onClick={() => onEdit(tarea)} style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left', flex: 1, minWidth: 0 }}>
              <strong style={{ fontSize: 13, textDecoration: tarea.completada ? 'line-through' : 'none', color: 'var(--text)' }}>
                {tarea.titulo}
              </strong>
            </button>
            <span style={{ fontSize: 11, color: vencida ? 'var(--red)' : 'var(--text-muted)', flexShrink: 0 }}>
              {tarea.fecha_vence ? fmtFecha(tarea.fecha_vence) : 'Sin fecha'}
              {tarea.hora_vence && ` · ${tarea.hora_vence.slice(0, 5)}`}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <span>{TIPO_LABEL[tarea.tipo]}</span>
            {tarea.asignado_a && <span>👤 {tarea.asignado_a}</span>}
            {tarea.prioridad < 5 && <span style={{ color: 'var(--red)' }}>★ prioridad {tarea.prioridad}</span>}
            {tarea.origen && tarea.origen !== 'manual' && <span style={{ color: 'var(--accent)' }}>origen: {tarea.origen}</span>}
          </div>
          {tarea.descripcion && <div style={{ fontSize: 12, marginTop: 5, color: 'var(--text-muted)' }}>{tarea.descripcion}</div>}
        </div>
      </div>
    </div>
  );
}

function ModalTareaTransversal({ tarea, personas, onClose, onDone, onError }: {
  tarea: Tarea | null;
  personas: { id: number; nombre: string | null }[];
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<Tarea> = tarea ?? {
    persona_id: null,
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
        onDone(form.persona_id ? 'Tarea actualizada (movida al M5 del cliente)' : 'Tarea actualizada');
      } else {
        await crearTarea({
          persona_id: form.persona_id ?? null,
          titulo: form.titulo!,
          descripcion: form.descripcion,
          tipo: form.tipo as TipoTarea,
          fecha_vence: form.fecha_vence,
          hora_vence: form.hora_vence,
          asignado_a: form.asignado_a,
          prioridad: form.prioridad ?? 5,
          origen: 'manual',
        });
        onDone(form.persona_id ? 'Tarea creada (va al M5 del cliente)' : 'Tarea transversal creada');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!tarea) return;
    if (!confirm('¿Eliminar esta tarea?')) return;
    try { await eliminarTarea(tarea.id); onDone('Tarea eliminada'); }
    catch (e: any) { onError(e.message); }
  }

  const haraMoverAClienteM5 = !!form.persona_id;

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {tarea ? 'Editar tarea' : 'Nueva tarea transversal'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <Field label="Título *">
          <input value={form.titulo ?? ''} onChange={e => setForm({ ...form, titulo: e.target.value })} placeholder="ej. Llamar al proveedor de telas" style={inp} autoFocus />
        </Field>

        <Field label="Cliente (opcional · si seleccionás, se mueve a M5 del cliente)">
          <select value={form.persona_id ?? ''} onChange={e => setForm({ ...form, persona_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
            <option value="">— sin cliente (queda transversal acá) —</option>
            {personas.map(p => <option key={p.id} value={p.id}>{p.nombre ?? `persona ${p.id}`}</option>)}
          </select>
          {haraMoverAClienteM5 && (
            <div style={{ marginTop: 4, padding: '6px 10px', background: '#fff7ed', border: '1px solid #fb923c', borderRadius: 6, fontSize: 11, color: '#9a3412' }}>
              ⚠ Si guardás con un cliente seleccionado, esta tarea va al <strong>M5 del cliente</strong> y deja de aparecer en esta pestaña.
            </div>
          )}
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Tipo">
            <select value={form.tipo ?? 'otro'} onChange={e => setForm({ ...form, tipo: e.target.value as TipoTarea })} style={inp}>
              {TIPOS_TAREA.map(t => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="Asignado a">
            <input value={form.asignado_a ?? ''} onChange={e => setForm({ ...form, asignado_a: e.target.value || null })} placeholder="jhon, instalador Pedro…" style={inp} />
          </Field>
          <Field label="Vence (fecha)">
            <input type="date" value={form.fecha_vence ?? ''} onChange={e => setForm({ ...form, fecha_vence: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Vence (hora)">
            <input type="time" value={form.hora_vence ?? ''} onChange={e => setForm({ ...form, hora_vence: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Prioridad (1=urgente, 9=baja)">
            <input type="number" min={1} max={9} value={form.prioridad ?? 5} onChange={e => setForm({ ...form, prioridad: Number(e.target.value) })} style={inp} />
          </Field>
        </div>

        <Field label="Descripción (opcional)">
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 6 }}>
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
