/**
 * 4.5 Compatibilidad técnica — validador de configuración por sistema.
 *
 * Catálogo global (no requiere cliente activo). Para cada sistema, lista las
 * reglas de qué componentes (tela, motor, tubo, soporte, riel, control, cenefa)
 * son compatibles o NO sirven.
 *
 * Útil cuando vas a armar una cotización para no proponer configs que fallan.
 */
import { useEffect, useMemo, useState } from 'react';
import { fetchReglasCompatibilidad, fetchSistemasSafra, type ReglaCompatibilidad } from '../../lib/queries';

const SEV_COLOR: Record<string, string> = { critico: 'var(--red)', warning: 'var(--orange)', info: 'var(--accent)' };
const SEV_ICON: Record<string, string> = { critico: '🚨', warning: '⚠', info: 'ℹ' };

export function Compatibilidad() {
  const [reglas, setReglas] = useState<ReglaCompatibilidad[]>([]);
  const [sistemas, setSistemas] = useState<{ codigo: string; nombre: string }[]>([]);
  const [filtroSistema, setFiltroSistema] = useState('');
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCargando(true); setError(null);
    Promise.all([fetchReglasCompatibilidad(), fetchSistemasSafra()])
      .then(([r, s]) => { setReglas(r); setSistemas(s); })
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, []);

  const reglasFiltradas = useMemo(() => {
    if (!filtroSistema) return reglas;
    return reglas.filter(r => r.sistema_codigo === filtroSistema);
  }, [reglas, filtroSistema]);

  const porSistema: Record<string, ReglaCompatibilidad[]> = {};
  for (const r of reglasFiltradas) {
    const k = r.sistema_codigo ?? '(global)';
    (porSistema[k] ||= []).push(r);
  }

  const nombreSistema = (codigo: string) => sistemas.find(s => s.codigo === codigo)?.nombre ?? codigo;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Reglas de compatibilidad técnica</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Catálogo global. Para cada sistema Safra, qué componentes funcionan y cuáles NO.
        Sirve para no proponer configuraciones que fallen en instalación o producción.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Filtrar por sistema:</span>
        <select value={filtroSistema} onChange={e => setFiltroSistema(e.target.value)}
          style={{ padding: '5px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
          <option value="">— Todos los sistemas —</option>
          {sistemas.map(s => <option key={s.codigo} value={s.codigo}>{s.nombre}</option>)}
        </select>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{reglasFiltradas.length} reglas</span>
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && reglasFiltradas.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin reglas para {filtroSistema ? nombreSistema(filtroSistema) : 'el filtro actual'}.
        </div>
      )}

      {Object.entries(porSistema).map(([sistema, rs]) => (
        <div key={sistema} style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>
            {sistema === '(global)' ? 'Aplica a todos' : nombreSistema(sistema)}
          </h3>
          {rs.map(r => (
            <div key={r.id} style={{
              background: 'var(--bg-panel)',
              border: `1px solid ${SEV_COLOR[r.severidad]}`,
              borderRadius: 6, padding: 12, marginBottom: 8,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                <strong style={{ fontSize: 13, color: SEV_COLOR[r.severidad] }}>
                  {SEV_ICON[r.severidad]} Componente: {r.componente}
                </strong>
                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.codigo}</span>
              </div>
              {r.regla && <div style={{ fontSize: 12, marginBottom: 6 }}>{r.regla}</div>}
              <div style={{ display: 'flex', gap: 16, fontSize: 11 }}>
                {(r.valores_ok ?? []).length > 0 && (
                  <div>
                    <span style={{ color: 'var(--green)', fontWeight: 700 }}>✓ OK:</span>{' '}
                    {(r.valores_ok ?? []).join(', ')}
                  </div>
                )}
                {(r.valores_ko ?? []).length > 0 && (
                  <div>
                    <span style={{ color: 'var(--red)', fontWeight: 700 }}>✗ NO:</span>{' '}
                    {(r.valores_ko ?? []).join(', ')}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
