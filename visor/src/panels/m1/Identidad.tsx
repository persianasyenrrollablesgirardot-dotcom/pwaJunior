import { useEffect, useState } from 'react';
import { ambitoLabel, ambitoColor, type Persona, type Proyecto } from '../../lib/fakeData';
import { actualizarPersona, crearPersona, fusionarPersonas, fetchNotasPersona, agregarNota, eliminarNota, type NotaLibre } from '../../lib/queries';
import { useModo } from '../../lib/modo';
import { useContextoActivo } from '../../lib/contexto_activo';

const AMBITOS: { codigo: string; label: string }[] = [
  { codigo: 'comercial', label: 'Comercial' },
  { codigo: 'proveedor', label: 'Proveedor' },
  { codigo: 'personal_familia', label: 'Personal · Familia' },
  { codigo: 'personal_amigos', label: 'Personal · Amigos' },
  { codigo: 'personal_otros', label: 'Personal · Otros' },
  { codigo: 'interno_equipo', label: 'Interno · Equipo' },
];

interface Props { personas: Persona[]; proyectos: Proyecto[]; }

export function Identidad({ personas, proyectos }: Props) {
  const [modo] = useModo();
  const ctx = useContextoActivo();
  const [modal, setModal] = useState<{ tipo: 'editar' | 'nueva' | 'fusionar' | 'nota'; persona?: Persona } | null>(null);
  const [notas, setNotas] = useState<NotaLibre[]>([]);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  // F1.20: la persona viene SIEMPRE del contexto activo (módulo Clientes la setea).
  // Sin ctx, este panel no se debería estar renderizando — Modulo1.tsx ya cortó.
  const seleccionada = ctx.personaActivaId;

  // F1.22 fix I5: validar id activo CONTRA BD (no contra la lista cargada).
  // Antes: si Modulo1 pasa una lista filtrada/paginada, una persona válida que no
  // está en la lista cargada disparaba ctx.limpiar() incorrectamente.
  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    if (personas.length === 0) return;
    if (personas.find(p => p.id === ctx.personaActivaId)) return;
    // No está en la lista local — pero puede ser que la lista esté filtrada por contexto
    // o paginada. Validar contra BD antes de limpiar.
    let cancelado = false;
    import('../../lib/supabase').then(({ supabase }) => {
      supabase.from('personas').select('id').eq('id', ctx.personaActivaId!).maybeSingle()
        .then(({ data }) => {
          if (cancelado) return;
          if (!data) {
            console.warn(`[Identidad] persona activa id=${ctx.personaActivaId} no existe en BD, limpiando ctx`);
            ctx.limpiar();
          }
        });
    });
    return () => { cancelado = true; };
  }, [personas, ctx.personaActivaId]);

  // Cargar notas
  useEffect(() => {
    if (seleccionada == null || modo === 'demo') { setNotas([]); return; }
    fetchNotasPersona(seleccionada).then(setNotas).catch(() => setNotas([]));
  }, [seleccionada, modo]);

  const persona = seleccionada != null ? personas.find(p => p.id === seleccionada) : null;
  if (!persona) {
    // No debería pasar (Modulo1 corta antes), pero por defensa
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        No hay persona activa. Andá a <strong>Clientes</strong> y elegí uno.
      </div>
    );
  }
  const sus_proyectos = proyectos.filter(p => p.persona_id === persona.id);
  const referidoPor = persona.referido_por_persona_id ? personas.find(p => p.id === persona.referido_por_persona_id) : null;
  const referidos = personas.filter(p => p.referido_por_persona_id === persona.id);

  return (
    <div style={{ display: 'flex', height: '100%' }}>
      {/* Sidebar de personas eliminado (F1.20). El módulo "Clientes" hace la selección única. */}
      <div style={{ flex: 1, padding: 24, overflow: 'auto' }}>
        {feedback && (
          <div style={{
            padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
            background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
            color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)',
          }}>{feedback.msg}</div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 24 }}>
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: ambitoColor(persona.ambito), color: 'white',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 24, fontWeight: 700,
          }}>{(persona.nombre || '').split(' ').filter(Boolean).map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '?'}</div>
          <div style={{ flex: 1 }}>
            <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{persona.nombre}</h2>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
              {persona.rol ?? '—'} · {persona.ciudad ?? 'sin ciudad'}
            </div>
            {persona.tags && persona.tags.length > 0 && (
              <div style={{ display: 'flex', gap: 4, marginTop: 8 }}>
                {persona.tags.map(t => (
                  <span key={t} style={{ fontSize: 10, padding: '2px 8px', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 10, fontWeight: 600 }}>{t}</span>
                ))}
              </div>
            )}
          </div>
          <button onClick={() => setModal({ tipo: 'editar', persona })} style={btnSec}>Editar</button>
          <button onClick={() => setModal({ tipo: 'fusionar', persona })} style={btnSec}>Fusionar</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
          <Card titulo="Contacto">
            <Field label="Teléfono" valor={persona.telefono} />
            <Field label="Email" valor={persona.email} />
            <Field label="Empresa" valor={persona.empresa} />
            <Field label="Ámbito" valor={ambitoLabel(persona.ambito)} color={ambitoColor(persona.ambito)} />
            {(persona.contacto_alterno_nombre || persona.contacto_alterno_telefono) && (
              <div style={{ marginTop: 10, padding: 8, background: 'var(--bg-page)', borderRadius: 6 }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>Contacto alterno</div>
                <div style={{ fontSize: 12 }}>
                  {persona.contacto_alterno_nombre ?? '—'}
                  {persona.contacto_alterno_telefono && <span style={{ color: 'var(--text-muted)' }}> · {persona.contacto_alterno_telefono}</span>}
                </div>
              </div>
            )}
          </Card>
          <Card titulo="Red de referidos">
            {referidoPor ? (
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                <span style={{ color: 'var(--text-muted)' }}>Referido por: </span>
                <strong>{referidoPor.nombre}</strong>
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 8 }}>Sin referidor.</div>
            )}
            {referidos.length > 0 ? (
              <div style={{ fontSize: 12 }}>
                <div style={{ color: 'var(--text-muted)', marginBottom: 4 }}>Personas referidas por {persona.nombre}:</div>
                {referidos.map(r => (
                  <div key={r.id} style={{ padding: '3px 0' }}>· <strong>{r.nombre}</strong></div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>No refirió a otros aún.</div>
            )}
          </Card>
        </div>

        <Card titulo={`Proyectos (${sus_proyectos.length})`}>
          {sus_proyectos.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Sin proyectos aún.</div>}
          {sus_proyectos.map(pr => (
            <div key={pr.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border-soft)' }}>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{pr.nombre}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                Estado: <strong>{pr.estado}</strong> · prioridad {pr.prioridad}
              </div>
            </div>
          ))}
        </Card>

        <div style={{ marginTop: 16 }}>
          <Card titulo="Notas libres (los agentes leen esto antes de inferir)">
            {persona.notas && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8, background: 'var(--bg-page)', borderRadius: 6, marginBottom: 12, fontStyle: 'italic' }}>
                <strong>Notas del registro:</strong> {persona.notas}
              </div>
            )}
            {notas.length === 0 && !persona.notas && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Sin notas todavía.</div>
            )}
            {notas.map(n => (
              <div key={n.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border-soft)', fontSize: 13 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ flex: 1, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{n.contenido}</div>
                  <button
                    onClick={async () => {
                      if (modo === 'real') {
                        await eliminarNota(n.id);
                        setNotas(notas.filter(x => x.id !== n.id));
                      }
                    }}
                    style={{ marginLeft: 12, fontSize: 10, background: 'transparent', border: 'none', color: 'var(--red)', cursor: 'pointer' }}
                  >Eliminar</button>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                  {new Date(n.ts_creado).toLocaleString('es-CO')}
                  {n.visible_para && n.visible_para.length > 0 && n.visible_para[0] !== 'todos' && (
                    <> · visible para: {n.visible_para.join(', ')}</>
                  )}
                </div>
              </div>
            ))}
            <button onClick={() => setModal({ tipo: 'nota', persona })} style={{ ...btnSec, marginTop: 12 }}>+ Agregar nota</button>
          </Card>
        </div>
      </div>

      {modal?.tipo === 'editar' && modal.persona && (
        <ModalEditarPersona
          persona={modal.persona}
          todasPersonas={personas}
          modo={modo}
          onClose={() => setModal(null)}
          onDone={msg => { setModal(null); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={msg => setFeedback({ tipo: 'err', msg })}
        />
      )}
      {modal?.tipo === 'nueva' && (
        <ModalNuevaPersona
          modo={modo}
          onClose={() => setModal(null)}
          onDone={msg => { setModal(null); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={msg => setFeedback({ tipo: 'err', msg })}
        />
      )}
      {modal?.tipo === 'fusionar' && modal.persona && (
        <ModalFusionar
          actual={modal.persona}
          candidatos={personas.filter(p => p.id !== modal.persona!.id)}
          modo={modo}
          onClose={() => setModal(null)}
          onDone={msg => { setModal(null); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={msg => setFeedback({ tipo: 'err', msg })}
        />
      )}
      {modal?.tipo === 'nota' && modal.persona && (
        <ModalAgregarNota
          persona={modal.persona}
          modo={modo}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); setFeedback({ tipo: 'ok', msg: 'Nota agregada' }); fetchNotasPersona(modal.persona!.id).then(setNotas); }}
          onError={msg => setFeedback({ tipo: 'err', msg })}
        />
      )}
    </div>
  );
}

// ─── Subcomponentes ──────────────────────────────────────────────────

function Card({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 16 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 10 }}>{titulo}</div>
      {children}
    </div>
  );
}
function Field({ label, valor, color }: { label: string; valor?: string; color?: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 13, color: color ?? 'var(--text)', fontWeight: 500, marginTop: 2 }}>{valor ?? '—'}</div>
    </div>
  );
}

// ─── Modales ─────────────────────────────────────────────────────────

function ModalEditarPersona({ persona, todasPersonas, modo, onClose, onDone, onError }: {
  persona: Persona; todasPersonas: Persona[]; modo: 'real' | 'demo';
  onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [form, setForm] = useState({
    nombre: persona.nombre,
    telefono_e164: persona.telefono ?? '',
    email: persona.email ?? '',
    empresa: persona.empresa ?? '',
    ciudad: persona.ciudad ?? '',
    rol: persona.rol ?? '',
    ambito_principal: persona.ambito,
    notas: persona.notas ?? '',
    referido_por_persona_id: persona.referido_por_persona_id ?? '' as number | '',
    contacto_alterno_nombre: persona.contacto_alterno_nombre ?? '',
    contacto_alterno_telefono: persona.contacto_alterno_telefono ?? '',
  });
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    setAplicando(true);
    try {
      if (modo === 'real') {
        await actualizarPersona(persona.id, {
          nombre: form.nombre,
          telefono_e164: form.telefono_e164 || null,
          email: form.email || null,
          empresa: form.empresa || null,
          ciudad: form.ciudad || null,
          rol: form.rol || null,
          ambito_principal: form.ambito_principal,
          notas: form.notas || null,
          referido_por_persona_id: form.referido_por_persona_id ? Number(form.referido_por_persona_id) : null,
          contacto_alterno_nombre: form.contacto_alterno_nombre || null,
          contacto_alterno_telefono: form.contacto_alterno_telefono || null,
        });
      }
      onDone('Persona actualizada');
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  const candidatosReferidor = todasPersonas.filter(p => p.id !== persona.id);

  return (
    <ModalBase onClose={onClose} title={`Editar: ${persona.nombre}`}>
      <FormRow label="Nombre *"><input style={inp} value={form.nombre} onChange={e => setForm({...form, nombre: e.target.value})} /></FormRow>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <FormRow label="Teléfono"><input style={inp} value={form.telefono_e164} onChange={e => setForm({...form, telefono_e164: e.target.value})} placeholder="+573225458821" /></FormRow>
        <FormRow label="Email"><input style={inp} type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} /></FormRow>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <FormRow label="Empresa"><input style={inp} value={form.empresa} onChange={e => setForm({...form, empresa: e.target.value})} placeholder="Constructora X / Inmobiliaria Y" /></FormRow>
        <FormRow label="Ciudad"><input style={inp} value={form.ciudad} onChange={e => setForm({...form, ciudad: e.target.value})} /></FormRow>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <FormRow label="Rol"><input style={inp} value={form.rol} onChange={e => setForm({...form, rol: e.target.value})} placeholder="comprador, arquitecto, esposa..." /></FormRow>
        <FormRow label="Ámbito principal">
          <select style={inp} value={form.ambito_principal} onChange={e => setForm({...form, ambito_principal: e.target.value as any})}>
            {AMBITOS.map(a => <option key={a.codigo} value={a.codigo}>{a.label}</option>)}
          </select>
        </FormRow>
      </div>
      <FormRow label="Referido por (otra persona)">
        <select style={inp} value={form.referido_por_persona_id} onChange={e => setForm({...form, referido_por_persona_id: e.target.value === '' ? '' : Number(e.target.value)})}>
          <option value="">— ninguno —</option>
          {candidatosReferidor.map(p => <option key={p.id} value={p.id}>{p.nombre}{p.empresa ? ` (${p.empresa})` : ''}</option>)}
        </select>
      </FormRow>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <FormRow label="Contacto alterno · nombre"><input style={inp} value={form.contacto_alterno_nombre} onChange={e => setForm({...form, contacto_alterno_nombre: e.target.value})} placeholder="esposa, secretaria, hijo..." /></FormRow>
        <FormRow label="Contacto alterno · teléfono"><input style={inp} value={form.contacto_alterno_telefono} onChange={e => setForm({...form, contacto_alterno_telefono: e.target.value})} /></FormRow>
      </div>
      <FormRow label="Notas (los agentes IA las leen antes de inferir)">
        <textarea style={{ ...inp, height: 70 }} value={form.notas} onChange={e => setForm({...form, notas: e.target.value})} />
      </FormRow>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={guardar} disabled={aplicando} style={{ ...btnPrim, opacity: aplicando ? 0.5 : 1 }}>{aplicando ? 'Guardando…' : '✓ Guardar'}</button>
      </div>
    </ModalBase>
  );
}

function ModalNuevaPersona({ modo, onClose, onDone, onError }: {
  modo: 'real' | 'demo'; onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [form, setForm] = useState({
    nombre: '', telefono_e164: '', email: '',
    ciudad: '', rol: '', ambito_principal: 'comercial', notas: '',
  });
  const [aplicando, setAplicando] = useState(false);

  async function crear() {
    if (!form.nombre.trim()) { onError('Nombre obligatorio'); return; }
    setAplicando(true);
    try {
      if (modo === 'real') {
        await crearPersona({
          nombre: form.nombre.trim(),
          telefono_e164: form.telefono_e164 || undefined,
          email: form.email || undefined,
          ciudad: form.ciudad || undefined,
          rol: form.rol || undefined,
          ambito_principal: form.ambito_principal,
          notas: form.notas || undefined,
        });
      }
      onDone('Persona creada');
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  return (
    <ModalBase onClose={onClose} title="Nueva persona">
      <FormRow label="Nombre *"><input style={inp} autoFocus value={form.nombre} onChange={e => setForm({...form, nombre: e.target.value})} /></FormRow>
      <FormRow label="Teléfono (E.164)"><input style={inp} value={form.telefono_e164} onChange={e => setForm({...form, telefono_e164: e.target.value})} placeholder="+573225458821" /></FormRow>
      <FormRow label="Email"><input style={inp} type="email" value={form.email} onChange={e => setForm({...form, email: e.target.value})} /></FormRow>
      <FormRow label="Ciudad"><input style={inp} value={form.ciudad} onChange={e => setForm({...form, ciudad: e.target.value})} /></FormRow>
      <FormRow label="Rol"><input style={inp} value={form.rol} onChange={e => setForm({...form, rol: e.target.value})} /></FormRow>
      <FormRow label="Ámbito">
        <select style={inp} value={form.ambito_principal} onChange={e => setForm({...form, ambito_principal: e.target.value})}>
          {AMBITOS.map(a => <option key={a.codigo} value={a.codigo}>{a.label}</option>)}
        </select>
      </FormRow>
      <FormRow label="Notas">
        <textarea style={{ ...inp, height: 60 }} value={form.notas} onChange={e => setForm({...form, notas: e.target.value})} />
      </FormRow>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={crear} disabled={aplicando || !form.nombre.trim()} style={{ ...btnPrim, opacity: aplicando || !form.nombre.trim() ? 0.5 : 1 }}>+ Crear</button>
      </div>
    </ModalBase>
  );
}

function ModalFusionar({ actual, candidatos, modo, onClose, onDone, onError }: {
  actual: Persona; candidatos: Persona[]; modo: 'real' | 'demo';
  onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [fusionadaId, setFusionadaId] = useState<number | null>(null);
  const [motivo, setMotivo] = useState('');
  const [aplicando, setAplicando] = useState(false);

  async function fusionar() {
    if (!fusionadaId || !motivo.trim()) { onError('Faltan datos'); return; }
    setAplicando(true);
    try {
      if (modo === 'real') await fusionarPersonas(actual.id, fusionadaId, motivo.trim());
      onDone('Personas fusionadas');
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  return (
    <ModalBase onClose={onClose} title="Fusionar personas duplicadas">
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        La persona <strong>{actual.nombre}</strong> sobrevive. La elegida abajo se fusiona con ella (todos sus eventos, proyectos, notas, etc. se mueven).
      </p>
      <div style={{ padding: 10, background: '#fff5f5', color: 'var(--red)', borderRadius: 6, fontSize: 11, marginBottom: 12 }}>
        <strong>⚠ Acción irreversible (papelera 30 días):</strong> mueve TODOS los eventos, proyectos, notas, correcciones y memoria local de la persona elegida hacia <strong>{actual.nombre}</strong>. Después se elimina (soft-delete).
      </div>
      <FormRow label="Persona a fusionar (será eliminada)">
        <select style={inp} value={fusionadaId ?? ''} onChange={e => setFusionadaId(Number(e.target.value) || null)}>
          <option value="">— elegí —</option>
          {candidatos.map(p => (
            <option key={p.id} value={p.id}>{p.nombre} {p.telefono ? `· ${p.telefono}` : ''}</option>
          ))}
        </select>
      </FormRow>
      <FormRow label="Motivo">
        <input style={inp} value={motivo} onChange={e => setMotivo(e.target.value)} placeholder="ej: mismo cliente, escribió por dos números distintos" />
      </FormRow>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={fusionar} disabled={aplicando || !fusionadaId || !motivo.trim()} style={{ ...btnDanger, opacity: aplicando || !fusionadaId || !motivo.trim() ? 0.5 : 1 }}>
          ⚡ Fusionar
        </button>
      </div>
    </ModalBase>
  );
}

function ModalAgregarNota({ persona, modo, onClose, onDone, onError }: {
  persona: Persona; modo: 'real' | 'demo';
  onClose: () => void; onDone: () => void; onError: (msg: string) => void;
}) {
  const [contenido, setContenido] = useState('');
  const [visibleFamilia, setVisibleFamilia] = useState(false);
  const [aplicando, setAplicando] = useState(false);

  async function agregar() {
    if (!contenido.trim()) return;
    setAplicando(true);
    try {
      if (modo === 'real') {
        await agregarNota({
          persona_id: persona.id,
          contenido: contenido.trim(),
          visible_para: visibleFamilia ? ['comercial', 'familia'] : ['todos'],
        });
      }
      onDone();
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  return (
    <ModalBase onClose={onClose} title={`Nueva nota: ${persona.nombre}`}>
      <p style={{ margin: '0 0 12px', fontSize: 11, color: 'var(--text-muted)' }}>
        Esta nota se guarda como contexto. Los agentes IA la leen antes de inferir sobre {persona.nombre}.
      </p>
      <textarea
        autoFocus
        value={contenido}
        onChange={e => setContenido(e.target.value)}
        rows={5}
        placeholder="ej: Cliente VIP, paga puntual. Recomendado por María. No le mandar promociones."
        style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={agregar} disabled={aplicando || !contenido.trim()} style={{ ...btnPrim, opacity: aplicando || !contenido.trim() ? 0.5 : 1 }}>+ Agregar</button>
      </div>
    </ModalBase>
  );
}

function ModalBase({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'white', borderRadius: 12, padding: 24,
        maxWidth: 480, width: '90%', maxHeight: '85vh', overflow: 'auto',
        boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
      }}>
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

const inp: React.CSSProperties = { width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, fontFamily: 'inherit' };
const btnPrim: React.CSSProperties = { padding: '7px 12px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'white' };
const btnSec: React.CSSProperties = { padding: '7px 12px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)' };
const btnDanger: React.CSSProperties = { padding: '7px 12px', fontSize: 12, fontWeight: 600, background: 'white', border: '1px solid var(--red)', borderRadius: 6, color: 'var(--red)' };
