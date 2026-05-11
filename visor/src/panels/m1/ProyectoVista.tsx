import { useState } from 'react';
import { ambitoColor, ambitoLabel, type Proyecto, type Persona, type Inmueble } from '../../lib/fakeData';
import { actualizarProyecto, crearProyecto } from '../../lib/queries';
import { useModo } from '../../lib/modo';

const ESTADOS: { codigo: string; label: string; color: string }[] = [
  { codigo: 'abierto', label: 'Abierto', color: '#007aff' },
  { codigo: 'en_progreso', label: 'En progreso', color: '#ff9500' },
  { codigo: 'ganado', label: 'Ganado', color: '#34c759' },
  { codigo: 'perdido', label: 'Perdido', color: '#8e8e93' },
  { codigo: 'cerrado', label: 'Cerrado', color: '#5856d6' },
  { codigo: 'en_garantia', label: 'En garantía', color: '#ff2d55' },
  { codigo: 'cancelado', label: 'Cancelado', color: '#6e6e73' },
];

const ESTADO_COLOR: Record<string, string> = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.color]));
const ESTADO_LABEL: Record<string, string> = Object.fromEntries(ESTADOS.map(e => [e.codigo, e.label]));

const AMBITOS_OPCIONES = [
  { codigo: 'comercial', label: 'Comercial' },
  { codigo: 'proveedor', label: 'Proveedor' },
  { codigo: 'personal_familia', label: 'Personal · Familia' },
  { codigo: 'personal_amigos', label: 'Personal · Amigos' },
  { codigo: 'personal_otros', label: 'Personal · Otros' },
  { codigo: 'interno_equipo', label: 'Interno · Equipo' },
];

interface Props {
  proyectos: Proyecto[];
  personas: Persona[];
  inmuebles: Inmueble[];
}

export function ProyectoVista({ proyectos, personas, inmuebles }: Props) {
  const [modo] = useModo();
  const [filtroAmbito, setFiltroAmbito] = useState<string>('todos');
  const [seleccionado, setSeleccionado] = useState<number | null>(null);
  const [modal, setModal] = useState<'nuevo' | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  const personaById = (id: number) => personas.find(p => p.id === id);
  const inmuebleById = (id: number) => inmuebles.find(i => i.id === id);

  const filtrados = filtroAmbito === 'todos' ? proyectos : proyectos.filter(p => p.ambito === filtroAmbito);
  const detalle = seleccionado != null ? proyectos.find(p => p.id === seleccionado) : null;

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Proyectos del cliente activo ({filtrados.length})</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <select
            value={filtroAmbito}
            onChange={e => setFiltroAmbito(e.target.value)}
            style={{ padding: '6px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'white' }}
          >
            <option value="todos">Todos los ámbitos</option>
            {AMBITOS_OPCIONES.map(a => <option key={a.codigo} value={a.codigo}>{a.label}</option>)}
          </select>
          <button onClick={() => setModal('nuevo')} style={btnPrim}>+ Nuevo proyecto</button>
        </div>
      </div>

      {feedback && (
        <div style={{
          padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)',
        }}>{feedback.msg}</div>
      )}

      {filtrados.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          {proyectos.length === 0 ? 'Este cliente aún no tiene proyectos. Click en "+ Nuevo proyecto" para crear uno.' : 'Ningún proyecto con este filtro.'}
        </div>
      ) : (
        <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, overflow: 'hidden' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-page)', textAlign: 'left' }}>
                <th style={th}>Proyecto</th>
                <th style={th}>Cliente</th>
                <th style={th}>Inmueble</th>
                <th style={th}>Ámbito</th>
                <th style={th}>Estado</th>
                <th style={th}>Origen</th>
                <th style={th}>Apertura</th>
                <th style={th}>Prio</th>
              </tr>
            </thead>
            <tbody>
              {filtrados.map(p => {
                const persona = personaById(p.persona_id);
                const inmueble = p.inmueble_id ? inmuebleById(p.inmueble_id) : null;
                return (
                  <tr key={p.id} onClick={() => setSeleccionado(p.id)} style={{ borderTop: '1px solid var(--border-soft)', cursor: 'pointer' }}>
                    <td style={td}><strong>{p.nombre}</strong></td>
                    <td style={td}>{persona?.nombre ?? '—'}</td>
                    <td style={td}>{inmueble ? `${inmueble.conjunto ?? inmueble.direccion} · ${inmueble.ciudad}` : '—'}</td>
                    <td style={td}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: ambitoColor(p.ambito), border: `1px solid ${ambitoColor(p.ambito)}`, padding: '1px 6px', borderRadius: 8, textTransform: 'uppercase' }}>
                        {ambitoLabel(p.ambito)}
                      </span>
                    </td>
                    <td style={td}>
                      <span style={{ fontSize: 11, fontWeight: 600, color: ESTADO_COLOR[p.estado] ?? '#000', textTransform: 'uppercase' }}>
                        {ESTADO_LABEL[p.estado] ?? p.estado}
                      </span>
                    </td>
                    <td style={td}><span style={{ color: 'var(--text-muted)' }}>{p.origen}</span></td>
                    <td style={td}><span style={{ color: 'var(--text-muted)' }}>{new Date(p.fecha_apertura).toLocaleDateString('es-CO')}</span></td>
                    <td style={td}>
                      <span style={{ display: 'inline-block', minWidth: 18, textAlign: 'center', fontSize: 11, fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: p.prioridad <= 2 ? '#ffe5e5' : 'var(--bg-page)', color: p.prioridad <= 2 ? 'var(--red)' : 'var(--text-muted)' }}>
                        {p.prioridad}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {detalle && (
        <ModalDetalleProyecto
          proyecto={detalle}
          persona={personaById(detalle.persona_id)}
          inmueble={detalle.inmueble_id ? inmuebleById(detalle.inmueble_id) : undefined}
          modo={modo}
          onClose={() => setSeleccionado(null)}
          onDone={msg => { setSeleccionado(null); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={msg => setFeedback({ tipo: 'err', msg })}
        />
      )}

      {modal === 'nuevo' && (
        <ModalNuevoProyecto
          personas={personas}
          inmuebles={inmuebles}
          modo={modo}
          onClose={() => setModal(null)}
          onDone={msg => { setModal(null); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={msg => setFeedback({ tipo: 'err', msg })}
        />
      )}
    </div>
  );
}

function ModalDetalleProyecto({ proyecto, persona, inmueble, modo, onClose, onDone, onError }: {
  proyecto: Proyecto; persona?: Persona; inmueble?: Inmueble; modo: 'real' | 'demo';
  onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [estado, setEstado] = useState(proyecto.estado);
  const [nombre, setNombre] = useState(proyecto.nombre);
  const [prioridad, setPrioridad] = useState(proyecto.prioridad);
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    setAplicando(true);
    try {
      if (modo === 'real') {
        await actualizarProyecto(proyecto.id, { nombre, estado, prioridad });
      }
      onDone('Proyecto actualizado');
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  return (
    <ModalBase onClose={onClose} title={`Proyecto #${proyecto.id}`}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 16 }}>
        {persona ? `Cliente: ${persona.nombre}` : 'Sin cliente asignado'}
        {inmueble && ` · Inmueble: ${inmueble.conjunto ?? inmueble.direccion} · ${inmueble.ciudad}`}
      </div>
      <FormRow label="Nombre"><input style={inp} value={nombre} onChange={e => setNombre(e.target.value)} /></FormRow>
      <FormRow label="Estado">
        <select style={inp} value={estado} onChange={e => setEstado(e.target.value as any)}>
          {ESTADOS.map(s => <option key={s.codigo} value={s.codigo}>{s.label}</option>)}
        </select>
      </FormRow>
      <FormRow label="Prioridad (1=crítica · 9=baja)">
        <input style={inp} type="number" min={1} max={9} value={prioridad} onChange={e => setPrioridad(Math.max(1, Math.min(9, Number(e.target.value))))} />
      </FormRow>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>
        Apertura: {new Date(proyecto.fecha_apertura).toLocaleString('es-CO')} · Origen: {proyecto.origen}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose} style={btnSec}>Cerrar</button>
        <button onClick={guardar} disabled={aplicando} style={{ ...btnPrim, opacity: aplicando ? 0.5 : 1 }}>{aplicando ? 'Guardando…' : '✓ Guardar'}</button>
      </div>
    </ModalBase>
  );
}

function ModalNuevoProyecto({ personas, inmuebles, modo, onClose, onDone, onError }: {
  personas: Persona[]; inmuebles: Inmueble[]; modo: 'real' | 'demo';
  onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [form, setForm] = useState({
    persona_id: personas[0]?.id ?? 0,
    inmueble_id: '' as string | number,
    ambito: 'comercial',
    nombre: '',
    estado: 'abierto',
    prioridad: 5,
  });
  const [aplicando, setAplicando] = useState(false);

  async function crear() {
    if (!form.nombre.trim() || !form.persona_id) { onError('Nombre y persona obligatorios'); return; }
    setAplicando(true);
    try {
      if (modo === 'real') {
        await crearProyecto({
          persona_id: form.persona_id,
          inmueble_id: form.inmueble_id ? Number(form.inmueble_id) : undefined,
          ambito: form.ambito,
          nombre: form.nombre.trim(),
          estado: form.estado,
          origen: 'manual',
          prioridad: form.prioridad,
        });
      }
      onDone('Proyecto creado');
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  return (
    <ModalBase onClose={onClose} title="Nuevo proyecto">
      <FormRow label="Cliente *">
        <select style={inp} value={form.persona_id} onChange={e => setForm({...form, persona_id: Number(e.target.value)})}>
          {personas.map(p => <option key={p.id} value={p.id}>{p.nombre}</option>)}
        </select>
      </FormRow>
      <FormRow label="Inmueble (opcional)">
        <select style={inp} value={form.inmueble_id} onChange={e => setForm({...form, inmueble_id: e.target.value})}>
          <option value="">— sin inmueble —</option>
          {inmuebles.map(i => <option key={i.id} value={i.id}>{i.conjunto ?? i.direccion} · {i.ciudad}</option>)}
        </select>
      </FormRow>
      <FormRow label="Ámbito">
        <select style={inp} value={form.ambito} onChange={e => setForm({...form, ambito: e.target.value})}>
          {AMBITOS_OPCIONES.map(a => <option key={a.codigo} value={a.codigo}>{a.label}</option>)}
        </select>
      </FormRow>
      <FormRow label="Nombre del proyecto *">
        <input style={inp} autoFocus value={form.nombre} onChange={e => setForm({...form, nombre: e.target.value})} placeholder="ej: Blackout sala + 2 alcobas" />
      </FormRow>
      <FormRow label="Estado inicial">
        <select style={inp} value={form.estado} onChange={e => setForm({...form, estado: e.target.value})}>
          {ESTADOS.map(s => <option key={s.codigo} value={s.codigo}>{s.label}</option>)}
        </select>
      </FormRow>
      <FormRow label="Prioridad (1-9)">
        <input style={inp} type="number" min={1} max={9} value={form.prioridad} onChange={e => setForm({...form, prioridad: Math.max(1, Math.min(9, Number(e.target.value)))})} />
      </FormRow>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={crear} disabled={aplicando || !form.nombre.trim()} style={{ ...btnPrim, opacity: aplicando || !form.nombre.trim() ? 0.5 : 1 }}>+ Crear</button>
      </div>
    </ModalBase>
  );
}

function ModalBase({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 12, padding: 24, maxWidth: 480, width: '90%', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.2)' }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function FormRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <label style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 4, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</label>
      {children}
    </div>
  );
}

const th: React.CSSProperties = { padding: '10px 12px', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 };
const td: React.CSSProperties = { padding: '12px', verticalAlign: 'middle' };
const inp: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit' };
const btnPrim: React.CSSProperties = { padding: '7px 12px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'white' };
const btnSec: React.CSSProperties = { padding: '7px 12px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' };
