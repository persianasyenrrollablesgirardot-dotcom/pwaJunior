/**
 * Pestaña "Agendamientos" del módulo Junior.
 *
 * Tablero de Calendario y Agenda interactiva:
 *  - Cuadrícula de calendario mensual con navegación.
 *  - Indicadores visuales de carga de agenda (puntos de colores por tipo de evento).
 *  - Detalle interactivo al seleccionar un día (agenda diaria).
 *  - Formulario premium para agendar citas manuales de forma rápida.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { fetchTareasGlobalConPersona, TareaConPersona } from '../lib/queries';

// ─── Tipos ──────────────────────────────────────────────────────────────────
type TipoEvento = 'visita_medidas' | 'instalacion' | 'reunion_proveedor' | 'personal' | 'otro';

interface Agendamiento {
  id: number;
  persona_id: number | null;
  titulo: string;
  tipo: TipoEvento;
  fecha: string; // YYYY-MM-DD
  hora_inicio: string; // HH:MM
  hora_fin: string | null;
  direccion: string | null;
  notas: string | null;
  persona?: { nombre: string } | null;
}

interface Persona {
  id: number;
  nombre: string;
}

const TIPO_META: Record<TipoEvento, { label: string; color: string; emoji: string }> = {
  visita_medidas:    { label: 'Toma de medidas', color: '#f59e0b', emoji: '📐' },
  instalacion:       { label: 'Instalación',     color: '#ef4444', emoji: '🛠️' },
  reunion_proveedor: { label: 'Proveedor',       color: '#8b5cf6', emoji: '💼' },
  personal:          { label: 'Cita personal',   color: '#10b981', emoji: '👤' },
  otro:              { label: 'Otro',            color: '#6b7280', emoji: '📅' },
};

export function JuniorAgendamientos() {
  const [agendamientos, setAgendamientos] = useState<Agendamiento[]>([]);
  const [backlogTareas, setBacklogTareas] = useState<TareaConPersona[]>([]);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [cargando, setCargando] = useState(true);
  const [fechaSeleccionada, setFechaSeleccionada] = useState<Date>(new Date());
  const [mesActivo, setMesActivo] = useState<number>(new Date().getMonth());
  const [anioActivo, setAnioActivo] = useState<number>(new Date().getFullYear());
  
  // Estados de Modal / Formulario
  const [modalAbierto, setModalAbierto] = useState(false);
  const [form, setForm] = useState({
    titulo: '',
    tipo: 'visita_medidas' as TipoEvento,
    persona_id: '' as string | number,
    fecha: '',
    hora: '',
    direccion: '',
    notas: '',
  });

  // Cargar agendamientos y personas
  async function cargar() {
    setCargando(true);
    const { data: ags } = await supabase
      .from('agendamientos')
      .select('id,persona_id,titulo,tipo,fecha,hora_inicio,hora_fin,direccion,notas,persona:personas(nombre)')
      .is('deleted_at', null);
    setAgendamientos((ags as any) ?? []);

    try {
      const tareasActivas = await fetchTareasGlobalConPersona(false);
      // Filtramos las tareas que NO tienen fecha_vence o NO tienen hora_vence
      const backlog = tareasActivas.filter(t => !t.fecha_vence || !t.hora_vence);
      setBacklogTareas(backlog);
    } catch (e) {
      console.error('Error cargando backlog', e);
    }

    const { data: pers } = await supabase
      .from('personas')
      .select('id,nombre')
      .is('deleted_at', null)
      .order('nombre');
    
    setPersonas(pers ?? []);
    setCargando(false);
  }

  useEffect(() => {
    cargar();
  }, []);

  // Generar cuadrícula del calendario
  const diasSemana = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
  const meses = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
  ];

  const primerDiaMes = new Date(anioActivo, mesActivo, 1).getDay();
  const totalDiasMes = new Date(anioActivo, mesActivo + 1, 0).getDate();

  const cambiarMes = (dir: 'prev' | 'next') => {
    if (dir === 'prev') {
      if (mesActivo === 0) {
        setMesActivo(11);
        setAnioActivo(anioActivo - 1);
      } else {
        setMesActivo(mesActivo - 1);
      }
    } else {
      if (mesActivo === 11) {
        setMesActivo(0);
        setAnioActivo(anioActivo + 1);
      } else {
        setMesActivo(mesActivo + 1);
      }
    }
  };

  // Agendamientos de un día específico
  const getAgendamientosDelDia = (fechaStr: string) => {
    return agendamientos.filter(a => a.fecha === fechaStr);
  };

  const formatearFechaDate = (dia: number) => {
    const mm = String(mesActivo + 1).padStart(2, '0');
    const dd = String(dia).padStart(2, '0');
    return `${anioActivo}-${mm}-${dd}`;
  };

  const hoyStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const selectFechaStr = fechaSeleccionada.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  const agendaDelDia = getAgendamientosDelDia(selectFechaStr);

  // Crear agendamiento manual
  async function handleCrear(e: React.FormEvent) {
    e.preventDefault();
    if (!form.titulo || !form.fecha || !form.hora) {
      alert('Por favor completa los campos obligatorios (*)');
      return;
    }

    const { error } = await supabase.from('agendamientos').insert({
      titulo: form.titulo,
      tipo: form.tipo,
      persona_id: form.persona_id ? Number(form.persona_id) : null,
      fecha: form.fecha,
      hora_inicio: form.hora,
      direccion: form.direccion || null,
      notas: form.notas || null,
    } as any);

    if (error) {
      alert('Error al agendar: ' + error.message);
      return;
    }

    setModalAbierto(false);
    setForm({
      titulo: '',
      tipo: 'visita_medidas',
      persona_id: '',
      fecha: '',
      hora: '',
      direccion: '',
      notas: '',
    });
    cargar();
  }

  // Cancelar/Eliminar agendamiento
  async function handleCancelar(id: number) {
    if (!confirm('¿Seguro que deseas eliminar este agendamiento de la agenda?')) return;
    const { error } = await supabase
      .from('agendamientos')
      .update({ deleted_at: new Date().toISOString() } as any)
      .eq('id', id);

    if (error) {
      alert('Error al cancelar: ' + error.message);
      return;
    }
    cargar();
  }

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', padding: '18px 24px', gap: 24 }}>
      {/* Columna Izquierda: Calendario */}
      <div style={{
        flex: '1.2', background: 'white', borderRadius: 12, border: '1px solid var(--border-soft)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.02)', padding: 20, display: 'flex', flexDirection: 'column'
      }}>
        {/* Encabezado Calendario */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
            {meses[mesActivo]} {anioActivo}
          </h2>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => cambiarMes('prev')} style={btnNav}>◀</button>
            <button onClick={() => {
              const h = new Date();
              setMesActivo(h.getMonth());
              setAnioActivo(h.getFullYear());
              setFechaSeleccionada(h);
            }} style={btnHoy}>Hoy</button>
            <button onClick={() => cambiarMes('next')} style={btnNav}>▶</button>
          </div>
        </div>

        {/* Nombres días semana */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 8, textAlign: 'center' }}>
          {diasSemana.map(d => (
            <span key={d} style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>
              {d}
            </span>
          ))}
        </div>

        {/* Cuadrícula días del mes */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6, flex: 1 }}>
          {/* Celdas vacías previas */}
          {Array.from({ length: primerDiaMes }).map((_, idx) => (
            <div key={`empty-${idx}`} style={{ border: '1px solid transparent' }} />
          ))}

          {/* Días del mes */}
          {Array.from({ length: totalDiasMes }).map((_, idx) => {
            const dia = idx + 1;
            const fStr = formatearFechaDate(dia);
            const esHoy = fStr === hoyStr;
            const esSeleccionado = fStr === selectFechaStr;
            const evs = getAgendamientosDelDia(fStr);

            return (
              <div
                key={`dia-${dia}`}
                onClick={() => setFechaSeleccionada(new Date(anioActivo, mesActivo, dia))}
                style={{
                  border: '1px solid var(--border-soft)',
                  borderRadius: 8,
                  padding: '6px 4px',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                  position: 'relative',
                  minHeight: 52,
                  transition: 'all 0.2s',
                  background: esSeleccionado ? 'var(--accent-soft)' : esHoy ? '#eff6ff' : 'var(--bg-panel)',
                  borderColor: esSeleccionado ? 'var(--accent)' : esHoy ? '#3b82f6' : 'var(--border-soft)',
                  boxShadow: esSeleccionado ? '0 0 0 2px var(--accent)' : 'none',
                }}
              >
                <span style={{
                  fontSize: 12,
                  fontWeight: esHoy || esSeleccionado ? 700 : 500,
                  color: esSeleccionado ? 'var(--accent-dark)' : esHoy ? '#1d4ed8' : 'var(--text)',
                }}>{dia}</span>

                {/* Puntos de carga de eventos */}
                {evs.length > 0 && (
                  <div style={{ display: 'flex', gap: 3, flexWrap: 'wrap', justifyContent: 'center', marginTop: 4 }}>
                    {evs.slice(0, 4).map(e => (
                      <span
                        key={e.id}
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: '50%',
                          background: TIPO_META[e.tipo]?.color || '#cbd5e1'
                        }}
                      />
                    ))}
                    {evs.length > 4 && <span style={{ fontSize: 7, color: 'var(--text-muted)' }}>+</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Leyenda */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16, borderTop: '1px solid var(--border-soft)', paddingTop: 12 }}>
          {(Object.keys(TIPO_META) as TipoEvento[]).map(k => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: TIPO_META[k].color }} />
              <span style={{ color: 'var(--text-muted)' }}>{TIPO_META[k].label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Columna Derecha: Agenda Diaria */}
      <div style={{ flex: '0.8', display: 'flex', flexDirection: 'column', gap: 24, overflow: 'hidden' }}>
        {/* PANEL 1: AGENDA DEL DÍA */}
        <div style={{
          flex: 1, background: 'white', borderRadius: 12, border: '1px solid var(--border-soft)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.02)', padding: 20, display: 'flex', flexDirection: 'column', overflow: 'hidden'
        }}>
        {/* Encabezado Agenda Diaria */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, borderBottom: '1px solid var(--border-soft)', paddingBottom: 10 }}>
          <div>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700 }}>Agenda del día</h3>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {fechaSeleccionada.toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long' })}
            </span>
          </div>
          <button onClick={() => {
            setForm({ ...form, fecha: selectFechaStr });
            setModalAbierto(true);
          }} style={btnCrear}>📅 Agendar</button>
        </div>

        {/* Lista de compromisos agendados */}
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {cargando ? (
            <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Cargando agenda...</p>
          ) : agendaDelDia.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)' }}>
              <span style={{ fontSize: 32 }}>🧘</span>
              <p style={{ fontSize: 12, margin: '8px 0 0' }}>No hay compromisos agendados para este día.</p>
            </div>
          ) : (
            (() => {
              const mapa = new Map<number | 'transversales', { nombre: string; citas: typeof agendaDelDia }>();
              for (const a of agendaDelDia) {
                const k = a.persona_id ?? 'transversales';
                if (!mapa.has(k)) {
                  mapa.set(k, {
                    nombre: a.persona_id ? (a.persona?.nombre ?? `Cliente #${a.persona_id}`) : 'Transversales / Administrativas',
                    citas: []
                  });
                }
                mapa.get(k)!.citas.push(a);
              }
              const arr = Array.from(mapa.values());
              arr.sort((a, b) => {
                if (a.nombre === 'Transversales / Administrativas') return 1;
                if (b.nombre === 'Transversales / Administrativas') return -1;
                return a.nombre.localeCompare(b.nombre);
              });
              return arr.map((g, idx) => (
                <div key={idx} style={{ marginBottom: 16 }}>
                  <h4 style={{ margin: '0 0 8px', fontSize: 13, fontWeight: 700, color: g.nombre === 'Transversales / Administrativas' ? '#0891b2' : '#7c3aed', textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    👤 {g.nombre} ({g.citas.length})
                  </h4>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {g.citas.map(a => {
                      const meta = TIPO_META[a.tipo];
                      return (
                        <div key={a.id} style={{
                          border: '1px solid var(--border-soft)',
                          borderRadius: 10,
                          padding: 12,
                          background: 'var(--bg-panel)',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 6,
                          position: 'relative'
                        }}>
                          <button onClick={() => handleCancelar(a.id)} style={btnCancelEvent}>×</button>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 12 }}>{meta.emoji}</span>
                            <strong style={{ fontSize: 13, color: 'var(--text)' }}>{a.titulo}</strong>
                            <span style={{
                              padding: '1px 6px', borderRadius: 8, fontSize: 9, fontWeight: 600,
                              color: 'white', background: meta.color
                            }}>{meta.label}</span>
                          </div>

                          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                            <div>⏰ <strong>{a.hora_inicio.slice(0, 5)}</strong>{a.hora_fin ? ` a ${a.hora_fin.slice(0, 5)}` : ''}</div>
                            {a.direccion && <div>📍 <strong>Lugar:</strong> {a.direccion}</div>}
                            {a.notas && <div style={{ background: 'white', padding: '6px 8px', borderRadius: 6, marginTop: 4, border: '1px solid var(--border-soft)', fontStyle: 'italic' }}>📝 {a.notas}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ));
            })()
          )}
        </div>
        </div>

        {/* PANEL 2: BACKLOG / PENDIENTES DE AGENDAR */}
        <div style={{
          flex: 1, background: '#f8fafc', borderRadius: 12, border: '1px solid var(--border-soft)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.02)', padding: 20, display: 'flex', flexDirection: 'column', overflow: 'hidden'
        }}>
          <div style={{ marginBottom: 12, borderBottom: '1px solid var(--border-soft)', paddingBottom: 8 }}>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: '#475569' }}>📥 Pendientes de Agendar</h3>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Tareas críticas sin fecha definida (Backlog)
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8, paddingRight: 4 }}>
            {cargando ? (
              <p style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>Cargando backlog...</p>
            ) : backlogTareas.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)' }}>
                <span style={{ fontSize: 24 }}>✨</span>
                <p style={{ fontSize: 11, margin: '8px 0 0' }}>Bolsa de parqueo vacía.</p>
              </div>
            ) : (
              backlogTareas.map(t => (
                <div key={t.id} style={{
                  border: '1px dashed #cbd5e1', borderRadius: 8, padding: '10px 12px', background: 'white',
                  display: 'flex', flexDirection: 'column', gap: 4, cursor: 'pointer',
                  transition: 'background 0.2s'
                }} onClick={() => {
                  setForm({
                    titulo: t.titulo,
                    tipo: 'visita_medidas',
                    persona_id: t.persona_id ?? '',
                    fecha: '',
                    hora: '',
                    direccion: '',
                    notas: `Sincronizado desde tarea #${t.id}`
                  });
                  setModalAbierto(true);
                }}
                onMouseEnter={e => e.currentTarget.style.background = '#f1f5f9'}
                onMouseLeave={e => e.currentTarget.style.background = 'white'}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t.titulo}</div>
                  <div style={{ fontSize: 11, color: '#64748b', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{t.persona ? `👤 ${t.persona.nombre}` : 'Transversal'}</span>
                    {t.fecha_vence && <span>📅 {t.fecha_vence}</span>}
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>Agendar →</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* MODAL / FORMULARIO CREACIÓN MANUAL */}
      {modalAbierto && (
        <div style={modalOverlay} onClick={() => setModalAbierto(false)}>
          <div style={modalBody} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>📅 Nuevo Agendamiento</h2>
              <button onClick={() => setModalAbierto(false)} style={btnCerrarModal}>×</button>
            </div>

            <form onSubmit={handleCrear} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <label style={labelStyle}>
                <span>Título del Evento *</span>
                <input
                  type="text"
                  required
                  placeholder="ej. Visita toma de medidas Don Walter"
                  value={form.titulo}
                  onChange={e => setForm({ ...form, titulo: e.target.value })}
                  style={inputStyle}
                />
              </label>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label style={labelStyle}>
                  <span>Tipo *</span>
                  <select
                    value={form.tipo}
                    onChange={e => setForm({ ...form, tipo: e.target.value as TipoEvento })}
                    style={inputStyle}
                  >
                    {(Object.keys(TIPO_META) as TipoEvento[]).map(k => (
                      <option key={k} value={k}>{TIPO_META[k].label}</option>
                    ))}
                  </select>
                </label>

                <label style={labelStyle}>
                  <span>Cliente (Opcional)</span>
                  <select
                    value={form.persona_id}
                    onChange={e => setForm({ ...form, persona_id: e.target.value })}
                    style={inputStyle}
                  >
                    <option value="">- Transversal (Sin cliente) -</option>
                    {personas.map(p => (
                      <option key={p.id} value={p.id}>{p.nombre}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label style={labelStyle}>
                  <span>Fecha *</span>
                  <input
                    type="date"
                    required
                    value={form.fecha}
                    onChange={e => setForm({ ...form, fecha: e.target.value })}
                    style={inputStyle}
                  />
                </label>

                <label style={labelStyle}>
                  <span>Hora de Inicio *</span>
                  <input
                    type="time"
                    required
                    value={form.hora}
                    onChange={e => setForm({ ...form, hora: e.target.value })}
                    style={inputStyle}
                  />
                </label>
              </div>

              <label style={labelStyle}>
                <span>Dirección / Ubicación</span>
                <input
                  type="text"
                  placeholder="ej. Conjunto Altos del Peñón, Casa 2"
                  value={form.direccion}
                  onChange={e => setForm({ ...form, direccion: e.target.value })}
                  style={inputStyle}
                />
              </label>

              <label style={labelStyle}>
                <span>Notas / Especificaciones</span>
                <textarea
                  rows={2}
                  placeholder="ej. Llevar muestras de blackout y catálogo de enrollables..."
                  value={form.notas}
                  onChange={e => setForm({ ...form, notas: e.target.value })}
                  style={{ ...inputStyle, fontFamily: 'inherit' }}
                />
              </label>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
                <button type="button" onClick={() => setModalAbierto(false)} style={btnCancel}>Cancelar</button>
                <button type="submit" style={btnSubmit}>Guardar compromiso</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Estilos en Línea (Vanilla CSS) ─────────────────────────────────────────
const btnNav: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  border: '1px solid var(--border-soft)',
  background: 'white',
  borderRadius: 6,
  cursor: 'pointer',
};
const btnHoy: React.CSSProperties = {
  padding: '4px 10px',
  fontSize: 11,
  fontWeight: 600,
  border: '1px solid var(--border-soft)',
  background: 'white',
  borderRadius: 6,
  cursor: 'pointer',
};
const btnCrear: React.CSSProperties = {
  padding: '5px 12px',
  fontSize: 11,
  fontWeight: 600,
  background: 'var(--accent)',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
const btnCancelEvent: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  right: 8,
  background: 'transparent',
  border: 'none',
  fontSize: 16,
  cursor: 'pointer',
  color: 'var(--red)',
  lineHeight: 1,
};
const modalOverlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};
const modalBody: React.CSSProperties = {
  background: 'white',
  borderRadius: 12,
  padding: 24,
  width: '90%',
  maxWidth: 500,
  boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
};
const btnCerrarModal: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  fontSize: 22,
  cursor: 'pointer',
  color: 'var(--text-muted)',
};
const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--text)',
};
const inputStyle: React.CSSProperties = {
  padding: '7px 10px',
  fontSize: 12,
  border: '1px solid var(--border)',
  borderRadius: 6,
  background: 'white',
  outline: 'none',
};
const btnCancel: React.CSSProperties = {
  padding: '7px 14px',
  fontSize: 12,
  fontWeight: 500,
  background: 'var(--bg-page)',
  color: 'var(--text)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  cursor: 'pointer',
};
const btnSubmit: React.CSSProperties = {
  padding: '7px 14px',
  fontSize: 12,
  fontWeight: 600,
  background: 'var(--accent)',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
};
