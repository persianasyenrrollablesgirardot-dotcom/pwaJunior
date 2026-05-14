/**
 * 2.6 Recompra — clientes viejos con cotizaciones ganadas hace >N meses,
 * candidatos a llamar.
 *
 * NO requiere cliente activo (vista global).
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { useNavegacion } from '../../lib/navegacion';
import { fetchCotizacionesGlobal, type Cotizacion } from '../../lib/queries';

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string) => new Date(s).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });

export function Recompra() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [meses, setMeses] = useState(6);
  const [filas, setFilas] = useState<{ cotizacion: Cotizacion; persona_nombre: string | null }[]>([]);
  const [cargando, setCargando] = useState(true);

  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setCargando(true); setError(null);
    fetchCotizacionesGlobal({ recompraDesdeMeses: meses })
      .then(setFilas)
      .catch(e => setError(e?.message ?? String(e)))
      .finally(() => setCargando(false));
  }, [meses]);

  function activarCliente(personaId: number, nombre: string) {
    ctx.seleccionarPersona(personaId, nombre);
    nav.cambiarModulo('m2');
  }

  // Agrupar por persona (un cliente puede tener varias cotizaciones ganadas viejas)
  const agrupado = new Map<number, { persona_nombre: string | null; ultima_compra: string; total_ganado: number; cotizaciones: number; persona_id: number }>();
  for (const f of filas) {
    const pid = f.cotizacion.persona_id;
    if (pid == null) continue;
    const existing = agrupado.get(pid) ?? { persona_id: pid, persona_nombre: f.persona_nombre, ultima_compra: f.cotizacion.updated_at, total_ganado: 0, cotizaciones: 0 };
    existing.total_ganado += Number(f.cotizacion.total);
    existing.cotizaciones += 1;
    if (f.cotizacion.updated_at > existing.ultima_compra) existing.ultima_compra = f.cotizacion.updated_at;
    agrupado.set(pid, existing);
  }
  const lista = [...agrupado.values()].sort((a, b) => b.ultima_compra.localeCompare(a.ultima_compra));

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Candidatos a recompra</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Clientes con cotizaciones <strong>ganadas hace más de</strong> X meses, sin actividad reciente. Buenos candidatos a llamar para nueva cotización, garantía vencida, recompra de complemento, etc.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Mostrar clientes con última compra hace más de:</span>
        <select value={meses} onChange={e => setMeses(Number(e.target.value))} style={{ padding: '5px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6 }}>
          <option value={3}>3 meses</option>
          <option value={6}>6 meses</option>
          <option value={12}>12 meses</option>
          <option value={24}>24 meses</option>
        </select>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{lista.length} candidatos</span>
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && lista.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin candidatos a recompra todavía con esta ventana de tiempo.
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {lista.map(c => {
          const dias = Math.floor((Date.now() - new Date(c.ultima_compra).getTime()) / (24 * 60 * 60 * 1000));
          const mesesAtras = Math.floor(dias / 30);
          return (
            <button key={c.persona_id} onClick={() => activarCliente(c.persona_id, c.persona_nombre ?? '(sin nombre)')}
              style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 12, textAlign: 'left', cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <strong>{c.persona_nombre ?? '(sin nombre)'}</strong>
                <span style={{ fontSize: 11, color: 'var(--green)', fontWeight: 700 }}>{fmtCop(c.total_ganado)}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                {c.cotizaciones} cotización(es) ganada(s) · última: {fmtFecha(c.ultima_compra)} ({mesesAtras} meses atrás)
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
