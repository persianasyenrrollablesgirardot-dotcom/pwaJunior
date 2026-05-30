/**
 * 7.1 Archivo documental — galería unificada de TODA la evidencia del cliente.
 * Combina evidencias_manuales + mensajes con media + abonos.comprobante +
 * instalaciones.fotos_urls + garantías.evidencia_urls.
 */
import { useEffect, useMemo, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { fetchEvidenciasPorPersona, type EvidenciaUnificada } from '../../lib/queries';

const FUENTE_LABEL: Record<EvidenciaUnificada['fuente'], string> = {
  evidencia_manual:   '📁 Manual',
  mensaje_wa:         '💬 WhatsApp',
  abono_comprobante:  '💵 Abono',
  instalacion_foto:   '🔧 Instalación',
  garantia_evidencia: '⚠ Garantía',
};
const FUENTE_COLOR: Record<EvidenciaUnificada['fuente'], string> = {
  evidencia_manual:   '#8e8e93',
  mensaje_wa:         '#34c759',
  abono_comprobante:  '#5856d6',
  instalacion_foto:   '#5ac8fa',
  garantia_evidencia: '#ff3b30',
};
const TIPO_ICON: Record<string, string> = {
  foto: '🖼️', video: '🎬', audio: '🎙️', comprobante: '🧾',
  factura: '🧾', cotizacion_pdf: '📋', pdf: '📄', imagen_medida: '📐',
  documento: '📎', otro: '📦',
};

const fmtFecha = (s: string) => new Date(s).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ArchivoDocumental() {
  const ctx = useContextoActivo();
  const [items, setItems] = useState<EvidenciaUnificada[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filtroTipo, setFiltroTipo] = useState<string>('');
  const [filtroFuente, setFiltroFuente] = useState<string>('');

  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    fetchEvidenciasPorPersona(ctx.personaActivaId)
      .then(setItems)
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, [ctx.personaActivaId]);

  const filtradas = useMemo(() => items.filter(i =>
    (!filtroTipo || i.tipo === filtroTipo) &&
    (!filtroFuente || i.fuente === filtroFuente)
  ), [items, filtroTipo, filtroFuente]);

  const stats = {
    total: items.length,
    fotos: items.filter(i => i.tipo === 'foto').length,
    audios: items.filter(i => i.tipo === 'audio').length,
    comprobantes: items.filter(i => i.tipo === 'comprobante').length,
    docs: items.filter(i => i.tipo === 'documento' || i.tipo === 'pdf').length,
  };

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Archivo documental — {ctx.personaActivaNombre} ({stats.total})
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Galería unificada de todas las evidencias del cliente.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="🖼️ Fotos"        valor={stats.fotos}        color="var(--accent)" />
        <KPI label="🎙️ Audios"       valor={stats.audios}       color="var(--orange)" />
        <KPI label="🧾 Comprobantes" valor={stats.comprobantes} color="#5856d6" />
        <KPI label="📄 Documentos"   valor={stats.docs}         color="var(--text)" />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value)} style={selStyle}>
          <option value="">— Todos los tipos —</option>
          <option value="foto">🖼️ Foto</option>
          <option value="video">🎬 Video</option>
          <option value="audio">🎙️ Audio</option>
          <option value="comprobante">🧾 Comprobante</option>
          <option value="documento">📎 Documento</option>
          <option value="pdf">📄 PDF</option>
        </select>
        <select value={filtroFuente} onChange={e => setFiltroFuente(e.target.value)} style={selStyle}>
          <option value="">— Todas las fuentes —</option>
          <option value="mensaje_wa">💬 WhatsApp</option>
          <option value="evidencia_manual">📁 Manual</option>
          <option value="abono_comprobante">💵 Abono</option>
          <option value="instalacion_foto">🔧 Instalación</option>
          <option value="garantia_evidencia">⚠ Garantía</option>
        </select>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{filtradas.length} resultados</span>
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && filtradas.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          {items.length === 0
            ? `Sin evidencias todavía para ${ctx.personaActivaNombre}.`
            : 'Sin resultados para los filtros actuales.'}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
        {filtradas.map(e => (
          <div key={e.uid} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ fontSize: 24 }}>{TIPO_ICON[e.tipo] ?? '📦'}</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: FUENTE_COLOR[e.fuente], textTransform: 'uppercase', letterSpacing: 0.4 }}>
                {FUENTE_LABEL[e.fuente]}
              </span>
            </div>
            {/* Preview: imagen si es foto */}
            {e.tipo === 'foto' && e.url && (
              <img src={e.url} alt="" style={{ width: '100%', height: 140, objectFit: 'cover', borderRadius: 4, marginBottom: 6 }}
                onError={(ev) => { (ev.target as HTMLImageElement).style.display = 'none'; }} />
            )}
            {e.tipo === 'audio' && e.url && (
              <audio controls src={e.url} style={{ width: '100%', marginBottom: 6 }} />
            )}
            <div style={{ fontSize: 12, marginBottom: 4 }}>
              {e.descripcion || <em style={{ color: 'var(--text-muted)' }}>(sin descripción)</em>}
            </div>
            {e.texto_extraido && e.texto_extraido !== e.descripcion && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 4, padding: 6, background: 'var(--bg-page)', borderRadius: 4 }}>
                📝 {e.texto_extraido.slice(0, 120)}{e.texto_extraido.length > 120 ? '…' : ''}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)' }}>
              <span>{e.quien ?? '—'}</span>
              <span>{fmtFecha(e.ts)}</span>
            </div>
            {e.url && (
              <a href={e.url} target="_blank" rel="noreferrer" style={{ display: 'block', marginTop: 6, fontSize: 11, color: 'var(--accent)', textDecoration: 'none' }}>
                ↗ Abrir original
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function KPI({ label, valor, color }: { label: string; valor: number | string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 120 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{valor}</div>
    </div>
  );
}
const selStyle: React.CSSProperties = { padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'white' };
