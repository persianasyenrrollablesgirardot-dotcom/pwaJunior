/**
 * Módulo Junior — el asistente de Jhon.
 *
 * Contenedor con pestañas de gestión:
 *  - Chat: la conversación con Junior.
 *  - Instrucciones por chat: registro visible de todo lo que Jhon le dictó.
 *  - Checklist por chat: estado de cada conversación (quién tiene la pelota).
 * Más adelante se suma Tareas agregando una pestaña acá.
 */
import { useState } from 'react';
import { JuniorChat } from './JuniorChat';
import { JuniorChecklist } from './JuniorChecklist';
import { JuniorTareas } from './JuniorTareas';
import { JuniorAgendamientos } from './JuniorAgendamientos';

type Tab = 'chat' | 'checklist' | 'agendamientos' | 'tareas';

const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: '💬 Chat' },
  { id: 'checklist', label: '✅ Checklist por chat' },
  { id: 'agendamientos', label: '📅 Agendamientos' },
  { id: 'tareas', label: '📋 Tareas' },
];

export function Junior() {
  const [tab, setTab] = useState<Tab>('chat');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Encabezado + pestañas */}
      <div style={{ padding: '14px 24px 0', borderBottom: '1px solid var(--border-soft)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%', background: 'var(--accent)',
            color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
          }}>🤖</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>Junior</h1>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-muted)' }}>
              Tu asistente. Conoce el estado de todos tus clientes.
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 4 }}>
          {TABS.map(t => {
            const activa = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                style={{
                  padding: '8px 14px', fontSize: 13, fontWeight: activa ? 700 : 500,
                  border: 'none', background: 'transparent', cursor: 'pointer',
                  color: activa ? 'var(--accent)' : 'var(--text-muted)',
                  borderBottom: `2px solid ${activa ? 'var(--accent)' : 'transparent'}`,
                  marginBottom: -1,
                }}
              >{t.label}</button>
            );
          })}
        </div>
      </div>

      {/* Contenido de la pestaña activa — se usa display:none en vez de desmontar
          para preservar el estado (texto del input, posición de scroll) al cambiar de tab. */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <div style={{ display: tab === 'chat' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
          <JuniorChat />
        </div>
        <div style={{ display: tab === 'checklist' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
          <JuniorChecklist />
        </div>
        <div style={{ display: tab === 'agendamientos' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
          <JuniorAgendamientos />
        </div>
        <div style={{ display: tab === 'tareas' ? 'flex' : 'none', flexDirection: 'column', height: '100%' }}>
          <JuniorTareas />
        </div>
      </div>
    </div>
  );
}
