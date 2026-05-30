import { useEffect, useState } from 'react';
import { useModo } from '../lib/modo';
import { fetchMetricas, fetchBuzon, fetchUltimosEventos, type MetricasCentro, type UltimoEvento } from '../lib/queries';
import { chequearExtension, listarChats, listarBloqueados } from '../lib/extension';
import { buzon as buzonFake } from '../lib/fakeData';

const REFRESH_MS = 10_000;  // refresca cada 10s

export function CentroControl() {
  const [modo] = useModo();
  const [metricas, setMetricas] = useState<MetricasCentro | null>(null);
  const [buzonItems, setBuzonItems] = useState<any[]>([]);
  const [ultimos, setUltimos] = useState<UltimoEvento[]>([]);
  const [extInfo, setExtInfo] = useState<{ conectada: boolean; version?: string; chatsLocal: number; bloqueadosLocal: number; mensaje: string }>({ conectada: false, chatsLocal: 0, bloqueadosLocal: 0, mensaje: '...' });
  const [cargando, setCargando] = useState(true);
  const [ultimaActualizacion, setUltimaActualizacion] = useState<Date | null>(null);

  async function cargar() {
    if (modo === 'demo') {
      setMetricas({
        chats_procesados: 3, personas: 3, proyectos_activos: 3, proyectos_total: 5,
        eventos_hoy: 47, buzon_pendientes: buzonFake.length, buzon_alta: buzonFake.filter(b => b.prioridad <= 2).length,
        costo_dia_usd: 0.18, tope_diario_usd: 5, modo_ia: 'OFF',
        eventos_nuevos: 0, eventos_ambiguos: 0, eventos_error: 0,
        ultimo_evento_procesado_at: new Date(Date.now() - 12 * 60 * 1000).toISOString(),
        media_total: 12, media_con_aitext: 8,
      });
      setBuzonItems(buzonFake);
      setExtInfo({ conectada: false, chatsLocal: 0, bloqueadosLocal: 0, mensaje: 'Modo demo, sin extensión' });
      setCargando(false);
      return;
    }
    try {
      const [m, b, u] = await Promise.all([
        fetchMetricas(),
        fetchBuzon(),
        fetchUltimosEventos(8),
      ]);
      setMetricas(m);
      setBuzonItems(b);
      setUltimos(u);
      // Extensión (puede fallar si no instalada)
      const check = await chequearExtension();
      if (check.conectada) {
        const [chats, bloq] = await Promise.all([listarChats(), listarBloqueados()]);
        const noStatus = chats.filter(c => !c.isStatus);
        setExtInfo({ conectada: true, version: check.version, chatsLocal: noStatus.length, bloqueadosLocal: bloq.length, mensaje: 'OK' });
      } else {
        setExtInfo({ conectada: false, chatsLocal: 0, bloqueadosLocal: 0, mensaje: check.mensaje });
      }
      setUltimaActualizacion(new Date());
    } catch (e: any) {
      console.error('CentroControl cargar:', e);
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => {
    cargar();
    const iv = setInterval(cargar, REFRESH_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modo]);

  if (!metricas) return <div style={{ padding: 32, fontSize: 13, color: 'var(--text-muted)' }}>Cargando…</div>;

  const m = metricas;
  const costoColor = m.costo_dia_usd < m.tope_diario_usd * 0.5 ? 'var(--green)' : m.costo_dia_usd < m.tope_diario_usd ? 'var(--orange)' : 'var(--red)';
  const cobertura = m.media_total > 0 ? Math.round((m.media_con_aitext / m.media_total) * 100) : 0;

  // Salud worker: si hay eventos NUEVO, hace cuánto fue el último procesado
  const ultimoMs = m.ultimo_evento_procesado_at ? Date.now() - new Date(m.ultimo_evento_procesado_at).getTime() : null;
  const workerSano = m.eventos_nuevos === 0 || (ultimoMs !== null && ultimoMs < 60_000);

  return (
    <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 }}>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Centro de Control</h1>
        {modo === 'demo' && <span style={{ fontSize: 10, padding: '2px 8px', background: 'var(--orange)', color: 'white', borderRadius: 10, fontWeight: 600 }}>DEMO</span>}
        {ultimaActualizacion && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>actualizado {ultimaActualizacion.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>}
      </div>
      <p style={{ margin: '0 0 20px', color: 'var(--text-muted)', fontSize: 13 }}>
        Sala de mando · {new Date().toLocaleDateString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      </p>

      {/* Fila 1: KPIs operativos */}
      <SeccionTitulo>Operación</SeccionTitulo>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        <KPI titulo="Captura local"        valor={extInfo.conectada ? extInfo.chatsLocal : '—'} subtitulo={extInfo.conectada ? `extensión v${extInfo.version}` : 'extensión OFF'} color={extInfo.conectada ? '#1c1c1e' : 'var(--text-muted)'} />
        <KPI titulo="Chats procesados"     valor={m.chats_procesados} subtitulo="ya en M1 Núcleo" color="var(--accent)" />
        <KPI titulo="Personas"             valor={m.personas} subtitulo={`${m.proyectos_total} proyectos`} color="var(--accent)" />
        <KPI titulo="Bloqueados"           valor={extInfo.bloqueadosLocal} subtitulo="en chats_bloqueados" color={extInfo.bloqueadosLocal > 0 ? 'var(--red)' : 'var(--text-muted)'} />
        <KPI titulo="Buzón pendiente"      valor={m.buzon_pendientes} subtitulo={`${m.buzon_alta} críticos`} color={m.buzon_alta > 0 ? 'var(--red)' : (m.buzon_pendientes > 0 ? 'var(--orange)' : 'var(--green)')} />
      </div>

      {/* Fila 2: Costo + IA */}
      <SeccionTitulo>Costo IA del día</SeccionTitulo>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
        <KPI titulo="Gastado hoy"          valor={`$${m.costo_dia_usd.toFixed(4)}`} subtitulo={`tope $${m.tope_diario_usd.toFixed(2)}`} color={costoColor} />
        <KPI titulo="Modo IA tiempo real"  valor={m.modo_ia === 'ON' ? '🟢 ON' : '⚫ OFF'} subtitulo={m.modo_ia === 'OFF' ? 'sin auto-procesado' : 'auto-procesado activo'} color={m.modo_ia === 'ON' ? 'var(--green)' : 'var(--text-muted)'} />
        <KPI titulo="Cobertura transcripción IA" valor={`${cobertura}%`} subtitulo={`${m.media_con_aitext}/${m.media_total} medias`} color={cobertura >= 80 ? 'var(--green)' : cobertura >= 50 ? 'var(--orange)' : 'var(--text-muted)'} />
        <KPI titulo="Eventos hoy"          valor={m.eventos_hoy} subtitulo="procesados o pendientes" color="var(--accent)" />
      </div>

      {/* Salud del sistema */}
      <SeccionTitulo>Salud del sistema</SeccionTitulo>
      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14, marginBottom: 20 }}>
        <Estado label="Extensión Chrome (captura local)" estado={extInfo.conectada ? 'on' : 'apagado'} detalle={extInfo.conectada ? `v${extInfo.version} · ${extInfo.chatsLocal} chats locales` : extInfo.mensaje} />
        <Estado label="Worker pipeline (identidad)" estado={workerSano ? 'on' : (m.eventos_nuevos > 0 ? 'pendiente' : 'on')} detalle={ultimoMs ? `último evento procesado hace ${formatHaceMs(ultimoMs)} · ${m.eventos_nuevos} en cola NUEVO · ${m.eventos_ambiguos} AMBIGUO · ${m.eventos_error} ERROR` : 'sin actividad todavía'} />
        <Estado label="Agentes IA (transcripción + extracción)" estado="apagado" detalle="se activan en MÓDULO 2 (Comerciales)" />
      </div>

      {/* Buzón + últimos eventos */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
        <Card titulo={`Tu atención (${m.buzon_pendientes})`}>
          {buzonItems.length === 0 && <Vacio mensaje="Buzón vacío. Cuando agentes IA detecten algo crítico, aparecerá aquí." />}
          {buzonItems.slice(0, 4).map((b, i) => (
            <div key={b.id} style={{ padding: '8px 0', borderTop: i === 0 ? 'none' : '1px solid var(--border-soft)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500, flex: 1 }}>{b.resumen}</span>
                {b.prioridad <= 2 && <span style={{ fontSize: 9, fontWeight: 700, color: 'white', background: 'var(--red)', padding: '2px 6px', borderRadius: 8 }}>CRÍTICO</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                {b.persona_nombre}{b.proyecto_nombre ? ` · ${b.proyecto_nombre}` : ''} · hace {Math.round(b.horas_pendiente ?? 0)}h
              </div>
            </div>
          ))}
        </Card>

        <Card titulo="Última actividad">
          {ultimos.length === 0 && <Vacio mensaje="Sin eventos todavía. Procesá un chat desde Captura para empezar." />}
          {ultimos.slice(0, 6).map(e => (
            <div key={e.id} style={{ padding: '6px 0', borderTop: '1px solid var(--border-soft)', fontSize: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span style={{ color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                  <strong>{e.persona_nombre ?? 'sin persona'}</strong>
                  {' · '}
                  <span style={{ color: 'var(--text-muted)' }}>{e.tipo_evento.replace(/_/g, ' ')}</span>
                  {e.preview && <span style={{ color: 'var(--text-muted)' }}> — {e.preview.slice(0, 40)}…</span>}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{formatHaceTs(e.ts_creado)}</span>
              </div>
            </div>
          ))}
        </Card>
      </div>

      {modo === 'real' && cargando && (
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', padding: 8 }}>Refrescando datos…</div>
      )}
    </div>
  );
}

function SeccionTitulo({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 600, marginBottom: 8 }}>{children}</div>;
}

function KPI({ titulo, valor, subtitulo, color }: { titulo: string; valor: number | string; subtitulo: string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{titulo}</div>
      <div style={{ fontSize: 24, fontWeight: 700, color, marginTop: 4 }}>{valor}</div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>{subtitulo}</div>
    </div>
  );
}

function Card({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{titulo}</div>
      {children}
    </div>
  );
}

function Vacio({ mensaje }: { mensaje: string }) {
  return <div style={{ fontSize: 11, color: 'var(--text-muted)', padding: 8, fontStyle: 'italic' }}>{mensaje}</div>;
}

function Estado({ label, estado, detalle }: { label: string; estado: 'on' | 'apagado' | 'pendiente'; detalle: string }) {
  const colorMap = { on: 'var(--green)', apagado: 'var(--text-muted)', pendiente: 'var(--orange)' };
  const labelMap = { on: 'Activo', apagado: 'Apagado', pendiente: 'Procesando' };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderTop: '1px solid var(--border-soft)' }}>
      <div style={{ width: 8, height: 8, borderRadius: '50%', background: colorMap[estado] }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1 }}>{detalle}</div>
      </div>
      <span style={{ fontSize: 10, color: colorMap[estado], fontWeight: 700, textTransform: 'uppercase' }}>{labelMap[estado]}</span>
    </div>
  );
}

function formatHaceMs(ms: number): string {
  if (ms < 60_000) return Math.round(ms / 1000) + 's';
  if (ms < 3_600_000) return Math.round(ms / 60_000) + 'min';
  if (ms < 86_400_000) return Math.round(ms / 3_600_000) + 'h';
  return Math.round(ms / 86_400_000) + 'd';
}

function formatHaceTs(iso: string): string {
  return formatHaceMs(Date.now() - new Date(iso).getTime());
}
