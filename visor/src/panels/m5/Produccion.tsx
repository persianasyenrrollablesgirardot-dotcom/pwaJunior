/**
 * 5.1 Producción — estado por cotización ganada del cliente activo.
 *
 * Lista las cotizaciones ganadas + estado de producción (1:1 con cotización).
 * Si no hay orden de producción, ofrece crear una. Quick-actions para
 * avanzar estado pendiente_abono → pedido_proveedor → en_produccion → ...
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchCotizacionesPorPersona, fetchProduccionPorPersona,
  upsertProduccion, cambiarEstadoProduccion,
  ESTADOS_PRODUCCION, type EstadoProduccion, type Cotizacion, type ProduccionOrden,
} from '../../lib/queries';

const ESTADO_LABEL: Record<EstadoProduccion, string> = {
  pendiente_abono: 'Pendiente abono',
  pedido_proveedor: 'Pedido a proveedor',
  en_produccion: 'En producción',
  listo_para_instalar: 'Listo para instalar',
  retenido: 'Retenido',
  entregado: 'Entregado',
  instalado: 'Instalado',
};
const ESTADO_COLOR: Record<EstadoProduccion, string> = {
  pendiente_abono: '#ff9500',
  pedido_proveedor: '#5856d6',
  en_produccion: '#5ac8fa',
  listo_para_instalar: '#34c759',
  retenido: '#ff3b30',
  entregado: '#34c759',
  instalado: '#34c759',
};

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Produccion() {
  const ctx = useContextoActivo();
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [ordenes, setOrdenes] = useState<ProduccionOrden[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    try {
      const [c, o] = await Promise.all([
        fetchCotizacionesPorPersona(ctx.personaActivaId),
        fetchProduccionPorPersona(ctx.personaActivaId),
      ]);
      // solo cotizaciones ganadas tienen sentido en producción
      setCotizaciones(c.filter(x => x.estado === 'ganada'));
      setOrdenes(o);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { recargar(); }, [ctx.personaActivaId]);

  function fb(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 3000);
  }

  async function crearOrden(cot: Cotizacion) {
    try {
      await upsertProduccion({
        cotizacion_id: cot.id,
        persona_id: ctx.personaActivaId!,
        estado: 'pendiente_abono',
        fecha_inicio: new Date().toISOString().slice(0, 10),
      });
      await recargar();
      fb('ok', 'Orden de producción creada');
    } catch (e: any) { fb('err', e.message); }
  }

  async function avanzar(orden: ProduccionOrden, nuevo: EstadoProduccion) {
    try {
      await cambiarEstadoProduccion(orden.id, nuevo);
      await recargar();
      fb('ok', `Estado → ${ESTADO_LABEL[nuevo]}`);
    } catch (e: any) { fb('err', e.message); }
  }

  const stats = {
    cotizaciones_sin_orden: cotizaciones.filter(c => !ordenes.find(o => o.cotizacion_id === c.id)).length,
    en_proceso: ordenes.filter(o => ['pedido_proveedor', 'en_produccion'].includes(o.estado)).length,
    listo: ordenes.filter(o => o.estado === 'listo_para_instalar').length,
    instalado: ordenes.filter(o => o.estado === 'instalado' || o.estado === 'entregado').length,
    retenido: ordenes.filter(o => o.estado === 'retenido').length,
  };

  if (cargando) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Producción de {ctx.personaActivaNombre}
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Estado por cotización ganada. Avanza con los quick-actions.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}
      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="Sin orden"        valor={stats.cotizaciones_sin_orden}  color="var(--text-muted)" />
        <KPI label="⚙ En proceso"     valor={stats.en_proceso}              color="var(--accent)" />
        <KPI label="✓ Listo instalar"  valor={stats.listo}                   color="var(--green)" />
        <KPI label="📦 Entregado/Instalado" valor={stats.instalado}          color="var(--green)" />
        <KPI label="⚠ Retenido"        valor={stats.retenido}                color="var(--red)" />
      </div>

      {cotizaciones.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin cotizaciones ganadas para {ctx.personaActivaNombre}. Marcalas como ganadas en M2 primero.
        </div>
      )}

      {cotizaciones.map(cot => {
        const orden = ordenes.find(o => o.cotizacion_id === cot.id);
        return (
          <div key={cot.id} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <strong style={{ fontSize: 14 }}>
                {cot.numero_cotizacion ?? '#' + cot.id}
                <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
                  · {fmtCop(Number(cot.total))}
                </span>
              </strong>
              {orden ? (
                <span style={{ fontSize: 11, fontWeight: 700, color: ESTADO_COLOR[orden.estado], textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {ESTADO_LABEL[orden.estado]}
                </span>
              ) : (
                <button onClick={() => crearOrden(cot)} style={btnPrim}>+ Crear orden producción</button>
              )}
            </div>

            {orden && (
              <>
                <div style={{ display: 'flex', gap: 14, fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>
                  {orden.fecha_inicio       && <span>Inicio: {fmtFecha(orden.fecha_inicio)}</span>}
                  {orden.fecha_estimada_lista && <span>Estimada: {fmtFecha(orden.fecha_estimada_lista)}</span>}
                  {orden.fecha_entrega       && <span>Entrega: {fmtFecha(orden.fecha_entrega)}</span>}
                  {orden.vendor              && <span>Proveedor: {orden.vendor}</span>}
                </div>
                {orden.estado === 'retenido' && orden.motivo_retencion && (
                  <div style={{ padding: 8, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 11, marginBottom: 10 }}>
                    ⚠ Retenido: {orden.motivo_retencion}
                  </div>
                )}

                {/* Quick-actions */}
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {ESTADOS_PRODUCCION.filter(e => e !== orden.estado).map(e => (
                    <button key={e} onClick={() => avanzar(orden, e)}
                      style={{
                        padding: '4px 10px', fontSize: 10, fontWeight: 600,
                        background: 'white', color: ESTADO_COLOR[e],
                        border: `1px solid ${ESTADO_COLOR[e]}`, borderRadius: 4, cursor: 'pointer',
                      }}>
                      → {ESTADO_LABEL[e]}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        );
      })}
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
const btnPrim: React.CSSProperties = { padding: '6px 12px', fontSize: 11, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' };
