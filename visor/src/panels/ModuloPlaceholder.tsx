interface Props {
  titulo: string;
  subtitulo: string;
}

export function ModuloPlaceholder({ titulo, subtitulo }: Props) {
  return (
    <div style={{ padding: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <div style={{
        textAlign: 'center',
        padding: 48,
        background: 'var(--bg-panel)',
        border: '1px dashed var(--border)',
        borderRadius: 12,
        maxWidth: 480,
      }}>
        <div style={{ fontSize: 32, marginBottom: 12, opacity: 0.4 }}>○</div>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{titulo}</h2>
        <p style={{ marginTop: 8, color: 'var(--text-muted)', fontSize: 13 }}>{subtitulo}</p>
        <p style={{ marginTop: 16, fontSize: 11, color: 'var(--text-muted)' }}>
          Construcción secuencial — un módulo a la vez<br />
          Ver <code>MAPA.md</code> para el orden
        </p>
      </div>
    </div>
  );
}
