import { useEffect, useState } from 'react';
import { useModo } from '../lib/modo';
import { supabase, supabaseConfigured } from '../lib/supabase';
import { fetchConfiguracion, guardarConfiguracion } from '../lib/queries';
import { setRealtimeExtension } from '../lib/extension';
import { useContextoActivo } from '../lib/contexto_activo';

export function TopBar() {
  const [modo, setModoExt] = useModo();
  const [iaModo, setIaModo] = useState<'OFF' | 'ON'>('OFF');
  const [iaToggling, setIaToggling] = useState(false);
  const [topeDiario, setTopeDiario] = useState<number>(5);
  const [costoHoy, setCostoHoy] = useState<number>(0);
  const ctx = useContextoActivo();

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
        // Sincronizar la extensión con el modo guardado (best-effort).
        setRealtimeExtension(on).catch(() => {});
      })
      .catch(() => {});
    // Costo del día: suma costo_usd de hoy en evento_pg
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

  // Prende/apaga el procesamiento IA en tiempo real: guarda el modo en Supabase
  // y se lo empuja a la extensión (que es la que captura).
  async function toggleIA() {
    if (modo !== 'real' || iaToggling) return;
    const next: 'ON' | 'OFF' = iaModo === 'ON' ? 'OFF' : 'ON';
    const prev = iaModo;
    setIaToggling(true);
    setIaModo(next);   // optimista
    try {
      await guardarConfiguracion('ia_modo_global', next);
      // La extensión puede no estar conectada — el modo igual queda guardado.
      await setRealtimeExtension(next === 'ON').catch(() => {});
    } catch {
      setIaModo(prev);  // revertir si falló el guardado
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
        <input
          type="text"
          placeholder="Buscar cliente, proyecto, mensaje, evento..."
          style={{
            flex: 1, maxWidth: 380, padding: '8px 12px', fontSize: 13,
            border: '1px solid var(--border)', borderRadius: 6,
            background: 'var(--bg-page)', outline: 'none',
          }}
        />

        {/* Pill de contexto activo — visible en todos los módulos */}
        {ctx.hayContexto && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 10px',
            background: '#e0f2fe',
            border: '1px solid #38bdf8',
            borderRadius: 14,
            fontSize: 11,
            maxWidth: 480,
            overflow: 'hidden',
          }}>
            <span style={{ fontWeight: 700, color: '#0369a1', textTransform: 'uppercase', fontSize: 9 }}>Activo</span>
            {ctx.personaActivaNombre && <span title="Persona">👤 <strong>{ctx.personaActivaNombre}</strong></span>}
            {ctx.proyectoActivoNombre && <span title="Proyecto" style={{ color: '#0369a1' }}>· 📋 {ctx.proyectoActivoNombre}</span>}
            {ctx.chatActivoTitulo && ctx.chatActivoTitulo !== ctx.personaActivaNombre && (
              <span title="Chat" style={{ color: '#0369a1' }}>· 💬 {ctx.chatActivoTitulo}</span>
            )}
            <button
              onClick={() => ctx.limpiar()}
              title="Limpiar contexto activo (vuelve a vista global)"
              style={{
                marginLeft: 4, padding: '2px 6px', fontSize: 10, fontWeight: 700,
                background: 'transparent', color: '#0369a1', border: 'none', borderRadius: 4, cursor: 'pointer',
              }}
            >✕</button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Toggle global Tiempo Real IA — procesa todos los chats no bloqueados */}
        <button
          onClick={toggleIA}
          disabled={modo !== 'real' || iaToggling}
          title={modo !== 'real'
            ? 'Disponible en modo Real'
            : 'Procesamiento IA en tiempo real: captura y procesa todos los chats automáticamente. Los bloqueados quedan afuera.'}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 10px',
            border: `1px solid ${iaModo === 'ON' ? 'var(--green)' : 'var(--border)'}`,
            borderRadius: 16,
            background: iaModo === 'ON' ? '#34c75922' : 'var(--bg-page)',
            cursor: modo === 'real' && !iaToggling ? 'pointer' : 'not-allowed',
            opacity: modo === 'real' ? 1 : 0.5,
          }}
        >
          <span style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 600 }}>IA Tiempo real</span>
          <span style={{
            fontSize: 11, fontWeight: 700,
            color: iaModo === 'ON' ? 'var(--green)' : 'var(--text-muted)',
          }}>
            {iaToggling ? '…' : (iaModo === 'ON' ? '🟢 ON' : '⚫ OFF')}
          </span>
        </button>

        {/* Costo del día */}
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Costo hoy: <strong style={{ color: costoColor }}>${costoHoy.toFixed(4)}</strong> · Tope ${topeDiario.toFixed(2)}
        </span>

        {/* Modo toggle Real / Demo */}
        <div style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <ModoBtn
            label="Real"
            activo={modo === 'real'}
            onClick={() => supabaseConfigured && setModoExt('real')}
            disabled={!supabaseConfigured}
            title={!supabaseConfigured ? 'Falta .env' : 'Datos en vivo desde Supabase'}
          />
          <ModoBtn
            label="Demo"
            activo={modo === 'demo'}
            onClick={() => setModoExt('demo')}
            title="Datos fake del mockup"
          />
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
    <button
      onClick={onClick} disabled={disabled} title={title}
      style={{
        padding: '5px 10px', fontSize: 11, fontWeight: 600, border: 'none',
        background: activo ? (label === 'Real' ? 'var(--green)' : 'var(--orange)') : 'var(--bg-page)',
        color: activo ? 'white' : (disabled ? 'var(--text-muted)' : 'var(--text)'),
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >{label}</button>
  );
}
