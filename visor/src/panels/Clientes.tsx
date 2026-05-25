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
import { previewEliminarChat, eliminarChatProcesado, reclasificarAmbito, type PreviewEliminarChat, type ResultadoEliminarChat } from '../lib/queries';

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

interface JuniorSint {
  sintesis: string | null;
  estado: string | null;
  estado_semaforo: 'verde' | 'amarillo' | 'rojo' | null;
  alerta: string | null;
}

const SEMAFORO_COLOR: Record<string, string> = {
  verde: '#34c759', amarillo: '#ff9500', rojo: '#ff3b30',
};

// Ámbitos para reclasificar un contacto (mismo catálogo que la tabla `ambitos`).
const AMBITOS: { codigo: string; label: string }[] = [
  { codigo: 'comercial',        label: 'Comercial (cliente)' },
  { codigo: 'proveedor',        label: 'Proveedor' },
  { codigo: 'personal_familia', label: 'Personal · Familia' },
  { codigo: 'personal_amigos',  label: 'Personal · Amigos' },
  { codigo: 'personal_otros',   label: 'Personal · Otros' },
  { codigo: 'interno_equipo',   label: 'Interno · Equipo' },
];

// Filtro superior — agrupa los 3 personal_* bajo "Personal".
const FILTROS_AMBITO: { val: string; label: string }[] = [
  { val: 'comercial',      label: 'Comercial' },
  { val: 'proveedor',      label: 'Proveedor' },
  { val: 'personal',       label: 'Personal' },
  { val: 'interno_equipo', label: 'Equipo' },
  { val: 'todos',          label: 'Todos' },
];

export function Clientes() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [rows, setRows] = useState<ClienteRow[]>([]);
  const [junior, setJunior] = useState<Record<number, JuniorSint>>({});
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');
  const [modalEliminar, setModalEliminar] = useState<ClienteRow | null>(null);
  const [aviso, setAviso] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);
  const [filtroAmbito, setFiltroAmbito] = useState('comercial');

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

      // Visión global de Junior por cliente (la conclusión de las 7 síntesis)
      const { data: jsint } = await supabase
        .from('modulo_sintesis')
        .select('persona_id,sintesis,estado,estado_semaforo,alerta')
        .eq('modulo', 'junior');
      const jmap: Record<number, JuniorSint> = {};
      (jsint ?? []).forEach((j: any) => { if (j.persona_id) jmap[j.persona_id] = j; });
      setJunior(jmap);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => { cargar(); }, []);

  const filtradas = useMemo(() => {
    let r = rows;
    if (filtroAmbito !== 'todos') {
      r = r.filter(x => filtroAmbito === 'personal'
        ? (x.ambito ?? '').startsWith('personal_')
        : x.ambito === filtroAmbito);
    }
    if (busqueda.trim()) {
      const q = busqueda.toLowerCase();
      r = r.filter(x =>
        x.chat_titulo.toLowerCase().includes(q) ||
        (x.persona_nombre ?? '').toLowerCase().includes(q) ||
        (x.persona_telefono ?? '').includes(q) ||
        (x.persona_email ?? '').toLowerCase().includes(q) ||
        (x.persona_empresa ?? '').toLowerCase().includes(q) ||
        (x.persona_ciudad ?? '').toLowerCase().includes(q));
    }
    return r;
  }, [rows, busqueda, filtroAmbito]);

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

  async function cambiarAmbito(r: ClienteRow, nuevo: string) {
    if (nuevo === r.ambito) return;
    try {
      await reclasificarAmbito({
        chatId: r.chat_id,
        proyectoId: r.proyecto_id,
        personaId: r.persona_id,
        ambitoAnterior: r.ambito,
        ambitoNuevo: nuevo,
      });
      const etiq = AMBITOS.find(a => a.codigo === nuevo)?.label ?? nuevo;
      setAviso({ tipo: 'ok', msg: `"${r.persona_nombre ?? r.chat_titulo}" reclasificado a ${etiq}.` });
      cargar();
    } catch (e: any) {
      setAviso({ tipo: 'err', msg: e.message ?? String(e) });
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Clientes</h1>
          <span style={{ fontSize: 10, padding: '2px 8px', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase' }}>
            chats procesados · {filtradas.length}
          </span>
          <button onClick={cargar} style={btnSec}>↻ Recargar</button>
        </div>
        <p style={{ margin: '4px 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          Click en un cliente → se vuelve el "activo" del Visor. Toda la info que ves en M1 Núcleo, M2 Comerciales, etc. es del cliente activo.
        </p>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
          <input
            type="search"
            value={busqueda}
            onChange={e => setBusqueda(e.target.value)}
            placeholder="🔍 Buscar nombre, teléfono, email, empresa…"
            style={{
              width: 320, padding: '7px 12px', fontSize: 13,
              border: '1px solid var(--border)', borderRadius: 6,
              background: 'var(--bg-page)', outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 2 }}>Ámbito:</span>
            {FILTROS_AMBITO.map(f => (
              <button key={f.val} onClick={() => setFiltroAmbito(f.val)}
                style={{
                  padding: '5px 9px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
                  border: `1px solid ${filtroAmbito === f.val ? 'var(--accent)' : 'var(--border)'}`,
                  background: filtroAmbito === f.val ? 'var(--accent-soft)' : 'var(--bg-page)',
                  color: filtroAmbito === f.val ? 'var(--accent)' : 'var(--text)',
                  fontWeight: filtroAmbito === f.val ? 600 : 400,
                }}>
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <div style={{ margin: '0 24px 8px', padding: 10, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12 }}>
          {error}
        </div>
      )}

      {aviso && (
        <div style={{
          margin: '0 24px 8px', padding: 10, borderRadius: 6, fontSize: 12,
          display: 'flex', alignItems: 'center', gap: 8,
          background: aviso.tipo === 'ok' ? '#e6f7ed' : '#ffe5e5',
          color: aviso.tipo === 'ok' ? '#1a7f37' : 'var(--red)',
        }}>
          <span style={{ flex: 1 }}>{aviso.tipo === 'ok' ? '✓ ' : '⚠ '}{aviso.msg}</span>
          <button onClick={() => setAviso(null)} style={{ ...btnSec, marginLeft: 0 }}>Cerrar</button>
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
            {busqueda.trim() ? `Sin resultados para "${busqueda}".` : 'No hay contactos en este ámbito.'}
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
          {filtradas.map(r => {
            const activo = ctx.chatActivoId === r.chat_id;
            const jr = r.persona_id ? junior[r.persona_id] : undefined;
            const semColor = jr?.estado_semaforo ? SEMAFORO_COLOR[jr.estado_semaforo] : null;
            const initial = ((r.persona_nombre ?? r.chat_titulo) || '').split(' ').filter(Boolean).map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '?';
            const ultMsg = r.msgs_ultimo_ts
              ? new Date(r.msgs_ultimo_ts).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
              : '—';
            return (
              <div role="button" key={r.chat_id} onClick={() => seleccionar(r)}
                style={{
                  display: 'block', textAlign: 'left',
                  background: activo ? 'var(--accent-soft)' : 'var(--bg-panel)',
                  border: `1px solid ${activo ? 'var(--accent)' : 'var(--border-soft)'}`,
                  borderLeft: semColor ? `4px solid ${semColor}` : `1px solid ${activo ? 'var(--accent)' : 'var(--border-soft)'}`,
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
                  <select
                    value={r.ambito}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => { e.stopPropagation(); cambiarAmbito(r, e.target.value); }}
                    title="Ámbito del contacto — cambialo para reclasificarlo (ej. de cliente a proveedor)"
                    style={{
                      flexShrink: 0, fontSize: 10, padding: '3px 4px', maxWidth: 122,
                      border: '1px solid var(--border)', borderRadius: 6,
                      background: 'var(--bg-page)', color: 'var(--text-muted)', cursor: 'pointer',
                    }}
                  >
                    {AMBITOS.map(a => <option key={a.codigo} value={a.codigo}>{a.label}</option>)}
                  </select>
                  <button
                    onClick={(e) => { e.stopPropagation(); setModalEliminar(r); }}
                    title="Eliminar este chat procesado para volver a procesarlo limpio desde Captura"
                    style={{
                      flexShrink: 0, width: 28, height: 28, padding: 0,
                      border: '1px solid var(--border)', borderRadius: 6,
                      background: 'var(--bg-page)', cursor: 'pointer', fontSize: 13, lineHeight: 1,
                    }}
                  >🗑</button>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 11, color: 'var(--text-muted)' }}>
                  <div>📋 {r.proyecto_nombre ?? '—'}</div>
                  <div>📍 {r.persona_ciudad ?? r.persona_empresa ?? '—'}</div>
                  <div>💬 {r.msgs_total} mensajes</div>
                  <div>🗂 {r.eventos_total} eventos</div>
                  <div style={{ gridColumn: 'span 2', fontSize: 10, color: 'var(--text-muted)' }}>último: {ultMsg}</div>
                </div>

                {jr?.sintesis && (
                  <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border-soft)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 4 }}>
                      {semColor && <span style={{ width: 7, height: 7, borderRadius: '50%', background: semColor, display: 'inline-block', flexShrink: 0 }} />}
                      <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        🤖 Junior{jr.estado ? ` · ${jr.estado}` : ''}
                      </span>
                    </div>
                    <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--text)' }}>{jr.sintesis}</div>
                    {jr.alerta && (
                      <div style={{ marginTop: 4, fontSize: 10, color: '#ff3b30', lineHeight: 1.4 }}>⚠ {jr.alerta}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {modalEliminar && (
        <ModalEliminarCliente
          cliente={modalEliminar}
          onClose={() => setModalEliminar(null)}
          onDone={(msg) => { setModalEliminar(null); setAviso({ tipo: 'ok', msg }); cargar(); }}
          onError={(msg) => { setAviso({ tipo: 'err', msg }); }}
        />
      )}
    </div>
  );
}

const btnSec: React.CSSProperties = {
  marginLeft: 'auto', padding: '5px 10px', fontSize: 11, fontWeight: 500,
  background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 6,
  color: 'var(--text)', cursor: 'pointer',
};

/**
 * Modal de confirmación para eliminar un chat procesado desde Clientes.
 * Reusa la lógica de borrado en cascada de queries.ts (la misma que M0 Captura):
 * borra mensajes + eventos + chat, y persona/proyecto/inmueble solo si quedan
 * huérfanos. La extensión conserva el chat en local → se puede re-procesar.
 */
function ModalEliminarCliente({ cliente, onClose, onDone, onError }: {
  cliente: ClienteRow;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [preview, setPreview] = useState<PreviewEliminarChat | null>(null);
  const [cargandoPreview, setCargandoPreview] = useState(true);
  const [aplicando, setAplicando] = useState(false);
  const [confirmacion, setConfirmacion] = useState('');
  const nombre = cliente.persona_nombre ?? cliente.chat_titulo;

  useEffect(() => {
    previewEliminarChat(cliente.chat_id)
      .then(setPreview)
      .catch(e => onError(e.message))
      .finally(() => setCargandoPreview(false));
  }, [cliente.chat_id]);

  async function confirmar() {
    if (confirmacion.trim().toLowerCase() !== 'eliminar') return;
    setAplicando(true);
    try {
      const r: ResultadoEliminarChat = await eliminarChatProcesado(cliente.chat_id);
      const partes = [`${r.mensajes_borrados} mensajes`, `${r.eventos_borrados} eventos`];
      if (r.proyectos_borrados > 0) partes.push(`${r.proyectos_borrados} proyecto`);
      if (r.personas_borradas > 0)  partes.push(`${r.personas_borradas} persona`);
      if (r.inmuebles_borrados > 0) partes.push(`${r.inmuebles_borrados} inmueble`);
      onDone(`"${nombre}" eliminado · ${partes.join(' · ')}. Ya podés re-procesarlo desde Captura.`);
    } catch (e: any) {
      onError(e.message ?? String(e));
      setAplicando(false);
    }
  }

  const listo = confirmacion.trim().toLowerCase() === 'eliminar';

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'white', borderRadius: 12, padding: 24, maxWidth: 520, width: '90%',
        maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
      }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700 }}>🗑 Eliminar chat procesado: {nombre}</h2>
        <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
          Borra todo lo que el procesamiento creó en Supabase para este chat (mensajes, eventos,
          transcripciones, persona/proyecto/inmueble si quedan huérfanos). La extensión{' '}
          <strong>conserva los mensajes en local</strong>, así que después podés ir a{' '}
          <strong>Captura</strong> y darle <strong>Procesar</strong> con el estado limpio.
        </p>

        {cargandoPreview && <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>Calculando impacto…</div>}

        {preview && (
          <div style={{ background: '#fff7ed', border: '1px solid #fb923c', borderRadius: 6, padding: 12, marginBottom: 12, fontSize: 12 }}>
            <div style={{ marginBottom: 6, fontWeight: 600 }}>Se borrará:</div>
            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
              <li><strong>{preview.mensajes}</strong> mensajes</li>
              <li><strong>{preview.eventos}</strong> eventos en evento_pg</li>
              <li><strong>1</strong> chat</li>
              {preview.proyecto_se_borra && <li><strong>1</strong> proyecto huérfano</li>}
              {preview.persona_se_borra && <li><strong>1</strong> persona huérfana</li>}
              {preview.inmueble_se_borra && <li><strong>1</strong> inmueble huérfano</li>}
              {preview.notas_libres > 0 && <li>{preview.notas_libres} notas libres asociadas</li>}
              {preview.correcciones > 0 && <li>{preview.correcciones} correcciones</li>}
              {preview.buzon_pendiente > 0 && <li>{preview.buzon_pendiente} ítems del buzón</li>}
            </ul>
            {!preview.proyecto_se_borra && preview.proyecto_id && (
              <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                ℹ El proyecto/persona/inmueble NO se borran porque hay otros chats que los referencian.
              </div>
            )}
          </div>
        )}

        <p style={{ fontSize: 12, marginBottom: 4 }}>
          Para confirmar, escribí <code style={{ background: 'var(--bg-page)', padding: '1px 6px', borderRadius: 3, fontWeight: 700 }}>eliminar</code>:
        </p>
        <input
          type="text" value={confirmacion} onChange={e => setConfirmacion(e.target.value)}
          placeholder="eliminar" autoFocus
          style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, boxSizing: 'border-box' }}
        />

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={{ ...btnSec, marginLeft: 0 }}>Cancelar</button>
          <button
            onClick={confirmar}
            disabled={aplicando || !listo || cargandoPreview}
            style={{
              padding: '5px 14px', fontSize: 12, fontWeight: 600, borderRadius: 6,
              border: '1px solid #ff3b30',
              background: listo && !aplicando ? '#ff3b30' : 'white',
              color: listo && !aplicando ? 'white' : '#ff3b30',
              cursor: listo && !aplicando ? 'pointer' : 'default',
              opacity: aplicando || !listo || cargandoPreview ? 0.5 : 1,
            }}
          >
            {aplicando ? 'Eliminando…' : '🗑 Eliminar definitivo'}
          </button>
        </div>
      </div>
    </div>
  );
}
