/**
 * 8.2 Pipelines — visualiza el DAG de cada pipeline.
 */
import { useEffect, useState } from 'react';
import { fetchPipelines, type PipelineRow } from '../../lib/m8_queries';

export function Pipelines() {
  const [rows, setRows] = useState<PipelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        setRows(await fetchPipelines());
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div style={{ padding: '20px 24px' }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 700 }}>Pipelines del enjambre</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Cada pipeline define un DAG de agentes que se dispara cuando llega un evento que cumple las condiciones del trigger.
        El worker <code>worker_pipeline_v2</code> los ejecuta automáticamente.
      </p>

      {err && <div style={{ padding: 12, background: '#fee', border: '1px solid #fcc', borderRadius: 4, color: '#900', fontSize: 13 }}>{err}</div>}
      {loading && <div style={{ padding: 16, color: 'var(--text-muted)' }}>Cargando…</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {rows.map(p => <PipelineCard key={p.id} p={p} />)}
        {rows.length === 0 && !loading && (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>Sin pipelines definidos</div>
        )}
      </div>
    </div>
  );
}

function PipelineCard({ p }: { p: PipelineRow }) {
  const cond = p.trigger_condiciones ?? {};
  const condStr = Object.entries(cond).map(([k, v]) => `${k}=${v}`).join(', ') || '(sin condiciones extra)';
  return (
    <div style={{ border: '1px solid var(--border-soft)', borderRadius: 6, background: 'white', padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <code style={{ fontSize: 13, fontWeight: 700 }}>{p.codigo}</code>
        <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 3,
          background: p.activo ? (p.shadow ? '#fef3c7' : '#dcfce7') : '#f1f5f9',
          color: p.activo ? (p.shadow ? '#b45309' : '#15803d') : '#94a3b8',
          fontWeight: 600, textTransform: 'uppercase' }}>
          {!p.activo ? 'off' : (p.shadow ? 'shadow' : 'productivo')}
        </span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>prio={p.prioridad} · v{p.version} · max ${Number(p.costo_max_estimado_usd).toFixed(2)}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>{p.descripcion ?? '—'}</div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
        <strong>Trigger:</strong> <code>{p.trigger_tipo_evento}</code> · {condStr}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, overflowX: 'auto', paddingBottom: 4 }}>
        {(p.pasos?.fases ?? []).map((f, i) => (
          <FaseBox key={i} fase={f} esUltima={i === (p.pasos?.fases?.length ?? 0) - 1} />
        ))}
      </div>
    </div>
  );
}

function FaseBox({ fase, esUltima }: { fase: PipelineRow['pasos']['fases'][number]; esUltima: boolean }) {
  const colorPorModo: Record<string, string> = {
    paralelo: '#3b82f6',
    serial: '#22c55e',
    routing: '#a855f7',
  };
  const color = colorPorModo[fase.modo] ?? '#94a3b8';

  return (
    <>
      <div style={{ minWidth: 160, border: `1px solid ${color}40`, background: `${color}08`, borderRadius: 6, padding: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 700, color, textTransform: 'uppercase' }}>{fase.modo}</span>
          <span style={{ fontSize: 11, fontWeight: 600 }}>{fase.id}</span>
        </div>

        {fase.modo === 'routing' ? (
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4 }}>switch: <code>{fase.switch_on}</code></div>
            {Object.entries(fase.rutas ?? {}).map(([k, lista]) => (
              <div key={k} style={{ marginBottom: 3 }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: '#6b7280' }}>{k}:</span>{' '}
                {(lista as string[]).map((a, j) => (
                  <code key={`${a}-${j}`} style={{ fontSize: 10, padding: '1px 4px', background: 'white', border: '1px solid var(--border-soft)', borderRadius: 3, marginRight: 2 }}>{a}</code>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {(fase.agentes ?? []).map((a, j) => (
              <code key={`${a}-${j}`} style={{ fontSize: 10, padding: '2px 6px', background: 'white', border: '1px solid var(--border-soft)', borderRadius: 3 }}>{a}</code>
            ))}
          </div>
        )}
      </div>
      {!esUltima && (
        <div style={{ alignSelf: 'center', color: '#cbd5e1', fontSize: 18 }}>→</div>
      )}
    </>
  );
}
