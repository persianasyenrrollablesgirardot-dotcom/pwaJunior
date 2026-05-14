/**
 * 8.5 Correcciones — memoria de errores: lo que el humano corrigió a los agentes.
 *
 * Cada vez que Jhon edita un buzón propuesto antes de aprobarlo, se registra
 * acá. Los agentes leen sus últimas correcciones por persona en cada
 * invocación (vía hooks.cargarContexto → runner.ts) para no repetir el mismo
 * error en el futuro.
 */
import { useEffect, useState } from 'react';
import { fetchCorrecciones, type CorreccionRow } from '../../lib/m8_queries';

export function Correcciones() {
  const [rows, setRows] = useState<CorreccionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [agente, setAgente] = useState('');

  async function recargar() {
    setLoading(true); setErr(null);
    try {
      setRows(await fetchCorrecciones({ agente: agente.trim() || undefined, limite: 200 }));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { recargar(); }, [agente]);

  return (
    <div style={{ padding: '20px 24px' }}>
      <h2 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 700 }}>Correcciones del humano a los agentes</h2>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        Cada edición que Jhon hace en el buzón antes de aprobar queda registrada acá. Los agentes la leen al procesar a esa
        misma persona y no repiten el error.
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, fontSize: 12 }}>
        <span style={{ color: 'var(--text-muted)' }}>Agente:</span>
        <input value={agente} onChange={e => setAgente(e.target.value)} placeholder="filtrar por código de agente"
          style={{ padding: '4px 8px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 4, width: 220 }} />
        <button onClick={recargar} disabled={loading}
          style={{ padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 4, background: 'white', cursor: 'pointer' }}>
          {loading ? '...' : '↻'}
        </button>
        <span style={{ marginLeft: 'auto', color: 'var(--text-muted)' }}>{rows.length} correcciones</span>
      </div>

      {err && <div style={{ padding: 12, background: '#fee', border: '1px solid #fcc', borderRadius: 4, color: '#900', fontSize: 13, marginBottom: 12 }}>{err}</div>}

      <div style={{ overflow: 'auto', border: '1px solid var(--border-soft)', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ background: 'var(--bg-page-soft, #f7f7f9)' }}>
            <tr>
              <Th>Cuándo</Th>
              <Th>Agente</Th>
              <Th>Persona</Th>
              <Th>Campo</Th>
              <Th>Antes</Th>
              <Th>Después</Th>
              <Th>Motivo</Th>
              <Th>Evento</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} style={{ borderTop: '1px solid var(--border-soft)' }}>
                <Td>{new Date(r.ts).toLocaleString()}</Td>
                <Td><code style={{ fontSize: 11, fontWeight: 600 }}>{r.agente_codigo ?? '—'}</code></Td>
                <Td><code style={{ fontSize: 11 }}>#{r.persona_id ?? '—'}</code></Td>
                <Td><strong style={{ fontSize: 11 }}>{r.campo}</strong></Td>
                <Td style={{ maxWidth: 200, fontSize: 11, color: '#7f1d1d', wordBreak: 'break-word' }}><code>{formatVal(r.valor_anterior)}</code></Td>
                <Td style={{ maxWidth: 200, fontSize: 11, color: '#166534', wordBreak: 'break-word' }}><code>{formatVal(r.valor_nuevo)}</code></Td>
                <Td style={{ maxWidth: 220, fontSize: 11 }}>{r.motivo ?? '—'}</Td>
                <Td><code style={{ fontSize: 10 }}>{r.evento_origen_id ?? '—'}</code></Td>
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr><td colSpan={8} style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Sin correcciones todavía</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatVal(v: any): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return <th style={{ textAlign: align ?? 'left', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{children}</th>;
}
function Td({ children, align, style }: { children: React.ReactNode; align?: 'right'; style?: React.CSSProperties }) {
  return <td style={{ textAlign: align ?? 'left', padding: '7px 10px', ...(style ?? {}) }}>{children}</td>;
}
