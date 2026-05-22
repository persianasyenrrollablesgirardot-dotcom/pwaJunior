/**
 * Pestaña "Checklist por chat" del módulo Junior.
 *
 * Tablero de "¿quién tiene la pelota?": por cada chat muestra su estado (sin
 * responder / te toca / esperando cliente / frío / cerrada), su checklist
 * adaptativo según el tipo de conversación (venta / garantía / consulta) y el
 * próximo paso concreto. Arriba, los compromisos que el negocio prometió y no
 * cumplió. La fuente es la tabla `chat_checklist`, que el agente A_CHECKLIST
 * mantiene al día leyendo cada conversación.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

// ─── Tipos ──────────────────────────────────────────────────────────────────
type Estado = 'sin_responder' | 'te_toca' | 'frio' | 'esperando_cliente' | 'cerrada';
type TipoConv = 'venta' | 'garantia' | 'consulta';

interface Paso { label: string; hecho: boolean; responsable: 'jhon' | 'cliente' | null }
interface Compromiso { texto: string; prometido_at: string | null }
interface Fila {
  id: number;
  chat_id: number;
  tipo: TipoConv;
  estado: Estado;
  proximo_paso: string | null;
  motivo_cierre: string | null;
  pasos: Paso[];
  compromisos: Compromiso[];
  ultimo_mensaje_ts: string | null;
  persona: { nombre: string | null } | null;
  chat: { titulo: string | null } | null;
}

// ─── Metadatos visuales ─────────────────────────────────────────────────────
const ESTADO_META: Record<Estado, { label: string; punto: string; color: string; orden: number }> = {
  sin_responder:     { label: 'Sin responder',        punto: '🔴', color: '#dc2626', orden: 1 },
  te_toca:           { label: 'Te toca a vos',        punto: '🟠', color: '#ea580c', orden: 2 },
  frio:              { label: 'Frío · recontactar',   punto: '⚪', color: '#9ca3af', orden: 3 },
  esperando_cliente: { label: 'Esperando al cliente', punto: '🔵', color: '#2563eb', orden: 4 },
  cerrada:           { label: 'Cerrada',              punto: '🟢', color: '#16a34a', orden: 5 },
};
const TIPO_META: Record<TipoConv, { label: string; color: string }> = {
  venta:    { label: 'Venta',    color: '#2563eb' },
  garantia: { label: 'Garantía', color: '#d97706' },
  consulta: { label: 'Consulta', color: '#7c3aed' },
};
// "Te toca a vos" (abierto) vs "No te toca" (cerrado), según la visión de Jhon.
const TE_TOCA: Estado[] = ['sin_responder', 'te_toca', 'frio'];

// ─── Helpers de fecha ───────────────────────────────────────────────────────
function hace(iso: string | null): string {
  if (!iso) return '';
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'recién';
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.floor(h / 24);
  return `hace ${d} día${d === 1 ? '' : 's'}`;
}
function haceDias(fecha: string | null): string {
  if (!fecha) return '';
  const d = Math.floor((Date.now() - new Date(`${fecha}T12:00:00`).getTime()) / 86400000);
  if (d <= 0) return 'hoy';
  return `hace ${d} día${d === 1 ? '' : 's'}`;
}
const nombreDe = (f: Fila) =>
  f.persona?.nombre || f.chat?.titulo || `Chat #${f.chat_id}`;

// ─── Componente ─────────────────────────────────────────────────────────────
export function JuniorChecklist() {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cargado, setCargado] = useState(false);
  const [abierto, setAbierto] = useState<number | null>(null);
  const [filtro, setFiltro] = useState<Estado | 'todos'>('todos');

  async function cargar() {
    const { data } = await supabase
      .from('chat_checklist')
      .select('id,chat_id,tipo,estado,proximo_paso,motivo_cierre,pasos,compromisos,' +
        'ultimo_mensaje_ts,persona:personas(nombre),chat:chats(titulo)');
    const rows = (data as any as Fila[]) ?? [];
    rows.sort((a, b) =>
      (ESTADO_META[a.estado]?.orden ?? 9) - (ESTADO_META[b.estado]?.orden ?? 9) ||
      (b.ultimo_mensaje_ts ?? '').localeCompare(a.ultimo_mensaje_ts ?? ''));
    setFilas(rows);
    setCargado(true);
  }

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 5000);
    return () => clearInterval(t);
  }, []);

  const conteo = (e: Estado) => filas.filter(f => f.estado === e).length;
  const teToca = filas.filter(f => TE_TOCA.includes(f.estado));
  const noTeToca = filas.filter(f => !TE_TOCA.includes(f.estado));
  const filtradas = filtro === 'todos' ? [] : filas.filter(f => f.estado === filtro);
  const compromisos = filas.flatMap(f =>
    (f.compromisos ?? []).map(c => ({ cliente: nombreDe(f), ...c })));

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '18px 24px' }}>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: 'var(--text-muted)' }}>
        El estado de cada conversación: en qué chats <strong>te toca mover a vos</strong> y
        en cuáles no. Junior lo mantiene al día leyendo cada chat.
        {' '}<em>Tocá un estado para filtrar.</em>
      </p>

      {cargado && filas.length === 0 && (
        <div style={{ textAlign: 'center', padding: '50px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>✅</div>
          <p style={{ fontSize: 13, margin: 0 }}>
            Todavía no hay chats analizados. El checklist se llena solo a medida
            que Junior procesa las conversaciones.
          </p>
        </div>
      )}

      {filas.length > 0 && (
        <>
          {/* Filtro por estado — el semáforo es clickeable */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 18 }}>
            <FiltroChip activo={filtro === 'todos'} onClick={() => setFiltro('todos')}
              punto="" label="Todos" count={filas.length} color="var(--accent)" />
            {(Object.keys(ESTADO_META) as Estado[]).map(e => (
              <FiltroChip key={e} activo={filtro === e}
                onClick={() => setFiltro(filtro === e ? 'todos' : e)}
                punto={ESTADO_META[e].punto} label={ESTADO_META[e].label}
                count={conteo(e)} color={ESTADO_META[e].color} />
            ))}
          </div>

          {/* Compromisos pendientes */}
          {compromisos.length > 0 && (
            <>
              <SeccionTitulo icono="⚠️" texto={`Compromisos pendientes (${compromisos.length})`} color="#d97706" />
              <div style={{
                background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10,
                padding: '6px 4px', marginBottom: 22,
              }}>
                {compromisos.map((c, i) => (
                  <div key={i} style={{
                    display: 'flex', alignItems: 'baseline', gap: 8, padding: '7px 12px', fontSize: 13,
                  }}>
                    <span style={{ color: '#d97706' }}>⚠</span>
                    <div style={{ flex: 1 }}>
                      <strong>{c.cliente}</strong>
                      <span style={{ color: 'var(--text-muted)' }}> — le dijiste «{c.texto}»</span>
                    </div>
                    <span style={{ fontSize: 11, color: '#b45309', whiteSpace: 'nowrap' }}>
                      {haceDias(c.prometido_at)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Con filtro activo: una sola lista del estado elegido */}
          {filtro !== 'todos' && (
            <>
              <SeccionTitulo icono={ESTADO_META[filtro].punto}
                texto={`${ESTADO_META[filtro].label} (${filtradas.length})`}
                color={ESTADO_META[filtro].color} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {filtradas.length === 0 && <Vacio texto="No hay chats en este estado." />}
                {filtradas.map(f => (
                  <ChatCard key={f.id} fila={f} expandido={abierto === f.id}
                    onToggle={() => setAbierto(abierto === f.id ? null : f.id)} />
                ))}
              </div>
            </>
          )}

          {/* Sin filtro: los dos grupos — te toca a vos / no te toca */}
          {filtro === 'todos' && (
            <>
              <SeccionTitulo icono="🎯" texto={`Te toca a vos (${teToca.length})`} color="#dc2626" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 22 }}>
                {teToca.length === 0 && <Vacio texto="Nada pendiente de tu lado. 👏" />}
                {teToca.map(f => (
                  <ChatCard key={f.id} fila={f} expandido={abierto === f.id}
                    onToggle={() => setAbierto(abierto === f.id ? null : f.id)} />
                ))}
              </div>

              <SeccionTitulo icono="✓" texto={`No te toca — esperando o cerradas (${noTeToca.length})`} color="#16a34a" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {noTeToca.length === 0 && <Vacio texto="—" />}
                {noTeToca.map(f => (
                  <ChatCard key={f.id} fila={f} expandido={abierto === f.id}
                    onToggle={() => setAbierto(abierto === f.id ? null : f.id)} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Sub-componentes ────────────────────────────────────────────────────────
function SeccionTitulo({ icono, texto, color }: { icono: string; texto: string; color: string }) {
  return (
    <h3 style={{
      display: 'flex', alignItems: 'center', gap: 7, margin: '0 0 8px',
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color,
    }}>
      <span>{icono}</span>{texto}
    </h3>
  );
}

function Vacio({ texto }: { texto: string }) {
  return (
    <div style={{
      padding: '14px', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)',
      background: 'var(--bg-panel)', border: '1px dashed var(--border-soft)', borderRadius: 10,
    }}>{texto}</div>
  );
}

function FiltroChip({ activo, onClick, punto, label, count, color }: {
  activo: boolean; onClick: () => void; punto: string; label: string; count: number; color: string;
}) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '5px 11px',
      borderRadius: 999, cursor: 'pointer', fontSize: 12,
      background: activo ? color : 'var(--bg-panel)',
      border: `1px solid ${activo ? color : 'var(--border-soft)'}`,
    }}>
      {punto && <span>{punto}</span>}
      <strong style={{ color: activo ? 'white' : color }}>{count}</strong>
      <span style={{ color: activo ? 'white' : 'var(--text-muted)' }}>{label}</span>
    </button>
  );
}

function ChatCard({ fila, expandido, onToggle }: {
  fila: Fila; expandido: boolean; onToggle: () => void;
}) {
  const em = ESTADO_META[fila.estado];
  const tm = TIPO_META[fila.tipo];
  const pasos = fila.pasos ?? [];
  const hechos = pasos.filter(p => p.hecho).length;

  return (
    <div style={{
      border: '1px solid var(--border-soft)', borderLeft: `3px solid ${em.color}`,
      borderRadius: 10, background: 'var(--bg-panel)', overflow: 'hidden',
    }}>
      {/* Cabecera clickeable */}
      <div onClick={onToggle} style={{ padding: '10px 14px', cursor: 'pointer' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13 }}>{em.punto}</span>
          <strong style={{ fontSize: 14 }}>{nombreDe(fila)}</strong>
          <span style={{
            padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 600,
            color: tm.color, background: 'var(--bg-page)', border: '1px solid var(--border-soft)',
          }}>{tm.label}</span>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>
            {hace(fila.ultimo_mensaje_ts)}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{expandido ? '▲' : '▼'}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 5 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: em.color }}>{em.label}</span>
          <span style={{ fontSize: 12, color: 'var(--text)' }}>
            {fila.estado === 'cerrada'
              ? (fila.motivo_cierre || 'Conversación cerrada')
              : `→ ${fila.proximo_paso || 'sin próximo paso definido'}`}
          </span>
        </div>
      </div>

      {/* Checklist expandido */}
      {expandido && pasos.length > 0 && (
        <div style={{
          borderTop: '1px solid var(--border-soft)', background: 'var(--bg-page)',
          padding: '10px 14px',
        }}>
          <div style={{
            fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
            color: 'var(--text-muted)', marginBottom: 7,
          }}>
            Flujo de {tm.label.toLowerCase()} · {hechos}/{pasos.length} pasos
          </div>
          {pasos.map((p, i) => {
            const esProximo = !p.hecho && pasos.slice(0, i).every(x => x.hecho);
            return (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 13,
                color: p.hecho ? 'var(--text-muted)' : 'var(--text)',
              }}>
                <span>{p.hecho ? '☑' : '☐'}</span>
                <span style={{
                  textDecoration: p.hecho ? 'line-through' : 'none',
                  fontWeight: esProximo ? 700 : 400,
                }}>{p.label}</span>
                {esProximo && (
                  <span style={{
                    padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                    color: 'white', background: p.responsable === 'jhon' ? '#ea580c' : '#2563eb',
                  }}>
                    {p.responsable === 'jhon' ? 'TE TOCA' : 'ESPERA AL CLIENTE'}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
