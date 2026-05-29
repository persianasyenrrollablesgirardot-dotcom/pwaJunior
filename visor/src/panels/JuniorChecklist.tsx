/**
 * Pestaña "Checklist por chat" — VERSIÓN V2.
 *
 * Tablero de "¿quién tiene la pelota?" leyendo de `tarjeta_checklist` (V2), que
 * mantiene el agente derivado de cada tarjeta. Estados: cerrado / espera_jhon /
 * espera_cliente / sin_responder. Agrupa en "te toca a vos" vs "no te toca".
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Estado = 'cerrado' | 'espera_jhon' | 'espera_cliente' | 'sin_responder';

interface Fila {
  chat_id: number;
  nombre: string;
  tipo: string;
  estado: Estado;
  proximo_paso: string | null;
  actualizado_at: string | null;
}

const ESTADO_META: Record<Estado, { label: string; punto: string; color: string; orden: number }> = {
  sin_responder:  { label: 'Sin responder',           punto: '🔴', color: '#dc2626', orden: 1 },
  espera_jhon:    { label: 'Te toca a vos',            punto: '🟠', color: '#ea580c', orden: 2 },
  espera_cliente: { label: 'Esperando al cliente',     punto: '🔵', color: '#2563eb', orden: 3 },
  cerrado:        { label: 'Cerrado',                  punto: '🟢', color: '#16a34a', orden: 4 },
};
const TE_TOCA: Estado[] = ['sin_responder', 'espera_jhon'];

function hace(iso: string | null): string {
  if (!iso) return '';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  return `hace ${Math.floor(h / 24)} d`;
}

export function JuniorChecklist() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [ocultos, setOcultos] = useState(0);
  const [cargado, setCargado] = useState(false);
  const [filtro, setFiltro] = useState<Estado | 'todos'>('todos');

  const cargar = useCallback(async () => {
    const { data: tjs } = await supabase.from('tarjeta')
      .select('chat_id, tipo_contacto, es_no_cliente, personas(nombre)');
    const { data: cks } = await supabase.from('tarjeta_checklist')
      .select('chat_id, estado_conversacion, proximo_paso, actualizado_at');
    const ck = new Map((cks as any[] ?? []).map(c => [c.chat_id, c]));
    // Filtrar no-clientes (restaurante/spam/etc. detectados por A2) del tablero.
    const comerciales = (tjs as any[] ?? []).filter(t => !t.es_no_cliente);
    setOcultos(((tjs as any[] ?? []).length) - comerciales.length);
    const rows: Fila[] = comerciales.map(t => {
      const c = ck.get(t.chat_id);
      return {
        chat_id: t.chat_id,
        nombre: t.personas?.nombre ?? `Chat #${t.chat_id}`,
        tipo: t.tipo_contacto,
        estado: (c?.estado_conversacion ?? 'sin_responder') as Estado,
        proximo_paso: c?.proximo_paso ?? null,
        actualizado_at: c?.actualizado_at ?? null,
      };
    }).filter(f => ESTADO_META[f.estado]);
    rows.sort((a, b) => ESTADO_META[a.estado].orden - ESTADO_META[b.estado].orden);
    setFilas(rows);
    setCargado(true);
  }, []);

  useEffect(() => { cargar(); const t = setInterval(cargar, 5000); return () => clearInterval(t); }, [cargar]);

  const conteo = (e: Estado) => filas.filter(f => f.estado === e).length;
  const teToca = filas.filter(f => TE_TOCA.includes(f.estado));
  const noTeToca = filas.filter(f => !TE_TOCA.includes(f.estado));
  const filtradas = filtro === 'todos' ? [] : filas.filter(f => f.estado === filtro);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '18px 24px' }}>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
        Estado de cada conversación según las tarjetas V2: en qué chats <strong>te toca mover a vos</strong> y
        en cuáles no. <em>Tocá un estado para filtrar.</em>
        {ocultos > 0 && <span style={{ marginLeft: 8, color: '#9ca3af' }}>· {ocultos} no-cliente{ocultos > 1 ? 's' : ''} oculto{ocultos > 1 ? 's' : ''} (restaurante/spam/etc.)</span>}
      </p>

      {cargado && filas.length === 0 && (
        <div style={{ textAlign: 'center', padding: '50px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>✅</div>
          <p style={{ fontSize: 13 }}>Todavía no hay tarjetas con checklist. El worker las arma solo.</p>
        </div>
      )}

      {filas.length > 0 && (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            <FiltroChip activo={filtro === 'todos'} onClick={() => setFiltro('todos')} punto="" label="Todos" count={filas.length} color="var(--accent)" />
            {(Object.keys(ESTADO_META) as Estado[]).map(e => (
              <FiltroChip key={e} activo={filtro === e} onClick={() => setFiltro(filtro === e ? 'todos' : e)}
                punto={ESTADO_META[e].punto} label={ESTADO_META[e].label} count={conteo(e)} color={ESTADO_META[e].color} />
            ))}
          </div>

          {filtro !== 'todos' ? (
            <>
              <SeccionTitulo icono={ESTADO_META[filtro].punto} texto={`${ESTADO_META[filtro].label} (${filtradas.length})`} color={ESTADO_META[filtro].color} />
              <Lista filas={filtradas} />
            </>
          ) : (
            <>
              <SeccionTitulo icono="🎯" texto={`Te toca a vos (${teToca.length})`} color="#dc2626" />
              <Lista filas={teToca} vacio="Nada pendiente de tu lado. 👏" />
              <div style={{ height: 18 }} />
              <SeccionTitulo icono="✓" texto={`No te toca — esperando o cerradas (${noTeToca.length})`} color="#16a34a" />
              <Lista filas={noTeToca} vacio="—" />
            </>
          )}
        </>
      )}
    </div>
  );
}

function Lista({ filas, vacio }: { filas: Fila[]; vacio?: string }) {
  if (filas.length === 0) return (
    <div style={{ padding: 14, textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', background: 'var(--bg-panel)', border: '1px dashed var(--border-soft)', borderRadius: 10 }}>{vacio ?? 'No hay chats en este estado.'}</div>
  );
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {filas.map(f => {
        const em = ESTADO_META[f.estado];
        return (
          <div key={f.chat_id} style={{ border: '1px solid var(--border-soft)', borderLeft: `3px solid ${em.color}`, borderRadius: 10, background: 'var(--bg-panel)', padding: '10px 14px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{em.punto}</span>
              <strong style={{ fontSize: 14 }}>{f.nombre}</strong>
              <span style={{ padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--bg-page)', border: '1px solid var(--border-soft)' }}>{f.tipo}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>{hace(f.actualizado_at)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 5 }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: em.color }}>{em.label}</span>
              <span style={{ fontSize: 12 }}>→ {f.proximo_paso || 'sin próximo paso'}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SeccionTitulo({ icono, texto, color }: { icono: string; texto: string; color: string }) {
  return <h3 style={{ display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 8px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color }}><span>{icono}</span>{texto}</h3>;
}
function FiltroChip({ activo, onClick, punto, label, count, color }: { activo: boolean; onClick: () => void; punto: string; label: string; count: number; color: string }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999, cursor: 'pointer', fontSize: 12, background: activo ? color : 'var(--bg-panel)', border: `1px solid ${activo ? color : 'var(--border-soft)'}` }}>
      {punto && <span>{punto}</span>}
      <strong style={{ color: activo ? 'white' : color }}>{count}</strong>
      <span style={{ color: activo ? 'white' : 'var(--text-muted)' }}>{label}</span>
    </button>
  );
}
