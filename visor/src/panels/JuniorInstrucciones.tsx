/**
 * Pestaña "Instrucciones por chat" del módulo Junior.
 *
 * Registro visible de todo lo que Jhon le dictó a Junior por el chat directo:
 * clientes que registró, correcciones/novedades sobre clientes y preferencias
 * que le enseñó. La fuente es la tabla `junior_instrucciones`, que el worker
 * escribe cada vez que procesa un mensaje de Jhon.
 */
import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

interface Instruccion {
  id: number;
  tipo: 'nuevo_cliente' | 'correccion' | 'memoria';
  resumen: string;
  persona_id: number | null;
  modulo: string | null;
  created_at: string;
  persona: { nombre: string } | null;
}

const TIPO_META: Record<Instruccion['tipo'], { label: string; icono: string; color: string }> = {
  nuevo_cliente: { label: 'Cliente nuevo', icono: '🆕', color: '#16a34a' },
  correccion:    { label: 'Corrección',    icono: '✏️', color: '#2563eb' },
  memoria:       { label: 'Aprendizaje',   icono: '🧠', color: '#9333ea' },
};

const MODULO_NOMBRE: Record<string, string> = {
  m1: 'Cliente', m2: 'Comercial', m3: 'Financiero', m4: 'Técnico',
  m5: 'Operativo', m6: 'Postventa', m7: 'Evidencias',
};

function fechaRelativa(iso: string): string {
  const opts = { timeZone: 'America/Bogota' } as const;
  const d = new Date(iso);
  const hoy = new Date();
  const ayer = new Date();
  ayer.setDate(ayer.getDate() - 1);
  const dia = d.toLocaleDateString('es-CO', opts);
  const hora = d.toLocaleTimeString('es-CO', { ...opts, hour: '2-digit', minute: '2-digit' });
  if (dia === hoy.toLocaleDateString('es-CO', opts)) return `hoy ${hora}`;
  if (dia === ayer.toLocaleDateString('es-CO', opts)) return `ayer ${hora}`;
  return `${d.toLocaleDateString('es-CO', { ...opts, day: '2-digit', month: '2-digit' })} ${hora}`;
}

export function JuniorInstrucciones() {
  const [instrucciones, setInstrucciones] = useState<Instruccion[]>([]);
  const [cargado, setCargado] = useState(false);

  async function cargar() {
    const { data } = await supabase
      .from('junior_instrucciones')
      .select('id,tipo,resumen,persona_id,modulo,created_at,persona:personas(nombre)')
      .order('created_at', { ascending: false });
    setInstrucciones((data as any as Instruccion[]) ?? []);
    setCargado(true);
  }

  useEffect(() => {
    cargar();
    const t = setInterval(cargar, 4000);
    return () => clearInterval(t);
  }, []);

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: '18px 24px' }}>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Todo lo que le dictaste a Junior por el chat queda registrado acá: clientes que
        registraste, correcciones y lo que le enseñaste.
      </p>

      {cargado && instrucciones.length === 0 && (
        <div style={{ textAlign: 'center', padding: '50px 0', color: 'var(--text-muted)' }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>📋</div>
          <p style={{ fontSize: 13, margin: 0 }}>
            Todavía no le diste ninguna instrucción a Junior por el chat.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {instrucciones.map(it => {
          const meta = TIPO_META[it.tipo];
          return (
            <div key={it.id} style={{
              border: '1px solid var(--border-soft)', borderRadius: 10,
              borderLeft: `3px solid ${meta.color}`, background: 'var(--bg-panel)',
              padding: '10px 14px',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5,
                fontSize: 11, color: 'var(--text-muted)',
              }}>
                <span style={{ fontWeight: 700, color: meta.color }}>
                  {meta.icono} {meta.label}
                </span>
                {it.modulo && MODULO_NOMBRE[it.modulo] && (
                  <span style={{
                    padding: '1px 7px', borderRadius: 10, fontSize: 10,
                    background: 'var(--bg-page)', border: '1px solid var(--border-soft)',
                  }}>{MODULO_NOMBRE[it.modulo]}</span>
                )}
                <span style={{ marginLeft: 'auto' }}>{fechaRelativa(it.created_at)}</span>
              </div>
              <div style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.45 }}>
                {it.resumen}
              </div>
              {it.persona && (
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)' }}>
                  → Cliente: <strong>{it.persona.nombre}</strong>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
