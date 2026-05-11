/**
 * 2.3 Objeciones — registro de "muy caro", "lo pienso", "compito con X".
 */
import { useEffect, useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import {
  fetchCotizacionesPorPersona, fetchObjecionesPorCotizacion, fetchTiposObjecion,
  crearObjecion, eliminarObjecion,
  type Cotizacion, type CotizacionObjecion,
} from '../../lib/queries';

const fmtFecha = (s: string) => new Date(s).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Objeciones() {
  const ctx = useContextoActivo();
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [tipos, setTipos] = useState<{ codigo: string; etiqueta: string }[]>([]);
  const [objeciones, setObjeciones] = useState<Record<number, CotizacionObjecion[]>>({});
  const [creando, setCreando] = useState<{ cotizacion_id: number } | null>(null);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  async function recargar() {
    if (ctx.personaActivaId == null) return;
    const list = await fetchCotizacionesPorPersona(ctx.personaActivaId);
    setCotizaciones(list);
    const obj: Record<number, CotizacionObjecion[]> = {};
    for (const c of list) {
      obj[c.id] = await fetchObjecionesPorCotizacion(c.id);
    }
    setObjeciones(obj);
  }
  useEffect(() => { recargar(); fetchTiposObjecion().then(setTipos); }, [ctx.personaActivaId]);

  async function borrarObj(id: number) {
    if (!confirm('¿Eliminar esta objeción?')) return;
    try { await eliminarObjecion(id); await recargar(); }
    catch (e: any) { setFeedback({ tipo: 'err', msg: e.message }); }
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>Objeciones del cliente</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Registro de "muy caro", "lo pienso", "compito con X" y cómo se respondió. Los agentes IA y Junior van a aprender de esto a futuro.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      {cotizaciones.length === 0 ? (
        <div style={{ padding: 30, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--text-muted)', fontSize: 13, textAlign: 'center' }}>
          Sin cotizaciones para registrarles objeciones. Creá una en 2.1 Cotizaciones primero.
        </div>
      ) : cotizaciones.map(c => (
        <div key={c.id} style={{ marginBottom: 16, background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <strong style={{ fontSize: 13 }}>{c.numero_cotizacion ?? '#' + c.id} · {c.estado}</strong>
            <button onClick={() => setCreando({ cotizacion_id: c.id })} style={btnSec}>+ Registrar objeción</button>
          </div>

          {(objeciones[c.id] ?? []).length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>Sin objeciones registradas para esta cotización.</div>
          ) : (objeciones[c.id] ?? []).map(o => {
            const tipo = tipos.find(t => t.codigo === o.tipo_objecion_codigo);
            const colorRes = o.resultado === 'resuelto' ? 'var(--green)' : o.resultado === 'cliente_se_fue' ? 'var(--red)' : o.resultado === 'persiste' ? 'var(--orange)' : 'var(--text-muted)';
            return (
              <div key={o.id} style={{ background: 'var(--bg-page)', borderRadius: 6, padding: 10, marginBottom: 6 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                  <strong>{tipo?.etiqueta ?? o.tipo_objecion_codigo}</strong>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontSize: 10, fontWeight: 700, color: colorRes, textTransform: 'uppercase' }}>{o.resultado ?? 'pendiente'}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{fmtFecha(o.ts_objecion)}</span>
                  </div>
                </div>
                {o.texto_cliente && <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>"{o.texto_cliente}"</div>}
                {o.respuesta_dada && <div style={{ fontSize: 12, marginTop: 4 }}>→ {o.respuesta_dada}</div>}
                <button onClick={() => borrarObj(o.id)} style={{ ...miniBtnDanger, marginTop: 6 }}>Eliminar</button>
              </div>
            );
          })}
        </div>
      ))}

      {creando && (
        <ModalCrear
          cotizacionId={creando.cotizacion_id}
          tipos={tipos}
          onClose={() => setCreando(null)}
          onDone={async () => { setCreando(null); await recargar(); setFeedback({ tipo: 'ok', msg: 'Objeción registrada' }); setTimeout(() => setFeedback(null), 3000); }}
          onError={(msg) => setFeedback({ tipo: 'err', msg })}
        />
      )}
    </div>
  );
}

function ModalCrear({ cotizacionId, tipos, onClose, onDone, onError }: {
  cotizacionId: number; tipos: { codigo: string; etiqueta: string }[];
  onClose: () => void; onDone: () => Promise<void>; onError: (msg: string) => void;
}) {
  const ctx = useContextoActivo();
  const [tipo, setTipo] = useState('');
  const [texto, setTexto] = useState('');
  const [respuesta, setRespuesta] = useState('');
  const [resultado, setResultado] = useState<'resuelto' | 'persiste' | 'cliente_se_fue' | 'pendiente'>('pendiente');

  async function guardar() {
    if (!tipo) {
      onError('Seleccioná un tipo de objeción primero.');
      return;
    }
    try {
      await crearObjecion({
        cotizacion_id: cotizacionId,
        persona_id: ctx.personaActivaId,
        tipo_objecion_codigo: tipo,
        texto_cliente: texto || null,
        respuesta_dada: respuesta || null,
        resultado,
        notas: null,
      } as any);
      await onDone();
    } catch (e: any) { onError(e.message); }
  }

  return (
    <div onClick={onClose} style={overlay}>
      <div onClick={e => e.stopPropagation()} style={{ ...modalBox, maxWidth: 540 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 700 }}>Registrar objeción</h3>
        {tipos.length === 0 && (
          <div style={{ padding: 10, background: '#ffe5e5', color: 'var(--red)', borderRadius: 6, fontSize: 12, marginBottom: 12 }}>
            ⚠ No hay tipos de objeción cargados en la BD. Hablá con Claude para arreglarlo antes de continuar.
          </div>
        )}
        <Field label="Tipo">
          <select value={tipo} onChange={e => setTipo(e.target.value)} style={inp}>
            <option value="">— Seleccioná un tipo —</option>
            {tipos.map(t => <option key={t.codigo} value={t.codigo}>{t.etiqueta}</option>)}
          </select>
        </Field>
        <Field label="Frase exacta del cliente (opcional)">
          <textarea rows={2} value={texto} onChange={e => setTexto(e.target.value)} placeholder='ej. "está muy caro comparado con lo que me dijo el otro proveedor"' style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>
        <Field label="¿Qué se respondió?">
          <textarea rows={2} value={respuesta} onChange={e => setRespuesta(e.target.value)} placeholder="ej. Le ofrecí descuento del 10% si paga al contado" style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
        </Field>
        <Field label="Resultado">
          <select value={resultado} onChange={e => setResultado(e.target.value as any)} style={inp}>
            <option value="pendiente">Pendiente / no respondió aún</option>
            <option value="resuelto">Resuelto / aceptó</option>
            <option value="persiste">Persiste / sigue dudando</option>
            <option value="cliente_se_fue">Cliente se fue</option>
          </select>
        </Field>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button onClick={onClose} style={btnSec}>Cancelar</button>
          <button onClick={guardar} style={btnPrim}>✓ Guardar</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 10 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      {children}
    </label>
  );
}
const inp: React.CSSProperties = { padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'white', outline: 'none' };
const btnPrim: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' };
const btnSec: React.CSSProperties = { padding: '7px 14px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' };
const miniBtnDanger: React.CSSProperties = { padding: '3px 8px', fontSize: 10, fontWeight: 500, background: 'white', color: 'var(--red)', border: '1px solid var(--red)', borderRadius: 4, cursor: 'pointer' };
const overlay: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 };
const modalBox: React.CSSProperties = { background: 'white', borderRadius: 10, padding: 24, width: '90%', maxWidth: 720, maxHeight: '90vh', overflow: 'auto', boxShadow: '0 10px 40px rgba(0,0,0,0.2)' };
