/**
 * 4.6 Biblioteca técnica — link al proyecto separado de la biblioteca RAG.
 *
 * La biblioteca técnica vive en http://localhost:5500 (proyecto aparte).
 * Tiene 13 agentes especialistas: Blackout, Screen Solar, Sheer Elegance,
 * Panel Japonés, Enrollables, Verticales, Películas Solares, Toldos, Motores,
 * Domótica, Rieles, Mantenimientos, Garantías.
 *
 * Hace health-check para saber si está corriendo, y si sí, abre en iframe.
 */
import { useEffect, useState } from 'react';

const BIB_URL = 'http://localhost:5500';
const ESPECIALISTAS = [
  'Blackout', 'Screen Solar', 'Sheer Elegance', 'Panel Japonés',
  'Enrollables', 'Verticales', 'Películas Solares', 'Toldos',
  'Motores', 'Domótica', 'Rieles', 'Mantenimientos', 'Garantías',
];

export function BibliotecaTecnica() {
  const [estado, setEstado] = useState<'verificando' | 'online' | 'offline'>('verificando');
  const [verIframe, setVerIframe] = useState(false);

  useEffect(() => {
    // health-check con timeout corto
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    fetch(BIB_URL, { mode: 'no-cors', signal: ctrl.signal })
      .then(() => { setEstado('online'); clearTimeout(t); })
      .catch(() => { setEstado('offline'); clearTimeout(t); });
    return () => { ctrl.abort(); clearTimeout(t); };
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Biblioteca técnica</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        El conocimiento técnico (fichas, compatibilidades, garantías, advertencias por sistema)
        vive en un proyecto separado: la <strong>biblioteca RAG</strong> en{' '}
        <code style={{ background: 'var(--bg-page)', padding: '1px 6px', borderRadius: 4 }}>{BIB_URL}</code>
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16 }}>
        <div style={{
          padding: '6px 14px', fontSize: 11, fontWeight: 700, borderRadius: 14, textTransform: 'uppercase', letterSpacing: 0.4,
          background: estado === 'online' ? 'var(--green)' : estado === 'offline' ? 'var(--red)' : 'var(--orange)',
          color: 'white',
        }}>
          {estado === 'verificando' ? 'Verificando…' : estado === 'online' ? '● Online' : '○ Offline'}
        </div>
        {estado === 'online' && (
          <>
            <button onClick={() => setVerIframe(v => !v)} style={btnPrim}>
              {verIframe ? 'Cerrar visor' : 'Abrir biblioteca acá ↓'}
            </button>
            <a href={BIB_URL} target="_blank" rel="noreferrer" style={{ ...btnSec, textDecoration: 'none', display: 'inline-block' }}>
              Abrir en nueva pestaña ↗
            </a>
          </>
        )}
      </div>

      {estado === 'offline' && (
        <div style={{ padding: 16, background: '#ffe5e5', border: '1px solid var(--red)', borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          <strong style={{ color: 'var(--red)' }}>✗ La biblioteca RAG no está corriendo.</strong><br />
          Iniciala con:<br />
          <code style={{ display: 'block', background: 'var(--bg-page)', padding: 8, borderRadius: 4, marginTop: 8, fontSize: 11 }}>
            cd C:\Proyectos\Sandbox_Enjambre_Precios{'\n'}
            npm run dev
          </code>
        </div>
      )}

      <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginTop: 20, marginBottom: 8 }}>
        Los 13 agentes especialistas
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 6 }}>
        {ESPECIALISTAS.map(nombre => (
          <div key={nombre} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: '8px 12px', fontSize: 12, fontWeight: 500 }}>
            🤖 {nombre}
          </div>
        ))}
      </div>

      {verIframe && estado === 'online' && (
        <div style={{ marginTop: 20, border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
          <iframe src={BIB_URL} title="Biblioteca técnica RAG" style={{ width: '100%', height: 600, border: 'none' }} />
        </div>
      )}

      <div style={{ marginTop: 20, padding: 12, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        ℹ La integración profunda (que cada item de cotización consulte automáticamente al agente
        especialista de su sistema, traiga ficha técnica, advertencias y compatibilidades) está
        planificada para el <strong>Agente_Biblioteca_RAG</strong> — el sistema nervioso central de la
        red de apps de Persianas Girardot.
      </div>
    </div>
  );
}

const btnPrim: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' };
const btnSec: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' };
