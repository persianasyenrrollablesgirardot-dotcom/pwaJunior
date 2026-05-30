/**
 * 6.5 Reclamos sensibles — casos que pueden volverse crisis. Escalation tracking.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchReclamosPorPersona, crearReclamo, actualizarReclamo,
  MOTIVOS_RECLAMO,
  type ReclamoSensible, type MotivoReclamo, type SeveridadReclamo, type EstadoReclamo,
} from '../../lib/queries';

const MOTIVO_LABEL: Record<MotivoReclamo, string> = {
  cliente_molesto: 'Cliente molesto',
  garantia_mal_manejada: 'Garantía mal manejada',
  dano_costoso: 'Daño costoso',
  publicacion_negativa: 'Publicación negativa',
  mala_resena: 'Mala reseña pública',
  incumplimiento: 'Incumplimiento',
  otro: 'Otro',
};
const SEVERIDAD_COLOR: Record<SeveridadReclamo, string> = {
  baja: '#5ac8fa', media: '#ff9500', alta: '#ff3b30', critica: '#7c2d12',
};
const ESTADO_LABEL: Record<EstadoReclamo, string> = {
  abierto: 'Abierto', en_contencion: 'En contención', escalado: 'Escalado',
  resuelto: 'Resuelto', cerrado_negativo: 'Cerrado mal',
};

const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function ReclamosSensibles() {
  const ctx = useContextoActivo();
  const [items, setItems] = useState<ReclamoSensible[]>([]);
  const [cargando, setCargando] = useState(true);
  const [editando, setEditando] = useState<ReclamoSensible | null>(null);
  const [creando, setCreando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true);
    try { setItems(await fetchReclamosPorPersona(ctx.personaActivaId)); }
    catch { /* */ } finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  function fb(tipo: 'ok' | 'err', msg: string) { setFeedback({ tipo, msg }); setTimeout(() => setFeedback(null), 3000); }

  const stats = {
    total: items.length,
    abiertos: items.filter(r => r.estado !== 'resuelto' && r.estado !== 'cerrado_negativo').length,
    alta_critica: items.filter(r => r.severidad === 'alta' || r.severidad === 'critica').length,
    escalados: items.filter(r => r.estado === 'escalado').length,
  };

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
          Reclamos sensibles — {ctx.personaActivaNombre}
        </h2>
        <button onClick={() => setCreando(true)} style={btnPrim}>+ Registrar reclamo</button>
      </div>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Casos con riesgo que deben escalarse antes de volverse crisis.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="⚠ Abiertos"      valor={stats.abiertos}    color="var(--red)" />
        <KPI label="🚨 Alta/Crítica" valor={stats.alta_critica} color={SEVERIDAD_COLOR.alta} />
        <KPI label="↑ Escalados"      valor={stats.escalados}   color="var(--orange)" />
      </div>

      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && items.length === 0 && (
        <div style={{ padding: 30, background: '#e8f8ee', border: '1px solid var(--green)', borderRadius: 8, color: 'var(--green)', fontSize: 13, textAlign: 'center' }}>
          ✓ Sin reclamos sensibles para {ctx.personaActivaNombre}.
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {items.map(r => (
          <button key={r.id} onClick={() => setEditando(r)} style={{
            width: '100%', textAlign: 'left', background: 'var(--bg-panel)',
            border: `2px solid ${SEVERIDAD_COLOR[r.severidad]}`, borderRadius: 8, padding: 14, cursor: 'pointer',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <strong style={{ fontSize: 13 }}>
                {MOTIVO_LABEL[r.motivo]}
                <span style={{ marginLeft: 8, fontSize: 10, padding: '2px 8px', background: SEVERIDAD_COLOR[r.severidad], color: 'white', borderRadius: 4, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {r.severidad}
                </span>
              </strong>
              <span style={{ fontSize: 11, fontWeight: 600, color: r.estado === 'resuelto' ? 'var(--green)' : r.estado === 'cerrado_negativo' ? 'var(--red)' : 'var(--orange)' }}>
                {ESTADO_LABEL[r.estado]}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)' }}>
              <span>Abierto: {fmtFecha(r.fecha_apertura)}</span>
              {r.fecha_resolucion && <span>Resuelto: {fmtFecha(r.fecha_resolucion)}</span>}
              {r.escalado_a && <span>↑ {r.escalado_a}</span>}
            </div>
            {r.acciones_tomadas && <div style={{ fontSize: 12, marginTop: 6 }}>→ {r.acciones_tomadas}</div>}
          </button>
        ))}
      </div>

      {(editando || creando) && (
        <ModalReclamo
          reclamo={editando}
          personaId={ctx.personaActivaId!}
          onClose={() => { setEditando(null); setCreando(false); }}
          onDone={async (msg) => { setEditando(null); setCreando(false); await recargar(); fb('ok', msg); }}
          onError={(msg) => fb('err', msg)}
        />
      )}
    </div>
  );
}

function ModalReclamo({ reclamo, personaId, onClose, onDone, onError }: {
  reclamo: ReclamoSensible | null;
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<ReclamoSensible> = reclamo ?? {
    persona_id: personaId,
    motivo: 'cliente_molesto',
    severidad: 'media',
    estado: 'abierto',
    escalado_a: null,
    acciones_tomadas: null,
    notas: null,
  };
  const [form, setForm] = useState<Partial<ReclamoSensible>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    setAplicando(true);
    try {
      if (reclamo) {
        await actualizarReclamo(reclamo.id, form);
        onDone('Reclamo actualizado');
      } else {
        await crearReclamo({
          persona_id: personaId,
          motivo: form.motivo as MotivoReclamo,
          severidad: form.severidad as SeveridadReclamo,
          escalado_a: form.escalado_a,
          acciones_tomadas: form.acciones_tomadas,
          notas: form.notas,
        });
        onDone('Reclamo registrado');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            {reclamo ? 'Editar reclamo' : 'Registrar reclamo sensible'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <Field label="Motivo *">
            <select value={form.motivo ?? ''} onChange={e => setForm({ ...form, motivo: e.target.value as MotivoReclamo })} style={inp}>
              {MOTIVOS_RECLAMO.map(m => <option key={m} value={m}>{MOTIVO_LABEL[m]}</option>)}
            </select>
          </Field>
          <Field label="Severidad *">
            <select value={form.severidad ?? 'media'} onChange={e => setForm({ ...form, severidad: e.target.value as SeveridadReclamo })} style={inp}>
              <option value="baja">Baja</option>
              <option value="media">Media</option>
              <option value="alta">Alta</option>
              <option value="critica">Crítica</option>
            </select>
          </Field>
          <Field label="Estado">
            <select value={form.estado ?? 'abierto'} onChange={e => setForm({ ...form, estado: e.target.value as EstadoReclamo })} style={inp}>
              <option value="abierto">Abierto</option>
              <option value="en_contencion">En contención</option>
              <option value="escalado">Escalado</option>
              <option value="resuelto">Resuelto</option>
              <option value="cerrado_negativo">Cerrado mal</option>
            </select>
          </Field>
          <Field label="Escalado a">
            <input value={form.escalado_a ?? ''} onChange={e => setForm({ ...form, escalado_a: e.target.value || null })} placeholder="jhon, abogado, gerente…" style={inp} />
          </Field>
        </div>

        <Field label="Acciones tomadas">
          <textarea rows={2} value={form.acciones_tomadas ?? ''} onChange={e => setForm({ ...form, acciones_tomadas: e.target.value || null })}
            placeholder='ej. "Llamada de Jhon, oferta de reembolso 50%."' style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        <Field label="Resultado / cierre">
          <textarea rows={2} value={form.resultado ?? ''} onChange={e => setForm({ ...form, resultado: e.target.value || null })} style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        <Field label="Notas internas">
          <textarea rows={2} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })} style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={btnSec}>Cancelar</button>
          <button onClick={guardar} disabled={aplicando} style={{ ...btnPrim, opacity: aplicando ? 0.5 : 1 }}>
            {aplicando ? 'Guardando…' : '✓ Guardar'}
          </button>
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
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalBox: React.CSSProperties = { background: 'white', borderRadius: 10, padding: 24, width: '90%', maxWidth: 600, boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
