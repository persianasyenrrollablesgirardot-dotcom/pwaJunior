/**
 * MÓDULO 7 — Evidencias
 *
 *   7.1 Archivo documental — galería unificada de TODA la evidencia del cliente
 *   7.2 Evidencia por evento — eventos con evidencia adjunta visible
 *   7.3 Transcripción audio — vista global cross-cliente de audios transcritos
 *   7.4 Captura en vivo — upload manual + transcripción (futura llamada en vivo)
 */
import { useState } from 'react';
import { useContextoActivo } from '../lib/contexto_activo';
import { useNavegacion } from '../lib/navegacion';
import { ArchivoDocumental } from './m7/ArchivoDocumental';
import { EvidenciaEventos } from './m7/EvidenciaEventos';
import { CapturaEnVivo } from './m7/CapturaEnVivo';

// 7.3 Transcripción audio (cross-cliente) movida a "Vistas globales".

type Sub = 'archivo' | 'eventos' | 'captura';

const TABS: { id: Sub; label: string; requiereContexto: boolean }[] = [
  { id: 'archivo',  label: '7.1 Archivo documental',  requiereContexto: true },
  { id: 'eventos',  label: '7.2 Evidencia por evento', requiereContexto: true },
  { id: 'captura',  label: '7.3 Captura en vivo',     requiereContexto: true },
];

export function Modulo7() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [sub, setSub] = useState<Sub>('archivo');
  const tab = TABS.find(t => t.id === sub)!;
  const necesitaCtx = tab.requiereContexto && !ctx.hayContexto;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <h1 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 700 }}>MÓDULO 7 · Evidencias</h1>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>
          Archivo unificado de fotos/videos/audios/comprobantes + eventos con evidencia + transcripciones + captura manual.
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
            {sub === 'archivo' && <ArchivoDocumental />}
            {sub === 'eventos' && <EvidenciaEventos />}
            {sub === 'captura' && <CapturaEnVivo />}
          </>
        )}
      </div>
    </div>
  );
}
