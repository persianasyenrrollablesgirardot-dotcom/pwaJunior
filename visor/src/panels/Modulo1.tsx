import { useMemo, useState } from 'react';
import { useModo, useDatos } from '../lib/modo';
import { fetchChats, fetchPersonas, fetchInmuebles, fetchProyectos, fetchEventos, fetchBuzon } from '../lib/queries';
import * as fake from '../lib/fakeData';
import { Identidad } from './m1/Identidad';
import { InmuebleVista } from './m1/InmuebleVista';
import { ProyectoVista } from './m1/ProyectoVista';
import { Timeline } from './m1/Timeline';
import { EventoPGVista } from './m1/EventoPGVista';
import { Transcripciones } from './m1/Transcripciones';
import { BuzonValidacion } from './m1/BuzonValidacion';
import { useContextoActivo } from '../lib/contexto_activo';
import { PanelSintesis } from './PanelSintesis';
import { useNavegacion } from '../lib/navegacion';

type Sub = 'identidad' | 'inmueble' | 'proyecto' | 'timeline' | 'evento_pg' | 'transcripciones' | 'buzon';

const TABS: { id: Sub; label: string }[] = [
  { id: 'identidad',      label: '1.1 Identidad' },
  { id: 'inmueble',       label: '1.2 Inmueble' },
  { id: 'proyecto',       label: '1.3 Proyecto' },
  { id: 'timeline',       label: '1.4 Timeline' },
  { id: 'evento_pg',      label: '1.5 EVENTO_PG' },
  { id: 'transcripciones',label: '1.6 Transcripciones' },
  { id: 'buzon',          label: '1.7 Buzón' },
];

export function Modulo1() {
  const [sub, setSub] = useState<Sub>('identidad');
  const [modo] = useModo();
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [verTodo, setVerTodo] = useState(false);   // toggle "ignorar contexto activo" temporalmente

  // Cargas con realtime activo si modo='real'
  const chats     = useDatos(fetchChats,     fake.chats,     modo, 'chats');
  const personas  = useDatos(fetchPersonas,  fake.personas,  modo, 'personas');
  const inmuebles = useDatos(fetchInmuebles, fake.inmuebles, modo, 'inmuebles');
  const proyectos = useDatos(fetchProyectos, fake.proyectos, modo, 'proyectos');
  // Si hay contexto activo, fetchEventos filtra en BD (evita perder eventos por LIMIT 50)
  const eventosFetcher = useMemo(() => () => {
    if (!ctx.hayContexto) return fetchEventos();
    return fetchEventos({
      personaId: ctx.personaActivaId ?? undefined,
      proyectoId: ctx.proyectoActivoId ?? undefined,
      chatId: ctx.chatActivoId ?? undefined,
    });
  }, [ctx.hayContexto, ctx.personaActivaId, ctx.proyectoActivoId, ctx.chatActivoId]);
  const eventos   = useDatos(eventosFetcher, fake.eventos,   modo, 'evento_pg');
  const buzon     = useDatos(fetchBuzon,     fake.buzon,     modo, 'buzon_validacion');

  const cargando = chats.cargando || personas.cargando || proyectos.cargando;
  const error = chats.error || personas.error || proyectos.error;
  const bdVacia = modo === 'real' && !cargando && chats.datos.length === 0 && personas.datos.length === 0;

  // ─── Filtrado por contexto activo ─────────────────────────────────
  // Si Jhon seleccionó una persona en M0 Captura o en M1 Identidad,
  // los demás submódulos filtran AUTOMÁTICAMENTE por esa persona.
  // Toggle "Ver todo" desactiva el filtro temporalmente.
  const filtroActivo = ctx.hayContexto && !verTodo;

  const proyectosFiltrados = useMemo(() => {
    if (!filtroActivo || ctx.personaActivaId == null) return proyectos.datos;
    return proyectos.datos.filter(p => p.persona_id === ctx.personaActivaId);
  }, [proyectos.datos, filtroActivo, ctx.personaActivaId]);

  // F1.22 fix I6: Identidad recibe solo la persona activa + sus referidos (red),
  // no la lista entera. Con muchas personas en BD esto evita pasar 500+ items inútiles.
  const personasParaIdentidad = useMemo(() => {
    if (!filtroActivo || ctx.personaActivaId == null) return personas.datos;
    const activa = personas.datos.find(p => p.id === ctx.personaActivaId);
    if (!activa) return personas.datos;    // todavía cargando
    const ids = new Set<number>([activa.id]);
    if (activa.referido_por_persona_id != null) ids.add(activa.referido_por_persona_id);
    personas.datos.forEach(p => { if (p.referido_por_persona_id === activa.id) ids.add(p.id); });
    return personas.datos.filter(p => ids.has(p.id));
  }, [personas.datos, filtroActivo, ctx.personaActivaId]);

  const inmueblesIdsDePersona = useMemo(() => {
    if (!filtroActivo || ctx.personaActivaId == null) return null;
    const ids = new Set<number>();
    proyectos.datos.filter(p => p.persona_id === ctx.personaActivaId)
      .forEach(p => { if (p.inmueble_id != null) ids.add(p.inmueble_id); });
    return ids;
  }, [proyectos.datos, filtroActivo, ctx.personaActivaId]);

  const inmueblesFiltrados = useMemo(() => {
    if (!inmueblesIdsDePersona) return inmuebles.datos;
    return inmuebles.datos.filter(i => inmueblesIdsDePersona.has(i.id));
  }, [inmuebles.datos, inmueblesIdsDePersona]);

  const eventosFiltrados = useMemo(() => {
    if (!filtroActivo) return eventos.datos;
    return eventos.datos.filter(e => {
      if (ctx.proyectoActivoId != null && e.proyecto_id === ctx.proyectoActivoId) return true;
      if (ctx.personaActivaId != null && e.persona_id === ctx.personaActivaId) return true;
      return false;
    });
  }, [eventos.datos, filtroActivo, ctx.personaActivaId, ctx.proyectoActivoId]);

  const buzonFiltrado = useMemo(() => {
    if (!filtroActivo) return buzon.datos;
    return buzon.datos.filter(b => {
      const it: any = b;
      if (ctx.proyectoActivoId != null && it.proyecto_id === ctx.proyectoActivoId) return true;
      if (ctx.personaActivaId != null && it.persona_id === ctx.personaActivaId) return true;
      return false;
    });
  }, [buzon.datos, filtroActivo, ctx.personaActivaId, ctx.proyectoActivoId]);

  // Conteos para badges (sobre lo filtrado para que el badge tenga sentido en contexto)
  const buzonPendientes = buzonFiltrado.length;

  // F1.20: si NO hay cliente activo, M1 no tiene nada que mostrar — mandamos a Clientes.
  if (!ctx.hayContexto && modo === 'real') {
    return (
      <div style={{ padding: 60, textAlign: 'center' }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>👤</div>
        <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700 }}>Sin cliente activo</h2>
        <p style={{ margin: '0 auto 16px', maxWidth: 420, fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.5 }}>
          M1 Núcleo muestra info detallada del cliente que vos seleccionaste.<br />
          Andá al módulo <strong>Clientes</strong> y elegí uno para ver acá su Identidad, Inmueble, Proyecto, Timeline, etc.
        </p>
        <button
          onClick={() => nav.cambiarModulo('clientes')}
          style={{ padding: '8px 16px', fontSize: 13, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' }}
        >
          → Ir a Clientes
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '16px 24px 0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h1 style={{ margin: '0 0 2px', fontSize: 18, fontWeight: 700 }}>MÓDULO 1 · Núcleo</h1>
          {modo === 'demo' && (
            <span style={{ fontSize: 10, padding: '2px 8px', background: 'var(--orange)', color: 'white', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase' }}>
              Demo · datos fake
            </span>
          )}
          {modo === 'real' && !cargando && !error && !bdVacia && (
            <span style={{ fontSize: 10, padding: '2px 8px', background: 'var(--green)', color: 'white', borderRadius: 10, fontWeight: 600, textTransform: 'uppercase' }}>
              Real · vivo
            </span>
          )}
        </div>
        <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 12 }}>
          Solo chats <strong>procesados</strong>. Identidad · Inmueble · Proyecto · Timeline · EVENTO_PG · Buzón validación. (Para ver todos los chats locales sin procesar → módulo <strong>Captura</strong>)
        </p>
      </div>

      {/* Banner de estado */}
      {error && (
        <div style={{ margin: '12px 24px 0', padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12 }}>
          <strong>Error de conexión:</strong> {error}. Cambia a modo Demo para ver el mockup.
        </div>
      )}
      {bdVacia && (
        <div style={{ margin: '12px 24px 0', padding: 12, background: 'var(--accent-soft)', color: 'var(--accent)', borderRadius: 6, fontSize: 12 }}>
          <strong>BD vacía.</strong> Para ver datos reales: 1) carga la extensión Visor PG en Chrome, 2) abre WhatsApp Web, 3) autoriza un chat con el popup. Los mensajes aparecen acá en &lt;5 seg.
        </div>
      )}

      {/* La conclusión del agente analista — lo primero que se ve */}
      <PanelSintesis modulo="m1" titulo="Análisis del Cliente" />

      {/* Tabs internos */}
      <div style={{ display: 'flex', gap: 4, padding: '12px 24px 0', borderBottom: '1px solid var(--border-soft)' }}>
        {TABS.map(t => {
          const activo = t.id === sub;
          const badge = t.id === 'buzon' && buzonPendientes > 0 ? buzonPendientes : null;
          return (
            <button
              key={t.id}
              onClick={() => setSub(t.id)}
              style={{
                padding: '8px 14px',
                fontSize: 12,
                fontWeight: activo ? 600 : 500,
                color: activo ? 'var(--accent)' : 'var(--text-muted)',
                background: 'transparent',
                border: 'none',
                borderBottom: activo ? '2px solid var(--accent)' : '2px solid transparent',
                marginBottom: -1,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              {t.label}
              {badge !== null && (
                <span style={{ background: 'var(--red)', color: 'white', borderRadius: 8, padding: '1px 6px', fontSize: 10, fontWeight: 600 }}>
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Banner de contexto activo + toggle Ver todo */}
      {filtroActivo && (
        <div style={{
          margin: '10px 24px 0', padding: '8px 12px',
          background: '#e0f2fe', border: '1px solid #38bdf8', borderRadius: 6,
          fontSize: 11, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12,
        }}>
          <span>
            <strong style={{ color: '#0369a1' }}>Filtrado por contexto activo:</strong>
            {ctx.personaActivaNombre && <> 👤 {ctx.personaActivaNombre}</>}
            {ctx.proyectoActivoNombre && <> · 📋 {ctx.proyectoActivoNombre}</>}
            {ctx.chatActivoTitulo && ctx.chatActivoTitulo !== ctx.personaActivaNombre && <> · 💬 {ctx.chatActivoTitulo}</>}
            {' '} · {proyectosFiltrados.length}/{proyectos.datos.length} proyectos · {inmueblesFiltrados.length}/{inmuebles.datos.length} inmuebles · {eventosFiltrados.length}/{eventos.datos.length} eventos · {buzonFiltrado.length}/{buzon.datos.length} buzón
          </span>
          <button
            onClick={() => setVerTodo(true)}
            style={{ padding: '3px 10px', fontSize: 10, fontWeight: 600, background: 'white', color: '#0369a1', border: '1px solid #38bdf8', borderRadius: 4, cursor: 'pointer' }}
          >Ver TODO →</button>
        </div>
      )}
      {ctx.hayContexto && verTodo && (
        <div style={{
          margin: '10px 24px 0', padding: '8px 12px',
          background: '#fef3c7', border: '1px solid #f59e0b', borderRadius: 6,
          fontSize: 11, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span>⚠️ Mostrando TODO (contexto activo ignorado solo en este módulo)</span>
          <button onClick={() => setVerTodo(false)} style={{ padding: '3px 10px', fontSize: 10, fontWeight: 600, background: 'white', color: '#a16207', border: '1px solid #f59e0b', borderRadius: 4, cursor: 'pointer' }}>Volver a filtrar</button>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {sub === 'identidad' && <Identidad personas={personasParaIdentidad} proyectos={proyectos.datos} />}
        {sub === 'inmueble' && <InmuebleVista inmuebles={inmueblesFiltrados} />}
        {sub === 'proyecto' && <ProyectoVista proyectos={proyectosFiltrados} personas={personas.datos} inmuebles={inmuebles.datos} />}
        {sub === 'timeline' && <Timeline eventos={eventosFiltrados} proyectos={proyectosFiltrados} personas={personas.datos} />}
        {sub === 'evento_pg' && <EventoPGVista eventos={eventosFiltrados} personas={personas.datos} />}
        {sub === 'transcripciones' && <Transcripciones />}
        {sub === 'buzon' && <BuzonValidacion items={buzonFiltrado} />}
      </div>
    </div>
  );
}
