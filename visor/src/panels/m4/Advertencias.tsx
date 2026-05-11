/**
 * 4.4 Advertencias técnicas — filtradas por sistemas del cliente activo.
 *
 * Catálogo en BD (advertencias_safra). Muestra primero las globales (sin sistema)
 * y luego las específicas de los sistemas cotizados por el cliente.
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchCotizacionesPorPersona, fetchItemsPorCotizacion, fetchAdvertenciasPorSistemas,
  fetchSistemasSafra, type Advertencia,
} from '../../lib/queries';

const SEV_COLOR: Record<string, string> = { critico: 'var(--red)', warning: 'var(--orange)', info: 'var(--accent)' };
const SEV_ICON: Record<string, string> = { critico: '🚨', warning: '⚠', info: 'ℹ' };
const SEV_ORDEN: Record<string, number> = { critico: 0, warning: 1, info: 2 };

export function Advertencias() {
  const ctx = useContextoActivo();
  const [advertencias, setAdvertencias] = useState<Advertencia[]>([]);
  const [sistemasCliente, setSistemasCliente] = useState<string[]>([]);
  const [sistemasCatalogo, setSistemasCatalogo] = useState<{ codigo: string; nombre: string }[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (ctx.personaActivaId == null) return;
    setCargando(true); setError(null);
    (async () => {
      try {
        const cots = await fetchCotizacionesPorPersona(ctx.personaActivaId!);
        const codigos = new Set<string>();
        for (const c of cots) {
          const its = await fetchItemsPorCotizacion(c.id);
          for (const it of its) if (it.sistema_safra_codigo) codigos.add(it.sistema_safra_codigo);
        }
        setSistemasCliente([...codigos]);
        setAdvertencias(await fetchAdvertenciasPorSistemas([...codigos]));
        setSistemasCatalogo(await fetchSistemasSafra());
      } catch (e: any) { setError(e.message); }
      finally { setCargando(false); }
    })();
  }, [ctx.personaActivaId]);

  if (cargando) return <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Cargando…</div>;

  const ordenadas = [...advertencias].sort((a, b) => (SEV_ORDEN[a.severidad] ?? 9) - (SEV_ORDEN[b.severidad] ?? 9));
  const globales = ordenadas.filter(a => a.sistema_codigo == null);
  const porSistema: Record<string, Advertencia[]> = {};
  for (const a of ordenadas) if (a.sistema_codigo) {
    (porSistema[a.sistema_codigo] ||= []).push(a);
  }

  const nombreSistema = (codigo: string) => sistemasCatalogo.find(s => s.codigo === codigo)?.nombre ?? codigo;

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Advertencias técnicas para {ctx.personaActivaNombre}
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Reglas técnicas que aplican según los sistemas que tiene cotizados ({sistemasCliente.length} sistema{sistemasCliente.length !== 1 ? 's' : ''} detectado{sistemasCliente.length !== 1 ? 's' : ''}).
      </p>

      {error && <div style={{ padding: 12, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>Error: {error}</div>}

      {ordenadas.length === 0 && (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin advertencias para los sistemas de este cliente.
        </div>
      )}

      {globales.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>
            Advertencias generales (aplican siempre)
          </h3>
          {globales.map(a => <CardAdvertencia key={a.id} a={a} />)}
        </div>
      )}

      {Object.entries(porSistema).map(([sistema, advs]) => (
        <div key={sistema} style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.5, fontWeight: 700, marginBottom: 8 }}>
            Sistema: {nombreSistema(sistema)}
          </h3>
          {advs.map(a => <CardAdvertencia key={a.id} a={a} />)}
        </div>
      ))}
    </div>
  );
}

function CardAdvertencia({ a }: { a: Advertencia }) {
  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: `1px solid ${SEV_COLOR[a.severidad]}`,
      borderLeft: `4px solid ${SEV_COLOR[a.severidad]}`,
      borderRadius: 6, padding: 12, marginBottom: 8,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <strong style={{ fontSize: 13, color: SEV_COLOR[a.severidad] }}>
          {SEV_ICON[a.severidad]} {a.titulo}
        </strong>
        <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{a.codigo}</span>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.4 }}>{a.texto}</div>
      {a.contexto && (
        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
          Contexto: {a.contexto}
        </div>
      )}
    </div>
  );
}
