/**
 * 2.2 Comparador — pone 2+ cotizaciones del mismo cliente lado a lado para
 * ver rápido qué cambió entre versiones (productos, montos, descuentos).
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { fetchCotizacionesPorPersona, fetchItemsPorCotizacion, type Cotizacion, type CotizacionItem } from '../../lib/queries';

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }) : '—';

interface ColData { cot: Cotizacion; items: CotizacionItem[]; }

export function Comparador() {
  const ctx = useContextoActivo();
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [seleccionadas, setSeleccionadas] = useState<number[]>([]);
  const [columnas, setColumnas] = useState<ColData[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    setCargando(true);
    fetchCotizacionesPorPersona(ctx.personaActivaId)
      .then(list => {
        setCotizaciones(list);
        // Auto-seleccionar las 2 más recientes
        if (list.length >= 2) setSeleccionadas([list[0].id, list[1].id]);
        else if (list.length === 1) setSeleccionadas([list[0].id]);
      })
      .finally(() => setCargando(false));
  }, [ctx.personaActivaId]);

  useEffect(() => {
    if (seleccionadas.length === 0) { setColumnas([]); return; }
    Promise.all(seleccionadas.map(async id => {
      const cot = cotizaciones.find(c => c.id === id);
      if (!cot) return null;
      const items = await fetchItemsPorCotizacion(id);
      return { cot, items };
    })).then(results => setColumnas(results.filter(Boolean) as ColData[]));
  }, [seleccionadas, cotizaciones]);

  function toggle(id: number) {
    setSeleccionadas(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 3) return [...prev.slice(1), id];   // max 3 columnas
      return [...prev, id];
    });
  }

  if (cargando) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Comparador de cotizaciones</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Seleccioná 2 o 3 cotizaciones para verlas lado a lado y comparar productos, montos y cambios.
      </p>

      {cotizaciones.length < 2 ? (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Necesitás al menos 2 cotizaciones del cliente para usar el comparador.<br />
          Hoy tenés <strong>{cotizaciones.length}</strong>. Andá a 2.1 Cotizaciones y crea otra versión.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            {cotizaciones.map(c => (
              <button key={c.id} onClick={() => toggle(c.id)}
                style={{
                  padding: '6px 12px', fontSize: 11, fontWeight: 600,
                  border: `1px solid ${seleccionadas.includes(c.id) ? 'var(--accent)' : 'var(--border)'}`,
                  background: seleccionadas.includes(c.id) ? 'var(--accent-soft)' : 'white',
                  color: seleccionadas.includes(c.id) ? 'var(--accent)' : 'var(--text)',
                  borderRadius: 6, cursor: 'pointer',
                }}>
                {c.numero_cotizacion ?? '#' + c.id} · {fmtFecha(c.fecha)} · {fmtCop(Number(c.total))}
              </button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${columnas.length}, 1fr)`, gap: 12 }}>
            {columnas.map(col => (
              <div key={col.cot.id} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>{col.cot.numero_cotizacion ?? '#' + col.cot.id}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>{fmtFecha(col.cot.fecha)} · {col.cot.estado}</div>

                <div style={{ marginBottom: 12 }}>
                  {col.items.map(it => (
                    <div key={it.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border-soft)', fontSize: 12 }}>
                      <div><strong>{it.sistema_safra_codigo ?? '—'}</strong>{it.ambiente && ` · ${it.ambiente}`}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                        {it.ancho_m && it.alto_m && `${Number(it.ancho_m).toFixed(2)}×${Number(it.alto_m).toFixed(2)}m · `}
                        {fmtCop(Number(it.monto_total))}
                      </div>
                    </div>
                  ))}
                </div>

                <div style={{ background: 'var(--bg-page)', padding: 8, borderRadius: 6, fontSize: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Subtotal</span><span>{fmtCop(Number(col.cot.subtotal))}</span></div>
                  {Number(col.cot.descuento_pct) > 0 && (
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--orange)' }}><span>Descuento {col.cot.descuento_pct}%</span><span>−{fmtCop(Number(col.cot.descuento_monto))}</span></div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginTop: 4 }}><span>TOTAL</span><span>{fmtCop(Number(col.cot.total))}</span></div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
