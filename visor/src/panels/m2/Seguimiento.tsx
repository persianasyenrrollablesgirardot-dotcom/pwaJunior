/**
 * 2.4 Seguimiento — vista read-only del estado actual de cada cotización
 * con próxima acción y alerta si está parado >N días.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { fetchCotizacionesPorPersona, type Cotizacion } from '../../lib/queries';

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const ESTADO_LABEL: Record<string, string> = {
  propuesta: 'Propuesta', negociando: 'Negociando', intencion_cierre: 'Intención de cierre',
  ganada: 'Ganada', perdida: 'Perdida', vencida: 'Vencida', cancelada: 'Cancelada',
};
const ESTADO_COLOR: Record<string, string> = {
  propuesta: '#007aff', negociando: '#ff9500', intencion_cierre: '#5856d6',
  ganada: '#34c759', perdida: '#8e8e93', vencida: '#ff3b30', cancelada: '#6e6e73',
};

export function Seguimiento() {
  const ctx = useContextoActivo();
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    fetchCotizacionesPorPersona(ctx.personaActivaId).then(c => { setCotizaciones(c); setCargando(false); });
  }, [ctx.personaActivaId]);

  if (cargando) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>;

  const ahora = new Date();
  const activas = cotizaciones.filter(c => c.estado !== 'cancelada' && c.estado !== 'perdida');
  const conAccion = activas.filter(c => c.proxima_accion);
  const sinAccion = activas.filter(c => !c.proxima_accion);
  const stats = {
    pendientes_decision: cotizaciones.filter(c => c.estado === 'propuesta' || c.estado === 'negociando').length,
    intencion_cierre: cotizaciones.filter(c => c.estado === 'intencion_cierre').length,
    cerradas_recientes: cotizaciones.filter(c => c.estado === 'ganada' && (ahora.getTime() - new Date(c.updated_at).getTime()) < 30 * 24 * 60 * 60 * 1000).length,
    saldo_pendiente: cotizaciones.reduce((a, c) => a + Number(c.saldo ?? 0), 0),
  };

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Seguimiento de {ctx.personaActivaNombre}</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Estado actual de cada cotización + próxima acción + alerta si está parado.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <KPI label="⏳ Pendientes decisión" valor={stats.pendientes_decision} color="var(--orange)" />
        <KPI label="🎯 Intención cierre" valor={stats.intencion_cierre} color="#5856d6" />
        <KPI label="✓ Ganadas <30d" valor={stats.cerradas_recientes} color="var(--green)" />
        <KPI label="💰 Saldo pend total" valor={fmtCop(stats.saldo_pendiente)} color={stats.saldo_pendiente > 0 ? 'var(--orange)' : 'var(--text-muted)'} />
      </div>

      {cotizaciones.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin cotizaciones que seguir.
        </div>
      )}

      {conAccion.length > 0 && (
        <>
          <h3 style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>Con próxima acción definida</h3>
          {conAccion.map(c => <FilaSeg key={c.id} cot={c} ahora={ahora} />)}
        </>
      )}

      {sinAccion.length > 0 && (
        <>
          <h3 style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8, marginTop: 20 }}>⚠ Sin próxima acción asignada</h3>
          {sinAccion.map(c => <FilaSeg key={c.id} cot={c} ahora={ahora} />)}
        </>
      )}
    </div>
  );
}

function FilaSeg({ cot, ahora }: { cot: Cotizacion; ahora: Date }) {
  const diasParado = Math.floor((ahora.getTime() - new Date(cot.updated_at).getTime()) / (24 * 60 * 60 * 1000));
  const alerta = diasParado > 7 && (cot.estado === 'propuesta' || cot.estado === 'negociando');
  return (
    <div style={{ background: 'var(--bg-panel)', border: `1px solid ${alerta ? 'var(--orange)' : 'var(--border-soft)'}`, borderRadius: 8, padding: 12, marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <strong>{cot.numero_cotizacion ?? '#' + cot.id}</strong>
        <span style={{ fontSize: 10, fontWeight: 700, color: ESTADO_COLOR[cot.estado], textTransform: 'uppercase' }}>{ESTADO_LABEL[cot.estado]}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <span>Total {fmtCop(Number(cot.total))}</span>
        {Number(cot.saldo) > 0 && <span style={{ color: 'var(--orange)' }}>Saldo {fmtCop(Number(cot.saldo))}</span>}
        <span>Última actualización: {fmtFecha(cot.updated_at.slice(0, 10))} ({diasParado}d atrás)</span>
        {alerta && <span style={{ color: 'var(--orange)', fontWeight: 600 }}>⚠ parado &gt;7d</span>}
      </div>
      {cot.proxima_accion && (
        <div style={{ marginTop: 8, padding: 8, background: 'var(--accent-soft)', borderRadius: 6, fontSize: 12 }}>
          → <strong>{cot.proxima_accion.replace(/_/g, ' ')}</strong>{cot.proxima_accion_fecha && ` (${fmtFecha(cot.proxima_accion_fecha)})`}
        </div>
      )}
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
