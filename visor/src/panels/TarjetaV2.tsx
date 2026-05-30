/**
 * TARJETA V2 — vista REAL (Hito 1).
 *
 * Lee de las tablas V2 (tarjeta + tarjeta_checklist/tarea/agenda) que mantiene
 * el worker de tarjetas. El input de notas escribe en notas_libres y marca la
 * tarjeta dirty → el worker la rehace → el auto-refresh (5s) muestra el cambio.
 *
 * Foco Hito 1: que el FLUJO funcione (no la calidad del contenido).
 */
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { linkifyTelefonos } from '../lib/linkify';

type EstadoConv = 'cerrado' | 'espera_jhon' | 'espera_cliente' | 'sin_responder';
interface ModuloCtx { modulo: string; titulo: string; sintesis: string; alerta: string | null }
interface TarjetaRow {
  chat_id: number; persona_id: number | null; tipo_contacto: string;
  narrativa: string | null; notas: string[]; contexto: ModuloCtx[];
  actualizado_at: string; dirty: boolean; personas: { nombre: string | null } | null;
}
interface Checklist { chat_id: number; estado_conversacion: EstadoConv; proximo_paso: string | null }
interface Tarea { id: number; titulo: string; prioridad: number }
interface Agenda { id: number; titulo: string; cuando: string; lugar: string }
interface AgCanon { id: number; titulo: string; tipo: string | null; fecha: string | null; hora_inicio: string | null; direccion: string | null; origen: string | null }
interface MediaRow { id: number; tipo: string; direccion: 'entrante' | 'saliente'; ts_canal: string; metadata: any }

const TIPO_META: Record<string, { label: string; color: string }> = {
  comercial:        { label: '💼 Comercial',  color: '#2563eb' },
  proveedor:        { label: '🏭 Proveedor',  color: '#d97706' },
  personal_familia: { label: '👪 Familia',    color: '#16a34a' },
  personal_amigos:  { label: '🤝 Amigos',     color: '#0891b2' },
  personal_otros:   { label: '👤 Personal',   color: '#6b7280' },
  interno_equipo:   { label: '🛠 Equipo',     color: '#7c3aed' },
  familiar:         { label: '👪 Familiar',   color: '#16a34a' },  // legacy
  publicitario:     { label: '📣 Publicitario', color: '#7c3aed' }, // legacy
  desconocido:      { label: '❔ Desconocido', color: '#6b7280' },
};
const ESTADO_META: Record<EstadoConv, { label: string; punto: string; color: string }> = {
  cerrado: { label: 'Cerrado', punto: '🟢', color: '#16a34a' },
  espera_jhon: { label: 'Espera que vos contestes', punto: '🟠', color: '#ea580c' },
  espera_cliente: { label: 'Espera al cliente', punto: '🔵', color: '#2563eb' },
  sin_responder: { label: 'Sin responder', punto: '🔴', color: '#dc2626' },
};
const tipoMeta = (t: string) => TIPO_META[t] ?? TIPO_META.desconocido;
const nombreDe = (t: TarjetaRow) => t.personas?.nombre || `Chat #${t.chat_id}`;
// Placeholder de contactos @lid que WA Web no logró resolver (FASE 9.1).
const esSinIdentificar = (t: TarjetaRow) => {
  const n = (t.personas?.nombre ?? '').trim();
  return n.startsWith('⏳') || /^identificando/i.test(n);
};
function hace(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'recién'; if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`; return `hace ${Math.floor(s / 86400)} d`;
}

export function TarjetaV2() {
  const [lista, setLista] = useState<TarjetaRow[]>([]);
  const [checklists, setChecklists] = useState<Record<number, Checklist>>({});
  const [sel, setSel] = useState<number | null>(null);
  const [chkSel, setChkSel] = useState<Checklist | null>(null);
  const [tareas, setTareas] = useState<Tarea[]>([]);
  const [agenda, setAgenda] = useState<Agenda[]>([]);
  const [borrador, setBorrador] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [cargado, setCargado] = useState(false);
  const [media, setMedia] = useState<MediaRow[]>([]);
  const [reprocesando, setReprocesando] = useState<number | null>(null);
  const [filtroEstado, setFiltroEstado] = useState<'activos' | 'cerrados' | 'todos'>('activos');
  const [filtroTipo, setFiltroTipo] = useState<string | null>(null); // null = todos
  const [verSinIdentificar, setVerSinIdentificar] = useState(false);
  const [agCanon, setAgCanon] = useState<AgCanon[]>([]);
  const [editandoAg, setEditandoAg] = useState<number | null>(null);
  const [editFecha, setEditFecha] = useState('');
  const [editHora, setEditHora] = useState('');
  // Chat con Junior V2 (lee solo las tarjetas relevantes)
  const [jPregunta, setJPregunta] = useState('');
  const [jResp, setJResp] = useState<{ respuesta: string; tarjetas_usadas: number[]; via_indice: boolean; costo_usd: number } | null>(null);
  const [jCargando, setJCargando] = useState(false);

  async function preguntarJunior() {
    if (!jPregunta.trim() || jCargando) return;
    setJCargando(true); setJResp(null);
    try {
      const res = await fetch('/api/junior-v2', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pregunta: jPregunta.trim() }),
      });
      const data = await res.json();
      setJResp(data.error ? { respuesta: 'Error: ' + data.error, tarjetas_usadas: [], via_indice: false, costo_usd: 0 } : data);
    } catch (e: any) {
      setJResp({ respuesta: 'Error de red: ' + e.message, tarjetas_usadas: [], via_indice: false, costo_usd: 0 });
    } finally { setJCargando(false); }
  }

  const cargarLista = useCallback(async () => {
    const { data } = await supabase.from('tarjeta')
      .select('chat_id, persona_id, tipo_contacto, narrativa, notas, contexto, actualizado_at, dirty, personas(nombre)')
      .order('actualizado_at', { ascending: false });
    const rows = (data as any as TarjetaRow[]) ?? [];
    setLista(rows);
    const { data: cks } = await supabase.from('tarjeta_checklist').select('chat_id, estado_conversacion, proximo_paso');
    const map: Record<number, Checklist> = {};
    for (const c of (cks as any as Checklist[]) ?? []) map[c.chat_id] = c;
    setChecklists(map);
    setCargado(true);
    return rows;
  }, []);

  const cargarDerivados = useCallback(async (chatId: number) => {
    const { data: ck } = await supabase.from('tarjeta_checklist').select('*').eq('chat_id', chatId).maybeSingle();
    setChkSel((ck as any) ?? null);
    const { data: tr } = await supabase.from('tarjeta_tarea').select('*').eq('chat_id', chatId).order('prioridad');
    setTareas((tr as any) ?? []);
    const { data: ag } = await supabase.from('tarjeta_agenda').select('*').eq('chat_id', chatId);
    setAgenda((ag as any) ?? []);
    // Agendamientos canónicos del PERSONA (no del chat) — editables.
    const { data: tj } = await supabase.from('tarjeta').select('persona_id').eq('chat_id', chatId).maybeSingle();
    const pid = (tj as any)?.persona_id;
    if (pid) {
      const { data: ags } = await supabase.from('agendamientos')
        .select('id, titulo, tipo, fecha, hora_inicio, direccion, origen')
        .eq('persona_id', pid).order('fecha', { ascending: true });
      setAgCanon((ags as any) ?? []);
    } else { setAgCanon([]); }
    const { data: md } = await supabase.from('mensajes')
      .select('id, tipo, direccion, ts_canal, metadata')
      .eq('chat_id', chatId).in('tipo', ['imagen','audio','documento','video'])
      .is('deleted_at', null).order('ts_canal', { ascending: false }).limit(30);
    setMedia((md as any) ?? []);
  }, []);

  function iniciarEdit(ag: AgCanon) {
    setEditandoAg(ag.id);
    setEditFecha(ag.fecha ?? '');
    setEditHora((ag.hora_inicio ?? '').slice(0, 5)); // HH:MM
  }
  function cancelarEdit() { setEditandoAg(null); }
  async function guardarEdit(ag: AgCanon) {
    if (!editFecha) return;
    const nuevaFecha = editFecha;
    const nuevaHora = editHora ? `${editHora}:00` : null;
    const viejaFecha = ag.fecha ?? 'sin fecha';
    const viejaHora = (ag.hora_inicio ?? '').slice(0, 5) || 'sin hora';
    const nueva = `${nuevaFecha}${nuevaHora ? ' ' + nuevaHora.slice(0,5) : ''}`;
    const vieja = `${viejaFecha}${viejaHora !== 'sin hora' ? ' ' + viejaHora : ''}`;
    // 1) PATCH agendamiento — origen='manual_edit' protege contra el delete+insert del agente.
    await supabase.from('agendamientos').update({
      fecha: nuevaFecha, hora_inicio: nuevaHora, origen: 'manual_edit',
    } as any).eq('id', ag.id);
    // 2) Nota para que la próxima síntesis (agregador + derivados) honre el cambio.
    if (t?.persona_id) {
      await supabase.from('notas_libres').insert({
        persona_id: t.persona_id,
        contenido: `Agenda actualizada por Jhon: "${ag.titulo}" reprogramado de ${vieja} a ${nueva}.`,
        visible_para: ['todos'], creado_por: 1,
      } as any);
      await supabase.from('personas').update({ sintesis_pendiente: true } as any).eq('id', t.persona_id);
    }
    // 3) Marcar tarjeta dirty (PK chat_id) → cicloTarjetas la regenera.
    if (sel != null) await supabase.from('tarjeta').update({ dirty: true } as any).eq('chat_id', sel);
    setEditandoAg(null);
    if (sel != null) await cargarDerivados(sel);
  }

  async function reprocesarMedia(body: { message_id?: number; chat_id?: number }) {
    const key = body.message_id ?? -1;
    setReprocesando(key);
    try {
      const res = await fetch('/api/reprocesar-media', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) alert('Error: ' + data.error);
      else if (sel != null) await cargarDerivados(sel);
    } finally { setReprocesando(null); }
  }

  useEffect(() => {
    let cancel = false;
    (async () => { const rows = await cargarLista(); if (!cancel) setSel(s => s ?? rows[0]?.chat_id ?? null); })();
    const t = setInterval(cargarLista, 5000);
    return () => { cancel = true; clearInterval(t); };
  }, [cargarLista]);

  useEffect(() => {
    if (sel == null) return;
    cargarDerivados(sel);
    const t = setInterval(() => cargarDerivados(sel), 5000);
    return () => clearInterval(t);
  }, [sel, cargarDerivados]);

  const t = lista.find(x => x.chat_id === sel) ?? null;

  // Si los filtros dejan afuera a la tarjeta seleccionada, saltar a la primera visible.
  useEffect(() => {
    if (sel == null) return;
    const visible = lista.filter(x => {
      const est = checklists[x.chat_id]?.estado_conversacion;
      if (filtroEstado === 'cerrados' && est !== 'cerrado') return false;
      if (filtroEstado === 'activos'  && est === 'cerrado') return false;
      if (filtroTipo && x.tipo_contacto !== filtroTipo) return false;
      if (!verSinIdentificar && esSinIdentificar(x)) return false;
      return true;
    });
    if (!visible.some(x => x.chat_id === sel)) setSel(visible[0]?.chat_id ?? null);
  }, [filtroEstado, filtroTipo, verSinIdentificar, lista, checklists, sel]);


  async function guardarNota() {
    if (!t?.persona_id || !borrador.trim()) return;
    setGuardando(true);
    try {
      await supabase.from('notas_libres').insert({ persona_id: t.persona_id, contenido: borrador.trim(), visible_para: ['todos'], creado_por: 1 });
      await supabase.from('personas').update({ sintesis_pendiente: true }).eq('id', t.persona_id);
      await supabase.from('tarjeta').update({ dirty: true }).eq('chat_id', t.chat_id);
      setBorrador('');
      await cargarLista();
    } finally { setGuardando(false); }
  }

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '18px 24px', maxWidth: 1100, margin: '0 auto' }}>
      <div style={{ background: '#eef6ff', border: '1px solid #bcdcff', borderRadius: 10, padding: '8px 14px', marginBottom: 16, fontSize: 12, color: '#0c4a6e' }}>
        🃏 <strong>Tarjeta V2 — datos reales.</strong> Las mantiene el worker de tarjetas. Agregá una nota abajo: marca la tarjeta para rehacerse y en unos segundos vas a ver cómo cambian narrativa, checklist, tareas y agenda. (Refresco automático cada 5s.)
      </div>

      {/* Chat con Junior — lee SOLO las tarjetas relevantes, no las 81 */}
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderTop: '3px solid #5856d6', borderRadius: 12, padding: '14px 16px', marginBottom: 18, boxShadow: 'var(--shadow-sm)' }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>💬 Preguntale a Junior</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={jPregunta} onChange={e => setJPregunta(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') preguntarJunior(); }}
            placeholder="ej: ¿qué pasa con Pedidos Cubides? · ¿quién espera mi respuesta?" disabled={jCargando}
            style={{ flex: 1, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }} />
          <button onClick={preguntarJunior} disabled={jCargando || !jPregunta.trim()} style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: jCargando ? '#9ca3af' : '#5856d6', color: 'white', fontWeight: 600, fontSize: 13 }}>
            {jCargando ? 'Pensando…' : 'Preguntar'}
          </button>
        </div>
        {jResp && (
          <div style={{ marginTop: 10, background: 'var(--bg-page)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{linkifyTelefonos(jResp.respuesta)}</div>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
              {jResp.via_indice
                ? '· respondió con el índice (sin leer tarjetas en detalle)'
                : `· leyó ${jResp.tarjetas_usadas.length} tarjeta(s): ${jResp.tarjetas_usadas.map(c => `chat ${c}`).join(', ') || '—'}`}
              {' · '}${jResp.costo_usd.toFixed(4)}
            </div>
          </div>
        )}
      </div>

      {cargado && lista.length === 0 && (
        <div style={{ textAlign: 'center', padding: '50px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>⏳</div>
          <p style={{ fontSize: 13 }}>Todavía no hay tarjetas. El worker (<code>worker_tarjetas</code>) las arma solo; esperá unos segundos y refrescá.</p>
        </div>
      )}

      {lista.length > 0 && (() => {
        // 1er filtro: estado del checklist.
        const tras1 = lista.filter(x => {
          const est = checklists[x.chat_id]?.estado_conversacion;
          if (filtroEstado === 'cerrados') return est === 'cerrado';
          if (filtroEstado === 'activos') return est !== 'cerrado';
          return true;
        });
        // 2do filtro: tipo_contacto (sobre el resultado del 1ro, así los conteos del 2do
        // reflejan lo realmente disponible).
        const tras2 = filtroTipo ? tras1.filter(x => x.tipo_contacto === filtroTipo) : tras1;
        // 3er filtro: ocultar placeholders "⏳ Identificando…" salvo que verSinIdentificar.
        const sinIdentificarN = tras2.filter(esSinIdentificar).length;
        const listaFiltrada = verSinIdentificar ? tras2 : tras2.filter(x => !esSinIdentificar(x));
        // Conteos para chips estado (sobre TODA la lista — los counts no dependen del tipo).
        const cerradas = lista.filter(x => checklists[x.chat_id]?.estado_conversacion === 'cerrado').length;
        const activas = lista.length - cerradas;
        // Tipos presentes en tras1 + sus conteos (chips de tipo se acotan al estado activo).
        const tipoCount = new Map<string, number>();
        for (const x of tras1) tipoCount.set(x.tipo_contacto, (tipoCount.get(x.tipo_contacto) ?? 0) + 1);
        const tiposPresentes = [...tipoCount.entries()].sort((a, b) => b[1] - a[1]);
        const chipEstado = (id: 'activos' | 'cerrados' | 'todos', label: string, n: number) => (
          <button key={id} onClick={() => setFiltroEstado(id)} style={{
            padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: filtroEstado === id ? 'var(--accent)' : 'transparent',
            color: filtroEstado === id ? 'white' : 'var(--text-muted)',
            border: `1px solid ${filtroEstado === id ? 'var(--accent)' : 'var(--border)'}`,
            cursor: 'pointer',
          }}>{label} ({n})</button>
        );
        const chipTipo = (id: string | null, label: string, n: number, col?: string) => (
          <button key={id ?? '_all'} onClick={() => setFiltroTipo(id)} style={{
            padding: '6px 12px', borderRadius: 999, fontSize: 12, fontWeight: 600,
            background: filtroTipo === id ? (col ?? 'var(--accent)') : 'transparent',
            color: filtroTipo === id ? 'white' : 'var(--text-muted)',
            border: `1px solid ${filtroTipo === id ? (col ?? 'var(--accent)') : 'var(--border)'}`,
            cursor: 'pointer',
          }}>{label} ({n})</button>
        );
        return (
        <>
          {/* Filtro por estado */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, minWidth: 50 }}>Estado:</span>
            {chipEstado('activos',  '🔥 Activos',  activas)}
            {chipEstado('cerrados', '✅ Cerrados', cerradas)}
            {chipEstado('todos',    'Todos',       lista.length)}
          </div>
          {/* Filtro por tipo de contacto */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, minWidth: 50 }}>Tipo:</span>
            {chipTipo(null, 'Todos', tras1.length)}
            {tiposPresentes.map(([tipo, n]) => {
              const tm = tipoMeta(tipo);
              return chipTipo(tipo, tm.label, n, tm.color);
            })}
            {sinIdentificarN > 0 && (
              <button onClick={() => setVerSinIdentificar(v => !v)} title="Contactos @lid que la extensión no logró identificar — generalmente destinatarios sin nombre en tu libreta" style={{
                marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)', background: 'transparent',
                border: '1px dashed var(--border-soft)', borderRadius: 6, padding: '4px 8px', cursor: 'pointer',
              }}>
                {verSinIdentificar ? `✕ ocultar ${sinIdentificarN} sin identificar` : `+ ${sinIdentificarN} sin identificar`}
              </button>
            )}
          </div>
          {/* Selector de tarjetas */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            {listaFiltrada.length === 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: '6px 0' }}>
                — Sin tarjetas en este filtro
              </div>
            )}
            {listaFiltrada.map(x => {
              const tm = tipoMeta(x.tipo_contacto);
              const est = checklists[x.chat_id]?.estado_conversacion;
              const punto = est ? ESTADO_META[est].punto : '⚪';
              return (
                <button key={x.chat_id} onClick={() => setSel(x.chat_id)} style={{
                  display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 999, fontSize: 12,
                  background: x.chat_id === sel ? tm.color : 'var(--bg-panel)', color: x.chat_id === sel ? 'white' : 'var(--text)',
                  border: `1px solid ${x.chat_id === sel ? tm.color : 'var(--border-soft)'}`,
                }}>{punto} {nombreDe(x)}</button>
              );
            })}
          </div>

          {t && (
            <>
              <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderTop: `3px solid ${chkSel ? ESTADO_META[chkSel.estado_conversacion].color : '#999'}`, borderRadius: 12, padding: '16px 18px', boxShadow: 'var(--shadow-sm)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0, fontSize: 20 }}>{nombreDe(t)}</h2>
                  <Chip texto={tipoMeta(t.tipo_contacto).label} color={tipoMeta(t.tipo_contacto).color} />
                  {chkSel && <Chip texto={`${ESTADO_META[chkSel.estado_conversacion].punto} ${ESTADO_META[chkSel.estado_conversacion].label}`} color={ESTADO_META[chkSel.estado_conversacion].color} />}
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
                    chat #{t.chat_id} · {hace(t.actualizado_at)}{t.dirty ? ' · 🔄 actualizando…' : ''}
                  </span>
                </div>

                <Seccion icono="🧠" titulo="Estado general" sub="narrativa del agregador">
                  <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55 }}>{t.narrativa || '(sin narrativa todavía)'}</p>
                </Seccion>

                <Seccion icono="📝" titulo="Notas libres" sub="verdad humana — al guardar, la tarjeta se rehace">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                    {(t.notas ?? []).length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>— sin notas</div>}
                    {(t.notas ?? []).map((n, i) => (
                      <div key={i} style={{ background: 'var(--bg-page)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '7px 11px', fontSize: 13 }}>{n}</div>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input value={borrador} onChange={e => setBorrador(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') guardarNota(); }}
                      placeholder="Escribí una nota y Enter…" disabled={guardando}
                      style={{ flex: 1, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13 }} />
                    <button onClick={guardarNota} disabled={guardando || !borrador.trim()} style={{ padding: '9px 16px', borderRadius: 8, border: 'none', background: guardando ? '#9ca3af' : 'var(--accent)', color: 'white', fontWeight: 600, fontSize: 13 }}>
                      {guardando ? 'Guardando…' : 'Guardar nota'}
                    </button>
                  </div>
                </Seccion>

                <Seccion icono="🗂" titulo="Contexto estructurado" sub={`${(t.contexto ?? []).length} módulos · verbatim de los 32 agentes`}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                    {(t.contexto ?? []).map(c => (
                      <div key={c.modulo} style={{ background: 'var(--bg-page)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '9px 12px' }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 5 }}>{c.modulo} · {c.titulo}</div>
                        <div style={{ fontSize: 13 }}>{c.sintesis}</div>
                        {c.alerta && <div style={{ fontSize: 12, color: '#d97706', marginTop: 4 }}>⚠ {c.alerta}</div>}
                      </div>
                    ))}
                    {(t.contexto ?? []).length === 0 && <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>(sin síntesis por módulo todavía)</div>}
                  </div>
                </Seccion>

                {media.length > 0 && (() => {
                  const pendientes = media.filter(m => {
                    const s = m.metadata?.ai_status;
                    return s !== 'processed' && s !== 'skipped_cdn_lost';
                  });
                  return (
                    <Seccion icono="📎" titulo="Media" sub={`${media.length} archivos · ${pendientes.length} sin transcribir`}>
                      {pendientes.length > 0 && (
                        <div style={{ marginBottom: 10 }}>
                          <button
                            onClick={() => reprocesarMedia({ chat_id: t.chat_id })}
                            disabled={reprocesando !== null}
                            style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: '#d97706', color: 'white', fontWeight: 600, fontSize: 12, cursor: 'pointer' }}
                          >
                            🔄 Reprocesar los {pendientes.length} pendientes
                          </button>
                        </div>
                      )}
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 8 }}>
                        {media.map(m => {
                          const md = m.metadata ?? {};
                          const procesado = md.ai_status === 'processed';
                          const perdido = md.ai_status === 'skipped_cdn_lost';
                          const flagged = !!md.reprocesar_pending;
                          const icono = m.tipo === 'imagen' ? '🖼' : m.tipo === 'audio' ? '🎤' : m.tipo === 'documento' ? '📄' : '🎬';
                          const fecha = new Date(m.ts_canal).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
                          return (
                            <div key={m.id} style={{ background: 'var(--bg-page)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                              <span style={{ fontSize: 18 }}>{icono}</span>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>
                                  {m.direccion === 'saliente' ? '↗ vos enviaste' : '↙ entrante'} · {fecha} · #{m.id}
                                  {procesado && <span style={{ marginLeft: 8, color: '#16a34a', fontWeight: 600 }}>✓ procesado</span>}
                                  {perdido && <span style={{ marginLeft: 8, color: '#dc2626', fontWeight: 600 }}>✗ CDN perdido</span>}
                                  {!procesado && !perdido && flagged && <span style={{ marginLeft: 8, color: '#d97706', fontWeight: 600 }}>⏳ en cola</span>}
                                  {!procesado && !perdido && !flagged && <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>sin procesar</span>}
                                </div>
                                <div style={{ fontSize: 13, color: procesado ? 'var(--text)' : 'var(--text-muted)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                                  {procesado ? (md.ai_text ?? '').slice(0, 250) : (perdido ? '(bytes no recuperables — la URL de WhatsApp expiró)' : '(sin transcripción)')}
                                </div>
                              </div>
                              {!procesado && !perdido && (
                                <button
                                  onClick={() => reprocesarMedia({ message_id: m.id })}
                                  disabled={reprocesando !== null}
                                  style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', cursor: 'pointer', fontSize: 11 }}
                                  title="Marcar para que la extensión lo re-encole"
                                >
                                  🔄
                                </button>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </Seccion>
                  );
                })()}
              </div>

              <div style={{ marginTop: 18 }}>
                <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.6, color: 'var(--text-muted)', marginBottom: 10 }}>⬇ Derivado de esta tarjeta por los 3 agentes</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 12 }}>
                  <Derivado icono="✅" titulo="Checklist" color={chkSel ? ESTADO_META[chkSel.estado_conversacion].color : '#999'}>
                    {chkSel ? (<>
                      <div style={{ fontSize: 13, fontWeight: 700, color: ESTADO_META[chkSel.estado_conversacion].color, marginBottom: 4 }}>{ESTADO_META[chkSel.estado_conversacion].punto} {ESTADO_META[chkSel.estado_conversacion].label}</div>
                      <div style={{ fontSize: 13 }}>→ {chkSel.proximo_paso || 'sin próximo paso'}</div>
                    </>) : <Vacio />}
                  </Derivado>
                  <Derivado icono="📋" titulo="Tareas" color="#7c3aed">
                    {tareas.length === 0 ? <Vacio /> : tareas.map(x => (
                      <div key={x.id} style={{ fontSize: 13, padding: '3px 0', display: 'flex', gap: 6 }}>
                        <span>{x.prioridad === 1 ? '🔴' : x.prioridad === 2 ? '🟡' : '⚪'}</span><span>{x.titulo}</span>
                      </div>
                    ))}
                  </Derivado>
                  <Derivado icono="📅" titulo="Agendamiento" color="#0891b2">
                    {agCanon.length === 0 && agenda.length === 0 && <Vacio />}
                    {agCanon.map(x => {
                      const editando = editandoAg === x.id;
                      const horaShow = (x.hora_inicio ?? '').slice(0, 5);
                      const editado = x.origen === 'manual_edit';
                      return (
                        <div key={x.id} style={{ fontSize: 13, padding: '6px 0', borderBottom: '1px dashed var(--border-soft)' }}>
                          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontWeight: 600 }}>{x.titulo}{editado && <span title="Editado por vos" style={{ marginLeft: 6, fontSize: 10, color: '#16a34a', fontWeight: 700 }}>✎ editado</span>}</div>
                              {editando ? (
                                <div style={{ marginTop: 4, display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <input type="date" value={editFecha} onChange={e => setEditFecha(e.target.value)}
                                    style={{ fontSize: 12, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 4 }} />
                                  <input type="time" value={editHora} onChange={e => setEditHora(e.target.value)}
                                    style={{ fontSize: 12, padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 4 }} />
                                  <button onClick={() => guardarEdit(x)} style={{ fontSize: 11, padding: '3px 10px', border: 'none', background: '#16a34a', color: 'white', borderRadius: 4, cursor: 'pointer', fontWeight: 600 }}>Guardar</button>
                                  <button onClick={cancelarEdit} style={{ fontSize: 11, padding: '3px 10px', border: '1px solid var(--border)', background: 'transparent', borderRadius: 4, cursor: 'pointer' }}>✕</button>
                                </div>
                              ) : (
                                <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>
                                  {x.fecha ?? 'por coordinar'}{horaShow ? ' · ' + horaShow : ''}{x.direccion ? ' · ' + x.direccion : ''}
                                </div>
                              )}
                            </div>
                            {!editando && x.fecha && (
                              <button onClick={() => iniciarEdit(x)} title="Reprogramar fecha / hora" style={{
                                fontSize: 11, padding: '3px 8px', border: '1px solid var(--border)',
                                background: 'transparent', cursor: 'pointer', borderRadius: 4, color: 'var(--text-muted)',
                              }}>✏️</button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {/* Items 'por coordinar' (sin fecha) del agente, solo lectura */}
                    {agenda.filter(x => !x.cuando || x.cuando === 'por coordinar').map(x => (
                      <div key={`tc-${x.id}`} style={{ fontSize: 13, padding: '4px 0', color: 'var(--text-muted)' }}>
                        <span style={{ fontWeight: 600 }}>{x.titulo}</span> <span style={{ fontSize: 11 }}>· por coordinar</span>
                      </div>
                    ))}
                  </Derivado>
                </div>
              </div>
            </>
          )}
        </>
        );
      })()}
    </div>
  );
}

function Chip({ texto, color }: { texto: string; color: string }) {
  return <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, color, background: 'var(--bg-page)', border: `1px solid ${color}33` }}>{texto}</span>;
}
function Seccion({ icono, titulo, sub, children }: { icono: string; titulo: string; sub: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>{icono} {titulo}</h3>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>— {sub}</span>
      </div>
      {children}
    </div>
  );
}
function Derivado({ icono, titulo, color, children }: { icono: string; titulo: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderTop: `3px solid ${color}`, borderRadius: 10, padding: '12px 14px' }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 8 }}>{icono} {titulo}</div>
      {children}
    </div>
  );
}
function Vacio() { return <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>— nada por ahora</div>; }
