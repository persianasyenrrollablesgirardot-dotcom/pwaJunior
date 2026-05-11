/**
 * 5.4 Rutas y zonas — instalaciones agrupadas por zona geográfica.
 *
 * Catálogo de zonas (zonas_instalacion) + cuántas instalaciones tiene cada una
 * en próximos 30 días. Sirve para agrupar visitas y reducir transporte.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../../lib/supabase';
import { fetchZonas, type Zona } from '../../lib/queries';

interface InstalacionPorZona {
  zona_codigo: string | null;
  zona_nombre: string | null;
  count: number;
  proximas: { id: number; fecha_programada: string; instalador: string | null; persona_nombre: string | null }[];
}

export function RutasZonas() {
  const [zonas, setZonas] = useState<Zona[]>([]);
  const [stats, setStats] = useState<InstalacionPorZona[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCargando(true); setError(null);
    (async () => {
      try {
        const z = await fetchZonas();
        setZonas(z);
        // Instalaciones pendientes próximos 30 días, agrupadas por zona
        const hoy = new Date().toISOString().slice(0, 10);
        const fin = new Date(); fin.setDate(fin.getDate() + 30);
        const finIso = fin.toISOString().slice(0, 10);
        const { data, error } = await supabase
          .from('instalaciones')
          .select('id, zona_codigo, fecha_programada, instalador, persona_id, personas(nombre)')
          .gte('fecha_programada', hoy)
          .lte('fecha_programada', finIso)
          .is('deleted_at', null)
          .is('resultado', null)
          .order('fecha_programada', { ascending: true });
        if (error) throw error;

        const byZona: Record<string, InstalacionPorZona> = {};
        for (const row of (data ?? []) as any[]) {
          const k = row.zona_codigo ?? '_sin_zona';
          const zona = z.find(x => x.codigo === row.zona_codigo);
          byZona[k] ??= {
            zona_codigo: row.zona_codigo,
            zona_nombre: zona?.nombre ?? '(sin zona)',
            count: 0,
            proximas: [],
          };
          byZona[k].count += 1;
          byZona[k].proximas.push({
            id: row.id,
            fecha_programada: row.fecha_programada,
            instalador: row.instalador ?? null,
            persona_nombre: row.personas?.nombre ?? null,
          });
        }
        setStats(Object.values(byZona).sort((a, b) => b.count - a.count));
      } catch (e: any) { setError(e.message); }
      finally { setCargando(false); }
    })();
  }, []);

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Rutas y zonas</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Instalaciones pendientes en los próximos 30 días agrupadas por zona. Sirve para armar rutas.
      </p>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && stats.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin instalaciones programadas en los próximos 30 días.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {stats.map(s => {
          const zona = zonas.find(z => z.codigo === s.zona_codigo);
          return (
            <div key={s.zona_codigo ?? '_sin'} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
                <strong style={{ fontSize: 14 }}>📍 {s.zona_nombre}</strong>
                <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--accent)' }}>{s.count}</span>
              </div>
              {zona && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 8, fontStyle: 'italic' }}>
                  {zona.costo_traslado_incluido ? '✓ Traslado incluido' : '⚠ Traslado extra'}
                  {zona.notas && ` · ${zona.notas}`}
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                {s.proximas.slice(0, 5).map(p => (
                  <div key={p.id} style={{ fontSize: 11, color: 'var(--text-muted)', padding: '3px 0', borderTop: '1px solid var(--border-soft)' }}>
                    {new Date(p.fecha_programada + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short' })}
                    {' · '}
                    {p.persona_nombre ?? '(sin nombre)'}
                    {p.instalador && ` · ${p.instalador}`}
                  </div>
                ))}
                {s.proximas.length > 5 && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: '3px 0', fontStyle: 'italic' }}>
                    +{s.proximas.length - 5} más…
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginTop: 24, marginBottom: 8 }}>
        Catálogo de zonas
      </h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 6 }}>
        {zonas.map(z => (
          <div key={z.codigo} style={{ padding: 8, background: 'var(--bg-page)', border: '1px solid var(--border-soft)', borderRadius: 6, fontSize: 11 }}>
            <strong>{z.nombre}</strong>
            <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
              {z.costo_traslado_incluido ? '✓ Incluido' : '⚠ Extra'}
              {z.notas && ` — ${z.notas}`}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
