import { useEffect, useMemo, useState } from 'react';
import { chequearExtension, listarChats, obtenerMensajes, procesarChat, bloquearChatExt, desbloquearChatExt, type ChatCaptura, type MensajeCanonico } from '../lib/extension';
import { fetchConfiguracion, eliminarChatProcesado, previewEliminarChat, type PreviewEliminarChat, type ResultadoEliminarChat } from '../lib/queries';
import { supabase } from '../lib/supabase';
import { useContextoActivo } from '../lib/contexto_activo';

type FiltroEstado = 'todos' | 'crudos' | 'bloqueados' | 'sospechosos';
type Orden = 'volumen' | 'reciente' | 'antiguo';   // volumen primero — workaround mientras se arregla el timestamp de la extensión (F1.19)

const NO_CLIENTE_LABEL: Record<string, { label: string; emoji: string }> = {
  restaurante: { label: 'Restaurante', emoji: '🍔' },
  transporte:  { label: 'Transporte', emoji: '🚖' },
  spam_finan:  { label: 'Spam financiero', emoji: '💸' },
  encuesta:    { label: 'Encuesta', emoji: '📞' },
  broadcast:   { label: 'Broadcast', emoji: '📢' },
};

export function Captura() {
  const [chats, setChats] = useState<ChatCaptura[]>([]);
  const [cargando, setCargando] = useState(true);
  const [extError, setExtError] = useState<string | null>(null);
  const [seleccionado, setSeleccionado] = useState<string | null>(null);
  const [mensajes, setMensajes] = useState<MensajeCanonico[]>([]);
  const [cargandoMsgs, setCargandoMsgs] = useState(false);
  const [filtro, setFiltro] = useState<FiltroEstado>('crudos');
  const [orden, setOrden] = useState<Orden>('reciente');   // F1.19 fix aplicado: usa chatT real de WA Web
  const [costoTexto, setCostoTexto] = useState(0.0007);
  const [costoMedia, setCostoMedia] = useState(0.005);
  const [topeDiario, setTopeDiario] = useState(5);
  const [modal, setModal] = useState<{ tipo: 'procesar' | 'bloquear' | 'eliminar'; chat: ChatCaptura } | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);
  const [procesadosPorJid, setProcesadosPorJid] = useState<Map<string, number>>(new Map());  // jid → chat_id_db
  const ctx = useContextoActivo();

  // Verificar extensión + cargar chats
  useEffect(() => {
    (async () => {
      const check = await chequearExtension();
      if (!check.conectada) {
        setExtError(check.mensaje);
        setCargando(false);
        return;
      }
      try {
        const [data, { data: proc }] = await Promise.all([
          listarChats(),
          supabase.from('chats')
            .select('id, canal_chat_id, ia_historico_procesado')
            .eq('canal', 'whatsapp')
            .eq('ia_historico_procesado', true),
        ]);
        setChats(data);
        const m = new Map<string, number>();
        (proc ?? []).forEach((c: any) => { if (c.canal_chat_id) m.set(c.canal_chat_id, c.id); });
        setProcesadosPorJid(m);
      } catch (e: any) {
        setExtError(e.message);
      } finally {
        setCargando(false);
      }
    })();
    fetchConfiguracion(['ia_costo_estimado_por_mensaje_texto_usd','ia_costo_estimado_por_mensaje_media_usd','ia_tope_diario_alerta_usd'])
      .then(cfg => {
        setCostoTexto(Number(cfg.ia_costo_estimado_por_mensaje_texto_usd ?? 0.0007));
        setCostoMedia(Number(cfg.ia_costo_estimado_por_mensaje_media_usd ?? 0.005));
        setTopeDiario(Number(cfg.ia_tope_diario_alerta_usd ?? 5));
      })
      .catch(() => {});

    // SUSCRIPCIÓN EN TIEMPO REAL: Recargar los chats procesados si cambian en Supabase
    const canalChats = supabase
      .channel('realtime:captura_procesados')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'chats' },
        async () => {
          console.log('[VPG-REALTIME] Cambio detectado en chats. Recargando procesados...');
          try {
            const { data } = await supabase.from('chats')
              .select('id, canal_chat_id, ia_historico_procesado')
              .eq('canal', 'whatsapp')
              .eq('ia_historico_procesado', true);
            const m = new Map<string, number>();
            (data ?? []).forEach((c: any) => { if (c.canal_chat_id) m.set(c.canal_chat_id, c.id); });
            setProcesadosPorJid(m);
          } catch (err) {
            console.error('[VPG-REALTIME] Error recargando procesados:', err);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(canalChats);
    };
  }, []);

  // Cargar mensajes del chat seleccionado para preview en panel derecho.
  // F1.20: NO setea ctx activo aquí — eso lo hace SOLO el módulo "Clientes".
  // M0 Captura es para preview/decidir qué procesar, no para selección global.
  useEffect(() => {
    if (!seleccionado) { setMensajes([]); return; }
    setCargandoMsgs(true);
    obtenerMensajes(seleccionado, 300).then(setMensajes).catch(() => setMensajes([])).finally(() => setCargandoMsgs(false));
  }, [seleccionado]);

  function recargar() {
    setCargando(true);
    listarChats().then(setChats).catch(e => setExtError(e.message)).finally(() => setCargando(false));
    // Recargar también qué chats están procesados en Supabase
    supabase.from('chats')
      .select('id, canal_chat_id, ia_historico_procesado')
      .eq('canal', 'whatsapp')
      .eq('ia_historico_procesado', true)
      .then(({ data }) => {
        const m = new Map<string, number>();
        (data ?? []).forEach((c: any) => { if (c.canal_chat_id) m.set(c.canal_chat_id, c.id); });
        setProcesadosPorJid(m);
      });
  }

  // Estadísticas globales
  const stats = useMemo(() => {
    const totalCaptura = chats.length;
    const bloqueados = chats.filter(c => c.bloqueado).length;
    const sospechosos = chats.filter(c => !c.bloqueado && c.no_cliente_score >= 2).length;
    const crudos = totalCaptura - bloqueados;
    const totalMsgs = chats.reduce((a, c) => a + c.stats.total, 0);
    const totalTexto = chats.reduce((a, c) => a + c.stats.texto, 0);
    const totalMedia = chats.reduce((a, c) => a + c.stats.imagen + c.stats.audio + c.stats.video + c.stats.documento, 0);
    // Costo proyectado de procesar TODOS los crudos (no bloqueados)
    const costoProyectado = chats
      .filter(c => !c.bloqueado && !c.isStatus)
      .reduce((a, c) => a + (c.stats.texto * costoTexto) + ((c.stats.imagen + c.stats.audio + c.stats.video + c.stats.documento) * costoMedia), 0);
    return { totalCaptura, crudos, bloqueados, sospechosos, totalMsgs, totalTexto, totalMedia, costoProyectado };
  }, [chats, costoTexto, costoMedia]);

  const filtrados = useMemo(() => {
    let arr = chats.filter(c => !c.isStatus);  // status@broadcast nunca se muestra
    if (filtro === 'crudos') arr = arr.filter(c => !c.bloqueado);
    else if (filtro === 'bloqueados') arr = arr.filter(c => c.bloqueado);
    else if (filtro === 'sospechosos') arr = arr.filter(c => !c.bloqueado && c.no_cliente_score >= 2);

    if (orden === 'reciente') {
      arr.sort((a, b) => {
        const tsA = Number(a.stats.last_ts) || 0;
        const tsB = Number(b.stats.last_ts) || 0;
        if (tsB !== tsA) return tsB - tsA;
        return (a.titulo || '').localeCompare(b.titulo || '');     // tiebreak alfabético
      });
    } else if (orden === 'volumen') {
      arr.sort((a, b) => (Number(b.stats.total) || 0) - (Number(a.stats.total) || 0));
    } else if (orden === 'antiguo') {
      arr.sort((a, b) => {
        const tsA = Number(a.stats.first_ts) || Number.MAX_SAFE_INTEGER;
        const tsB = Number(b.stats.first_ts) || Number.MAX_SAFE_INTEGER;
        return tsA - tsB;
      });
    }
    return arr;
  }, [chats, filtro, orden]);

  const chat = seleccionado ? chats.find(c => c.jid === seleccionado) : null;

  if (extError) {
    return (
      <div style={{ padding: 32 }}>
        <div style={{ background: '#ffe5e5', color: 'var(--red)', padding: 16, borderRadius: 8, fontSize: 13 }}>
          <strong>Extensión no disponible:</strong> {extError}<br /><br />
          <ul style={{ margin: '8px 0', paddingLeft: 20 }}>
            <li>Verificá que la extensión "Visor PG · Captura WhatsApp" esté cargada en Chrome</li>
            <li>Verificá que la versión sea ≥5.0.0</li>
            <li>Recargá esta página después de instalar/actualizar</li>
          </ul>
          <button onClick={() => window.location.reload()} style={btnPrim}>Reintentar</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>Captura</h1>
          <span style={{ fontSize: 10, padding: '2px 8px', background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase' }}>local · IndexedDB extensión</span>
          <button onClick={recargar} style={{ ...btnSec, marginLeft: 'auto' }}>↻ Recargar</button>
        </div>
        <p style={{ margin: '4px 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
          Todos los chats que la extensión sniffeó. Los datos están <strong>en local</strong> hasta que vos elijas <strong>Procesar</strong> (sube a Supabase + IA en un click) o <strong>Bloquear</strong>.
        </p>

        {feedback && (
          <div style={{ padding: 10, borderRadius: 6, fontSize: 12, marginBottom: 8,
            background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
            color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>
            {feedback.msg}
          </div>
        )}

        {/* KPIs globales */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          <KPI label="Captura local" valor={stats.totalCaptura} color="#1c1c1e" />
          <KPI label="Crudos sin procesar" valor={stats.crudos} color="var(--accent)" />
          <KPI label="Sospechosos NO-cliente" valor={stats.sospechosos} color="var(--orange)" />
          <KPI label="Bloqueados" valor={stats.bloqueados} color="var(--red)" />
          <div style={{ flex: 1 }} />
          <KPI label="Mensajes totales" valor={stats.totalMsgs.toLocaleString('es-CO')} color="#1c1c1e" />
          <KPI label="Costo proyectado todos" valor={`$${stats.costoProyectado.toFixed(2)}`} color={stats.costoProyectado > topeDiario ? 'var(--red)' : 'var(--green)'} subtitulo={`tope diario $${topeDiario.toFixed(2)}`} />
        </div>

        {/* Filtros */}
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
          <Chip label={`Crudos · ${chats.filter(c => !c.bloqueado && !c.isStatus).length}`} activo={filtro === 'crudos'} onClick={() => setFiltro('crudos')} color="var(--accent)" />
          <Chip label={`Sospechosos · ${stats.sospechosos}`} activo={filtro === 'sospechosos'} onClick={() => setFiltro('sospechosos')} color="var(--orange)" />
          <Chip label={`Bloqueados · ${stats.bloqueados}`} activo={filtro === 'bloqueados'} onClick={() => setFiltro('bloqueados')} color="var(--red)" />
          <Chip label={`Todos · ${chats.filter(c => !c.isStatus).length}`} activo={filtro === 'todos'} onClick={() => setFiltro('todos')} color="#1c1c1e" />
          <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--text-muted)' }}>Orden:</span>
          <select value={orden} onChange={e => setOrden(e.target.value as Orden)} style={{ padding: '4px 8px', fontSize: 11, border: '1px solid var(--border)', borderRadius: 6 }}>
            <option value="volumen">Mayor volumen</option>
            <option value="reciente">Más reciente</option>
            <option value="antiguo">Más antiguo</option>
          </select>
        </div>
      </div>

      {/* Layout 2 columnas */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden', borderTop: '1px solid var(--border-soft)' }}>
        {/* Lista */}
        <div style={{ width: 420, borderRight: '1px solid var(--border-soft)', overflow: 'auto', background: 'var(--bg-panel)' }}>
          {cargando && <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Cargando chats locales…</div>}
          {!cargando && filtrados.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>Sin chats con este filtro.</div>
          )}
          {filtrados.map(c => (
            <ChatRow key={c.jid} chat={c} activo={c.jid === seleccionado} onClick={() => setSeleccionado(c.jid)} costoTexto={costoTexto} costoMedia={costoMedia} />
          ))}
        </div>

        {/* Detalle */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {!chat && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, margin: 'auto' }}>
              Click en un chat de la lista para ver mensajes y stats. Después podés <strong>Procesar</strong> o <strong>Bloquear</strong>.
            </div>
          )}
          {chat && (
            <DetalleChat
              chat={chat} mensajes={mensajes} cargando={cargandoMsgs}
              costoTexto={costoTexto} costoMedia={costoMedia}
              chatIdDbProcesado={procesadosPorJid.get(chat.jid)}
              onProcesar={() => setModal({ tipo: 'procesar', chat })}
              onBloquear={() => setModal({ tipo: 'bloquear', chat })}
              onEliminar={() => setModal({ tipo: 'eliminar', chat })}
              onDesbloquear={async () => {
                try {
                  await desbloquearChatExt(chat.jid, 'desbloqueo manual');
                  setFeedback({ tipo: 'ok', msg: 'Chat desbloqueado' });
                  recargar();
                } catch (e: any) { setFeedback({ tipo: 'err', msg: e.message }); }
              }}
            />
          )}
        </div>
      </div>

      {modal?.tipo === 'procesar' && (
        <ModalProcesar chat={modal.chat} costoTexto={costoTexto} costoMedia={costoMedia} topeDiario={topeDiario}
          onClose={() => setModal(null)}
          onDone={(msg) => { setModal(null); setFeedback({ tipo: 'ok', msg }); recargar(); }}
          onError={(msg) => setFeedback({ tipo: 'err', msg })} />
      )}
      {modal?.tipo === 'bloquear' && (
        <ModalBloquear chat={modal.chat}
          onClose={() => setModal(null)}
          onDone={(msg) => { setModal(null); setFeedback({ tipo: 'ok', msg }); recargar(); }}
          onError={(msg) => setFeedback({ tipo: 'err', msg })} />
      )}
      {modal?.tipo === 'eliminar' && procesadosPorJid.get(modal.chat.jid) != null && (
        <ModalEliminar
          chat={modal.chat}
          chatIdDb={procesadosPorJid.get(modal.chat.jid)!}
          onClose={() => setModal(null)}
          onDone={(msg) => {
            // Si el chat/persona eliminado era el activo, limpiar el contexto para evitar id stale
            if (ctx.chatActivoId === procesadosPorJid.get(modal.chat.jid)) ctx.limpiar();
            setModal(null);
            setFeedback({ tipo: 'ok', msg });
            recargar();
          }}
          onError={(msg) => setFeedback({ tipo: 'err', msg })}
        />
      )}
    </div>
  );
}

// ─── Subcomponentes ────────────────────────────────────────────────

function KPI({ label, valor, color, subtitulo }: { label: string; valor: number | string; color: string; subtitulo?: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 100 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color }}>{valor}</div>
      {subtitulo && <div style={{ fontSize: 9, color: 'var(--text-muted)' }}>{subtitulo}</div>}
    </div>
  );
}

function Chip({ label, activo, onClick, color }: { label: string; activo: boolean; onClick: () => void; color: string }) {
  return (
    <button onClick={onClick} style={{
      padding: '4px 10px', fontSize: 11, fontWeight: 600,
      background: activo ? color : 'transparent',
      color: activo ? 'white' : color,
      border: `1px solid ${color}`, borderRadius: 12,
    }}>{label}</button>
  );
}

function ChatRow({ chat, activo, onClick, costoTexto, costoMedia }: {
  chat: ChatCaptura; activo: boolean; onClick: () => void; costoTexto: number; costoMedia: number;
}) {
  const costoEst = chat.stats.texto * costoTexto + (chat.stats.imagen + chat.stats.audio + chat.stats.video + chat.stats.documento) * costoMedia;
  const lastTs = chat.stats.last_ts;
  const fechaUlt = lastTs
    ? new Date(lastTs).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
    : '—';
  const initial = (chat.titulo || '').split(' ').filter(Boolean).map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '?';

  return (
    <button onClick={onClick} style={{
      width: '100%', textAlign: 'left',
      padding: '10px 14px',
      background: activo ? 'var(--accent-soft)' : 'transparent',
      border: 'none', borderBottom: '1px solid var(--border-soft)',
      borderLeft: chat.bloqueado ? '3px solid var(--red)' : (chat.no_cliente_score >= 2 ? '3px solid var(--orange)' : '3px solid transparent'),
      display: 'flex', gap: 10, alignItems: 'flex-start',
      opacity: chat.bloqueado ? 0.55 : 1,
    }}>
      <Avatar chat={chat} initial={initial} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
          <span style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{chat.titulo}</span>
          <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{fechaUlt}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 4, fontSize: 10, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
          <span><strong>{chat.stats.total}</strong> msgs</span>
          {chat.stats.texto > 0 && <span>· 💬 {chat.stats.texto}</span>}
          {chat.stats.audio > 0 && <span>· 🎙 {chat.stats.audio}</span>}
          {chat.stats.imagen > 0 && <span>· 📷 {chat.stats.imagen}</span>}
          {chat.stats.documento > 0 && <span>· 📄 {chat.stats.documento}</span>}
        </div>
        <div style={{ display: 'flex', gap: 4, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
          {chat.isGroup && <Tag color="#5856d6">grupo</Tag>}
          {chat.isBusiness && <Tag color="#34c759">negocio</Tag>}
          {chat.isAddressBook && <Tag color="#5ac8fa">en agenda</Tag>}
          {chat.bloqueado && <Tag color="var(--red)">🚫 bloqueado</Tag>}
          {chat.no_cliente_tags.map(tag => {
            const t = NO_CLIENTE_LABEL[tag];
            return t ? <Tag key={tag} color="var(--orange)">{t.emoji} {t.label}</Tag> : null;
          })}
          <span style={{ marginLeft: 'auto', fontSize: 9, color: costoEst > 0.05 ? 'var(--red)' : 'var(--text-muted)' }}>
            ~${costoEst.toFixed(4)}
          </span>
        </div>
      </div>
    </button>
  );
}

function Avatar({ chat, initial }: { chat: ChatCaptura; initial: string }) {
  const [error, setError] = useState(false);
  const fallback = (
    <div style={{
      width: 40, height: 40, flexShrink: 0,
      borderRadius: '50%', background: chat.isGroup ? '#5856d6' : 'var(--accent)',
      color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 13, fontWeight: 600,
    }}>{initial}</div>
  );
  if (!chat.profilePicUrl || error) return fallback;
  return (
    <img
      src={chat.profilePicUrl}
      alt={chat.titulo}
      onError={() => setError(true)}
      referrerPolicy="no-referrer"
      style={{
        width: 40, height: 40, flexShrink: 0,
        borderRadius: '50%', objectFit: 'cover',
        background: '#e5e5ea',
      }}
    />
  );
}

function Tag({ color, children }: { color: string; children: React.ReactNode }) {
  return <span style={{ fontSize: 9, fontWeight: 600, color, border: `1px solid ${color}`, padding: '1px 5px', borderRadius: 8 }}>{children}</span>;
}

function DetalleChat({ chat, mensajes, cargando, costoTexto, costoMedia, chatIdDbProcesado, onProcesar, onBloquear, onDesbloquear, onEliminar }: {
  chat: ChatCaptura; mensajes: MensajeCanonico[]; cargando: boolean;
  costoTexto: number; costoMedia: number;
  chatIdDbProcesado?: number;     // si está seteado, el chat ya fue procesado (existe en Supabase)
  onProcesar: () => void; onBloquear: () => void; onDesbloquear: () => void; onEliminar: () => void;
}) {
  const costoEst = chat.stats.texto * costoTexto + (chat.stats.imagen + chat.stats.audio + chat.stats.video + chat.stats.documento) * costoMedia;
  const initial = (chat.titulo || '').split(' ').filter(Boolean).map(s => s[0] || '').join('').slice(0, 2).toUpperCase() || '?';
  const yaProcesado = chatIdDbProcesado != null;
  return (
    <>
      <div style={{ padding: '10px 16px', background: 'var(--bg-panel)', borderBottom: '1px solid var(--border-soft)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar chat={chat} initial={initial} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {chat.titulo}
              {chat.isBusiness && <span style={{ fontSize: 9, fontWeight: 600, color: '#34c759', border: '1px solid #34c759', padding: '1px 5px', borderRadius: 8, marginLeft: 6 }}>NEGOCIO</span>}
              {yaProcesado && <span style={{ fontSize: 9, fontWeight: 600, color: 'var(--green)', border: '1px solid var(--green)', padding: '1px 5px', borderRadius: 8, marginLeft: 6 }}>PROCESADO</span>}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {chat.phoneNumber || chat.jid} · {chat.isGroup ? 'GRUPO' : 'individual'} · <strong>{chat.stats.total}</strong> mensajes · {chat.stats.entrantes}↓ {chat.stats.salientes}↑ ({chat.stats.pct_entrante}% entrantes)
            </div>
            {chat.no_cliente_tags.length > 0 && (
              <div style={{ marginTop: 4, fontSize: 10, color: 'var(--orange)' }}>
                ⚠ posible NO-cliente: {chat.no_cliente_tags.map(t => NO_CLIENTE_LABEL[t]?.label || t).join(', ')}
              </div>
            )}
          </div>
          {chat.bloqueado ? (
            <button onClick={onDesbloquear} style={btnSec}>Desbloquear</button>
          ) : yaProcesado ? (
            <>
              <button onClick={onEliminar} style={btnDanger} title="Borra este chat de Supabase para poder re-procesarlo limpio. La extensión conserva los mensajes en local.">
                🗑 Eliminar y re-procesar
              </button>
            </>
          ) : (
            <>
              <button onClick={onBloquear} style={btnDanger}>🚫 Bloquear</button>
              <button onClick={onProcesar} style={btnPrim}>▶ Procesar (~${costoEst.toFixed(4)})</button>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflow: 'auto', padding: 16, background: '#ece5dd' }}>
        {cargando && <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, marginTop: 40 }}>Cargando mensajes…</div>}
        {!cargando && mensajes.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 12, marginTop: 40 }}>Sin mensajes aún en este chat.</div>
        )}
        {mensajes.map(m => {
          const ts = m.timestamp_ms ? new Date(m.timestamp_ms) : null;
          const txt = m.text ?? m.caption ?? `[${m.type}]`;
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: m.is_owner ? 'flex-end' : 'flex-start', marginBottom: 6 }}>
              <div style={{
                maxWidth: '70%', padding: '6px 10px',
                background: m.is_owner ? '#dcf8c6' : 'white',
                borderRadius: 8, boxShadow: 'var(--shadow-sm)', fontSize: 13,
              }}>
                {(m.type === 'image' || m.type === 'video' || m.type === 'audio' || m.type === 'ptt' || m.type === 'document') && (
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', marginBottom: 2 }}>
                    [{m.type}{m.mimetype ? ` · ${m.mimetype.split('/')[1]}` : ''}]
                  </div>
                )}
                <div>{txt}</div>
                {ts && <div style={{ fontSize: 10, color: 'var(--text-muted)', textAlign: 'right', marginTop: 2 }}>{ts.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ─── Modales ───────────────────────────────────────────────────────

function ModalProcesar({ chat, costoTexto, costoMedia, topeDiario, onClose, onDone, onError }: {
  chat: ChatCaptura; costoTexto: number; costoMedia: number; topeDiario: number;
  onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [aplicando, setAplicando] = useState(false);
  const costoEst = chat.stats.texto * costoTexto + (chat.stats.imagen + chat.stats.audio + chat.stats.video + chat.stats.documento) * costoMedia;
  const exceedeTope = costoEst > topeDiario;

  async function confirmar() {
    setAplicando(true);
    try {
      const r = await procesarChat(chat.jid);
      onDone(`✓ ${r.mensajes_subidos} mensajes subidos · ${r.eventos_creados} eventos creados`);
    } catch (e: any) {
      onError(e.message);
      setAplicando(false);
    }
  }

  return (
    <ModalBase onClose={onClose} title={`Procesar "${chat.titulo}"`}>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        Subimos los <strong>{chat.stats.total}</strong> mensajes a Supabase y los pasamos por identidad. Aparecen después en el módulo Núcleo.
      </p>

      <div style={{ background: 'var(--bg-page)', padding: 12, borderRadius: 6, fontSize: 12, marginBottom: 12 }}>
        <Linea label="Total mensajes" valor={String(chat.stats.total)} />
        <Linea label="Texto" valor={String(chat.stats.texto)} />
        <Linea label="Audios (PTT y adjuntos)" valor={String(chat.stats.audio)} />
        <Linea label="Imágenes" valor={String(chat.stats.imagen)} />
        <Linea label="Documentos" valor={String(chat.stats.documento)} />
        <Linea label="Videos" valor={String(chat.stats.video)} />
        <Linea label="% entrantes" valor={`${chat.stats.pct_entrante}%`} />
        <div style={{ borderTop: '1px solid var(--border-soft)', marginTop: 8, paddingTop: 8 }}>
          <Linea label={<strong>Costo estimado</strong>} valor={
            <strong style={{ color: exceedeTope ? 'var(--red)' : 'var(--green)' }}>${costoEst.toFixed(4)} USD</strong>
          } />
        </div>
      </div>

      {exceedeTope && (
        <div style={{ padding: 10, background: '#fff3cd', color: '#856404', borderRadius: 6, fontSize: 11, marginBottom: 12 }}>
          ⚠ Excede el tope diario (${topeDiario.toFixed(2)}). Se procesa igual (tope blando), pero Junior lo registrará en alertas.
        </div>
      )}

      {chat.no_cliente_tags.length > 0 && (
        <div style={{ padding: 10, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 11, marginBottom: 12 }}>
          ⚠ <strong>Posible NO-cliente:</strong> {chat.no_cliente_tags.map(t => NO_CLIENTE_LABEL[t]?.label || t).join(', ')}. ¿Estás seguro?
        </div>
      )}

      <div style={{ padding: 10, background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 6, fontSize: 11, marginBottom: 16 }}>
        Los agentes IA llegarán en MÓDULO 2. Por ahora confirmar marca el chat como autorizado y registra la intención. El costo real se cobrará cuando los agentes estén activos.
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={confirmar} disabled={aplicando} style={{ ...btnPrim, opacity: aplicando ? 0.5 : 1 }}>
          {aplicando ? 'Procesando…' : '✓ Confirmar y procesar'}
        </button>
      </div>
    </ModalBase>
  );
}

function ModalBloquear({ chat, onClose, onDone, onError }: {
  chat: ChatCaptura;
  onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [motivo, setMotivo] = useState(chat.no_cliente_tags.length > 0 ? `${chat.no_cliente_tags[0]} (auto-detectado)` : '');
  const [aplicando, setAplicando] = useState(false);

  async function confirmar() {
    if (!motivo.trim()) return;
    setAplicando(true);
    try {
      await bloquearChatExt(chat.jid, motivo.trim(), chat.titulo);
      onDone(`Chat "${chat.titulo}" bloqueado`);
    } catch (e: any) {
      onError(e.message);
      setAplicando(false);
    }
  }

  return (
    <ModalBase onClose={onClose} title={`🚫 Bloquear de IA: ${chat.titulo}`}>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        Este chat NUNCA se procesará con IA, ni siquiera en modo automático. Sigue capturándose en local pero no llega a Supabase.
        El bloqueo persiste en BD aunque reinstales la extensión.
      </p>
      <label style={{ fontSize: 11, fontWeight: 600, display: 'block', marginBottom: 4, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Motivo (obligatorio)</label>
      <input
        type="text" value={motivo} onChange={e => setMotivo(e.target.value)}
        placeholder="ej: spam, restaurante, número equivocado, ex-cliente"
        style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6 }}
        autoFocus
      />
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button onClick={confirmar} disabled={aplicando || !motivo.trim()} style={{ ...btnDanger, opacity: aplicando || !motivo.trim() ? 0.5 : 1 }}>
          {aplicando ? 'Bloqueando…' : '🚫 Bloquear'}
        </button>
      </div>
    </ModalBase>
  );
}

function ModalEliminar({ chat, chatIdDb, onClose, onDone, onError }: {
  chat: ChatCaptura; chatIdDb: number;
  onClose: () => void; onDone: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [preview, setPreview] = useState<PreviewEliminarChat | null>(null);
  const [cargandoPreview, setCargandoPreview] = useState(true);
  const [aplicando, setAplicando] = useState(false);
  const [confirmacionTexto, setConfirmacionTexto] = useState('');

  useEffect(() => {
    previewEliminarChat(chatIdDb)
      .then(setPreview)
      .catch(e => onError(e.message))
      .finally(() => setCargandoPreview(false));
  }, [chatIdDb]);

  async function confirmar() {
    if (confirmacionTexto.trim().toLowerCase() !== 'eliminar') return;
    setAplicando(true);
    try {
      const r: ResultadoEliminarChat = await eliminarChatProcesado(chatIdDb);
      const partes = [
        `${r.mensajes_borrados} mensajes`,
        `${r.eventos_borrados} eventos`,
      ];
      if (r.proyectos_borrados > 0) partes.push(`${r.proyectos_borrados} proyecto`);
      if (r.personas_borradas > 0) partes.push(`${r.personas_borradas} persona`);
      if (r.inmuebles_borrados > 0) partes.push(`${r.inmuebles_borrados} inmueble`);
      onDone(`Chat "${chat.titulo}" eliminado · ${partes.join(' · ')}. Ya podés re-procesarlo.`);
    } catch (e: any) {
      onError(e.message);
      setAplicando(false);
    }
  }

  return (
    <ModalBase onClose={onClose} title={`🗑 Eliminar chat procesado: ${chat.titulo}`}>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--text-muted)' }}>
        Borra todo lo que el procesamiento creó en Supabase para este chat (mensajes, eventos, transcripciones, persona/proyecto/inmueble si quedan huérfanos).
        La extensión <strong>conserva los mensajes en local</strong>, así que después podés volver a darle <strong>Procesar</strong> con el estado limpio.
      </p>

      {cargandoPreview && <div style={{ padding: 12, color: 'var(--text-muted)', fontSize: 12 }}>Calculando impacto…</div>}

      {preview && (
        <div style={{ background: '#fff7ed', border: '1px solid #fb923c', borderRadius: 6, padding: 12, marginBottom: 12, fontSize: 12 }}>
          <div style={{ marginBottom: 6, fontWeight: 600 }}>Se borrará:</div>
          <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
            <li><strong>{preview.mensajes}</strong> mensajes</li>
            <li><strong>{preview.eventos}</strong> eventos en evento_pg</li>
            <li><strong>1</strong> chat (id={preview.chat_id}, jid={preview.jid?.slice(0, 30)}…)</li>
            {preview.proyecto_se_borra && <li><strong>1</strong> proyecto huérfano (id={preview.proyecto_id})</li>}
            {preview.persona_se_borra && <li><strong>1</strong> persona huérfana (id={preview.persona_id})</li>}
            {preview.inmueble_se_borra && <li><strong>1</strong> inmueble huérfano (id={preview.inmueble_id})</li>}
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
        type="text" value={confirmacionTexto} onChange={e => setConfirmacionTexto(e.target.value)}
        placeholder="eliminar"
        style={{ width: '100%', padding: '8px 10px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6 }}
        autoFocus
      />

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button onClick={onClose} style={btnSec}>Cancelar</button>
        <button
          onClick={confirmar}
          disabled={aplicando || confirmacionTexto.trim().toLowerCase() !== 'eliminar' || cargandoPreview}
          style={{ ...btnDanger, background: confirmacionTexto.trim().toLowerCase() === 'eliminar' && !aplicando ? 'var(--red)' : 'white', color: confirmacionTexto.trim().toLowerCase() === 'eliminar' && !aplicando ? 'white' : 'var(--red)', opacity: aplicando || confirmacionTexto.trim().toLowerCase() !== 'eliminar' || cargandoPreview ? 0.5 : 1 }}
        >
          {aplicando ? 'Eliminando…' : '🗑 Eliminar definitivo'}
        </button>
      </div>
    </ModalBase>
  );
}

function ModalBase({ children, onClose, title }: { children: React.ReactNode; onClose: () => void; title: string }) {
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: 'white', borderRadius: 12, padding: 24, maxWidth: 520, width: '90%',
        maxHeight: '85vh', overflow: 'auto', boxShadow: '0 20px 50px rgba(0,0,0,0.2)',
      }}>
        <h2 style={{ margin: '0 0 16px', fontSize: 17, fontWeight: 700 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Linea({ label, valor }: { label: React.ReactNode; valor: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 13 }}>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span>{valor}</span>
    </div>
  );
}

const btnPrim: React.CSSProperties = { padding: '7px 12px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', border: 'none', borderRadius: 6, color: 'white', cursor: 'pointer' };
const btnSec: React.CSSProperties = { padding: '7px 12px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text)', cursor: 'pointer' };
const btnDanger: React.CSSProperties = { padding: '7px 12px', fontSize: 12, fontWeight: 600, background: 'white', border: '1px solid var(--red)', borderRadius: 6, color: 'var(--red)', cursor: 'pointer' };
