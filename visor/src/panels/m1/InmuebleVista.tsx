import { useState } from 'react';
import type { Inmueble } from '../../lib/fakeData';
import { crearInmueble, actualizarInmueble } from '../../lib/queries';
import { useModo } from '../../lib/modo';

const TIPOS = ['apartamento', 'casa', 'local', 'oficina', 'otro'];

export function InmuebleVista({ inmuebles }: { inmuebles: Inmueble[] }) {
  const [modo] = useModo();
  const [modal, setModal] = useState<{ tipo: 'nuevo' } | { tipo: 'editar'; inmueble: Inmueble } | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  return (
    <div style={{ padding: 24, overflow: 'auto', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Inmueble del cliente activo</h2>
        <button onClick={() => setModal({ tipo: 'nuevo' })} style={btnPrim}>+ Nuevo inmueble</button>
      </div>

      {feedback && (
        <div style={{
          padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)',
        }}>{feedback.msg}</div>
      )}

      {inmuebles.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8 }}>
          Este cliente aún no tiene un inmueble registrado.<br />
          Click en "+ Nuevo inmueble" cuando confirme la dirección de instalación.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 16 }}>
          {inmuebles.map(i => (
            <div key={i.id} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 16 }}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{i.tipo}</div>
                <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>{i.direccion || '(sin dirección)'}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
                  {i.barrio && <>{i.barrio} · </>}
                  {i.ciudad || '(sin ciudad)'}
                </div>
              </div>

              {(i.conjunto || i.torre || i.apartamento) && (
                <div style={{ fontSize: 12, marginTop: 8, padding: 10, background: 'var(--bg-page)', borderRadius: 6 }}>
                  {i.conjunto && <div>Conjunto: <strong>{i.conjunto}</strong></div>}
                  {i.torre && <div>Torre: <strong>{i.torre}</strong></div>}
                  {i.apartamento && <div>Apartamento: <strong>{i.apartamento}</strong></div>}
                </div>
              )}

              {/* Logística (importante para instalación) */}
              {(i.parqueadero !== undefined || i.ascensor !== undefined || i.horarios_permitidos || i.administracion_contacto) && (
                <div style={{ fontSize: 11, marginTop: 10, padding: 10, background: '#f0f7ff', borderRadius: 6, color: 'var(--text)' }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--accent)', textTransform: 'uppercase', fontSize: 9, letterSpacing: 0.4 }}>Logística instalación</div>
                  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                    {i.parqueadero !== undefined && <span>{i.parqueadero ? '🚗 con parqueadero' : '🚗 sin parqueadero'}</span>}
                    {i.ascensor !== undefined && <span>{i.ascensor ? '🛗 con ascensor' : '🪜 sin ascensor'}</span>}
                  </div>
                  {i.horarios_permitidos && <div style={{ marginTop: 4 }}><strong>Horarios:</strong> {i.horarios_permitidos}</div>}
                  {i.administracion_contacto && <div style={{ marginTop: 4 }}><strong>Admin:</strong> {i.administracion_contacto}</div>}
                </div>
              )}

              {i.restricciones_ingreso && (
                <div style={{ fontSize: 11, marginTop: 10, padding: 10, background: '#fff5f5', color: 'var(--red)', borderRadius: 6 }}>
                  <strong>⚠ Restricciones:</strong> {i.restricciones_ingreso}
                </div>
              )}

              {i.notas && (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 12, lineHeight: 1.5 }}>{i.notas}</div>
              )}

              <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
                <button onClick={() => setModal({ tipo: 'editar', inmueble: i })} style={btnSec}>Editar</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {modal?.tipo === 'nuevo' && (
        <ModalInmueble
          modo={modo}
          onClose={() => setModal(null)}
          onDone={msg => { setModal(null); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={msg => setFeedback({ tipo: 'err', msg })}
        />
      )}
      {modal?.tipo === 'editar' && (
        <ModalInmueble
          inmueble={modal.inmueble}
          modo={modo}
          onClose={() => setModal(null)}
          onDone={msg => { setModal(null); setFeedback({ tipo: 'ok', msg }); setTimeout(() => setFeedback(null), 3000); }}
          onError={msg => setFeedback({ tipo: 'err', msg })}
        />
      )}
    </div>
  );
}

function ModalInmueble({ inmueble, modo, onClose, onDone, onError }: {
  inmueble?: Inmueble; modo: 'real' | 'demo';
  onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const editando = !!inmueble;
  const [form, setForm] = useState({
    direccion: inmueble?.direccion ?? '',
    ciudad: inmueble?.ciudad ?? '',
    barrio: inmueble?.barrio ?? '',
    conjunto: inmueble?.conjunto ?? '',
    torre: inmueble?.torre ?? '',
    apartamento: inmueble?.apartamento ?? '',
    tipo: inmueble?.tipo ?? 'apartamento',
    notas: inmueble?.notas ?? '',
    restricciones_ingreso: inmueble?.restricciones_ingreso ?? '',
    administracion_contacto: inmueble?.administracion_contacto ?? '',
    horarios_permitidos: inmueble?.horarios_permitidos ?? '',
    parqueadero: inmueble?.parqueadero ?? false,
    ascensor: inmueble?.ascensor ?? false,
  });
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    if (!form.direccion.trim() && !form.conjunto.trim()) { onError('Dirección o conjunto obligatorio'); return; }
    setAplicando(true);
    try {
      if (modo === 'real') {
        const data = {
          direccion: form.direccion || undefined,
          ciudad: form.ciudad || undefined,
          barrio: form.barrio || undefined,
          conjunto: form.conjunto || undefined,
          torre: form.torre || undefined,
          apartamento: form.apartamento || undefined,
          tipo: form.tipo,
          notas: form.notas || undefined,
          restricciones_ingreso: form.restricciones_ingreso || undefined,
          administracion_contacto: form.administracion_contacto || undefined,
          horarios_permitidos: form.horarios_permitidos || undefined,
          parqueadero: form.parqueadero,
          ascensor: form.ascensor,
        };
        if (editando) await actualizarInmueble(inmueble!.id, data as any);
        else await crearInmueble(data);
      }
      onDone(editando ? 'Inmueble actualizado' : 'Inmueble creado');
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  return (
    <ModalBase onClose={onClose} title={editando ? 'Editar inmueble' : 'Nuevo inmueble'}>
      <FormRow label="Dirección">
        <input style={inp} autoFocus value={form.direccion} onChange={e => setForm({...form, direccion: e.target.value})} placeholder="ej: Cra 10 # 35-20" />
      </FormRow>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <FormRow label="Ciudad">
          <input style={inp} value={form.ciudad} onChange={e => setForm({...form, ciudad: e.target.value})} placeholder="Girardot, Ricaurte..." />
        </FormRow>
        <FormRow label="Barrio">
          <input style={inp} value={form.barrio} onChange={e => setForm({...form, barrio: e.target.value})} />
        </FormRow>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 8 }}>
        <FormRow label="Conjunto"><input style={inp} value={form.conjunto} onChange={e => setForm({...form, conjunto: e.target.value})} /></FormRow>
        <FormRow label="Torre"><input style={inp} value={form.torre} onChange={e => setForm({...form, torre: e.target.value})} /></FormRow>
        <FormRow label="Apto"><input style={inp} value={form.apartamento} onChange={e => setForm({...form, apartamento: e.target.value})} /></FormRow>
      </div>
      <FormRow label="Tipo">
        <select style={inp} value={form.tipo} onChange={e => setForm({...form, tipo: e.target.value})}>
          {TIPOS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </FormRow>

      {/* Logística instalación (sección 1.3 doc visión) */}
      <div style={{ marginTop: 6, marginBottom: 6, padding: 10, background: 'var(--bg-page)', borderRadius: 6 }}>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
          Logística instalación
        </div>
        <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.parqueadero} onChange={e => setForm({...form, parqueadero: e.target.checked})} />
            🚗 Parqueadero disponible
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, cursor: 'pointer' }}>
            <input type="checkbox" checked={form.ascensor} onChange={e => setForm({...form, ascensor: e.target.checked})} />
            🛗 Ascensor disponible
          </label>
        </div>
        <FormRow label="Horarios permitidos para instalación">
          <input style={inp} value={form.horarios_permitidos} onChange={e => setForm({...form, horarios_permitidos: e.target.value})} placeholder="ej: lun-vie 8am-5pm · sáb hasta 1pm" />
        </FormRow>
        <FormRow label="Administración (contacto)">
          <input style={inp} value={form.administracion_contacto} onChange={e => setForm({...form, administracion_contacto: e.target.value})} placeholder="nombre + teléfono del administrador" />
        </FormRow>
      </div>

      <FormRow label="Restricciones de ingreso (visible en rojo)">
        <textarea style={{ ...inp, height: 50 }} value={form.restricciones_ingreso} onChange={e => setForm({...form, restricciones_ingreso: e.target.value})} placeholder="ej: solo registrados con cédula · lunes cerrado · cero camiones grandes" />
      </FormRow>
      <FormRow label="Notas adicionales">
        <textarea style={{ ...inp, height: 50 }} value={form.notas} onChange={e => setForm({...form, notas: e.target.value})} />
      </FormRow>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={guardar} disabled={aplicando} style={{ ...btnPrim, opacity: aplicando ? 0.5 : 1 }}>
          {aplicando ? 'Guardando…' : (editando ? '✓ Guardar' : '+ Crear')}
        </button>
      </div>
    </ModalBase>
  );
}

function ModalBase({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: 'white', borderRadius: 12, padding: 24, maxWidth: 520, width: '90%', maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.2)' }}>
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
