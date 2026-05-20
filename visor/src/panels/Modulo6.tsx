/**
 * MÓDULO 6 — Postventa
 *
 *   6.1 Garantías        — CRUD con causa→responsable auto-mapeado
 *   6.2 Mantenimientos   — registro de servicios (lavado, perfilado, cambios)
 *   6.3 Satisfacción     — estado del cliente post-instalación
 *   6.4 Google Reviews   — workflow apto → solicitada → recibida (estrellas)
 *   6.5 Reclamos sensibles — escalation tracking con severidad
 */
import { useState } from 'react';
import { useContextoActivo } from '../lib/contexto_activo';
import { PanelSintesis } from './PanelSintesis';
import { useNavegacion } from '../lib/navegacion';
import { Garantias } from './m6/Garantias';
import { Mantenimientos } from './m6/Mantenimientos';
import { Satisfaccion } from './m6/Satisfaccion';
import { GoogleReviews } from './m6/GoogleReviews';
import { ReclamosSensibles } from './m6/ReclamosSensibles';

type Sub = 'garantias' | 'mantenimientos' | 'satisfaccion' | 'reviews' | 'reclamos';

const TABS: { id: Sub; label: string }[] = [
  { id: 'garantias',      label: '6.1 Garantías' },
  { id: 'mantenimientos', label: '6.2 Mantenimientos' },
  { id: 'satisfaccion',   label: '6.3 Satisfacción' },
  { id: 'reviews',        label: '6.4 Google Reviews' },
  { id: 'reclamos',       label: '6.5 Reclamos sensibles' },
];

export function Modulo6() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [sub, setSub] = useState<Sub>('garantias');
  const necesitaCtx = !ctx.hayContexto;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <h1 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 700 }}>MÓDULO 6 · Postventa</h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>
          Análisis de postventa del cliente activo. El detalle (garantías, reclamos, reseñas…) está en las sub-tabs.
        </p>
      </div>

      <PanelSintesis modulo="m6" titulo="Análisis de Postventa" />

      <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0', borderBottom: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
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
              Andá al módulo <strong>Clientes</strong> y elegí uno.
            </p>
            <button onClick={() => nav.cambiarModulo('clientes')}
              style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              → Ir a Clientes
            </button>
          </div>
        ) : (
          <>
            {sub === 'garantias'      && <Garantias />}
            {sub === 'mantenimientos' && <Mantenimientos />}
            {sub === 'satisfaccion'   && <Satisfaccion />}
            {sub === 'reviews'        && <GoogleReviews />}
            {sub === 'reclamos'       && <ReclamosSensibles />}
          </>
        )}
      </div>
    </div>
  );
}
