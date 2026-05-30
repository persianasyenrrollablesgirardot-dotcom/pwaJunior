/**
 * 4.3 Producto/Sistema — vista de los items del cliente agrupados por sistema Safra.
 *
 * Para cada sistema cotizado/vendido al cliente, muestra:
 *   - Cuántos items
 *   - Área total
 *   - Monto total
 *   - Advertencias específicas que aplican
 */
import { useEffect, useMemo, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchCotizacionesPorPersona, fetchItemsPorCotizacion, fetchSistemasSafra,
  fetchAdvertenciasPorSistemas,
  type Cotizacion, type CotizacionItem, type Advertencia,
} from '../../lib/queries';

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const SEV_COLOR: Record<string, string> = { critico: 'var(--red)', warning: 'var(--orange)', info: 'var(--accent)' };

export function ProductoSistema() {
  const ctx = useContextoActivo();
  const [items, setItems] = useState<CotizacionItem[]>([]);
  const [sistemas, setSistemas] = useState<{ codigo: string; nombre: string }[]>([]);
  const [advertencias, setAdvertencias] = useState<Advertencia[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    setCargando(true);
    (async () => {
      const cots = await fetchCotizacionesPorPersona(ctx.personaActivaId!);
      const allItems: CotizacionItem[] = [];
      for (const c of cots) {
        const its = await fetchItemsPorCotizacion(c.id);
        allItems.push(...its);
      }
      setItems(allItems);
      setSistemas(await fetchSistemasSafra());
      // advertencias filtradas por sistemas que el cliente tiene cotizados
      const codigosCliente = Array.from(new Set(allItems.map(i => i.sistema_safra_codigo).filter(Boolean) as string[]));
      setAdvertencias(await fetchAdvertenciasPorSistemas(codigosCliente));
      setCargando(false);
    })();
  }, [ctx.personaActivaId]);

  const grupos = useMemo(() => {
    const byCodigo: Record<string, { items: CotizacionItem[]; area: number; monto: number }> = {};
    for (const it of items) {
      const k = it.sistema_safra_codigo ?? '(sin sistema)';
      if (!byCodigo[k]) byCodigo[k] = { items: [], area: 0, monto: 0 };
      byCodigo[k].items.push(it);
      byCodigo[k].area += Number(it.area_m2 ?? 0) * Number(it.cantidad ?? 1);
      byCodigo[k].monto += Number(it.monto_total ?? 0);
    }
    return Object.entries(byCodigo).sort((a, b) => b[1].monto - a[1].monto);
  }, [items]);

  if (cargando) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Sistemas vendidos/cotizados a {ctx.personaActivaNombre}
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Items agrupados por sistema Safra. Cada sistema trae sus propias reglas técnicas y advertencias.
      </p>

      {grupos.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin items cotizados todavía.
        </div>
      )}

      {grupos.map(([codigo, g]) => {
        const sis = sistemas.find(s => s.codigo === codigo);
        const advsSistema = advertencias.filter(a => a.sistema_codigo === codigo);
        return (
          <div key={codigo} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14, marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <strong style={{ fontSize: 14 }}>{sis?.nombre ?? codigo}</strong>
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>código: {codigo}</span>
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
              <span><strong>{g.items.length}</strong> items</span>
              <span><strong>{g.area.toFixed(2)}m²</strong> área total</span>
              <span><strong>{fmtCop(g.monto)}</strong> total</span>
            </div>

            {advsSistema.length > 0 && (
              <div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.4, marginBottom: 6 }}>
                  Advertencias técnicas de este sistema ({advsSistema.length})
                </div>
                {advsSistema.map(a => (
                  <div key={a.id} style={{ background: 'var(--bg-page)', borderLeft: `3px solid ${SEV_COLOR[a.severidad]}`, borderRadius: 4, padding: 8, marginBottom: 4 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: SEV_COLOR[a.severidad] }}>{a.titulo}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{a.texto}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
