/**
 * 3.3 Cartera — vista GLOBAL de personas con deuda > 0.
 *
 * No requiere cliente activo. Lista personas ordenadas por deuda total descendente.
 * Click en una card → setea contexto activo y navega a M3 Facturación del mismo.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { useNavegacion } from '../../lib/navegacion';
import { fetchCartera, type ResumenCartera } from '../../lib/queries';

const fmtCop = (n: number) => n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
const fmtFecha = (s: string | null) => s ? new Date(s).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

export function Cartera() {
  const ctx = useContextoActivo();
  const nav = useNavegacion();
  const [filas, setFilas] = useState<ResumenCartera[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState('');

  async function cargar() {
    setCargando(true); setError(null);
    try {
      const data = await fetchCartera();
      setFilas(data);
    } catch (e: any) { setError(e.message); }
    finally { setCargando(false); }
  }
  useEffect(() => { cargar(); }, []);

  const filtradas = busqueda.trim()
    ? filas.filter(f =>
        (f.persona_nombre ?? '').toLowerCase().includes(busqueda.toLowerCase()) ||
        (f.persona_telefono ?? '').includes(busqueda) ||
        (f.persona_ciudad ?? '').toLowerCase().includes(busqueda.toLowerCase()))
    : filas;

  const totales = {
    personas: filtradas.length,
    deuda: filtradas.reduce((s, f) => s + Number(f.deuda_total), 0),
    facturado: filtradas.reduce((s, f) => s + Number(f.facturado_total), 0),
    abonado: filtradas.reduce((s, f) => s + Number(f.abonado_total), 0),
  };

  function abrirCliente(f: ResumenCartera) {
    ctx.seleccionarPersona(f.persona_id, f.persona_nombre);
    nav.cambiarModulo('m3');
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Cartera — saldos pendientes</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Solo personas con <strong>deuda &gt; 0</strong>. Click en una card para seleccionar al cliente y ver detalle.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <KPI label="👥 Personas con saldo" valor={totales.personas} color="var(--accent)" />
        <KPI label="$ Deuda total"         valor={fmtCop(totales.deuda)}     color={totales.deuda > 0 ? 'var(--red)' : 'var(--text-muted)'} />
        <KPI label="$ Facturado total"     valor={fmtCop(totales.facturado)} color="var(--text)" />
        <KPI label="$ Abonado total"       valor={fmtCop(totales.abonado)}   color="var(--green)" />
      </div>

      <input
        type="search"
        value={busqueda}
        onChange={e => setBusqueda(e.target.value)}
        placeholder="🔍 Buscar nombre, teléfono o ciudad…"
        style={{ width: 380, padding: '7px 12px', fontSize: 13, border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-page)', outline: 'none', marginBottom: 12 }}
      />

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}
      {cargando && <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>}

      {!cargando && filas.length === 0 && (
        <div style={{ padding: 40, textAlign: 'center', background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13 }}>
          🎉 Nadie debe nada. Todas las cotizaciones están con saldo 0 o no hay cotizaciones activas.
        </div>
      )}

      {!cargando && filas.length > 0 && filtradas.length === 0 && (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12 }}>
          Sin resultados para "{busqueda}".
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {filtradas.map(f => (
          <button key={f.persona_id} onClick={() => abrirCliente(f)}
            style={{ width: '100%', textAlign: 'left', background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14, cursor: 'pointer' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <strong style={{ fontSize: 14 }}>{f.persona_nombre}</strong>
              <span style={{ fontSize: 14, color: 'var(--red)', fontWeight: 700 }}>{fmtCop(Number(f.deuda_total))}</span>
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)' }}>
              {f.persona_telefono && <span>📞 {f.persona_telefono}</span>}
              {f.persona_ciudad && <span>📍 {f.persona_ciudad}</span>}
              <span>📋 {f.cotizaciones_con_saldo} cotización(es) con saldo</span>
              {Number(f.facturas_pendientes) > 0 && <span>🧾 {f.facturas_pendientes} factura(s) pendiente(s)</span>}
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              <span>Facturado: {fmtCop(Number(f.facturado_total))}</span>
              <span>Abonado: {fmtCop(Number(f.abonado_total))}</span>
              <span style={{ marginLeft: 'auto' }}>última act.: {fmtFecha(f.ultima_actividad)}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function KPI({ label, valor, color }: { label: string; valor: number | string; color: string }) {
  return (
    <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: '8px 12px', minWidth: 140 }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color }}>{valor}</div>
    </div>
  );
}
