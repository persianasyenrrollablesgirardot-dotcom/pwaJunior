/**
 * MÓDULO 5 — Operativos
 *
 *   5.1 Producción       — estado por cotización ganada (pendiente_abono → instalado)
 *   5.2 Instalaciones    — CRUD visitas (parcial/fallida/reagendada/completa)
 *   5.3 Agenda operativa — vista global cronológica (instalaciones + tareas pendientes)
 *   5.4 Rutas y zonas    — agrupar instalaciones por zona (Girardot, Ricaurte, Melgar...)
 *   5.5 Tareas           — pendientes por cliente activo
 *   5.6 Checklist        — items por fase (antes/durante/despues) por instalación
 */
import { useState } from 'react';
import { useContextoActivo } from '../lib/contexto_activo';
import { useNavegacion } from '../lib/navegacion';
import { Produccion } from './m5/Produccion';
import { Instalaciones } from './m5/Instalaciones';
import { AgendaOperativa } from './m5/AgendaOperativa';
import { RutasZonas } from './m5/RutasZonas';
import { Tareas } from './m5/Tareas';
import { ChecklistInstalacion } from './m5/ChecklistInstalacion';
import { Difusiones } from './m5/Difusiones';

type Sub = 'produccion' | 'instalaciones' | 'agenda' | 'rutas' | 'tareas' | 'checklist' | 'difusiones';

const TABS: { id: Sub; label: string; requiereContexto: boolean }[] = [
  { id: 'produccion',    label: '5.1 Producción',     requiereContexto: true  },
  { id: 'instalaciones', label: '5.2 Instalaciones',  requiereContexto: true  },
  { id: 'agenda',        label: '5.3 Agenda',         requiereContexto: false },   // global
  { id: 'rutas',         label: '5.4 Rutas y zonas',  requiereContexto: false },   // global
  { id: 'tareas',        label: '5.5 Tareas',         requiereContexto: true  },
  { id: 'checklist',     label: '5.6 Checklist',      requiereContexto: true  },
  { id: 'difusiones',    label: '5.7 Difusiones',     requiereContexto: false },   // global
];

export function Modulo5() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [sub, setSub] = useState<Sub>('produccion');

  const tabActual = TABS.find(t => t.id === sub)!;
  const necesitaCtx = tabActual.requiereContexto && !ctx.hayContexto;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <h1 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 700 }}>MÓDULO 5 · Operativos</h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>
          Producción, instalaciones, agenda, rutas, tareas y checklist de instalación.
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
              Esta sub-tab muestra info operativa del cliente. Andá al módulo <strong>Clientes</strong> y elegí uno.
            </p>
            <button onClick={() => nav.cambiarModulo('clientes')}
              style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}>
              → Ir a Clientes
            </button>
          </div>
        ) : (
          <>
            {sub === 'produccion'    && <Produccion />}
            {sub === 'instalaciones' && <Instalaciones />}
            {sub === 'agenda'        && <AgendaOperativa />}
            {sub === 'rutas'         && <RutasZonas />}
            {sub === 'tareas'        && <Tareas />}
            {sub === 'checklist'     && <ChecklistInstalacion />}
            {sub === 'difusiones'    && <Difusiones />}
          </>
        )}
      </div>
    </div>
  );
}
