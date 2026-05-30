/**
 * VISTAS GLOBALES — agrupador de sub-tabs que NO dependen del cliente activo.
 *
 * Antes vivían dispersas en M2/M3/M4/M5/M7 mezcladas con tabs per-cliente,
 * lo cual confundía: al seleccionar cliente "X" y entrar a M3.3 Cartera
 * aparecían TODOS los clientes con deuda, no solo X. Solución: separarlas
 * en este módulo top-level. Los M2-M7 quedan 100% per-cliente.
 *
 * Sub-tabs (8):
 *   G.1 Agenda operativa     — instalaciones + tareas pendientes
 *   G.2 Rutas y zonas        — agrupado geográfico para visitas
 *   G.3 Cartera              — personas con saldo pendiente
 *   G.4 Recompra             — clientes ganados hace > N meses
 *   G.5 Transcripciones      — audios transcritos cross-cliente
 *   G.6 Difusiones           — chats broadcast + plantillas
 *   G.7 Compatibilidad       — reglas técnicas Safra (catálogo)
 *   G.8 Biblioteca técnica   — link al proyecto RAG separado
 */
import { useState } from 'react';
import { AgendaOperativa } from './m5/AgendaOperativa';
import { RutasZonas } from './m5/RutasZonas';
import { Cartera } from './m3/Cartera';
import { Recompra } from './m2/Recompra';
import { TranscripcionesAudioGlobal } from './m7/TranscripcionesAudioGlobal';
import { Difusiones } from './m5/Difusiones';
import { Compatibilidad } from './m4/Compatibilidad';
import { BibliotecaTecnica } from './m4/BibliotecaTecnica';

type Sub = 'agenda' | 'rutas' | 'cartera' | 'recompra' | 'transcripciones' | 'difusiones' | 'compatibilidad' | 'biblioteca';

const TABS: { id: Sub; label: string; descripcion: string }[] = [
  { id: 'agenda',          label: 'G.1 Agenda',          descripcion: 'instalaciones programadas + tareas pendientes de hoy / semana' },
  { id: 'rutas',           label: 'G.2 Rutas y zonas',   descripcion: 'instalaciones próximas agrupadas por zona geográfica' },
  { id: 'cartera',         label: 'G.3 Cartera',         descripcion: 'personas con saldo pendiente > 0, ordenadas por deuda' },
  { id: 'recompra',        label: 'G.4 Recompra',        descripcion: 'clientes con compra ganada hace > N meses, candidatos a contactar' },
  { id: 'transcripciones', label: 'G.5 Transcripciones', descripcion: 'audios transcritos de TODOS los clientes — búsqueda full-text' },
  { id: 'difusiones',      label: 'G.6 Difusiones',      descripcion: 'chats broadcast + biblioteca de plantillas de respuesta' },
  { id: 'compatibilidad',  label: 'G.7 Compatibilidad',  descripcion: 'reglas técnicas Safra por sistema (catálogo)' },
  { id: 'biblioteca',      label: 'G.8 Biblioteca',      descripcion: 'link al proyecto separado de la biblioteca RAG (13 agentes especialistas)' },
];

export function VistasGlobales() {
  const [sub, setSub] = useState<Sub>('agenda');
  const tabActual = TABS.find(t => t.id === sub)!;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>🌐 Vistas globales</h1>
          <span style={{ fontSize: 10, padding: '2px 8px', background: 'var(--bg-page)', color: 'var(--text-muted)', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
            sin cliente activo
          </span>
        </div>
        <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 12 }}>
          Estas vistas muestran TODA la operación, no info de un cliente específico. Son útiles cuando necesitás ver el negocio completo o decidir a quién contactar.
        </p>
      </div>

      <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0', borderBottom: '1px solid var(--border-soft)', flexWrap: 'wrap' }}>
        {TABS.map(t => {
          const activo = t.id === sub;
          return (
            <button key={t.id} onClick={() => setSub(t.id)}
              title={t.descripcion}
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

      {/* Banner contextual: recuerda al usuario que es global */}
      <div style={{
        padding: '8px 24px',
        background: 'var(--bg-page)',
        borderBottom: '1px solid var(--border-soft)',
        fontSize: 11, color: 'var(--text-muted)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <span style={{ fontSize: 14 }}>🌐</span>
        <span>{tabActual.descripcion}</span>
      </div>

      <div style={{ flex: 1, overflow: 'auto' }}>
        {sub === 'agenda'          && <AgendaOperativa />}
        {sub === 'rutas'           && <RutasZonas />}
        {sub === 'cartera'         && <Cartera />}
        {sub === 'recompra'        && <Recompra />}
        {sub === 'transcripciones' && <TranscripcionesAudioGlobal />}
        {sub === 'difusiones'      && <Difusiones />}
        {sub === 'compatibilidad'  && <Compatibilidad />}
        {sub === 'biblioteca'      && <BibliotecaTecnica />}
      </div>
    </div>
  );
}
