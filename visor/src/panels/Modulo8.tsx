/**
 * MÓDULO 8 — Agentes
 *
 *   8.1 Lista agentes      → ver/editar 33 agentes (activo/shadow + métricas hoy)
 *   8.2 Pipelines          → DAG de PIPE_MENSAJE_COMERCIAL / PIPE_AUDIO / PIPE_IMAGEN
 *   8.3 Invocaciones       → log de cada llamada al LLM
 *   8.4 DLQ                → eventos que fallaron 3 veces, reintentar/resolver
 *   8.5 Correcciones       → memoria de errores que Jhon corrigió a los agentes
 *
 * GLOBAL: no requiere persona/proyecto/chat activo.
 */
import { useState } from 'react';
import { ListaAgentes } from './m8/ListaAgentes';
import { Pipelines } from './m8/Pipelines';
import { Invocaciones } from './m8/Invocaciones';
import { DLQ } from './m8/DLQ';
import { Correcciones } from './m8/Correcciones';

type Sub = 'agentes' | 'pipelines' | 'invocaciones' | 'dlq' | 'correcciones';

const TABS: { id: Sub; label: string }[] = [
  { id: 'agentes',      label: '8.1 Agentes' },
  { id: 'pipelines',    label: '8.2 Pipelines' },
  { id: 'invocaciones', label: '8.3 Invocaciones' },
  { id: 'dlq',          label: '8.4 DLQ' },
  { id: 'correcciones', label: '8.5 Correcciones' },
];

export function Modulo8() {
  const [sub, setSub] = useState<Sub>('agentes');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <h1 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 700 }}>MÓDULO 8 · Agentes</h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>
          Enjambre de 33 agentes IA. Cada uno arranca en <strong>shadow</strong> (propone al buzón, no escribe) y Jhon lo
          promueve a <strong>productivo</strong> cuando confía en sus resultados.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0', borderBottom: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
        {TABS.map(t => {
          const activo = t.id === sub;
          return (
            <button key={t.id} onClick={() => setSub(t.id)} style={{
              padding: '8px 14px', fontSize: 12,
              fontWeight: activo ? 600 : 500,
              color: activo ? 'var(--accent)' : 'var(--text-muted)',
              background: 'transparent', border: 'none',
              borderBottom: activo ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: -1, cursor: 'pointer',
            }}>{t.label}</button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {sub === 'agentes'      && <ListaAgentes />}
        {sub === 'pipelines'    && <Pipelines />}
        {sub === 'invocaciones' && <Invocaciones />}
        {sub === 'dlq'          && <DLQ />}
        {sub === 'correcciones' && <Correcciones />}
      </div>
    </div>
  );
}
