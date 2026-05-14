/**
 * 8.3 Invocaciones — log de cada llamada al LLM.
 */
import { useEffect, useState } from 'react';
import { fetchInvocaciones, type InvocacionRow } from '../../lib/m8_queries';

export function Invocaciones() {
  const [rows, setRows] = useState<InvocacionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [agente, setAgente] = useState<string>('');
  const [soloErrores, setSoloErrores] = useState(false);
  const [sel, setSel] = useState<InvocacionRow | null>(null);

  async function recargar() {
    setLoading(true); setErr(null);
    try {
      setRows(await fetchInvocaciones({
        agente: agente.trim() || undefined,
        soloErrores,
        limite: 200,
      }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { recargar(); }, [agente, soloErrores]);

  const totalCosto = rows.reduce((s, r) => s + Number(r.costo_usd), 0);
  const totalErrores = rows.filter(r => !r.ok).length;

  return (
    <div style={{ padding: '20px 24px' }}>
      {/* Filtros */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, fontSize: 12 }}>
        <span style={{ color: 'var(--text-muted)' }}>Agente:</span>
        <input value={agente} onChange={e => setAgente(e.target.value)} placeholder="A1_MEDIDAS, A5_ABONO…"
          style={{ padding: '4px 8px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 4, width: 180 }} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={soloErrores} onChange={e => setSoloErrores(e.target.checked)} />
          Solo errores
        </label>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>
          {rows.length} resultados · {totalErrores} con error · ${totalCosto.toFixed(4)} acumulado
        </span>
        <button onClick={recargar} disabled={loading}
          style={{ padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 4, background: 'white', cursor: 'pointer' }}>
          {loading ? '...' : '↻'}
        </button>
      </div>

      {err && <div style={{ padding: 12, background: '#fee', border: '1px solid #fcc', borderRadius: 4, color: '#900', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      {/* Tabla */}
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 1, overflow: 'auto', border: '1px solid var(--border-soft)', borderRadius: 6, maxHeight: 'calc(100vh - 240px)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead style={{ background: 'var(--bg-page-soft, #f7f7f9)', position: 'sticky', top: 0 }}>
              <tr>
                <Th>ID</Th>
                <Th>Cuándo</Th>
                <Th>Agente</Th>
                <Th>Modelo</Th>
                <Th align="right">Tokens</Th>
                <Th align="right">$ USD</Th>
                <Th align="right">ms</Th>
                <Th>Modo</Th>
                <Th>OK</Th>
                <Th>Evento</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} onClick={() => setSel(r)}
                  style={{
                    borderTop: '1px solid var(--border-soft)',
                    background: sel?.id === r.id ? '#eff6ff' : (r.ok ? 'transparent' : '#fef2f2'),
                    cursor: 'pointer',
                  }}>
                  <Td><code style={{ fontSize: 10 }}>{r.id}</code></Td>
                  <Td>{new Date(r.created_at).toLocaleString()}</Td>
                  <Td><code style={{ fontSize: 11, fontWeight: 600 }}>{r.agente_codigo}</code></Td>
                  <Td style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.modelo ?? '—'}</Td>
                  <Td align="right">{(r.tokens_in ?? 0) + (r.tokens_out ?? 0)}</Td>
                  <Td align="right">${Number(r.costo_usd).toFixed(6)}</Td>
                  <Td align="right">{r.latencia_ms ?? '—'}</Td>
                  <Td>{r.shadow ? <Badge tono="warn">shadow</Badge> : <Badge tono="ok">prod</Badge>}</Td>
                  <Td>{r.ok ? '✓' : <span style={{ color: '#dc2626', fontWeight: 700 }}>✗</span>}</Td>
                  <Td><code style={{ fontSize: 10 }}>{r.evento_id ?? '—'}</code></Td>
                </tr>
              ))}
              {rows.length === 0 && !loading && (
                <tr><td colSpan={10} style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Sin invocaciones</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Detalle a la derecha */}
        {sel && (
          <div style={{ width: 380, flexShrink: 0, border: '1px solid var(--border-soft)', borderRadius: 6, padding: 16, background: 'white', alignSelf: 'flex-start' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>Invocación #{sel.id}</h3>
              <button onClick={() => setSel(null)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16, color: 'var(--text-muted)' }}>×</button>
            </div>
            <Detalle label="Agente"     valor={sel.agente_codigo} />
            <Detalle label="Modelo"     valor={sel.modelo ?? '—'} />
            <Detalle label="Tokens in"  valor={String(sel.tokens_in ?? '—')} />
            <Detalle label="Tokens out" valor={String(sel.tokens_out ?? '—')} />
            <Detalle label="Cached"     valor={String(sel.tokens_cached ?? '—')} />
            <Detalle label="Costo"      valor={`$${Number(sel.costo_usd).toFixed(6)}`} />
            <Detalle label="Latencia"   valor={`${sel.latencia_ms ?? '—'} ms`} />
            <Detalle label="Intentos"   valor={String(sel.intentos)} />
            <Detalle label="Shadow"     valor={sel.shadow ? 'sí' : 'no'} />
            <Detalle label="OK"         valor={sel.ok ? 'sí' : 'NO'} />
            {sel.error_msg && (
              <>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12, marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 }}>Error</div>
                <pre style={{ margin: 0, padding: 8, background: '#fef2f2', border: '1px solid #fca5a5', borderRadius: 4, fontSize: 11, color: '#7f1d1d', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{sel.error_msg}</pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return <th style={{ textAlign: align ?? 'left', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{children}</th>;
}
function Td({ children, align, style }: { children: React.ReactNode; align?: 'right'; style?: React.CSSProperties }) {
  return <td style={{ textAlign: align ?? 'left', padding: '6px 10px', ...(style ?? {}) }}>{children}</td>;
}
function Badge({ children, tono }: { children: React.ReactNode; tono: 'ok' | 'warn' | 'err' }) {
  const map = { ok: ['#dcfce7', '#15803d'], warn: ['#fef3c7', '#b45309'], err: ['#fee2e2', '#991b1b'] } as const;
  const [bg, fg] = map[tono];
  return <span style={{ fontSize: 10, fontWeight: 600, color: fg, background: bg, padding: '2px 5px', borderRadius: 3 }}>{children}</span>;
}
function Detalle({ label, valor }: { label: string; valor: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border-soft)' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 500 }}>{valor}</span>
    </div>
  );
}
