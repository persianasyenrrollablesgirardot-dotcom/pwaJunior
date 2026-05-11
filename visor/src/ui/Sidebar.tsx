export type ModuloId =
  | 'centro_control'
  | 'captura'
  | 'clientes'
  | 'm1' | 'm2' | 'm3' | 'm4' | 'm5'
  | 'm6' | 'm7' | 'm8' | 'm9' | 'm10'
  | 'junior';

interface SidebarProps {
  modulos: { id: ModuloId; nombre: string }[];
  activo: ModuloId;
  onChange: (id: ModuloId) => void;
}

export function Sidebar({ modulos, activo, onChange }: SidebarProps) {
  return (
    <aside style={{
      width: 240,
      background: 'var(--bg-sidebar)',
      color: 'var(--text-on-dark)',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0,
    }}>
      <div style={{ padding: '20px 16px 16px', borderBottom: '1px solid #38383a' }}>
        <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: -0.3 }}>Visor PG</div>
        <div style={{ fontSize: 11, color: '#8e8e93', marginTop: 2 }}>Persianas Girardot</div>
      </div>

      <nav style={{ flex: 1, overflow: 'auto', padding: '8px 0' }}>
        {modulos.map(m => {
          const esActivo = m.id === activo;
          const esCentro = m.id === 'centro_control';
          const esCaptura = m.id === 'captura';
          const esClientes = m.id === 'clientes';
          const esJunior = m.id === 'junior';
          const esSeparator = m.id === 'm1';
          return (
            <div key={m.id}>
              {esSeparator && (
                <div style={{ padding: '12px 16px 4px', fontSize: 10, color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>
                  Módulos del Visor
                </div>
              )}
              {esJunior && (
                <div style={{ padding: '12px 16px 4px', fontSize: 10, color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.6, fontWeight: 600 }}>
                  Asistente personal
                </div>
              )}
              <button
                onClick={() => onChange(m.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 16px',
                  fontSize: 13,
                  background: esActivo ? 'var(--bg-sidebar-active)' : 'transparent',
                  color: esActivo ? 'white' : (esCentro || esCaptura || esClientes || esJunior ? '#5ac8fa' : '#d1d1d6'),
                  border: 'none',
                  fontWeight: esActivo ? 600 : (esCentro || esCaptura || esClientes || esJunior ? 500 : 400),
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => { if (!esActivo) e.currentTarget.style.background = 'var(--bg-sidebar-hover)'; }}
                onMouseLeave={(e) => { if (!esActivo) e.currentTarget.style.background = 'transparent'; }}
              >
                {m.nombre}
              </button>
            </div>
          );
        })}
      </nav>

      <div style={{ padding: '12px 16px', borderTop: '1px solid #38383a', fontSize: 11, color: '#8e8e93' }}>
        <div>v0.1 · MVP</div>
        <div style={{ marginTop: 2 }}>Mockup con datos fake</div>
      </div>
    </aside>
  );
}
