/**
 * 8.1 Lista agentes — tabla con métricas del día y toggles activo/shadow.
 */
import { useEffect, useState } from 'react';
import { fetchAgentes, toggleAgenteActivo, toggleAgenteShadow, type AgenteRow } from '../../lib/m8_queries';

export function ListaAgentes() {
  const [rows, setRows] = useState<AgenteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filtroCriticidad, setFiltroCriticidad] = useState<'todos' | 'alta' | 'media' | 'baja'>('todos');
  const [filtroEstado, setFiltroEstado] = useState<'todos' | 'productivo' | 'shadow' | 'desactivado'>('todos');

  async function recargar() {
    setLoading(true);
    setErr(null);
    try {
      setRows(await fetchAgentes());
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { recargar(); }, []);

  const visible = rows.filter(r => {
    if (filtroCriticidad !== 'todos' && r.criticidad !== filtroCriticidad) return false;
    if (filtroEstado === 'productivo' && (!r.activo || r.shadow)) return false;
    if (filtroEstado === 'shadow' && !r.shadow) return false;
    if (filtroEstado === 'desactivado' && r.activo) return false;
    return true;
  });

  const totales = visible.reduce((acc, r) => ({
    invocaciones: acc.invocaciones + r.invocaciones_hoy,
    errores: acc.errores + r.errores_hoy,
    costo: acc.costo + r.costo_hoy_usd,
    dlq: acc.dlq + r.en_dead_letter_queue,
  }), { invocaciones: 0, errores: 0, costo: 0, dlq: 0 });

  return (
    <div style={{ padding: '20px 24px' }}>
      {/* Resumen */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <Card label="Agentes" valor={String(visible.length)} sub={`${rows.length} total`} />
        <Card label="Invocaciones hoy" valor={String(totales.invocaciones)} />
        <Card label="Errores hoy" valor={String(totales.errores)} tono={totales.errores > 0 ? 'rojo' : undefined} />
        <Card label="Costo hoy" valor={`$${totales.costo.toFixed(4)}`} />
        <Card label="En DLQ" valor={String(totales.dlq)} tono={totales.dlq > 0 ? 'rojo' : undefined} />
      </div>

      {/* Filtros */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, fontSize: 12 }}>
        <span style={{ color: 'var(--text-muted)' }}>Criticidad:</span>
        <select value={filtroCriticidad} onChange={(e) => setFiltroCriticidad(e.target.value as any)}
          style={{ padding: '4px 8px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 4 }}>
          <option value="todos">Todos</option>
          <option value="alta">Alta</option>
          <option value="media">Media</option>
          <option value="baja">Baja</option>
        </select>
        <span style={{ color: 'var(--text-muted)' }}>Estado:</span>
        <select value={filtroEstado} onChange={(e) => setFiltroEstado(e.target.value as any)}
          style={{ padding: '4px 8px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 4 }}>
          <option value="todos">Todos</option>
          <option value="productivo">Productivo</option>
          <option value="shadow">Shadow</option>
          <option value="desactivado">Desactivado</option>
        </select>
        <button onClick={recargar} disabled={loading}
          style={{ padding: '4px 10px', fontSize: 12, border: '1px solid var(--border-soft)', borderRadius: 4, background: 'white', cursor: 'pointer', marginLeft: 'auto' }}>
          {loading ? '...' : '↻ Refrescar'}
        </button>
      </div>

      {err && <div style={{ padding: 12, background: '#fee', border: '1px solid #fcc', borderRadius: 4, color: '#900', fontSize: 13 }}>{err}</div>}

      {/* Tabla */}
      <div style={{ overflow: 'auto', border: '1px solid var(--border-soft)', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead style={{ background: 'var(--bg-page-soft, #f7f7f9)' }}>
            <tr>
              <Th>Código</Th>
              <Th>Nombre</Th>
              <Th>Crit</Th>
              <Th>Estado</Th>
              <Th align="right">Inv hoy</Th>
              <Th align="right">Errores</Th>
              <Th align="right">$ hoy</Th>
              <Th align="right">Lat ms</Th>
              <Th align="right">DLQ</Th>
              <Th>Última</Th>
              <Th>Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map(r => (
              <tr key={r.codigo} style={{ borderTop: '1px solid var(--border-soft)' }}>
                <Td><code style={{ fontSize: 11, fontWeight: 600 }}>{r.codigo}</code></Td>
                <Td>{r.nombre}</Td>
                <Td><CriticidadBadge c={r.criticidad} /></Td>
                <Td><EstadoBadge activo={r.activo} shadow={r.shadow} /></Td>
                <Td align="right">{r.invocaciones_hoy}</Td>
                <Td align="right" tono={r.errores_hoy > 0 ? 'rojo' : undefined}>{r.errores_hoy}</Td>
                <Td align="right">${r.costo_hoy_usd.toFixed(4)}</Td>
                <Td align="right">{r.latencia_promedio_ms}</Td>
                <Td align="right" tono={r.en_dead_letter_queue > 0 ? 'rojo' : undefined}>{r.en_dead_letter_queue}</Td>
                <Td>{r.ultima_invocacion ? new Date(r.ultima_invocacion).toLocaleString() : '—'}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button title="Activo / Desactivado"
                      onClick={async () => { await toggleAgenteActivo(r.codigo, !r.activo); recargar(); }}
                      style={btnMini(r.activo ? '#22c55e' : '#94a3b8')}>
                      {r.activo ? 'ON' : 'off'}
                    </button>
                    <button title="Shadow / Productivo"
                      onClick={async () => { await toggleAgenteShadow(r.codigo, !r.shadow); recargar(); }}
                      style={btnMini(r.shadow ? '#f59e0b' : '#3b82f6')}>
                      {r.shadow ? 'shadow' : 'prod'}
                    </button>
                  </div>
                </Td>
              </tr>
            ))}
            {visible.length === 0 && !loading && (
              <tr><td colSpan={11} style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Sin agentes con esos filtros</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Helpers visuales ──────────────────────────────────────────────────────

function Card({ label, valor, sub, tono }: { label: string; valor: string; sub?: string; tono?: 'rojo' }) {
  return (
    <div style={{
      flex: '1 1 140px', minWidth: 120, padding: 12,
      border: '1px solid var(--border-soft)', borderRadius: 6, background: 'white',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, marginTop: 2, color: tono === 'rojo' ? '#dc2626' : 'inherit' }}>{valor}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function Th({ children, align }: { children: React.ReactNode; align?: 'right' }) {
  return <th style={{ textAlign: align ?? 'left', padding: '8px 10px', fontWeight: 600, fontSize: 11, color: 'var(--text-muted)' }}>{children}</th>;
}

function Td({ children, align, tono }: { children: React.ReactNode; align?: 'right'; tono?: 'rojo' }) {
  return <td style={{ textAlign: align ?? 'left', padding: '7px 10px', color: tono === 'rojo' ? '#dc2626' : 'inherit' }}>{children}</td>;
}

function CriticidadBadge({ c }: { c: 'alta' | 'media' | 'baja' }) {
  const color = c === 'alta' ? '#dc2626' : c === 'media' ? '#f59e0b' : '#94a3b8';
  return <span style={{ fontSize: 10, fontWeight: 700, color, background: color + '15', padding: '2px 6px', borderRadius: 3, textTransform: 'uppercase' }}>{c}</span>;
}

function EstadoBadge({ activo, shadow }: { activo: boolean; shadow: boolean }) {
  if (!activo) return <span style={{ fontSize: 10, fontWeight: 600, color: '#94a3b8', background: '#f1f5f9', padding: '2px 6px', borderRadius: 3 }}>off</span>;
  if (shadow)  return <span style={{ fontSize: 10, fontWeight: 600, color: '#b45309', background: '#fef3c7', padding: '2px 6px', borderRadius: 3 }}>SHADOW</span>;
  return <span style={{ fontSize: 10, fontWeight: 600, color: '#15803d', background: '#dcfce7', padding: '2px 6px', borderRadius: 3 }}>PRODUCTIVO</span>;
}

function btnMini(color: string): React.CSSProperties {
  return {
    padding: '3px 8px', fontSize: 10, fontWeight: 700, color: 'white', background: color,
    border: 'none', borderRadius: 3, cursor: 'pointer', textTransform: 'uppercase',
  };
}
