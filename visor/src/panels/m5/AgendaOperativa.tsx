/**
 * 5.3 Agenda operativa — vista global cronológica.
 *
 * Combina instalaciones programadas (sin resultado aún) + tareas pendientes
 * en una sola lista ordenada por fecha. Filtros: hoy / semana / mes / todo.
 */
import { useEffect, useMemo, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { useNavegacion } from '../../lib/navegacion';
import { fetchAgendaPorRango, type AgendaItem } from '../../lib/queries';

const fmtFecha = (s: string | null) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { weekday: 'short', day: '2-digit', month: 'short' }) : 'Sin fecha';

type Rango = 'hoy' | 'semana' | 'mes' | 'todo';

export function AgendaOperativa() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [items, setItems] = useState<AgendaItem[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rango, setRango] = useState<Rango>('semana');

  const { desde, hasta } = useMemo(() => {
    const hoy = new Date();
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    if (rango === 'hoy') return { desde: iso(hoy), hasta: iso(hoy) };
    if (rango === 'semana') {
      const fin = new Date(hoy); fin.setDate(fin.getDate() + 7);
      return { desde: iso(hoy), hasta: iso(fin) };
    }
    if (rango === 'mes') {
      const fin = new Date(hoy); fin.setMonth(fin.getMonth() + 1);
      return { desde: iso(hoy), hasta: iso(fin) };
    }
    return { desde: undefined, hasta: undefined };
  }, [rango]);

  useEffect(() => {
    setCargando(true); setError(null);
    fetchAgendaPorRango(desde, hasta)
      .then(setItems)
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }, [desde, hasta]);

  // Agrupar por fecha
  const grupos: Record<string, AgendaItem[]> = {};
  for (const it of items) {
    const k = it.fecha ?? 'Sin fecha';
    (grupos[k] ||= []).push(it);
  }
  const fechas = Object.keys(grupos).sort();

  function abrirCliente(it: AgendaItem) {
    if (it.persona_id && it.persona_nombre) {
      ctx.seleccionarPersona(it.persona_id, it.persona_nombre);
      nav.cambiarModulo('m5');
    }
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Agenda operativa</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Vista global: instalaciones programadas + tareas pendientes ordenadas por fecha.
      </p>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {(['hoy', 'semana', 'mes', 'todo'] as Rango[]).map(r => (
          <button key={r} onClick={() => setRango(r)}
            style={{
              padding: '6px 12px', fontSize: 11, fontWeight: 600,
              background: rango === r ? 'var(--accent)' : 'white',
              color: rango === r ? 'white' : 'var(--text)',
              border: `1px solid ${rango === r ? 'var(--accent)' : 'var(--border)'}`,
              borderRadius: 6, cursor: 'pointer', textTransform: 'capitalize',
            }}>{r}</button>
        ))}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto', alignSelf: 'center' }}>
          {items.length} eventos
        </span>
      </div>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && items.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin eventos en este rango.
        </div>
      )}

      {fechas.map(fecha => (
        <div key={fecha} style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 6 }}>
            {fmtFecha(fecha)} ({grupos[fecha].length})
          </h3>
          {grupos[fecha].map(it => (
            <button key={`${it.tipo}-${it.source_id}`} onClick={() => abrirCliente(it)}
              style={{ width: '100%', textAlign: 'left', background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 6, padding: 10, marginBottom: 4, cursor: 'pointer' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <span style={{ fontSize: 11, padding: '2px 6px', borderRadius: 4, marginRight: 6, fontWeight: 600,
                    background: it.tipo === 'instalacion' ? 'var(--accent-soft)' : '#fff7ed',
                    color: it.tipo === 'instalacion' ? 'var(--accent)' : '#9a3412' }}>
                    {it.tipo === 'instalacion' ? '🔧 Instalación' : '📋 Tarea'}
                  </span>
                  <strong style={{ fontSize: 13 }}>{it.titulo}</strong>
                </div>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                  {it.hora ? it.hora.slice(0, 5) : '—'}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {it.persona_nombre && <>👤 {it.persona_nombre} · </>}
                {it.zona_codigo && <>📍 {it.zona_codigo} · </>}
                {it.prioridad < 5 && <span style={{ color: 'var(--red)', fontWeight: 600 }}>★ alta prioridad</span>}
              </div>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
