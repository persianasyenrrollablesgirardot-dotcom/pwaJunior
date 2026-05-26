import { useEffect, useRef, useState } from 'react';
import { useModo } from '../lib/modo';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { fetchConfiguracion, guardarConfiguracion } from '../lib/queries';
import { setRealtimeExtension } from '../lib/extension';
import { useContextoActivo } from '../lib/contexto_activo';

// ─── Resultado de búsqueda global ─────────────────────────────────────────
interface ResultadoBusqueda {
  tipo: 'persona' | 'chat';
  id: number;
  titulo: string;
  subtitulo: string;
}

async function buscarGlobal(q: string): Promise<ResultadoBusqueda[]> {
  if (!q.trim()) return [];
  const resultados: ResultadoBusqueda[] = [];

  // Detectar búsqueda por ID: "id154", "#154", o solo un número
  const matchId = q.match(/^(?:id#?|#)?(\d+)$/i);
  if (matchId) {
    const id = Number(matchId[1]);
    // Buscar persona por ID
    const { data: p } = await supabase.from('personas')
      .select('id, nombre, telefono_e164, ciudad, ambito_principal')
      .eq('id', id).is('deleted_at', null).maybeSingle();
    if (p) {
      resultados.push({
        tipo: 'persona', id: p.id,
        titulo: p.nombre ?? `Persona #${p.id}`,
        subtitulo: [
          `id ${p.id}`,
          p.telefono_e164,
          p.ciudad,
          p.ambito_principal !== 'comercial' ? `(${p.ambito_principal})` : null,
        ].filter(Boolean).join(' · '),
      });
    }
    // Buscar chat por ID
    const { data: c } = await supabase.from('chats')
      .select('id, titulo, canal, canal_chat_id, personas(id, nombre)')
      .eq('id', id).is('deleted_at', null).maybeSingle();
    if (c) {
      const persona = (c as any).personas;
      resultados.push({
        tipo: 'chat', id: c.id,
        titulo: c.titulo ?? `Chat #${c.id}`,
        subtitulo: [
          `chat id ${c.id}`,
          c.canal,
          persona?.nombre ? `· ${persona.nombre}` : null,
        ].filter(Boolean).join(' '),
      });
    }
    return resultados;
  }

  // Búsqueda por texto: nombre, teléfono, ciudad
  const texto = q.trim();
  const { data: personas } = await supabase.from('personas')
    .select('id, nombre, telefono_e164, ciudad, ambito_principal')
    .is('deleted_at', null)
    .or(`nombre.ilike.%${texto}%,telefono_e164.ilike.%${texto}%,ciudad.ilike.%${texto}%`)
    .limit(8);

  for (const p of personas ?? []) {
    resultados.push({
      tipo: 'persona', id: p.id,
      titulo: p.nombre ?? `Persona #${p.id}`,
      subtitulo: [
        `id ${p.id}`,
        p.telefono_e164,
        p.ciudad,
        p.ambito_principal !== 'comercial' ? `· ${p.ambito_principal}` : null,
      ].filter(Boolean).join(' · '),
    });
  }

  return resultados;
}

export function TopBar() {
  const [modo, setModoExt] = useModo();
  const [iaModo, setIaModo] = useState<'OFF' | 'ON'>('OFF');
  const [iaToggling, setIaToggling] = useState(false);
  const [topeDiario, setTopeDiario] = useState<number>(5);
  const [costoHoy, setCostoHoy] = useState<number>(0);
  const ctx = useContextoActivo();

  // ── Buscador global ──────────────────────────────────────────────────────
  const [query, setQuery] = useState('');
  const [resultados, setResultados] = useState<ResultadoBusqueda[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [abierto, setAbierto] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Cerrar dropdown si se hace click fuera
  useEffect(() => {
    function onClickFuera(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setAbierto(false);
      }
    }
    document.addEventListener('mousedown', onClickFuera);
    return () => document.removeEventListener('mousedown', onClickFuera);
  }, []);

  // Debounce de búsqueda: espera 300ms después del último keystroke
  useEffect(() => {
    if (!query.trim()) { setResultados([]); setAbierto(false); return; }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setBuscando(true);
      try {
        const res = await buscarGlobal(query);
        setResultados(res);
        setAbierto(true);
      } catch { setResultados([]); }
      finally { setBuscando(false); }
    }, 300);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query]);

  function seleccionar(r: ResultadoBusqueda) {
    if (r.tipo === 'persona') {
      ctx.seleccionarPersona(r.id, r.titulo);
    }
    setQuery('');
    setAbierto(false);
    setResultados([]);
  }

  useEffect(() => {
    if (modo !== 'real') {
      setIaModo('OFF'); setCostoHoy(0); setTopeDiario(5);
      return;
    }
    fetchConfiguracion(['ia_modo_global', 'ia_tope_diario_alerta_usd'])
      .then(cfg => {
        const on = (cfg.ia_modo_global ?? 'OFF') === 'ON';
        setIaModo(on ? 'ON' : 'OFF');
        setTopeDiario(Number(cfg.ia_tope_diario_alerta_usd ?? 5));
        setRealtimeExtension(on).catch(() => {});
      })
      .catch(() => {});
    const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
    supabase
      .from('evento_pg')
      .select('costo_usd')
      .gte('ts_creado', hoy.toISOString())
      .then(({ data }) => {
        const total = (data ?? []).reduce((sum, e) => sum + Number(e.costo_usd ?? 0), 0);
        setCostoHoy(total);
      });
  }, [modo]);

  const costoColor = costoHoy < topeDiario * 0.5 ? 'var(--green)' : costoHoy < topeDiario ? 'var(--orange)' : 'var(--red)';

  async function toggleIA() {
    if (modo !== 'real' || iaToggling) return;
    const next: 'ON' | 'OFF' = iaModo === 'ON' ? 'OFF' : 'ON';
    const prev = iaModo;
    setIaToggling(true);
    setIaModo(next);
    try {
      await guardarConfiguracion('ia_modo_global', next);
      await setRealtimeExtension(next === 'ON').catch(() => {});
    } catch {
      setIaModo(prev);
    } finally {
      setIaToggling(false);
    }
  }

  return (
    <header style={{
      height: 52, background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', padding: '0 20px', gap: 16, flexShrink: 0,
    }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10 }}>

        {/* ── Buscador global ── */}
        <div ref={wrapperRef} style={{ position: 'relative', flex: 1, maxWidth: 380 }}>
          <div style={{ position: 'relative' }}>
            <span style={{
              position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)',
              fontSize: 13, pointerEvents: 'none', color: 'var(--text-muted)',
            }}>🔍</span>
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              onFocus={() => { if (resultados.length > 0) setAbierto(true); }}
              placeholder="Buscar cliente, id154, #154, teléfono..."
              style={{
                width: '100%', padding: '7px 12px 7px 30px', fontSize: 12, boxSizing: 'border-box',
                border: `1px solid ${abierto ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: abierto ? '6px 6px 0 0' : 6,
                background: 'var(--bg-page)', outline: 'none', transition: 'border-color 0.15s',
              }}
            />
            {buscando && (
              <span style={{
                position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                fontSize: 10, color: 'var(--text-muted)',
              }}>buscando…</span>
            )}
          </div>

          {/* Dropdown resultados */}
          {abierto && resultados.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999,
              background: 'var(--bg-panel)', border: '1px solid var(--accent)',
              borderTop: 'none', borderRadius: '0 0 8px 8px',
              boxShadow: '0 8px 24px rgba(0,0,0,0.15)', maxHeight: 320, overflowY: 'auto',
            }}>
              {resultados.map((r, i) => (
                <button
                  key={`${r.tipo}-${r.id}`}
                  onClick={() => seleccionar(r)}
                  style={{
                    width: '100%', display: 'flex', flexDirection: 'column', gap: 2,
                    padding: '10px 14px', textAlign: 'left', border: 'none', cursor: 'pointer',
                    background: 'transparent', borderTop: i > 0 ? '1px solid var(--border-soft)' : 'none',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-soft)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                >
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                    {r.tipo === 'persona' ? '👤' : '💬'} {r.titulo}
                  </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{r.subtitulo}</span>
                </button>
              ))}
              <div style={{ padding: '6px 14px', fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border-soft)' }}>
                Tip: escribí <strong>id154</strong> o <strong>#154</strong> para buscar por ID exacto
              </div>
            </div>
          )}

          {/* Sin resultados */}
          {abierto && !buscando && resultados.length === 0 && query.trim().length > 1 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 9999,
              background: 'var(--bg-panel)', border: '1px solid var(--border)',
              borderTop: 'none', borderRadius: '0 0 8px 8px',
              padding: '12px 14px', fontSize: 12, color: 'var(--text-muted)',
            }}>
              Sin resultados para <strong>"{query}"</strong>
            </div>
          )}
        </div>

        {/* Pill de contexto activo */}
        {ctx.hayContexto && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 10px', background: '#e0f2fe',
            border: '1px solid #38bdf8', borderRadius: 14,
            fontSize: 11, maxWidth: 480, overflow: 'hidden',
          }}>
            <span style={{ fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', fontSize: 9 }}>Activo</span>
            {ctx.personaActivaNombre && <span title="Persona">👤 <strong>{ctx.personaActivaNombre}</strong></span>}
            {ctx.proyectoActivoNombre && <span title="Proyecto" style={{ color: '#0369a1' }}>· 📋 {ctx.proyectoActivoNombre}</span>}
            {ctx.chatActivoTitulo && ctx.chatActivoTitulo !== ctx.personaActivaNombre && (
              <span title="Chat" style={{ color: '#0369a1' }}>· 💬 {ctx.chatActivoTitulo}</span>
            )}
            <button
              onClick={() => ctx.limpiar()}
              title="Limpiar contexto activo"
              style={{ marginLeft: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700, background: 'transparent', color: '#0369a1', border: 'none', borderRadius: 4, cursor: 'pointer' }}
            >✕</button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Toggle IA Tiempo Real */}
        <button
          onClick={toggleIA}
          disabled={modo !== 'real' || iaToggling}
          title={modo !== 'real' ? 'Disponible en modo Real' : 'Procesamiento IA en tiempo real'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px',
            border: `1px solid ${iaModo === 'ON' ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 16, background: iaModo === 'ON' ? '#34c75922' : 'var(--bg-page)',
            cursor: modo === 'real' && !iaToggling ? 'pointer' : 'not-allowed',
            opacity: modo === 'real' ? 1 : 0.5,
          }}
        >
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>IA Tiempo real</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: iaModo === 'ON' ? 'var(--green)' : 'var(--text-muted)' }}>
            {iaToggling ? '…' : (iaModo === 'ON' ? '🟢 ON' : '⚫ OFF')}
          </span>
        </button>

        {/* Costo del día */}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Costo hoy: <strong style={{ color: costoColor }}>${costoHoy.toFixed(4)}</strong> · Tope ${topeDiario.toFixed(2)}
        </span>

        {/* Modo toggle Real / Demo */}
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <ModoBtn label="Real" activo={modo === 'real'} onClick={() => supabaseConfigured && setModoExt('real')}
            disabled={!supabaseConfigured} title={!supabaseConfigured ? 'Falta .env' : 'Datos en vivo desde Supabase'} />
          <ModoBtn label="Demo" activo={modo === 'demo'} onClick={() => setModoExt('demo')} title="Datos fake del mockup" />
        </div>

        <div style={{ width: 1, height: 20, background: 'var(--border)' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 28, height: 28, borderRadius: '50%', background: 'var(--accent)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 600 }}>JC</div>
          <div style={{ fontSize: 12 }}>
            <div style={{ fontWeight: 600 }}>Jhon Cubides</div>
            <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>Dueño</div>
          </div>
        </div>
      </div>
    </header>
  );
}

function ModoBtn({ label, activo, onClick, disabled, title }: { label: string; activo: boolean; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title} style={{
      padding: '5px 10px', fontSize: 11, fontWeight: 600, border: 'none',
      background: activo ? (label === 'Real' ? 'var(--green)' : 'var(--orange)') : 'var(--bg-page)',
      color: activo ? 'white' : (disabled ? 'var(--text-muted)' : 'var(--text)'),
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    }}>{label}</button>
  );
}
