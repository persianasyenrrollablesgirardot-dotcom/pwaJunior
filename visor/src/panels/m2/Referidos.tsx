/**
 * 2.5 Referidos — métricas del valor comercial de la red de referidos del cliente.
 *
 * No duplica la lista de M1 Identidad: acá se muestra como MÉTRICA de negocio
 * (cuánto vendiste a personas que el cliente activo refirió, vs el cliente solo).
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { supabase } from '../../lib/supabase';

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });

interface ReferidoConMetricas {
  persona_id: number;
  nombre: string;
  cotizaciones_total: number;
  monto_ganado: number;
  cotizaciones_activas: number;
}

export function Referidos() {
  const ctx = useContextoActivo();
  const [referidos, setReferidos] = useState<ReferidoConMetricas[]>([]);
  const [referidor, setReferidor] = useState<ReferidoConMetricas | null>(null);
  const [propios, setPropios] = useState<ReferidoConMetricas | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    setCargando(true);
    (async () => {
      // Cliente activo + a quién refirió + quién lo refirió
      const { data: persona } = await supabase.from('personas')
        .select('id, nombre, referido_por_persona_id')
        .eq('id', ctx.personaActivaId).single();

      const { data: refList } = await supabase.from('personas')
        .select('id, nombre')
        .eq('referido_por_persona_id', ctx.personaActivaId)
        .is('deleted_at', null);

      // Métricas del cliente activo
      const propias = await metricsPersona(ctx.personaActivaId!);
      setPropios({ persona_id: persona!.id, nombre: persona!.nombre, ...propias });

      // Métricas de cada referido
      const conMetricas = await Promise.all((refList ?? []).map(async (r: any) => ({
        persona_id: r.id, nombre: r.nombre, ...(await metricsPersona(r.id)),
      })));
      setReferidos(conMetricas);

      // Referidor (quién refirió al cliente activo)
      if (persona?.referido_por_persona_id) {
        const { data: refr } = await supabase.from('personas').select('id, nombre').eq('id', persona.referido_por_persona_id).single();
        if (refr) setReferidor({ persona_id: refr.id, nombre: refr.nombre, ...(await metricsPersona(refr.id)) });
      } else { setReferidor(null); }

      setCargando(false);
    })().catch(() => setCargando(false));
  }, [ctx.personaActivaId]);

  if (cargando) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando red de referidos…</div>;

  const totalRedGanado = (propios?.monto_ganado ?? 0) + referidos.reduce((a, r) => a + r.monto_ganado, 0);

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Red de referidos</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Valor comercial generado por <strong>{ctx.personaActivaNombre}</strong> y su red.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        <KPI label="🌐 Personas en su red" valor={referidos.length + (referidor ? 1 : 0)} color="var(--accent)" />
        <KPI label="✓ Cotizaciones ganadas (red)" valor={(propios?.cotizaciones_total ?? 0)
          - (propios?.cotizaciones_activas ?? 0)
          + referidos.reduce((a, r) => a + (r.cotizaciones_total - r.cotizaciones_activas), 0)} color="var(--green)" />
        <KPI label="💰 Monto ganado red" valor={fmtCop(totalRedGanado)} color="var(--green)" />
      </div>

      {/* Referidor (arriba) */}
      {referidor && (
        <>
          <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.5, marginBottom: 6 }}>↑ Referido por</h3>
          <FilaPersona r={referidor} prefix="recomendó al cliente actual" />
        </>
      )}

      {/* Cliente activo */}
      <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.5, marginBottom: 6, marginTop: 16 }}>● Cliente activo</h3>
      {propios && <FilaPersona r={propios} highlight />}

      {/* Referidos por el cliente */}
      {referidos.length > 0 && (
        <>
          <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.5, marginBottom: 6, marginTop: 16 }}>↓ Personas que recomendó</h3>
          {referidos.map(r => <FilaPersona key={r.persona_id} r={r} />)}
        </>
      )}

      {!referidor && referidos.length === 0 && (
        <div style={{ padding: 20, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', marginTop: 16 }}>
          Este cliente no tiene relaciones de referido registradas. Editá la persona en M1 Identidad para asignar referidor.
        </div>
      )}
    </div>
  );
}

function FilaPersona({ r, prefix, highlight }: { r: ReferidoConMetricas; prefix?: string; highlight?: boolean }) {
  return (
    <div style={{
      background: highlight ? 'var(--accent-soft)' : 'var(--bg-panel)',
      border: `1px solid ${highlight ? 'var(--accent)' : 'var(--border-soft)'}`,
      borderRadius: 8, padding: 12, marginBottom: 6,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <strong>{r.nombre}</strong>
        <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 700 }}>{fmtCop(r.monto_ganado)}</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
        {prefix && <span>{prefix} · </span>}
        {r.cotizaciones_total} cotizaciones · {r.cotizaciones_activas} activas
      </div>
    </div>
  );
}

async function metricsPersona(id: number): Promise<{ cotizaciones_total: number; monto_ganado: number; cotizaciones_activas: number }> {
  const { data } = await supabase.from('vw_comerciales_resumen').select('*').eq('persona_id', id).maybeSingle();
  if (!data) return { cotizaciones_total: 0, monto_ganado: 0, cotizaciones_activas: 0 };
  return {
    cotizaciones_total: Number(data.cotizaciones_total) || 0,
    monto_ganado: Number(data.monto_ganado_total) || 0,
    cotizaciones_activas: (Number(data.cotizaciones_propuestas) || 0) + (Number(data.cotizaciones_negociando) || 0),
  };
}

function KPI({ label, valor, color }: { label: string; valor: number | string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 140 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{valor}</div>
    </div>
  );
}
