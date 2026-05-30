import { useEffect, useMemo, useState } from 'react';
import { fetchTranscripciones, type ItemTranscripcion, type EstadoTranscripcion } from '../../lib/queries';
import { useModo } from '../../lib/modo';
import { estimarMediaChat, transcribirMediaChat, type EstimadoMediaChat, type ResultadoTranscripcion } from '../../lib/extension';
import { useContextoActivo } from '../../lib/contexto_activo';

const TIPO_ICONO: Record<string, string> = {
  audio: '🎙', imagen: '📷', video: '🎬', documento: '📄', ubicacion: '📍', contacto: '👤',
};

const ESTADO_LABEL: Record<EstadoTranscripcion, string> = {
  'transcrito':         '✓ Transcrito',
  'pendiente_ia':       '⏳ Pendiente IA',
  'sin_ia':             '⏸ Sin procesar IA',
  'irrecuperable_cdn':  '💀 No recuperable (CDN expiró)',
  'error_temporal':     '⚠️ Error temporal (reintentar)',
  'error_inesperado':   '❌ Error inesperado',
  'no_aplica':          '— No aplica',
};

const ESTADO_COLOR: Record<EstadoTranscripcion, string> = {
  'transcrito':         'var(--green)',
  'pendiente_ia':       '#ff9500',
  'sin_ia':             'var(--text-muted)',
  'irrecuperable_cdn':  '#71717a',          // gris oscuro: definitivamente perdido
  'error_temporal':     '#fb923c',          // naranja: vale reintentar
  'error_inesperado':   'var(--red)',
  'no_aplica':          'var(--text-muted)',
};

type FiltroTipo = 'todos' | 'audio' | 'imagen' | 'video' | 'documento' | 'ubicacion';
type FiltroEstado = 'todos' | EstadoTranscripcion;

interface ChatPendiente {
  chat_id: number;
  chat_jid: string | null;     // jid de WhatsApp para llamar a la extensión
  chat_titulo: string;
  audios: number;
  imagenes: number;
  documentos: number;
  estimado?: EstimadoMediaChat;   // se calcula on-demand
  estimando?: boolean;
  estimadoError?: string;
}

interface CorriendoState {
  jid: string;
  titulo: string;
  estimado: EstimadoMediaChat;
  resultado?: ResultadoTranscripcion['stats'];
  error?: string;
  comenzado_at: number;
}

export function Transcripciones() {
  const [modo] = useModo();
  const ctx = useContextoActivo();
  const [items, setItems] = useState<ItemTranscripcion[]>([]);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filtroTipo, setFiltroTipo] = useState<FiltroTipo>('todos');
  const [filtroEstado, setFiltroEstado] = useState<FiltroEstado>('todos');
  const [filtroChat, setFiltroChat] = useState<string>('todos');
  const [seleccionado, setSeleccionado] = useState<number | null>(null);
  const [confirmando, setConfirmando] = useState<ChatPendiente | null>(null);
  const [corriendo, setCorriendo] = useState<CorriendoState | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  function recargar() {
    if (modo === 'demo') { setItems([]); return; }
    setCargando(true); setError(null);
    fetchTranscripciones()
      .then(setItems)
      .catch(e => setError(e.message))
      .finally(() => setCargando(false));
  }

  useEffect(() => { recargar(); }, [modo]);

  // Items que respetan el contexto activo (sin los filtros de UI tipo/estado/chat).
  // Sirve para que los KPIs y el banner de "chats pendientes" reflejen el contexto.
  const itemsEnContexto = useMemo(() => {
    if (!ctx.hayContexto) return items;
    if (ctx.chatActivoId != null)     return items.filter(i => i.chat_id === ctx.chatActivoId);
    if (ctx.proyectoActivoId != null) return items.filter(i => i.proyecto_id === ctx.proyectoActivoId);
    if (ctx.personaActivaId != null)  return items.filter(i => i.persona_id === ctx.personaActivaId);
    return items;
  }, [items, ctx.hayContexto, ctx.chatActivoId, ctx.proyectoActivoId, ctx.personaActivaId]);

  const stats = useMemo(() => {
    const base = itemsEnContexto;
    const total = base.length;
    const transcritos = base.filter(i => i.estado === 'transcrito').length;
    const pendientes = base.filter(i => i.estado === 'pendiente_ia' || i.estado === 'sin_ia').length;
    const irrecuperables = base.filter(i => i.estado === 'irrecuperable_cdn').length;
    const errorTemporal = base.filter(i => i.estado === 'error_temporal').length;
    const errorInesperado = base.filter(i => i.estado === 'error_inesperado').length;
    const errores = errorTemporal + errorInesperado;
    const procesable = total - base.filter(i => i.estado === 'no_aplica' || i.estado === 'irrecuperable_cdn').length;
    const cubiertos = procesable > 0 ? Math.round((transcritos / procesable) * 100) : 0;
    const costoSinIa = base.filter(i => i.estado === 'sin_ia').reduce((a, i) => a + i.costo_estimado_usd, 0);
    return { total, transcritos, pendientes, irrecuperables, errorTemporal, errorInesperado, errores, cubiertos, costoSinIa };
  }, [itemsEnContexto]);

  const chatsUnicos = useMemo(() => {
    const m = new Map<number, string>();
    items.forEach(i => m.set(i.chat_id, i.chat_titulo));
    return [...m.entries()].map(([id, titulo]) => ({ id, titulo }));
  }, [items]);

  // Chats con media pendiente IA (sin transcripción), agrupados.
  // Respeta el contexto activo: si Jhon está en Jairo, solo muestra el chat de Jairo.
  const [pendientesPorChat, setPendientesPorChat] = useState<ChatPendiente[]>([]);
  useEffect(() => {
    const map = new Map<number, ChatPendiente>();
    for (const i of itemsEnContexto) {
      if (i.estado !== 'sin_ia') continue;
      if (i.tipo !== 'audio' && i.tipo !== 'imagen' && i.tipo !== 'documento') continue;
      let entry = map.get(i.chat_id);
      if (!entry) {
        entry = {
          chat_id: i.chat_id,
          chat_jid: i.chat_jid ?? null,
          chat_titulo: i.chat_titulo,
          audios: 0, imagenes: 0, documentos: 0,
        };
        map.set(i.chat_id, entry);
      }
      if (i.tipo === 'audio') entry.audios++;
      else if (i.tipo === 'imagen') entry.imagenes++;
      else if (i.tipo === 'documento') entry.documentos++;
    }
    setPendientesPorChat([...map.values()].sort((a, b) =>
      (b.audios + b.imagenes + b.documentos) - (a.audios + a.imagenes + a.documentos)));
  }, [itemsEnContexto]);

  async function calcularEstimado(chatPend: ChatPendiente) {
    if (!chatPend.chat_jid) {
      setPendientesPorChat(arr => arr.map(p => p.chat_id === chatPend.chat_id
        ? { ...p, estimadoError: 'Chat sin jid de WhatsApp en BD — no se puede pedir a la extensión.' } : p));
      return;
    }
    setPendientesPorChat(arr => arr.map(p => p.chat_id === chatPend.chat_id ? { ...p, estimando: true, estimadoError: undefined } : p));
    try {
      const est = await estimarMediaChat(chatPend.chat_jid);
      setPendientesPorChat(arr => arr.map(p => p.chat_id === chatPend.chat_id
        ? { ...p, estimando: false, estimado: est } : p));
    } catch (e: any) {
      setPendientesPorChat(arr => arr.map(p => p.chat_id === chatPend.chat_id
        ? { ...p, estimando: false, estimadoError: e.message } : p));
    }
  }

  async function ejecutarTranscripcion(chatPend: ChatPendiente, est: EstimadoMediaChat) {
    if (!chatPend.chat_jid) return;
    setConfirmando(null);
    setCorriendo({ jid: chatPend.chat_jid, titulo: chatPend.chat_titulo, estimado: est, comenzado_at: Date.now() });
    try {
      const r = await transcribirMediaChat(chatPend.chat_jid);
      setCorriendo(prev => prev ? { ...prev, resultado: r.stats } : null);
      // Recargar items para reflejar transcripciones
      setTimeout(() => { recargar(); }, 800);
    } catch (e: any) {
      setCorriendo(prev => prev ? { ...prev, error: e.message } : null);
      setFeedback({ tipo: 'err', msg: 'Transcripción falló: ' + e.message });
      setTimeout(() => setFeedback(null), 6000);
    }
  }

  const filtrados = useMemo(() => {
    let arr = items;
    // Filtro por contexto activo (jerárquico: chat > proyecto > persona, el más específico que esté seteado)
    if (ctx.hayContexto) {
      if (ctx.chatActivoId != null) {
        arr = arr.filter(i => i.chat_id === ctx.chatActivoId);
      } else if (ctx.proyectoActivoId != null) {
        arr = arr.filter(i => i.proyecto_id === ctx.proyectoActivoId);
      } else if (ctx.personaActivaId != null) {
        arr = arr.filter(i => i.persona_id === ctx.personaActivaId);
      }
    }
    if (filtroTipo !== 'todos') arr = arr.filter(i => i.tipo === filtroTipo);
    if (filtroEstado !== 'todos') arr = arr.filter(i => i.estado === filtroEstado);
    if (filtroChat !== 'todos') arr = arr.filter(i => i.chat_id === Number(filtroChat));
    return arr;
  }, [items, filtroTipo, filtroEstado, filtroChat, ctx.hayContexto, ctx.chatActivoId, ctx.proyectoActivoId, ctx.personaActivaId]);

  const detalle = seleccionado != null ? items.find(i => i.id === seleccionado) : null;

  if (modo === 'demo') {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
        Modo demo · sin transcripciones disponibles. Cambiá a modo Real.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 8px' }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Transcripciones</h2>
        <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>
          Audios, imágenes, videos y documentos de los chats <strong>procesados</strong>. Verificá que cada media esté transcripta o descripta por IA.
        </p>

        {/* KPIs */}
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <KPI label="Total media" valor={stats.total} color="#1c1c1e" />
          <KPI label="✓ Transcritos" valor={stats.transcritos} color="var(--green)" />
          <KPI label="⏸ Pendientes" valor={stats.pendientes} color="var(--orange)" />
          {stats.irrecuperables > 0 && <KPI label="💀 No recuperables" valor={stats.irrecuperables} color="#71717a" />}
          {stats.errorTemporal > 0 && <KPI label="⚠️ Errores temporales" valor={stats.errorTemporal} color="#fb923c" />}
          {stats.errorInesperado > 0 && <KPI label="❌ Errores raros" valor={stats.errorInesperado} color="var(--red)" />}
          <KPI label="Cobertura IA" valor={`${stats.cubiertos}%`} color={stats.cubiertos >= 80 ? 'var(--green)' : stats.cubiertos >= 50 ? 'var(--orange)' : 'var(--red)'} />
          {stats.costoSinIa > 0 && (
            <KPI label="Costo procesar pendientes" valor={`$${stats.costoSinIa.toFixed(4)}`} color="var(--accent)" />
          )}
        </div>

        {/* Banner aclaratorio: si hay irrecuperables o errores, explicar */}
        {(stats.irrecuperables > 0 || stats.errorTemporal > 0 || stats.errorInesperado > 0) && (
          <div style={{
            marginTop: 10, padding: '8px 12px',
            background: '#fff8e1', border: '1px solid #f5c84b', borderRadius: 6,
            fontSize: 11, lineHeight: 1.5,
          }}>
            <strong>ℹ Aclaración de motivos:</strong>
            {stats.irrecuperables > 0 && (
              <span> · <strong style={{color:'#71717a'}}>💀 No recuperables ({stats.irrecuperables})</strong>: el archivo lleva más de 17 días sin actividad y WhatsApp ya lo borró del CDN. Imposible transcribir. Marcado para no aparecer más como pendiente.</span>
            )}
            {stats.errorTemporal > 0 && (
              <span> · <strong style={{color:'#fb923c'}}>⚠️ Temporales ({stats.errorTemporal})</strong>: rate limit / timeout / red. Reintentar más tarde con "Transcribir media" suele resolver.</span>
            )}
            {stats.errorInesperado > 0 && (
              <span> · <strong style={{color:'var(--red)'}}>❌ Raros ({stats.errorInesperado})</strong>: error no esperado del flujo. Click en cada item para ver el detalle del error.</span>
            )}
          </div>
        )}

        {/* Acciones de transcripción — chats con media pendiente */}
        {pendientesPorChat.length > 0 && (
          <div style={{
            marginTop: 14, padding: 12,
            background: 'linear-gradient(180deg, #fff8e1 0%, #fff5d4 100%)',
            border: '1px solid #f5c84b', borderRadius: 8,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
              <div>
                <strong style={{ fontSize: 13 }}>🎙 {pendientesPorChat.length} chat(s) con media pendiente de transcribir</strong>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                  La extensión bajará los archivos, llamará a Whisper/Vision con cache SHA-256 y subirá las transcripciones a Supabase.
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {pendientesPorChat.slice(0, 8).map(p => (
                <div key={p.chat_id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 10px', background: 'rgba(255,255,255,0.6)', borderRadius: 6,
                }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {p.chat_titulo}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                      {p.audios > 0 && <span>🎤 {p.audios} audio{p.audios !== 1 ? 's' : ''}</span>}
                      {p.imagenes > 0 && <span>{p.audios > 0 ? ' · ' : ''}🖼 {p.imagenes} imagen{p.imagenes !== 1 ? 'es' : ''}</span>}
                      {p.documentos > 0 && <span>{(p.audios > 0 || p.imagenes > 0) ? ' · ' : ''}📎 {p.documentos} doc{p.documentos !== 1 ? 's' : ''}</span>}
                      {!p.chat_jid && <span style={{ color: 'var(--red)', marginLeft: 6 }}> · sin jid (no transcribible)</span>}
                    </div>
                    {p.estimadoError && (
                      <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 2 }}>{p.estimadoError}</div>
                    )}
                  </div>
                  <button
                    onClick={() => p.estimado ? setConfirmando(p) : calcularEstimado(p)}
                    disabled={p.estimando || !!corriendo || !p.chat_jid}
                    style={{
                      ...btnPrimario,
                      opacity: (p.estimando || !!corriendo || !p.chat_jid) ? 0.5 : 1,
                      cursor: (p.estimando || !!corriendo || !p.chat_jid) ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {p.estimando ? 'Calculando…' :
                     p.estimado ? `🎙 Transcribir · $${p.estimado.costo_estimado_usd.toFixed(4)}` :
                     'Estimar costo'}
                  </button>
                </div>
              ))}
              {pendientesPorChat.length > 8 && (
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
                  + {pendientesPorChat.length - 8} más
                </div>
              )}
            </div>
          </div>
        )}

        {/* Filtros */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, fontWeight: 600 }}>Filtros:</span>
          <select value={filtroTipo} onChange={e => setFiltroTipo(e.target.value as FiltroTipo)} style={selS}>
            <option value="todos">Todos los tipos</option>
            <option value="audio">🎙 Audio</option>
            <option value="imagen">📷 Imagen</option>
            <option value="video">🎬 Video</option>
            <option value="documento">📄 Documento</option>
            <option value="ubicacion">📍 Ubicación</option>
          </select>
          <select value={filtroEstado} onChange={e => setFiltroEstado(e.target.value as FiltroEstado)} style={selS}>
            <option value="todos">Todos los estados</option>
            <option value="transcrito">✓ Transcrito</option>
            <option value="sin_ia">⏸ Sin IA</option>
            <option value="pendiente_ia">⏳ Pendiente</option>
            <option value="irrecuperable_cdn">💀 No recuperable (CDN)</option>
            <option value="error_temporal">⚠️ Error temporal</option>
            <option value="error_inesperado">❌ Error inesperado</option>
            <option value="no_aplica">— No aplica</option>
          </select>
          <select value={filtroChat} onChange={e => setFiltroChat(e.target.value)} style={selS}>
            <option value="todos">Todos los chats</option>
            {chatsUnicos.map(c => <option key={c.id} value={c.id}>{c.titulo}</option>)}
          </select>
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{filtrados.length} de {items.length}</span>
        </div>
      </div>

      {error && (
        <div style={{ margin: '8px 24px', padding: 10, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12 }}>
          Error: {error}
        </div>
      )}

      {feedback && (
        <div style={{
          position: 'fixed', top: 70, right: 24, zIndex: 1100,
          padding: '10px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600,
          background: feedback.tipo === 'ok' ? '#86efac' : '#fca5a5',
          color: feedback.tipo === 'ok' ? '#065f46' : '#7f1d1d',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        }}>
          {feedback.msg}
        </div>
      )}

      {confirmando && confirmando.estimado && (
        <ModalConfirmar
          chat={confirmando}
          estimado={confirmando.estimado}
          onCancelar={() => setConfirmando(null)}
          onConfirmar={() => ejecutarTranscripcion(confirmando, confirmando.estimado!)}
        />
      )}

      {corriendo && (
        <ModalCorriendo
          state={corriendo}
          onCerrar={() => { setCorriendo(null); recargar(); }}
        />
      )}

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', borderTop: '1px solid var(--border-soft)', marginTop: 12 }}>
        {/* Lista */}
        <div style={{ width: 480, borderRight: '1px solid var(--border-soft)', overflow: 'auto', background: 'var(--bg-panel)' }}>
          {cargando && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Cargando…</div>}
          {!cargando && filtrados.length === 0 && (
            <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
              {items.length === 0 ? 'Sin media en chats procesados todavía. Procesá un chat con audios/imágenes desde el módulo Captura.' : 'Sin resultados con estos filtros.'}
            </div>
          )}
          {filtrados.map(it => (
            <Fila key={it.id} item={it} activo={it.id === seleccionado} onClick={() => setSeleccionado(it.id)} />
          ))}
        </div>

        {/* Detalle */}
        <div style={{ flex: 1, padding: 24, overflow: 'auto' }}>
          {!detalle ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, marginTop: 60 }}>
              Click en una media de la lista para ver detalle, transcripción y metadata.
            </div>
          ) : (
            <Detalle item={detalle} />
          )}
        </div>
      </div>
    </div>
  );
}

function Fila({ item, activo, onClick }: { item: ItemTranscripcion; activo: boolean; onClick: () => void }) {
  const ts = new Date(item.ts_canal).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const previewIA = item.ai_text ? item.ai_text.slice(0, 100) + (item.ai_text.length > 100 ? '…' : '') : null;
  const previewTexto = item.texto ? item.texto.slice(0, 80) + (item.texto.length > 80 ? '…' : '') : null;

  return (
    <button onClick={onClick} style={{
      width: '100%', textAlign: 'left',
      padding: '10px 14px',
      background: activo ? 'var(--accent-soft)' : 'transparent',
      border: 'none', borderBottom: '1px solid var(--border-soft)',
      borderLeft: `3px solid ${ESTADO_COLOR[item.estado]}`,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          {TIPO_ICONO[item.tipo] ?? '•'} {item.chat_titulo}
          {item.persona_nombre && item.persona_nombre !== item.chat_titulo && (
            <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 4 }}>· {item.persona_nombre}</span>
          )}
        </span>
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{ts}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4, fontSize: 10 }}>
        <span style={{ fontWeight: 600, color: ESTADO_COLOR[item.estado] }}>{ESTADO_LABEL[item.estado]}</span>
        <span style={{ color: 'var(--text-muted)' }}>· {item.direccion === 'saliente' ? 'enviado por mí' : 'recibido'}</span>
      </div>
      {previewIA && (
        <div style={{ marginTop: 6, padding: 6, background: '#e8f8ee', borderRadius: 4, fontSize: 11, color: 'var(--text)' }}>
          <strong style={{ color: 'var(--green)' }}>IA:</strong> {previewIA}
        </div>
      )}
      {!previewIA && previewTexto && (
        <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {previewTexto}
        </div>
      )}
      {!previewIA && !previewTexto && (
        <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-muted)' }}>(sin texto crudo, sin transcripción)</div>
      )}
    </button>
  );
}

function Detalle({ item }: { item: ItemTranscripcion }) {
  const ts = new Date(item.ts_canal).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
        <div style={{ fontSize: 32 }}>{TIPO_ICONO[item.tipo] ?? '•'}</div>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700 }}>{item.chat_titulo}</h2>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>
            {item.persona_nombre ? `${item.persona_nombre} · ` : ''}
            {item.tipo}{item.type_original && item.type_original !== item.tipo ? ` (${item.type_original})` : ''}
            {' · '}{ts}
          </div>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 12,
          color: 'white', background: ESTADO_COLOR[item.estado],
        }}>{ESTADO_LABEL[item.estado]}</span>
      </div>

      {/* Texto crudo (caption en imagen/video, ubicación nombre, etc.) */}
      {item.texto && (
        <Card titulo="Texto crudo del mensaje (caption)">
          <div style={{ fontSize: 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{item.texto}</div>
        </Card>
      )}

      {/* Transcripción IA */}
      <Card titulo={item.tipo === 'audio' ? 'Transcripción (Whisper)' : item.tipo === 'imagen' ? 'Descripción IA (Vision)' : item.tipo === 'documento' ? 'Resumen IA (Files API)' : 'Texto IA'}>
        {item.ai_text ? (
          <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap', padding: 10, background: '#e8f8ee', borderRadius: 6 }}>
            {item.ai_text}
          </div>
        ) : item.estado === 'sin_ia' ? (
          <div style={{ padding: 10, background: 'var(--bg-page)', borderRadius: 6, fontSize: 12, color: 'var(--text-muted)' }}>
            ⏸ Esta media NO se procesó con IA. Costo estimado: <strong>${item.costo_estimado_usd.toFixed(4)}</strong>.
            Click en "Transcribir media" del banner amarillo arriba para procesar este chat.
          </div>
        ) : item.estado === 'irrecuperable_cdn' ? (
          <div style={{ padding: 10, background: '#f4f4f5', color: '#52525b', borderRadius: 6, fontSize: 12, border: '1px solid #d4d4d8' }}>
            💀 <strong>No recuperable.</strong> El archivo lleva más de 17 días sin actividad y WhatsApp ya lo borró
            de su CDN. <strong>No se puede transcribir.</strong> Esta media queda marcada para no aparecer más como pendiente.
          </div>
        ) : item.estado === 'error_temporal' ? (
          <div style={{ padding: 10, background: '#fff7ed', color: '#9a3412', borderRadius: 6, fontSize: 12, border: '1px solid #fb923c' }}>
            ⚠️ <strong>Error temporal</strong> (rate limit, timeout o red). Volver a darle "Transcribir media" más tarde suele resolver.
          </div>
        ) : item.estado === 'error_inesperado' ? (
          <div style={{ padding: 10, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12 }}>
            ❌ <strong>Error inesperado</strong> al procesar. Mirar el campo <code>metadata.ai_error</code> de este mensaje para el detalle.
          </div>
        ) : (
          <div style={{ padding: 10, fontSize: 12, color: 'var(--text-muted)' }}>
            Este tipo de mensaje no requiere transcripción IA.
          </div>
        )}
      </Card>

      <Card titulo="Metadata">
        <Linea label="ID interno" valor={String(item.id)} />
        <Linea label="ID canal" valor={item.canal_msg_id} />
        <Linea label="Tipo schema" valor={item.tipo} />
        <Linea label="Tipo original (canonical)" valor={item.type_original ?? '—'} />
        <Linea label="Dirección" valor={item.direccion} />
        <Linea label="Estado IA" valor={ESTADO_LABEL[item.estado]} color={ESTADO_COLOR[item.estado]} />
      </Card>
    </div>
  );
}

function KPI({ label, valor, color }: { label: string; valor: number | string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 100 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{valor}</div>
    </div>
  );
}

function Card({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14, marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 8 }}>{titulo}</div>
      {children}
    </div>
  );
}

function Linea({ label, valor, color }: { label: string; valor: string; color?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 12 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ color: color ?? 'var(--text)', fontWeight: color ? 600 : 400 }}>{valor}</span>
    </div>
  );
}

const selS: React.CSSProperties = { padding: '5px 8px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'white' };
const btnPrimario: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6,
  cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
};

// ─── Modales ──────────────────────────────────────────────────────

function ModalConfirmar({
  chat, estimado, onCancelar, onConfirmar,
}: {
  chat: ChatPendiente;
  estimado: EstimadoMediaChat;
  onCancelar: () => void;
  onConfirmar: () => void;
}) {
  const minutosAudio = (estimado.duracion_audio_seg / 60).toFixed(1);

  return (
    <div style={overlay} onClick={onCancelar}>
      <div style={{ ...modalBox, width: 480 }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>Transcribir media · {chat.chat_titulo}</h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 14px' }}>
          La extensión bajará los archivos cifrados de WhatsApp y los procesará con OpenAI.
          Cache SHA-256 activo: si una imagen aparece en otro chat, no se cobra de nuevo.
        </p>

        <div style={tablaCostos}>
          <RowCosto label={`🎤 ${estimado.procesables.audios} audio${estimado.procesables.audios !== 1 ? 's' : ''} (~${minutosAudio} min)`} costo={estimado.desglose_costos.audios} servicio="Whisper" />
          <RowCosto label={`🖼 ${estimado.procesables.imagenes} imagen${estimado.procesables.imagenes !== 1 ? 'es' : ''}`} costo={estimado.desglose_costos.imagenes} servicio="Vision low" />
          <RowCosto label={`📎 ${estimado.procesables.pdfs} PDF${estimado.procesables.pdfs !== 1 ? 's' : ''}`} costo={estimado.desglose_costos.pdfs} servicio="gpt-4o-mini" />
          <div style={{ borderTop: '1px solid var(--border-soft)', paddingTop: 8, marginTop: 8 }}>
            <RowCosto label="TOTAL ESTIMADO" costo={estimado.costo_estimado_usd} servicio="" total />
          </div>
        </div>

        {/* Omitidos por reglas duras */}
        {Object.values(estimado.omitidos).some(v => v > 0) && (
          <div style={{ marginTop: 12, padding: 10, background: 'var(--bg-page)', borderRadius: 6, fontSize: 11 }}>
            <strong style={{ display: 'block', marginBottom: 4, color: 'var(--text-muted)' }}>OMITIDOS por reglas duras (sin costo):</strong>
            {estimado.omitidos.sticker > 0 && <span style={tagOmit}>{estimado.omitidos.sticker} sticker</span>}
            {estimado.omitidos.video > 0 && <span style={tagOmit}>{estimado.omitidos.video} video</span>}
            {estimado.omitidos.status_broadcast > 0 && <span style={tagOmit}>{estimado.omitidos.status_broadcast} status</span>}
            {estimado.omitidos.forwarded_many > 0 && <span style={tagOmit}>{estimado.omitidos.forwarded_many} forwarded</span>}
            {estimado.omitidos.burst_limit > 0 && <span style={tagOmit}>{estimado.omitidos.burst_limit} burst &gt;10/min</span>}
            {estimado.omitidos.ya_procesado > 0 && <span style={tagOmit}>{estimado.omitidos.ya_procesado} ya procesados (cache)</span>}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onCancelar} style={btnSecundario}>Cancelar</button>
          <button onClick={onConfirmar} style={btnPrimario}>
            ✓ Procesar · ${estimado.costo_estimado_usd.toFixed(4)}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalCorriendo({ state, onCerrar }: { state: CorriendoState; onCerrar: () => void }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (state.resultado || state.error) return;
    const t = setInterval(() => setTick(x => x + 1), 1000);
    return () => clearInterval(t);
  }, [state.resultado, state.error]);

  const segundos = Math.floor((Date.now() - state.comenzado_at) / 1000);
  const enCurso = !state.resultado && !state.error;

  return (
    <div style={overlay}>
      <div style={{ ...modalBox, width: 480 }}>
        <h3 style={{ margin: '0 0 8px', fontSize: 16 }}>
          {enCurso ? '🎙 Transcribiendo…' : state.error ? '❌ Falló' : '✓ Completado'}
        </h3>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 14px' }}>
          {state.titulo}
        </p>

        {enCurso && (
          <div style={{ padding: 12, background: 'var(--bg-page)', borderRadius: 6 }}>
            <div style={{ fontSize: 12, marginBottom: 8 }}>
              Procesando {state.estimado.procesables.audios} audios + {state.estimado.procesables.imagenes} imágenes + {state.estimado.procesables.pdfs} PDFs…
            </div>
            <div style={{ height: 4, background: 'var(--border-soft)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                height: '100%', background: 'var(--accent)',
                width: `${Math.min(95, segundos * 3)}%`,
                transition: 'width 1s linear',
              }} />
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, textAlign: 'right' }}>
              {segundos}s · pool 3 paralelos · esperando respuesta de la extensión {tick % 4 === 0 ? '·' : tick % 4 === 1 ? '··' : tick % 4 === 2 ? '···' : ' '}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, textAlign: 'center' }}>
              Si tarda &gt;3 min, asegurate que la pestaña de WhatsApp Web esté abierta.
            </div>
          </div>
        )}

        {state.resultado && (
          <div style={{ padding: 12, background: '#e8f8ee', borderRadius: 6, fontSize: 12 }}>
            <strong style={{ color: 'var(--green)' }}>✓ Procesado en {segundos}s</strong>
            <div style={{ marginTop: 8 }}>
              {(state.resultado.audios ?? 0) > 0 && <Linea label="🎤 Audios transcritos" valor={String(state.resultado.audios)} color="var(--green)" />}
              {(state.resultado.imagenes ?? 0) > 0 && <Linea label="🖼 Imágenes descritas" valor={String(state.resultado.imagenes)} color="var(--green)" />}
              {(state.resultado.pdfs ?? 0) > 0 && <Linea label="📎 PDFs resumidos" valor={String(state.resultado.pdfs)} color="var(--green)" />}
              {(state.resultado.cache_hits ?? 0) > 0 && <Linea label="♻️ Cache SHA-256 (gratis)" valor={String(state.resultado.cache_hits)} color="var(--green)" />}
              {(state.resultado.irrecuperables_cdn ?? 0) > 0 && (
                <Linea label="💀 No recuperables (CDN expiró)" valor={String(state.resultado.irrecuperables_cdn)} color="#71717a" />
              )}
              {(state.resultado.errores_temporales ?? 0) > 0 && (
                <Linea label="⚠️ Errores temporales (reintentar)" valor={String(state.resultado.errores_temporales)} color="#fb923c" />
              )}
              {(state.resultado.errores ?? 0) > 0 && (
                <Linea label="❌ Errores inesperados" valor={String(state.resultado.errores)} color="var(--red)" />
              )}
              {(state.resultado.no_existentes_en_supabase ?? 0) > 0 && (
                <Linea label="No existentes en Supabase" valor={String(state.resultado.no_existentes_en_supabase)} color="var(--orange)" />
              )}
              {(state.resultado.omitidos_total ?? 0) > 0 && (
                <Linea label="Omitidos por reglas duras" valor={String(state.resultado.omitidos_total)} />
              )}
            </div>
            {(state.resultado.errores ?? 0) > 0 && (state.resultado.errores_inesperados_detalle?.length ?? 0) > 0 && (
              <details style={{ marginTop: 10, fontSize: 11 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--red)' }}>Ver detalle de errores inesperados</summary>
                <div style={{ marginTop: 6, padding: 8, background: '#fee2e2', borderRadius: 4, maxHeight: 200, overflow: 'auto' }}>
                  {(state.resultado.errores_inesperados_detalle ?? []).map((e, i) => (
                    <div key={i} style={{ marginBottom: 4 }}>
                      <strong>{e.kind}</strong> · {e.msg_id.slice(0, 30)}…<br />
                      <code style={{ fontSize: 10 }}>{e.error}</code>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}

        {state.error && (
          <div style={{ padding: 12, background: '#fee2e2', color: '#7f1d1d', borderRadius: 6, fontSize: 12 }}>
            <strong>Error:</strong> {state.error}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button onClick={onCerrar} style={enCurso ? btnSecundario : btnPrimario} disabled={enCurso}>
            {enCurso ? 'Esperá…' : 'Cerrar'}
          </button>
        </div>
      </div>
    </div>
  );
}

function RowCosto({ label, costo, servicio, total }: { label: string; costo: number; servicio: string; total?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: 12 }}>
      <span style={{ color: total ? 'var(--text)' : 'var(--text-muted)', fontWeight: total ? 700 : 400 }}>{label}</span>
      <span style={{ display: 'flex', gap: 10, alignItems: 'baseline' }}>
        {servicio && !total && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{servicio}</span>}
        <span style={{ fontWeight: 700, color: total ? 'var(--accent)' : 'var(--text)', fontSize: total ? 14 : 12 }}>
          ${costo.toFixed(4)}
        </span>
      </span>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
};
const modalBox: React.CSSProperties = {
  background: 'white', borderRadius: 10, padding: 20,
  boxShadow: '0 10px 40px rgba(0,0,0,0.2)', maxHeight: '80vh', overflow: 'auto',
};
const tablaCostos: React.CSSProperties = {
  background: 'var(--bg-page)', padding: 10, borderRadius: 6,
};
const tagOmit: React.CSSProperties = {
  display: 'inline-block', padding: '2px 6px', marginRight: 6, marginTop: 4,
  background: 'rgba(0,0,0,0.06)', borderRadius: 4, fontSize: 10, color: 'var(--text-muted)',
};
const btnSecundario: React.CSSProperties = {
  padding: '6px 12px', fontSize: 12, fontWeight: 600,
  background: 'transparent', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6,
  cursor: 'pointer',
};
