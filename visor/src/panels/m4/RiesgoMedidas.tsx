/**
 * 4.2 Riesgo medidas — alertas automáticas (vw_riesgos_medidas).
 *
 * Detecta: medidas incompletas, negativas, alto/ancho invertido probable,
 * cliente midió (R-013#1), área excesiva, área muy pequeña.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { fetchRiesgosPorPersona, type RiesgoMedida } from '../../lib/queries';

const TIPO_LABEL: Record<string, string> = {
  incompleta: 'Medida incompleta (falta ancho o alto)',
  negativa_o_cero: 'Medida negativa o cero',
  alto_ancho_invertido_probable: 'Alto/ancho invertido probable (alto > 3× ancho)',
  cliente_midio_riesgo_alto: 'Cliente midió — riesgo alto (R-013#1)',
  area_excesiva: 'Área >25m² — verificar viabilidad',
  area_muy_pequena: 'Área <0.3m² — posible error',
};
const SEV_COLOR: Record<string, string> = {
  critico: 'var(--red)',
  warning: 'var(--orange)',
  info: 'var(--accent)',
};
const SEV_ICON: Record<string, string> = {
  critico: '🚨',
  warning: '⚠',
  info: 'ℹ',
};

export function RiesgoMedidas() {
  const ctx = useContextoActivo();
  const [riesgos, setRiesgos] = useState<RiesgoMedida[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    fetchRiesgosPorPersona(ctx.personaActivaId)
      .then(setRiesgos)
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, [ctx.personaActivaId]);

  const grupos = {
    critico: riesgos.filter(r => r.severidad === 'critico'),
    warning: riesgos.filter(r => r.severidad === 'warning'),
    info:    riesgos.filter(r => r.severidad === 'info'),
  };

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Riesgos en medidas de {ctx.personaActivaNombre} ({riesgos.length})
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Alertas detectadas automáticamente sobre las medidas registradas en 4.1.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="🚨 Críticos" valor={grupos.critico.length} color={SEV_COLOR.critico} />
        <KPI label="⚠ Warning"  valor={grupos.warning.length} color={SEV_COLOR.warning} />
        <KPI label="ℹ Info"     valor={grupos.info.length}    color={SEV_COLOR.info} />
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && riesgos.length === 0 && (
        <div style={{ padding: 30, background: '#e8f8ee', border: '1px solid var(--green)', borderRadius: 8, color: 'var(--green)', fontSize: 13, textAlign: 'center' }}>
          ✓ Sin riesgos detectados. Las medidas registradas se ven consistentes.
        </div>
      )}

      {(['critico', 'warning', 'info'] as const).map(sev => (
        grupos[sev].length > 0 && (
          <div key={sev} style={{ marginBottom: 16 }}>
            <h3 style={{ fontSize: 11, color: SEV_COLOR[sev], textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>
              {SEV_ICON[sev]} {sev}
            </h3>
            {grupos[sev].map(r => (
              <div key={r.medida_id} style={{
                background: 'var(--bg-panel)',
                border: `1px solid ${SEV_COLOR[sev]}`,
                borderRadius: 8, padding: 12, marginBottom: 8,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <strong style={{ fontSize: 13, color: SEV_COLOR[sev] }}>
                    {TIPO_LABEL[r.tipo_riesgo ?? ''] ?? r.tipo_riesgo}
                  </strong>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>etapa: {r.etapa}</span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  Cotización: <strong>{r.numero_cotizacion ?? '#' + r.cotizacion_id}</strong>
                  {r.sistema_safra_codigo && <> · {r.sistema_safra_codigo}</>}
                  {r.ambiente && <> · {r.ambiente}</>}
                  {' · '}
                  {r.ancho_m != null && r.alto_m != null
                    ? <>medida {Number(r.ancho_m).toFixed(2)}×{Number(r.alto_m).toFixed(2)}m ({Number(r.area_m2 ?? 0).toFixed(2)}m²)</>
                    : <em>(sin medida completa)</em>}
                </div>
              </div>
            ))}
          </div>
        )
      ))}
    </div>
  );
}

function KPI({ label, valor, color }: { label: string; valor: number | string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 110 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{valor}</div>
    </div>
  );
}
