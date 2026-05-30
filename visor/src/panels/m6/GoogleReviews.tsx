/**
 * 6.4 Google Reviews — workflow apto → solicitada → recibida (estrellas).
 *
 * 1 fila por persona × cotización. Trigger SQL pasa a "recibida" cuando llega estrellas.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchReviewsPorPersona, upsertReview, fetchCotizacionesPorPersona,
  type GoogleReview, type EstadoReview, type Cotizacion,
} from '../../lib/queries';

const ESTADO_COLOR: Record<EstadoReview, string> = {
  no_apto: 'var(--text-muted)',
  apto: 'var(--accent)',
  solicitada: 'var(--orange)',
  recibida: 'var(--green)',
  rechazada_cliente: 'var(--red)',
  ignorada: 'var(--text-muted)',
};
const ESTADO_LABEL: Record<EstadoReview, string> = {
  no_apto: 'No apto', apto: 'Apto', solicitada: 'Solicitada',
  recibida: 'Recibida', rechazada_cliente: 'Cliente rechazó', ignorada: 'Ignorada',
};

const fmtFecha = (s: string | null | undefined) => s ? new Date(s).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function GoogleReviews() {
  const ctx = useContextoActivo();
  const [items, setItems] = useState<GoogleReview[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [cargando, setCargando] = useState(true);
  const [editando, setEditando] = useState<GoogleReview | { cotizacion_id: number } | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true);
    try {
      const [r, c] = await Promise.all([
        fetchReviewsPorPersona(ctx.personaActivaId),
        fetchCotizacionesPorPersona(ctx.personaActivaId),
      ]);
      setItems(r); setCotizaciones(c);
    } catch { /* */ } finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  function fb(tipo: 'ok' | 'err', msg: string) { setFeedback({ tipo, msg }); setTimeout(() => setFeedback(null), 3000); }

  // Cotizaciones GANADAS sin review todavía
  const cotsGanadasSinReview = cotizaciones
    .filter(c => c.estado === 'ganada')
    .filter(c => !items.find(r => r.cotizacion_id === c.id));

  const stats = {
    recibidas: items.filter(r => r.estado === 'recibida').length,
    pendientes: items.filter(r => r.estado === 'solicitada').length,
    aptas: items.filter(r => r.estado === 'apto').length,
    promedio_estrellas: (() => {
      const con = items.filter(r => r.estrellas != null);
      if (!con.length) return 0;
      return con.reduce((s, r) => s + (r.estrellas ?? 0), 0) / con.length;
    })(),
  };

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Google Reviews — {ctx.personaActivaNombre}
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Workflow: apto → solicitada → recibida. Reputación digital alimenta nuevas ventas.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="⭐ Recibidas"     valor={stats.recibidas}   color="var(--green)" />
        <KPI label="⏳ Solicitadas"   valor={stats.pendientes}  color="var(--orange)" />
        <KPI label="✓ Aptas"          valor={stats.aptas}       color="var(--accent)" />
        <KPI label="✰ Promedio"       valor={stats.promedio_estrellas.toFixed(1)} color="var(--text)" />
      </div>

      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {cotsGanadasSinReview.length > 0 && (
        <div style={{ background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 8, padding: 12, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#92400e', marginBottom: 8 }}>
            ⚠ Cotizaciones ganadas sin workflow de review iniciado:
          </div>
          {cotsGanadasSinReview.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: 12 }}>
              <span>{c.numero_cotizacion ?? '#' + c.id}</span>
              <button onClick={() => setEditando({ cotizacion_id: c.id })}
                style={{ padding: '4px 10px', fontSize: 11, fontWeight: 600, background: '#92400e', color: 'white', border: 'none', borderRadius: 4, cursor: 'pointer' }}>
                Iniciar workflow
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {items.map(r => (
          <button key={r.id} onClick={() => setEditando(r)} style={{
            width: '100%', textAlign: 'left', background: 'var(--bg-panel)',
            border: `1px solid ${ESTADO_COLOR[r.estado]}`, borderRadius: 8, padding: 14, cursor: 'pointer',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
              <strong style={{ fontSize: 13 }}>
                Cotización #{r.cotizacion_id}
                {r.estrellas != null && <span style={{ marginLeft: 8, color: 'var(--orange)', fontSize: 16 }}>{'★'.repeat(r.estrellas)}{'☆'.repeat(5 - r.estrellas)}</span>}
              </strong>
              <span style={{ fontSize: 10, fontWeight: 700, color: ESTADO_COLOR[r.estado], textTransform: 'uppercase', letterSpacing: 0.4 }}>
                {ESTADO_LABEL[r.estado]}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
              {r.solicitud_enviada_at && <span>📤 Solicitada: {fmtFecha(r.solicitud_enviada_at)}</span>}
              {r.resena_recibida_at   && <span>📥 Recibida: {fmtFecha(r.resena_recibida_at)}</span>}
            </div>
            {r.comentario && <div style={{ fontSize: 12, marginTop: 6, fontStyle: 'italic' }}>"{r.comentario}"</div>}
          </button>
        ))}
      </div>

      {editando && (
        <ModalReview
          review={'id' in editando ? editando : null}
          cotizacionId={'id' in editando ? editando.cotizacion_id : editando.cotizacion_id}
          personaId={ctx.personaActivaId!}
          onClose={() => setEditando(null)}
          onDone={async (msg) => { setEditando(null); await recargar(); fb('ok', msg); }}
          onError={(msg) => fb('err', msg)}
        />
      )}
    </div>
  );
}

function ModalReview({ review, cotizacionId, personaId, onClose, onDone, onError }: {
  review: GoogleReview | null;
  cotizacionId: number | null;
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const inicial: Partial<GoogleReview> = review ?? {
    apto_para_resena: true,
    estado: 'apto',
    estrellas: null,
    comentario: null,
    url_resena: null,
  };
  const [form, setForm] = useState<Partial<GoogleReview>>(inicial);
  const [aplicando, setAplicando] = useState(false);

  async function guardar() {
    setAplicando(true);
    try {
      await upsertReview(personaId, cotizacionId, form);
      onDone('Review actualizada');
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function marcarSolicitada() {
    setAplicando(true);
    try {
      await upsertReview(personaId, cotizacionId, {
        ...form,
        apto_para_resena: true,
        estado: 'solicitada',
        solicitud_enviada_at: new Date().toISOString(),
      });
      onDone('Marcada como solicitada');
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            Review {review ? '· editar' : '· iniciar'}
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={form.apto_para_resena ?? false} onChange={e => setForm({ ...form, apto_para_resena: e.target.checked })} />
          Apto para reseña (cliente quedó satisfecho)
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 10 }}>
          <Field label="Estado">
            <select value={form.estado ?? 'apto'} onChange={e => setForm({ ...form, estado: e.target.value as EstadoReview })} style={inp}>
              <option value="no_apto">No apto</option>
              <option value="apto">Apto</option>
              <option value="solicitada">Solicitada</option>
              <option value="recibida">Recibida</option>
              <option value="rechazada_cliente">Cliente rechazó</option>
              <option value="ignorada">Ignorada</option>
            </select>
          </Field>
          <Field label="Estrellas (1-5)">
            <select value={form.estrellas ?? ''} onChange={e => setForm({ ...form, estrellas: e.target.value === '' ? null : Number(e.target.value) })} style={inp}>
              <option value="">— Sin reseña aún —</option>
              <option value="5">★★★★★ (5)</option>
              <option value="4">★★★★☆ (4)</option>
              <option value="3">★★★☆☆ (3)</option>
              <option value="2">★★☆☆☆ (2)</option>
              <option value="1">★☆☆☆☆ (1)</option>
            </select>
          </Field>
        </div>

        <Field label="Comentario del cliente">
          <textarea rows={3} value={form.comentario ?? ''} onChange={e => setForm({ ...form, comentario: e.target.value || null })}
            placeholder='Texto literal que dejó el cliente en Google.' style={{ ...inp, fontFamily: 'inherit' }} />
        </Field>

        <Field label="URL de la reseña">
          <input value={form.url_resena ?? ''} onChange={e => setForm({ ...form, url_resena: e.target.value || null })} placeholder="https://g.co/..." style={inp} />
        </Field>

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {form.estado === 'apto' && (
            <button onClick={marcarSolicitada} style={{ ...btnPrim, background: 'var(--orange)' }} disabled={aplicando}>
              📤 Marcar como solicitada
            </button>
          )}
          <div style={{ display: 'flex', gap: 8, marginLeft: 'auto' }}>
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
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 110 }}>
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
