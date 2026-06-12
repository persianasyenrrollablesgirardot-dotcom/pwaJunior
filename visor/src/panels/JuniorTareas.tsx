/**
 * Junior → pestaña Tareas — VISTA UNIFICADA de TODAS las tareas.
 *
 * Muestra tareas DEL CLIENTE (persona_id != null) Y transversales (null),
 * con el nombre del cliente visible. Polling cada 5s para reflejar
 * lo que Junior crea en tiempo real desde el chat.
 *
 * Junior tiene control total: ve todo, puede completar desde el chat,
 * y puede auto-supervisar su trabajo pidiendo un resumen de pendientes.
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  fetchTareasGlobalConPersona, fetchPersonasMinimo,
  crearTarea, actualizarTarea, eliminarTarea,
  TIPOS_TAREA, type TipoTarea, type TareaConPersona,
} from '../lib/queries';

const TIPO_LABEL: Record<TipoTarea, string> = {
  llamar: '📞 Llamar',
  enviar_cotizacion: '📤 Cotización',
  confirmar_pago: '💵 Confirmar pago',
  pedir_ficha: '📄 Ficha técnica',
  agendar_instalacion: '📅 Instalación',
  reclamar_proveedor: '⚠ Proveedor',
  pedir_resena: '⭐ Reseña',
  otro: '· Otro',
};

const fmtFecha = (s: string | null | undefined) =>
  s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }) : '—';

type GrupoKey = 'vencidas' | 'hoy' | 'proximos' | 'sin_fecha' | 'completadas';

type Filtro = 'pendientes' | 'todas' | 'hechas';
type Alcance = 'todas' | 'clientes' | 'transversales';

export function JuniorTareas() {
  const [tareas, setTareas] = useState<TareaConPersona[]>([]);
  const [personas, setPersonas] = useState<{ id: number; nombre: string | null }[]>([]);
  const [filtro, setFiltro] = useState<Filtro>('pendientes');
  const [alcance, setAlcance] = useState<Alcance>('todas');
  const [cargando, setCargando] = useState(true);
  const [ultimaActualizacion, setUltimaActualizacion] = useState<Date>(new Date());
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<TareaConPersona | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  const cargar = useCallback(async (silencioso = false) => {
    if (!silencioso) setCargando(true);
    setError(null);
    try {
      const verCompletadas = filtro !== 'pendientes';
      setTareas(await fetchTareasGlobalConPersona(verCompletadas));
      setUltimaActualizacion(new Date());
    } catch (e: any) { setError(e.message); }
    finally { if (!silencioso) setCargando(false); }
  }, [filtro]);

  // Carga inicial + polling cada 5s para reflejar tareas creadas por Junior
  useEffect(() => {
    cargar();
    const t = setInterval(() => cargar(true), 5000);
    return () => clearInterval(t);
  }, [cargar]);

  useEffect(() => { fetchPersonasMinimo().then(setPersonas).catch(() => {}); }, []);

  function fb(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 4000);
  }

  async function toggleCompletar(t: TareaConPersona) {
    try {
      await actualizarTarea(t.id, { completada: !t.completada });
      await cargar();
      fb('ok', t.completada ? 'Tarea reabierta' : '✓ Marcada como hecha');
    } catch (e: any) { fb('err', e.message); }
  }

  // Asignar un contacto a una tarea transversal (deja de ser transversal). Si tiene
  // fecha, ya aparece en el calendario; al tener contacto se agrupa bajo él.
  async function asignarContacto(tareaId: number, personaId: number) {
    try {
      await actualizarTarea(tareaId, { persona_id: personaId } as any);
      await cargar();
      fb('ok', '👤 Tarea asignada al contacto');
    } catch (e: any) { fb('err', e.message); }
  }

  // Filtrar por alcance (todas / solo clientes / solo transversales)
  const tareasAlcance = useMemo(() => {
    if (alcance === 'clientes') return tareas.filter(t => t.persona_id != null);
    if (alcance === 'transversales') return tareas.filter(t => t.persona_id == null);
    return tareas;
  }, [tareas, alcance]);

  const grupos = useMemo(() => {
    const mapa = new Map<number | 'transversales', { nombre: string; tareas: TareaConPersona[]; color: string }>();

    for (const t of tareasAlcance) {
      if (filtro === 'hechas' && !t.completada) continue;
      if (filtro === 'pendientes' && t.completada) continue;

      const k = t.persona_id ?? 'transversales';
      if (!mapa.has(k)) {
        mapa.set(k, {
          nombre: t.persona_id ? (personas.find(p => p.id === t.persona_id)?.nombre ?? `Cliente #${t.persona_id}`) : 'Transversales / Administrativas',
          tareas: [],
          color: t.persona_id ? '#7c3aed' : '#0891b2'
        });
      }
      mapa.get(k)!.tareas.push(t);
    }

    const arr = Array.from(mapa.values());
    for (const g of arr) {
      g.tareas.sort((a, b) => {
         if (a.completada !== b.completada) return a.completada ? 1 : -1;
         if (!a.fecha_vence && !b.fecha_vence) return 0;
         if (!a.fecha_vence) return 1;
         if (!b.fecha_vence) return -1;
         return a.fecha_vence.localeCompare(b.fecha_vence);
      });
    }

    arr.sort((a, b) => {
       if (a.nombre === 'Transversales / Administrativas') return 1;
       if (b.nombre === 'Transversales / Administrativas') return -1;
       return a.nombre.localeCompare(b.nombre);
    });

    return arr;
  }, [tareasAlcance, filtro, personas]);

  const totalVisibles = grupos.reduce((s, g) => s + g.tareas.length, 0);
  const totalPendientes = tareas.filter(t => !t.completada).length;
  const totalCliente = tareas.filter(t => !t.completada && t.persona_id != null).length;
  const totalTransv = tareas.filter(t => !t.completada && t.persona_id == null).length;
  const totalVencidas = tareas.filter(t => !t.completada && t.fecha_vence && t.fecha_vence < new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' })).length;

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      {/* Encabezado */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            📋 Todas las tareas
            <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 13 }}> ({totalPendientes} pendientes)</span>
          </h2>
          <p style={{ margin: '3px 0 0', fontSize: 11, color: 'var(--text-muted)' }}>
            Vista unificada: tareas de clientes + transversales. Actualiza cada 5s.
            {totalVencidas > 0 && <span style={{ color: '#dc2626', fontWeight: 600 }}> · ⚠ {totalVencidas} vencida{totalVencidas > 1 ? 's' : ''}</span>}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {ultimaActualizacion.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
          <button onClick={() => cargar()} style={btnSec}>↻ Actualizar</button>
          <button onClick={() => setCreando(true)} style={btnPrim}>+ Nueva tarea</button>
        </div>
      </div>

      {/* Contadores de resumen */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
        {[
          { label: 'Todas', val: totalPendientes, key: 'todas' as Alcance, color: 'var(--accent)' },
          { label: `De clientes (${totalCliente})`, val: totalCliente, key: 'clientes' as Alcance, color: '#7c3aed' },
          { label: `Transversales (${totalTransv})`, val: totalTransv, key: 'transversales' as Alcance, color: '#0891b2' },
        ].map(chip => (
          <button key={chip.key} onClick={() => setAlcance(chip.key)} style={{
            padding: '5px 12px', fontSize: 11, borderRadius: 20, cursor: 'pointer', fontWeight: alcance === chip.key ? 700 : 400,
            border: `1.5px solid ${alcance === chip.key ? chip.color : 'var(--border)'}`,
            background: alcance === chip.key ? chip.color + '18' : 'var(--bg-page)',
            color: alcance === chip.key ? chip.color : 'var(--text)',
          }}>{chip.label}</button>
        ))}
      </div>

      {/* Filtro estado */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 14 }}>
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
          Sin tareas {filtro === 'pendientes' ? 'pendientes' : filtro === 'hechas' ? 'hechas' : ''} {alcance !== 'todas' ? `(${alcance})` : ''}.<br /><br />
          Decile a Junior: <strong>"agendame llamar a [cliente] mañana"</strong> o usá <strong>"+ Nueva tarea"</strong>.
        </div>
      )}

      {grupos.map((g, idx) => {
        const items = g.tareas;
        if (items.length === 0) return null;
        return (
          <div key={idx} style={{ marginBottom: 20 }}>
            <h3 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: g.color, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              👤 {g.nombre} ({items.length})
            </h3>
            <div style={{ display: 'grid', gap: 6 }}>
              {items.map(t => (
                <TareaRow key={t.id} tarea={t} onToggle={toggleCompletar} onEdit={setEditando} personas={personas} onAsignar={asignarContacto} />
              ))}
            </div>
          </div>
        );
      })}

      {(editando || creando) && (
        <ModalTarea
          tarea={editando}
          personas={personas}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await cargar(); fb('ok', msg); }}
          onError={(msg) => fb('err', msg)}
        />
      )}
    </div>
  );
}

function TareaRow({ tarea, onToggle, onEdit, personas, onAsignar }: {
  tarea: TareaConPersona;
  onToggle: (t: TareaConPersona) => void;
  onEdit: (t: TareaConPersona) => void;
  personas: { id: number; nombre: string | null }[];
  onAsignar: (tareaId: number, personaId: number) => void;
}) {
  const hoyStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const vencida = !tarea.completada && tarea.fecha_vence && tarea.fecha_vence < hoyStr;
  const esCliente = tarea.persona_id != null;
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: `1px solid ${vencida ? '#fca5a5' : tarea.completada ? '#bbf7d0' : 'var(--border-soft)'}`,
      borderRadius: 8, padding: '10px 12px',
      opacity: tarea.completada ? 0.65 : 1,
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <input type="checkbox" checked={tarea.completada} onChange={() => onToggle(tarea)}
          style={{ marginTop: 3, cursor: 'pointer', flexShrink: 0 }} />
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
            {esCliente && tarea.persona && (
              <span style={{ color: '#7c3aed', fontWeight: 600 }}>
                👤 {tarea.persona.nombre ?? `persona ${tarea.persona_id}`}
              </span>
            )}
            {!esCliente && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: '#0891b2' }}>↔ Transversal</span>
                <select
                  defaultValue=""
                  onChange={e => { if (e.target.value) onAsignar(tarea.id, Number(e.target.value)); }}
                  title="Asignar esta tarea a un contacto"
                  style={{ fontSize: 10, padding: '1px 4px', border: '1px solid #0891b2', borderRadius: 6, color: '#0891b2', background: 'white', cursor: 'pointer', maxWidth: 150 }}
                >
                  <option value="">👤 asignar a contacto…</option>
                  {personas.map(p => <option key={p.id} value={p.id}>{p.nombre ?? `persona ${p.id}`}</option>)}
                </select>
              </span>
            )}
            {tarea.prioridad < 5 && <span style={{ color: 'var(--red)' }}>★ Urgente</span>}
            {tarea.origen && tarea.origen !== 'manual' && (
              <span style={{ color: 'var(--accent)' }}>origen: {tarea.origen}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModalTarea({ tarea, personas, onClose, onDone, onError }: {
  tarea: TareaConPersona | null;
  personas: { id: number; nombre: string | null }[];
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [form, setForm] = useState<Partial<TareaConPersona>>(tarea ?? {
    persona_id: null, titulo: '', tipo: 'otro', fecha_vence: null,
    hora_vence: null, asignado_a: 'jhon', prioridad: 5, origen: 'manual',
  });
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
          persona_id: form.persona_id ?? null,
          titulo: form.titulo!,
          tipo: form.tipo as TipoTarea,
          fecha_vence: form.fecha_vence,
          hora_vence: form.hora_vence,
          asignado_a: form.asignado_a,
          prioridad: form.prioridad ?? 5,
          origen: 'manual',
        });
        onDone(form.persona_id ? 'Tarea de cliente creada' : 'Tarea transversal creada');
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
          <input value={form.titulo ?? ''} onChange={e => setForm({ ...form, titulo: e.target.value })}
            placeholder="ej. Llamar al proveedor de telas" style={inp} autoFocus />
        </Field>

        <Field label="Cliente (opcional)">
          <select value={form.persona_id ?? ''} onChange={e => setForm({ ...form, persona_id: e.target.value ? Number(e.target.value) : null })} style={inp}>
            <option value="">— sin cliente (transversal) —</option>
            {personas.map(p => <option key={p.id} value={p.id}>{p.nombre ?? `persona ${p.id}`}</option>)}
          </select>
        </Field>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <Field label="Tipo">
            <select value={form.tipo ?? 'otro'} onChange={e => setForm({ ...form, tipo: e.target.value as TipoTarea })} style={inp}>
              {TIPOS_TAREA.map(t => <option key={t} value={t}>{TIPO_LABEL[t]}</option>)}
            </select>
          </Field>
          <Field label="Asignado a">
            <input value={form.asignado_a ?? ''} onChange={e => setForm({ ...form, asignado_a: e.target.value || null })}
              placeholder="jhon, instalador Pedro…" style={inp} />
          </Field>
          <Field label="Vence (fecha)">
            <input type="date" value={form.fecha_vence ?? ''} onChange={e => setForm({ ...form, fecha_vence: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Vence (hora)">
            <input type="time" value={form.hora_vence ?? ''} onChange={e => setForm({ ...form, hora_vence: e.target.value || null })} style={inp} />
          </Field>
          <Field label="Prioridad (1=urgente · 9=baja)">
            <input type="number" min={1} max={9} value={form.prioridad ?? 5} onChange={e => setForm({ ...form, prioridad: Number(e.target.value) })} style={inp} />
          </Field>
        </div>

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
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 8 }}>
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
