/**
 * Módulo "Clientes" — selector ÚNICO de chat activo (F1.20).
 *
 * Lista de chats YA procesados (en Supabase). Click en uno → setea el contexto activo
 * (persona + proyecto + chat) y navega a M1 Núcleo. Los M1+ muestran info de ese activo.
 *
 * NO duplica M0 Captura: M0 trabaja con datos LOCALES de la extensión (chats sin procesar).
 * Clientes trabaja con datos en Supabase (chats ya procesados).
 */
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useContextoActivo } from '../lib/contexto_activo';
import { useNavegacion } from '../lib/navegacion';

interface ClienteRow {
  chat_id: number;
  chat_titulo: string;
  chat_jid: string | null;
  ambito: string;
  ia_costo_acumulado_usd: number;
  proyecto_id: number | null;
  proyecto_nombre: string | null;
  proyecto_estado: string | null;
  persona_id: number | null;
  persona_nombre: string | null;
  persona_telefono: string | null;
  persona_email: string | null;
  persona_empresa: string | null;
  persona_ciudad: string | null;
  msgs_total: number;
  msgs_ultimo_ts: string | null;
  eventos_total: number;
}

export function Clientes() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [rows, setRows] = useState<ClienteRow[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');

  async function cargar() {
    setCargando(true); setError(null);
    try {
      // UN solo query a la vista que precomputa todo (F1.20 — antes traíamos
      // TODOS los mensajes y eventos solo para contarlos, era lento)
      const { data, error: e } = await supabase
        .from('vw_clientes_resumen_v2')
        .select('*')
        .order('msgs_ultimo_ts', { ascending: false, nullsFirst: false });
      if (e) throw e;
      setRows((data ?? []).map((r: any) => ({
        chat_id: r.chat_id,
        chat_titulo: r.chat_titulo ?? '(sin título)',
        chat_jid: r.chat_jid,
        ambito: r.ambito ?? 'comercial',
        ia_costo_acumulado_usd: Number(r.ia_costo_acumulado_usd ?? 0),
        proyecto_id: r.proyecto_id,
        proyecto_nombre: r.proyecto_nombre,
        proyecto_estado: r.proyecto_estado,
        persona_id: r.persona_id,
        persona_nombre: r.persona_nombre,
        persona_telefono: r.persona_telefono,
        persona_email: r.persona_email,
        persona_empresa: r.persona_empresa,
        persona_ciudad: r.persona_ciudad,
        msgs_total: Number(r.msgs_total) || 0,
        msgs_ultimo_ts: r.msgs_ultimo_ts,
        eventos_total: Number(r.eventos_total) || 0,
      })));
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => { cargar(); }, []);

  const filtradas = useMemo(() => {
    if (!busqueda.trim()) return rows;
    const q = busqueda.toLowerCase();
    return rows.filter(r =>
      r.chat_titulo.toLowerCase().includes(q) ||
      (r.persona_nombre ?? '').toLowerCase().includes(q) ||
      (r.persona_telefono ?? '').includes(q) ||
      (r.persona_email ?? '').toLowerCase().includes(q) ||
      (r.persona_empresa ?? '').toLowerCase().includes(q) ||
      (r.persona_ciudad ?? '').toLowerCase().includes(q));
  }, [rows, busqueda]);

  function seleccionar(r: ClienteRow) {
    if (!r.chat_jid) return;
    ctx.seleccionarChat(r.chat_id, r.chat_titulo, r.chat_jid, {
      proyectoId: r.proyecto_id ?? undefined,
      proyectoNombre: r.proyecto_nombre ?? undefined,
      personaId: r.persona_id ?? undefined,
      personaNombre: r.persona_nombre ?? undefined,
    });
    nav.cambiarModulo('m1');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Clientes</h1>
          <span style={{ fontSize: 10, padding: '2px 8px', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase' }}>
            chats procesados · {rows.length}
          </span>
          <button onClick={cargar} style={btnSec}>↻ Recargar</button>
        </div>
        <p style={{ margin: '4px 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          Click en un cliente → se vuelve el "activo" del Visor. Toda la info que ves en M1 Núcleo, M2 Comerciales, etc. es del cliente activo.
        </p>

        <input
          type="search"
          value={busqueda}
          onChange={e => setBusqueda(e.target.value)}
          placeholder="🔍 Buscar nombre, teléfono, email, empresa…"
          style={{
            width: 380, padding: '7px 12px', fontSize: 13,
            border: '1px solid var(--border)', borderRadius: 6,
            background: 'var(--bg-page)', outline: 'none', marginBottom: 12,
          }}
        />
      </div>

      {error && (
        <div style={{ margin: '0 24px 8px', padding: 10, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12 }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '0 24px 16px' }}>
        {cargando && <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Cargando…</div>}
        {!cargando && rows.length === 0 && (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8 }}>
            Sin clientes procesados todavía.
            <br /><br />
            Andá a <strong>Captura</strong>, elegí un chat y dale click en <strong>"▶ Procesar"</strong> para que aparezca acá.
          </div>
        )}
        {!cargando && rows.length > 0 && filtradas.length === 0 && (
          <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
            Sin resultados para "{busqueda}".
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {filtradas.map(r => {
            const activo = ctx.chatActivoId === r.chat_id;
            const initial = ((r.persona_nombre ?? r.chat_titulo) || '').split(' ').filter(Boolean).map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '?';
            const ultMsg = r.msgs_ultimo_ts
              ? new Date(r.msgs_ultimo_ts).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
              : '—';
            return (
              <button key={r.chat_id} onClick={() => seleccionar(r)}
                style={{
                  display: 'block', textAlign: 'left',
                  background: activo ? 'var(--accent-soft)' : 'var(--bg-panel)',
                  border: `1px solid ${activo ? 'var(--accent)' : 'var(--border-soft)'}`,
                  borderRadius: 8, padding: 14, cursor: 'pointer',
                  transition: 'transform 0.05s, box-shadow 0.1s',
                }}
                onMouseEnter={(e) => { if (!activo) e.currentTarget.style.boxShadow = 'var(--shadow-sm)'; }}
                onMouseLeave={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <div style={{
                    width: 38, height: 38, borderRadius: '50%',
                    background: 'var(--accent)', color: 'white',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, fontWeight: 700, flexShrink: 0,
                  }}>{initial}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.persona_nombre ?? r.chat_titulo}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                      {r.persona_telefono ?? r.persona_email ?? '(sin contacto)'}
                    </div>
                  </div>
                  {activo && (
                    <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase' }}>activo</span>
                  )}
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  <div>📋 {r.proyecto_nombre ?? '—'}</div>
                  <div>📍 {r.persona_ciudad ?? r.persona_empresa ?? '—'}</div>
                  <div>💬 {r.msgs_total} mensajes</div>
                  <div>🗂 {r.eventos_total} eventos</div>
                  <div style={{ gridColumn: 'span 2', fontSize: 10, color: 'var(--text-muted)' }}>último: {ultMsg}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const btnSec: React.CSSProperties = {
  marginLeft: 'auto', padding: '5px 10px', fontSize: 11, fontWeight: 500,
  background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text)', cursor: 'pointer',
};
