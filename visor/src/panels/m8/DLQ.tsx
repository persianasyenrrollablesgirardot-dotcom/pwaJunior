/**
 * 8.4 Dead Letter Queue — eventos que fallaron N veces.
 */
import { useEffect, useState } from 'react';
import { fetchDLQ, resolverDLQ, reintentarDLQ, type DLQRow } from '../../lib/m8_queries';

export function DLQ() {
  const [rows, setRows] = useState<DLQRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [soloPendientes, setSoloPendientes] = useState(true);

  async function recargar() {
    setLoading(true); setErr(null);
    try {
      setRows(await fetchDLQ(soloPendientes));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { recargar(); }, [soloPendientes]);

  async function onResolver(id: number) {
    if (!confirm('Marcar como resuelto sin reintentar el evento?')) return;
    try { await resolverDLQ(id); await recargar(); } catch (e: any) { alert(e.message); }
  }

  async function onReintentar(id: number, eventoId: number) {
    if (!confirm(`Reintentar evento #${eventoId}? Esto va a poner el evento en estado NUEVO y el worker lo va a volver a procesar.`)) return;
    try { await reintentarDLQ(id, eventoId); await recargar(); } catch (e: any) { alert(e.message); }
  }

  return (
    <div style={{ padding: '20px 24px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700 }}>Dead Letter Queue</h2>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
            Eventos que un agente intentó procesar y fallaron <strong>3 veces seguidas</strong>. Revisá el error, corregí el problema, y reintentá.
          </p>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={soloPendientes} onChange={e => setSoloPendientes(e.target.checked)} />
          Solo pendientes
        </label>
      </div>

      {err && <div style={{ padding: 12, background: '#fee', border: '1px solid #fcc', borderRadius: 4, color: '#900', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      <div style={{ overflow: 'auto', border: '1px solid var(--border-soft)', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ background: 'var(--bg-page-soft, #f7f7f9)' }}>
            <tr>
              <Th>ID</Th>
              <Th>Evento</Th>
              <Th>Agente</Th>
              <Th align="right">Intentos</Th>
              <Th>Primer fallo</Th>
              <Th>Último fallo</Th>
              <Th>Error</Th>
              <Th>Estado</Th>
              <Th>Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const resuelto = !!r.resuelto_at;
              return (
                <tr key={r.id} style={{ borderTop: '1px solid var(--border-soft)', background: resuelto ? '#f8fafc' : '#fff7ed' }}>
                  <Td><code style={{ fontSize: 11 }}>{r.id}</code></Td>
                  <Td><code style={{ fontSize: 11 }}>{r.evento_id}</code></Td>
                  <Td><code style={{ fontSize: 11, fontWeight: 600 }}>{r.agente_codigo ?? '—'}</code></Td>
                  <Td align="right">{r.intentos}</Td>
                  <Td>{new Date(r.ts_primer_fallo).toLocaleString()}</Td>
                  <Td>{new Date(r.ts_ultimo_fallo).toLocaleString()}</Td>
                  <Td style={{ maxWidth: 320, fontSize: 11, color: '#7f1d1d' }}>{r.ultimo_error}</Td>
                  <Td>{resuelto
                    ? <span style={{ fontSize: 10, fontWeight: 600, color: '#15803d', background: '#dcfce7', padding: '2px 6px', borderRadius: 3 }}>RESUELTO</span>
                    : <span style={{ fontSize: 10, fontWeight: 600, color: '#b45309', background: '#fef3c7', padding: '2px 6px', borderRadius: 3 }}>PENDIENTE</span>
                  }</Td>
                  <Td>
                    {!resuelto && (
                      <div style={{ display: 'flex', gap: 4 }}>
                        <button onClick={() => onReintentar(r.id, r.evento_id)}
                          style={{ padding: '3px 8px', fontSize: 10, fontWeight: 600, color: 'white', background: '#3b82f6', border: 'none', borderRadius: 3, cursor: 'pointer' }}>
                          ↻ Reintentar
                        </button>
                        <button onClick={() => onResolver(r.id)}
                          style={{ padding: '3px 8px', fontSize: 10, fontWeight: 600, color: '#15803d', background: 'white', border: '1px solid #15803d', borderRadius: 3, cursor: 'pointer' }}>
                          ✓ Resolver
                        </button>
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={9} style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
                {soloPendientes ? '✓ No hay eventos en DLQ pendientes' : 'Sin entradas en DLQ'}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return <th style={{ textAlign: align ?? 'left', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{children}</th>;
}
function Td({ children, align, style }: { children: React.ReactNode; align?: 'right'; style?: React.CSSProperties }) {
  return <td style={{ textAlign: align ?? 'left', padding: '7px 10px', ...(style ?? {}) }}>{children}</td>;
}
