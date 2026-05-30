/**
 * 4.1 Medidas — 5 etapas por item de cotización del cliente activo.
 *
 * Etapas: cliente → empresa → corregida → produccion → instalada
 * Por cada item se ve la matriz "etapa vs medida". Click en celda para crear/editar.
 *
 * La regla R-013#1 (responsabilidad del cliente si quien_midio != técnico)
 * sigue viviendo en cotizacion_items.quien_midio. Esta tabla solo registra
 * el HISTORIAL de medidas tomadas en cada etapa.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchMedidasEtapasPorPersona, fetchMedidasPorItem,
  crearMedida, actualizarMedida, eliminarMedida,
  ETAPAS_MEDIDA, type EtapaMedida, type Medida, type MedidaEtapas,
} from '../../lib/queries';

const ETAPA_LABEL: Record<EtapaMedida, string> = {
  cliente: 'Cliente',
  empresa: 'Empresa',
  corregida: 'Corregida',
  produccion: 'Producción',
  instalada: 'Instalada',
};
const ETAPA_COLOR: Record<EtapaMedida, string> = {
  cliente: '#ff9500',
  empresa: '#007aff',
  corregida: '#5856d6',
  produccion: '#5ac8fa',
  instalada: '#34c759',
};
const ETAPA_NOTA: Record<EtapaMedida, string> = {
  cliente: 'Medida enviada por el cliente vía WhatsApp/foto. Bandera RIESGO.',
  empresa: 'Medida tomada por técnico nuestro. Responsabilidad de la empresa.',
  corregida: 'Ajuste posterior tras revisión técnica (R-013).',
  produccion: 'Medida final enviada a producción.',
  instalada: 'Medida real de la pieza ya instalada (puede diferir de produccion).',
};

const fmt = (n: number | null | undefined) => n == null ? '—' : Number(n).toFixed(2) + 'm';
const fmtArea = (a: number | null | undefined, b: number | null | undefined) =>
  a != null && b != null ? (Number(a) * Number(b)).toFixed(2) + 'm²' : '—';

export function Medidas() {
  const ctx = useContextoActivo();
  const [items, setItems] = useState<MedidaEtapas[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editando, setEditando] = useState<{ item: MedidaEtapas; etapa: EtapaMedida } | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try { setItems(await fetchMedidasEtapasPorPersona(ctx.personaActivaId)); }
    catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  function mostrarFeedback(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 3000);
  }

  if (cargando) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Medidas de {ctx.personaActivaNombre} ({items.length} items)
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Cada item de cotización tiene 5 etapas de medida. <strong>Click en una celda</strong> para crear/editar la medida de esa etapa.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}
      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}

      {items.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin items de cotización para {ctx.personaActivaNombre}. Crea cotizaciones e items en M2.
        </div>
      )}

      {items.map(it => (
        <div key={it.item_id} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14, marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>
              {it.sistema_safra_codigo ?? '(sin sistema)'}
              {it.ambiente && <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {it.ambiente}</span>}
            </strong>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              Cotizado: {fmt(it.ancho_cotizado)} × {fmt(it.alto_cotizado)} = {fmtArea(it.ancho_cotizado, it.alto_cotizado)}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
            {ETAPAS_MEDIDA.map(etapa => {
              const ancho = (it as any)[`ancho_${etapa}`] as number | null;
              const alto = (it as any)[`alto_${etapa}`] as number | null;
              const tiene = ancho != null || alto != null;
              return (
                <button key={etapa} onClick={() => setEditando({ item: it, etapa })}
                  style={{
                    padding: 10, fontSize: 11, textAlign: 'left',
                    background: tiene ? `${ETAPA_COLOR[etapa]}1a` : 'var(--bg-page)',
                    border: `1px ${tiene ? 'solid' : 'dashed'} ${tiene ? ETAPA_COLOR[etapa] : 'var(--border)'}`,
                    borderRadius: 6, cursor: 'pointer',
                  }}
                  title={ETAPA_NOTA[etapa]}
                >
                  <div style={{ fontSize: 10, color: ETAPA_COLOR[etapa], fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
                    {ETAPA_LABEL[etapa]}
                  </div>
                  {tiene ? (
                    <>
                      <div style={{ fontWeight: 600 }}>{fmt(ancho)} × {fmt(alto)}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtArea(ancho, alto)}</div>
                    </>
                  ) : (
                    <div style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>+ agregar</div>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {editando && (
        <ModalMedida
          item={editando.item}
          etapa={editando.etapa}
          personaId={ctx.personaActivaId!}
          onClose={() => setEditando(null)}
          onDone={async (msg) => { setEditando(null); await recargar(); mostrarFeedback('ok', msg); }}
          onError={(msg) => mostrarFeedback('err', msg)}
        />
      )}
    </div>
  );
}

function ModalMedida({ item, etapa, personaId, onClose, onDone, onError }: {
  item: MedidaEtapas;
  etapa: EtapaMedida;
  personaId: number;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const anchoInicial = (item as any)[`ancho_${etapa}`] as number | null;
  const altoInicial = (item as any)[`alto_${etapa}`] as number | null;
  const yaExiste = anchoInicial != null || altoInicial != null;

  const [existente, setExistente] = useState<Medida | null>(null);
  const [form, setForm] = useState<Partial<Medida>>({
    ancho_m: anchoInicial ?? null,
    alto_m: altoInicial ?? null,
    quien_midio: '',
    fecha: new Date().toISOString().slice(0, 10),
    notas: null,
  });
  const [aplicando, setAplicando] = useState(false);

  useEffect(() => {
    // Si ya existe, cargar la fila concreta para tener el id
    if (yaExiste) {
      fetchMedidasPorItem(item.item_id).then(meds => {
        const m = meds.find(x => x.etapa === etapa);
        if (m) { setExistente(m); setForm(m); }
      });
    }
  }, [item.item_id, etapa, yaExiste]);

  async function guardar() {
    if (form.ancho_m == null || form.alto_m == null) {
      onError('Ancho y alto son obligatorios');
      return;
    }
    setAplicando(true);
    try {
      if (existente) {
        await actualizarMedida(existente.id, {
          ancho_m: Number(form.ancho_m), alto_m: Number(form.alto_m),
          quien_midio: form.quien_midio || null,
          fecha: form.fecha, notas: form.notas,
        });
        onDone('Medida actualizada');
      } else {
        await crearMedida({
          cotizacion_item_id: item.item_id,
          persona_id: personaId,
          etapa,
          ancho_m: Number(form.ancho_m),
          alto_m: Number(form.alto_m),
          quien_midio: form.quien_midio || null,
          fecha: form.fecha,
          notas: form.notas,
        });
        onDone('Medida creada');
      }
    } catch (e: any) { onError(e.message); setAplicando(false); }
  }

  async function borrar() {
    if (!existente) return;
    if (!confirm(`¿Eliminar la medida de etapa "${ETAPA_LABEL[etapa]}"?`)) return;
    try { await eliminarMedida(existente.id); onDone('Medida eliminada'); }
    catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={modalBox}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>
            Medida etapa <span style={{ color: ETAPA_COLOR[etapa] }}>{ETAPA_LABEL[etapa]}</span>
          </h2>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', fontSize: 22, cursor: 'pointer', color: 'var(--text-muted)' }}>×</button>
        </div>
        <p style={{ margin: '0 0 16px', fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {ETAPA_NOTA[etapa]}
        </p>

        <div style={{ background: 'var(--bg-page)', padding: 10, borderRadius: 6, marginBottom: 14, fontSize: 11, color: 'var(--text-muted)' }}>
          <strong>{item.sistema_safra_codigo}</strong>{item.ambiente && ` · ${item.ambiente}`} ·
          Cotizado: {fmt(item.ancho_cotizado)} × {fmt(item.alto_cotizado)}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 12 }}>
          <Field label="Ancho (m) *">
            <input type="number" step={0.01} min={0} value={form.ancho_m ?? ''} onChange={e => setForm({ ...form, ancho_m: e.target.value === '' ? null : Number(e.target.value) })} style={inp} />
          </Field>
          <Field label="Alto (m) *">
            <input type="number" step={0.01} min={0} value={form.alto_m ?? ''} onChange={e => setForm({ ...form, alto_m: e.target.value === '' ? null : Number(e.target.value) })} style={inp} />
          </Field>
          <Field label="Quién midió">
            <input value={form.quien_midio ?? ''} onChange={e => setForm({ ...form, quien_midio: e.target.value })} placeholder="ej. Jhon, técnico Pedro, cliente, etc." style={inp} />
          </Field>
          <Field label="Fecha">
            <input type="date" value={form.fecha ?? ''} onChange={e => setForm({ ...form, fecha: e.target.value })} style={inp} />
          </Field>
        </div>

        <Field label="Notas">
          <textarea rows={2} value={form.notas ?? ''} onChange={e => setForm({ ...form, notas: e.target.value || null })}
            placeholder="ej. Vano irregular, hay reja por dentro, etc." style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>

        {form.ancho_m && form.alto_m && (
          <div style={{ background: 'var(--bg-page)', padding: 8, borderRadius: 6, marginTop: 12, textAlign: 'right', fontSize: 12 }}>
            Área: <strong>{(Number(form.ancho_m) * Number(form.alto_m)).toFixed(2)}m²</strong>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 16 }}>
          {existente ? <button onClick={borrar} style={btnDanger}>🗑 Eliminar</button> : <span />}
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
