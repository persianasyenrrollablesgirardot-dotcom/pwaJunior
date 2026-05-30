/**
 * 5.6 Checklist de instalación — items por fase (antes / durante / despues).
 *
 * Auto-generado al crear cada instalación (15 items default según VISION).
 * Permite marcar completo, agregar foto y notas. Muestra progreso por fase.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchInstalacionesPorPersona, fetchChecklistDeInstalacion, marcarChecklistItem,
  type Instalacion, type ChecklistItem, type FaseChecklist,
} from '../../lib/queries';

const FASE_LABEL: Record<FaseChecklist, string> = {
  antes: 'ANTES (preparación)',
  durante: 'DURANTE (en el sitio)',
  despues: 'DESPUÉS (cierre)',
};
const FASE_COLOR: Record<FaseChecklist, string> = {
  antes: '#5856d6', durante: '#5ac8fa', despues: '#34c759',
};

const fmtFecha = (s: string | null | undefined) => s ? new Date(s + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function ChecklistInstalacion() {
  const ctx = useContextoActivo();
  const [instalaciones, setInstalaciones] = useState<Instalacion[]>([]);
  const [instSel, setInstSel] = useState<number | null>(null);
  const [items, setItems] = useState<ChecklistItem[]>([]);
  const [cargando, setCargando] = useState(true);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  // Cargar instalaciones de la persona activa
  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    setCargando(true);
    fetchInstalacionesPorPersona(ctx.personaActivaId).then(list => {
      setInstalaciones(list);
      if (list.length && instSel == null) setInstSel(list[0].id);
      setCargando(false);
    }).catch(() => setCargando(false));
  }, [ctx.personaActivaId]);

  // Cargar items de la instalación seleccionada
  async function recargarItems() {
    if (instSel == null) { setItems([]); return; }
    setItems(await fetchChecklistDeInstalacion(instSel));
  }
  useEffect(() => { recargarItems(); }, [instSel]);

  function fb(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 2000);
  }

  async function toggle(it: ChecklistItem) {
    try {
      await marcarChecklistItem(it.id, !it.completado);
      await recargarItems();
    } catch (e: any) { fb('err', e.message); }
  }

  // Agrupar por fase
  const porFase: Record<FaseChecklist, ChecklistItem[]> = { antes: [], durante: [], despues: [] };
  for (const it of items) porFase[it.fase].push(it);

  const progreso: Record<FaseChecklist, { total: number; done: number }> = {
    antes:   { total: porFase.antes.length,   done: porFase.antes.filter(i => i.completado).length },
    durante: { total: porFase.durante.length, done: porFase.durante.filter(i => i.completado).length },
    despues: { total: porFase.despues.length, done: porFase.despues.filter(i => i.completado).length },
  };

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Checklist de instalación — {ctx.personaActivaNombre}
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Items auto-generados al crear cada instalación. Marcalos a medida que se completan.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && instalaciones.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          No hay instalaciones para {ctx.personaActivaNombre}. Creá una en sub-tab 5.2 y el checklist se auto-genera.
        </div>
      )}

      {instalaciones.length > 0 && (
        <>
          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.4 }}>
              Instalación
            </label>
            <select value={instSel ?? ''} onChange={e => setInstSel(Number(e.target.value))}
              style={{ display: 'block', marginTop: 4, padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, minWidth: 360 }}>
              {instalaciones.map(i => (
                <option key={i.id} value={i.id}>
                  {fmtFecha(i.fecha_programada)}{i.instalador ? ` · ${i.instalador}` : ''}{i.resultado ? ` · ${i.resultado}` : ' · programada'}
                </option>
              ))}
            </select>
          </div>

          {/* Resumen progreso por fase */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {(['antes', 'durante', 'despues'] as FaseChecklist[]).map(f => {
              const pct = progreso[f].total > 0 ? Math.round((progreso[f].done / progreso[f].total) * 100) : 0;
              return (
                <div key={f} style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 150 }}>
                  <div style={{ fontSize: 9, color: FASE_COLOR[f], textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.4 }}>{FASE_LABEL[f]}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{progreso[f].done} / {progreso[f].total} ({pct}%)</div>
                </div>
              );
            })}
          </div>

          {(['antes', 'durante', 'despues'] as FaseChecklist[]).map(fase => (
            <div key={fase} style={{ marginBottom: 18 }}>
              <h3 style={{ fontSize: 11, color: FASE_COLOR[fase], textTransform: 'uppercase', fontWeight: 700, letterSpacing: 0.5, marginBottom: 8 }}>
                {FASE_LABEL[fase]} ({porFase[fase].length})
              </h3>
              {porFase[fase].map(it => (
                <div key={it.id} style={{
                  background: 'var(--bg-panel)',
                  border: `1px solid ${it.completado ? FASE_COLOR[fase] : 'var(--border-soft)'}`,
                  borderRadius: 6, padding: 10, marginBottom: 4,
                  opacity: it.completado ? 0.75 : 1,
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <input type="checkbox" checked={it.completado} onChange={() => toggle(it)} style={{ cursor: 'pointer', width: 16, height: 16 }} />
                  <span style={{ flex: 1, fontSize: 12, textDecoration: it.completado ? 'line-through' : 'none' }}>
                    {it.descripcion}
                  </span>
                  {it.completado_at && (
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                      ✓ {new Date(it.completado_at).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
