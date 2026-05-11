/**
 * Placeholder explícito para sub-tabs del M3 que aún NO están implementadas.
 * Muestra: título, motivo, requisitos pendientes y código de tarea (F3.x).
 */
export function Placeholder3x({ titulo, subtitulo, pendienteId, requisitos }: {
  titulo: string;
  subtitulo: string;
  pendienteId: string;
  requisitos: string[];
}) {
  return (
    <div style={{ padding: 60, textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 12 }}>🚧</div>
      <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700 }}>{titulo}</h2>
      <p style={{ margin: '0 auto 20px', maxWidth: 480, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        {subtitulo}
      </p>

      <div style={{ display: 'inline-block', background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, padding: 16, textAlign: 'left', maxWidth: 480 }}>
        <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.5, marginBottom: 8 }}>
          Pendiente — código de tarea: <span style={{ color: 'var(--accent)' }}>{pendienteId}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text)', marginBottom: 6, fontWeight: 600 }}>Para implementarlo necesito antes:</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.7 }}>
          {requisitos.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      </div>
    </div>
  );
}
