/**
 * PanelSintesis — la conclusión del agente-analista para el cliente activo.
 *
 * Es lo PRIMERO que se ve al entrar a un módulo: una respuesta única y
 * conclusiva (síntesis + estado + próximo paso + alerta), no tablas crudas.
 * Las sub-tabs de detalle quedan abajo como soporte.
 *
 * Lee de la tabla `modulo_sintesis`, poblada por el agente analista de cada
 * módulo. Reusable: <PanelSintesis modulo="m2" />, "m3", etc.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../lib/contexto_activo';
import { supabase } from '../lib/supabase';

interface Sintesis {
  sintesis: string | null;
  estado: string | null;
  estado_semaforo: 'verde' | 'amarillo' | 'rojo' | null;
  proximo_paso: string | null;
  alerta: string | null;
  generado_at: string;
  generado_por: string | null;
}

const SEMAFORO: Record<string, { color: string; emoji: string }> = {
  verde:    { color: '#34c759', emoji: '🟢' },
  amarillo: { color: '#ff9500', emoji: '🟡' },
  rojo:     { color: '#ff3b30', emoji: '🔴' },
};

const fmtFecha = (s: string) =>
  new Date(s).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

const fmtFechaCorta = (s: string) =>
  new Date(s).toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });

interface Novedad { id: number; hecho: string; created_at: string }

export function PanelSintesis({ modulo, titulo }: { modulo: string; titulo: string }) {
  const ctx = useContextoActivo();
  const [data, setData] = useState<Sintesis | null>(null);
  const [novedades, setNovedades] = useState<Novedad[]>([]);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (ctx.personaActivaId == null) { setData(null); setNovedades([]); setCargando(false); return; }
    setCargando(true);
    const personaId = ctx.personaActivaId;
    Promise.all([
      supabase
        .from('modulo_sintesis')
        .select('sintesis,estado,estado_semaforo,proximo_paso,alerta,generado_at,generado_por')
        .eq('persona_id', personaId)
        .eq('modulo', modulo)
        .maybeSingle(),
      supabase
        .from('correcciones_humanas')
        .select('id,hecho,created_at')
        .eq('persona_id', personaId)
        .eq('modulo', modulo)
        .eq('vigente', true)
        .order('created_at', { ascending: false }),
    ]).then(([sint, corr]) => {
      setData((sint.data as Sintesis) ?? null);
      setNovedades((corr.data as Novedad[]) ?? []);
      setCargando(false);
    });
  }, [ctx.personaActivaId, modulo]);

  if (ctx.personaActivaId == null) return null;

  const wrap: React.CSSProperties = {
    margin: '16px 24px 4px',
    background: 'var(--bg-panel)',
    border: '1px solid var(--border-soft)',
    borderRadius: 10,
    padding: '16px 18px',
  };

  if (cargando) {
    return <div style={{ ...wrap, color: 'var(--text-muted)', fontSize: 13 }}>Cargando análisis…</div>;
  }

  if (!data || !data.sintesis) {
    return (
      <div style={{ ...wrap, color: 'var(--text-muted)', fontSize: 13 }}>
        El analista todavía no procesó a <strong>{ctx.personaActivaNombre}</strong>. Procesá su chat
        para que el agente genere el análisis.
      </div>
    );
  }

  const sem = SEMAFORO[data.estado_semaforo ?? 'verde'] ?? SEMAFORO.verde;

  return (
    <div style={{ ...wrap, borderLeft: `4px solid ${sem.color}` }}>
      {/* Encabezado */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'var(--accent)' }}>
          🤖 {titulo} — {ctx.personaActivaNombre}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
          analizado {fmtFecha(data.generado_at)}
        </span>
      </div>

      {/* Síntesis */}
      <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.55, color: 'var(--text)' }}>
        {data.sintesis}
      </p>

      {/* Estado */}
      {data.estado && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 14 }}>{sem.emoji}</span>
          <span style={{ fontSize: 13, fontWeight: 600, color: sem.color }}>{data.estado}</span>
        </div>
      )}

      {/* Próximo paso */}
      {data.proximo_paso && (
        <div style={{
          padding: '8px 12px', background: 'var(--accent-soft)', borderRadius: 6,
          fontSize: 13, lineHeight: 1.5, marginBottom: data.alerta ? 8 : 0,
        }}>
          <strong style={{ color: 'var(--accent)' }}>→ Próximo paso: </strong>
          {data.proximo_paso}
        </div>
      )}

      {/* Alerta */}
      {data.alerta && (
        <div style={{
          padding: '8px 12px', background: 'rgba(255,59,48,0.08)',
          border: '1px solid rgba(255,59,48,0.3)', borderRadius: 6,
          fontSize: 13, lineHeight: 1.5, color: '#ff3b30',
        }}>
          <strong>⚠ Alerta: </strong>{data.alerta}
        </div>
      )}

      {/* Novedades registradas — las correcciones que Jhon le dio a Junior */}
      {novedades.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-soft)' }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 6 }}>
            📌 Novedades que registraste
          </div>
          {novedades.map(n => (
            <div key={n.id} style={{ display: 'flex', gap: 8, fontSize: 12, lineHeight: 1.5, marginBottom: 4 }}>
              <span style={{ color: 'var(--text-muted)', flexShrink: 0, fontWeight: 600 }}>
                {fmtFechaCorta(n.created_at)}
              </span>
              <span style={{ color: 'var(--text)' }}>{n.hecho}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
