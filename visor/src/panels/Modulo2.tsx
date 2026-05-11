/**
 * MÓDULO 2 — Comerciales
 *
 * Vista detalle del cliente activo (selección hace en módulo "Clientes"):
 *   2.1 Cotizaciones    — CRUD completo (lista + form modal)
 *   2.2 Comparador      — cotizaciones lado a lado para ver cambios
 *   2.3 Objeciones      — registro de "muy caro", "lo pienso", etc.
 *   2.4 Seguimiento     — estado actual + próxima acción + alerta si parado
 *   2.5 Referidos       — métricas: quién refirió a quién (red de valor)
 *   2.6 Recompra        — clientes viejos > N meses → candidatos a llamar (vista global)
 */
import { useState } from 'react';
import { useContextoActivo } from '../lib/contexto_activo';
import { useNavegacion } from '../lib/navegacion';
import { Cotizaciones } from './m2/Cotizaciones';
import { Comparador } from './m2/Comparador';
import { Objeciones } from './m2/Objeciones';
import { Seguimiento } from './m2/Seguimiento';
import { Referidos } from './m2/Referidos';

// 2.6 Recompra movida a "Vistas globales" — era la única no per-cliente

type Sub = 'cotizaciones' | 'comparador' | 'objeciones' | 'seguimiento' | 'referidos';

const TABS: { id: Sub; label: string; requiereContexto: boolean }[] = [
  { id: 'cotizaciones', label: '2.1 Cotizaciones',  requiereContexto: true  },
  { id: 'comparador',   label: '2.2 Comparador',    requiereContexto: true  },
  { id: 'objeciones',   label: '2.3 Objeciones',    requiereContexto: true  },
  { id: 'seguimiento',  label: '2.4 Seguimiento',   requiereContexto: true  },
  { id: 'referidos',    label: '2.5 Referidos',     requiereContexto: true  },
];

export function Modulo2() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [sub, setSub] = useState<Sub>('cotizaciones');

  const tabActual = TABS.find(t => t.id === sub)!;
  const necesitaCtx = tabActual.requiereContexto && !ctx.hayContexto;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 700 }}>MÓDULO 2 · Comerciales</h1>
        </div>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>
          Cotizaciones, comparador, objeciones, seguimiento, referidos y recompra del cliente activo.
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
            {sub === 'cotizaciones'  && <Cotizaciones />}
            {sub === 'comparador'    && <Comparador />}
            {sub === 'objeciones'    && <Objeciones />}
            {sub === 'seguimiento'   && <Seguimiento />}
            {sub === 'referidos'     && <Referidos />}
          </>
        )}
      </div>
    </div>
  );
}
