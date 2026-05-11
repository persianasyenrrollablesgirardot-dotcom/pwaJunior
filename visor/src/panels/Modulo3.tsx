/**
 * MÓDULO 3 — Financieros
 *
 *   3.1 Facturación      — CRUD facturas asociadas a cotización
 *   3.2 Abonos           — CRUD abonos (con estado_validacion); trigger SQL
 *                          recalcula cotizaciones.abono_monto y saldo.
 *   3.3 Cartera          — vista GLOBAL (no requiere ctx) de personas con
 *                          deuda > 0, ordenadas por monto.
 *   3.4 Variaciones      — pendiente F3.4 (descuentos / cambios de producto /
 *                          retrabajos entre cotización y factura).
 *   3.5 Rentabilidad     — pendiente F3.5 (necesita tabla de costos: tela,
 *                          herrajes, motor, viáticos, visitas extra, retrabajos).
 */
import { useState } from 'react';
import { useContextoActivo } from '../lib/contexto_activo';
import { useNavegacion } from '../lib/navegacion';
import { Facturacion } from './m3/Facturacion';
import { Abonos } from './m3/Abonos';
import { Cartera } from './m3/Cartera';
import { Placeholder3x } from './m3/Placeholder3x';

type Sub = 'facturacion' | 'abonos' | 'cartera' | 'variaciones' | 'rentabilidad';

const TABS: { id: Sub; label: string; requiereContexto: boolean }[] = [
  { id: 'facturacion',  label: '3.1 Facturación',   requiereContexto: true  },
  { id: 'abonos',       label: '3.2 Abonos',        requiereContexto: true  },
  { id: 'cartera',      label: '3.3 Cartera',       requiereContexto: false },   // global
  { id: 'variaciones',  label: '3.4 Variaciones',   requiereContexto: false },   // placeholder
  { id: 'rentabilidad', label: '3.5 Rentabilidad',  requiereContexto: false },   // placeholder
];

export function Modulo3() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [sub, setSub] = useState<Sub>('facturacion');

  const tabActual = TABS.find(t => t.id === sub)!;
  const necesitaCtx = tabActual.requiereContexto && !ctx.hayContexto;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <h1 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 700 }}>MÓDULO 3 · Financieros</h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>
          Facturación, abonos, cartera. Variaciones y rentabilidad llegan después.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0', borderBottom: '1px solid var(--border-soft)' }}>
        {TABS.map(t => {
          const activo = t.id === sub;
          return (
            <button key={t.id} onClick={() => setSub(t.id)}
              style={{
                padding: '8px 14px', fontSize: 12,
                fontWeight: activo ? 600 : 500,
                color: activo ? 'var(--accent)' : 'var(--text-muted)',
                background: 'transparent', border: 'none',
                borderBottom: activo ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1, cursor: 'pointer',
              }}
            >{t.label}</button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {necesitaCtx ? (
          <div style={{ padding: 60, textAlign: 'center' }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>👤</div>
            <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700 }}>Sin cliente activo</h2>
            <p style={{ margin: '0 auto 16px', maxWidth: 420, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
              Esta sub-tab muestra info del cliente que vos seleccionaste. Andá al módulo <strong>Clientes</strong> y elegí uno.
            </p>
            <button onClick={() => nav.cambiarModulo('clientes')}
              style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              → Ir a Clientes
            </button>
          </div>
        ) : (
          <>
            {sub === 'facturacion'  && <Facturacion />}
            {sub === 'abonos'       && <Abonos />}
            {sub === 'cartera'      && <Cartera />}
            {sub === 'variaciones'  && <Placeholder3x titulo="3.4 Variaciones económicas" subtitulo="Log de descuentos, cambios de producto, motor agregado, retrabajos, etc., entre cotización y factura." pendienteId="F3.4" requisitos={['Tabla facturas con datos', 'Tabla abonos con datos', 'Cotizaciones ganadas con items concretos']} />}
            {sub === 'rentabilidad' && <Placeholder3x titulo="3.5 Rentabilidad real" subtitulo="Margen real: venta − costos (tela, herrajes, motores, viáticos, visitas extra, retrabajos)." pendienteId="F3.5" requisitos={['Tabla de costos por sistema Safra', 'Registro de visitas técnicas extra', 'Tiempo operativo por proyecto', 'Costos de garantías ejecutadas']} />}
          </>
        )}
      </div>
    </div>
  );
}
