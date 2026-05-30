/**
 * MÓDULO 3 — Financieros
 *
 *   3.1 Facturación      — CRUD facturas asociadas a cotización
 *   3.2 Abonos           — CRUD abonos (con estado_validacion); trigger SQL
 *                          recalcula cotizaciones.abono_monto y saldo.
 *   3.3 Cartera          — vista GLOBAL (no requiere ctx) de personas con
 *                          deuda > 0, ordenadas por monto.
 *   3.4 Variaciones      — log de diferencias económicas entre cotización y
 *                          factura (descuentos, cambios, retrabajos).
 *   3.5 Rentabilidad     — margen real (venta + variaciones − costos del
 *                          proyecto: producto, motor, viáticos, mano obra...).
 */
import { useState } from 'react';
import { useContextoActivo } from '../lib/contexto_activo';
import { PanelSintesis } from './PanelSintesis';
import { useNavegacion } from '../lib/navegacion';
import { Facturacion } from './m3/Facturacion';
import { Abonos } from './m3/Abonos';
import { Variaciones } from './m3/Variaciones';
import { Rentabilidad } from './m3/Rentabilidad';

// 3.3 Cartera movida a "Vistas globales" — era la única no per-cliente

type Sub = 'facturacion' | 'abonos' | 'variaciones' | 'rentabilidad';

const TABS: { id: Sub; label: string; requiereContexto: boolean }[] = [
  { id: 'facturacion',  label: '3.1 Facturación',   requiereContexto: true  },
  { id: 'abonos',       label: '3.2 Abonos',        requiereContexto: true  },
  { id: 'variaciones',  label: '3.3 Variaciones',   requiereContexto: true  },
  { id: 'rentabilidad', label: '3.4 Rentabilidad',  requiereContexto: true  },
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
          Análisis financiero del cliente activo. El detalle (facturación, abonos, cartera…) está en las sub-tabs.
        </p>
      </div>

      <PanelSintesis modulo="m3" titulo="Análisis Financiero" />

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
            {sub === 'variaciones'  && <Variaciones />}
            {sub === 'rentabilidad' && <Rentabilidad />}
          </>
        )}
      </div>
    </div>
  );
}
