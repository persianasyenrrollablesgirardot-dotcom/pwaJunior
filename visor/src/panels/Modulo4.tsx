/**
 * MÓDULO 4 — Técnicos
 *
 *   4.1 Medidas             — 5 etapas (cliente/empresa/corregida/produccion/instalada)
 *   4.2 Riesgo medidas      — alertas automáticas (vw_riesgos_medidas)
 *   4.3 Producto/Sistema    — items del cliente agrupados por sistema Safra
 *   4.4 Advertencias        — advertencias técnicas filtradas por sistemas del cliente
 *   4.5 Compatibilidad      — validador tela/motor/control por sistema
 *   4.6 Biblioteca técnica  — link al proyecto separado localhost:5500 (RAG de 13 agentes)
 */
import { useState } from 'react';
import { useContextoActivo } from '../lib/contexto_activo';
import { useNavegacion } from '../lib/navegacion';
import { Medidas } from './m4/Medidas';
import { RiesgoMedidas } from './m4/RiesgoMedidas';
import { ProductoSistema } from './m4/ProductoSistema';
import { Advertencias } from './m4/Advertencias';

// 4.5 Compatibilidad y 4.6 Biblioteca técnica movidas a "Vistas globales"
// (eran catálogos y links externos, no info de cliente).

type Sub = 'medidas' | 'riesgo' | 'producto' | 'advertencias';

const TABS: { id: Sub; label: string; requiereContexto: boolean }[] = [
  { id: 'medidas',        label: '4.1 Medidas',          requiereContexto: true },
  { id: 'riesgo',         label: '4.2 Riesgo medidas',   requiereContexto: true },
  { id: 'producto',       label: '4.3 Producto/Sistema', requiereContexto: true },
  { id: 'advertencias',   label: '4.4 Advertencias',     requiereContexto: true },
];

export function Modulo4() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [sub, setSub] = useState<Sub>('medidas');

  const tabActual = TABS.find(t => t.id === sub)!;
  const necesitaCtx = tabActual.requiereContexto && !ctx.hayContexto;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <h1 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 700 }}>MÓDULO 4 · Técnicos</h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>
          Medidas, riesgos, producto, advertencias técnicas, compatibilidades y biblioteca técnica del cliente activo.
        </p>
      </div>

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
              Esta sub-tab muestra info técnica del cliente. Andá al módulo <strong>Clientes</strong> y elegí uno.
            </p>
            <button onClick={() => nav.cambiarModulo('clientes')}
              style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              → Ir a Clientes
            </button>
          </div>
        ) : (
          <>
            {sub === 'medidas'        && <Medidas />}
            {sub === 'riesgo'         && <RiesgoMedidas />}
            {sub === 'producto'       && <ProductoSistema />}
            {sub === 'advertencias'   && <Advertencias />}
          </>
        )}
      </div>
    </div>
  );
}
