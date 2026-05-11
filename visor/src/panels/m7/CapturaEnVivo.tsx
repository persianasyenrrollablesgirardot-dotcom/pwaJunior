/**
 * 7.4 Captura en vivo — upload manual de audio + opción transcribir.
 *
 * NO es captura en VIVO de llamada (eso requiere infra telefónica). Pero sí
 * permite que Jhon o un técnico grabe un audio en el celular, lo suba acá, y
 * automáticamente quede transcrito en BD como evidencia tipo=audio.
 *
 * Workflow:
 *   1. Click "📎 Adjuntar audio" → file input
 *   2. Convertimos a base64 (data URL)
 *   3. (futuro) llamar al endpoint local de Whisper para transcribir
 *   4. Guardar en tabla evidencias con texto_extraido = transcripción
 */
import { useState } from 'react';
import { useContextoActivo } from '../../lib/contexto_activo';
import { crearEvidencia } from '../../lib/queries';

export function CapturaEnVivo() {
  const ctx = useContextoActivo();
  const [file, setFile] = useState<File | null>(null);
  const [descripcion, setDescripcion] = useState('');
  const [textoManual, setTextoManual] = useState('');
  const [transcribiendo, setTranscribiendo] = useState(false);
  const [guardando, setGuardando] = useState(false);
  const [feedback, setFeedback] = useState<{ tipo: 'ok' | 'err'; msg: string } | null>(null);

  function fb(tipo: 'ok' | 'err', msg: string) {
    setFeedback({ tipo, msg });
    setTimeout(() => setFeedback(null), 4000);
  }

  async function transcribir() {
    if (!file) { fb('err', 'Adjuntá un audio primero'); return; }
    setTranscribiendo(true);
    try {
      // Endpoint local: Vite plugin /api/transcribe (futuro). Por ahora pide al
      // usuario que pegue el texto manualmente o use la transcripción de WA.
      const form = new FormData();
      form.append('audio', file);
      const r = await fetch('/api/transcribe', { method: 'POST', body: form });
      if (!r.ok) throw new Error(`transcribe endpoint: ${r.status}`);
      const { texto } = await r.json();
      setTextoManual(texto ?? '');
      fb('ok', 'Audio transcrito ✓');
    } catch (e: any) {
      fb('err', `Transcripción automática no disponible aún. Pegá el texto a mano abajo. (${e.message})`);
    } finally { setTranscribiendo(false); }
  }

  async function guardar() {
    if (!file) { fb('err', 'Adjuntá un audio primero'); return; }
    if (ctx.personaActivaId == null) { fb('err', 'Sin cliente activo'); return; }
    setGuardando(true);
    try {
      // Convertir a base64 data URL para evitar storage externo (MVP)
      const url = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      await crearEvidencia({
        persona_id: ctx.personaActivaId,
        tipo: 'audio',
        url,
        mime: file.type,
        bytes: file.size,
        descripcion: descripcion || file.name,
        capturado_por: 'jhon',
        texto_extraido: textoManual || null,
      });
      setFile(null); setDescripcion(''); setTextoManual('');
      fb('ok', 'Evidencia guardada ✓');
    } catch (e: any) { fb('err', e.message); }
    finally { setGuardando(false); }
  }

  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ margin: '0 0 8px', fontSize: 16, fontWeight: 600 }}>
        Captura manual de audio — {ctx.personaActivaNombre}
      </h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Subí un audio grabado afuera del sistema (nota de voz, grabación de visita técnica) y queda como evidencia indexada del cliente.
      </p>

      {feedback && (
        <div style={{ padding: 10, borderRadius: 6, marginBottom: 12, fontSize: 12,
          background: feedback.tipo === 'ok' ? '#e8f8ee' : '#ffe5e5',
          color: feedback.tipo === 'ok' ? 'var(--green)' : 'var(--red)' }}>{feedback.msg}</div>
      )}

      <div style={{ background: 'var(--bg-panel)', border: '1px solid var(--border-soft)', borderRadius: 8, padding: 16, marginBottom: 16 }}>
        <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>
          Archivo de audio
        </label>
        <input type="file" accept="audio/*" onChange={e => setFile(e.target.files?.[0] ?? null)}
          style={{ display: 'block', padding: 8, border: '1px dashed var(--border)', borderRadius: 6, width: '100%' }} />
        {file && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            📎 {file.name} · {(file.size / 1024).toFixed(0)}KB · {file.type}
          </div>
        )}
        {file && (
          <audio controls src={URL.createObjectURL(file)} style={{ width: '100%', marginTop: 8 }} />
        )}
      </div>

      <Field label="Descripción">
        <input value={descripcion} onChange={e => setDescripcion(e.target.value)} placeholder="ej. Audio del cliente confirmando medidas finales" style={inp} />
      </Field>

      <Field label="Texto transcrito (pegar manualmente o usar transcripción automática)">
        <textarea rows={5} value={textoManual} onChange={e => setTextoManual(e.target.value)}
          placeholder="Acá va el texto que dijo el cliente en el audio." style={{ ...inp, fontFamily: 'inherit', resize: 'vertical' }} />
      </Field>

      <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
        <button onClick={transcribir} disabled={!file || transcribiendo} style={{ ...btnSec, opacity: !file || transcribiendo ? 0.5 : 1 }}>
          {transcribiendo ? 'Transcribiendo…' : '🤖 Transcribir auto (Whisper)'}
        </button>
        <button onClick={guardar} disabled={!file || guardando} style={{ ...btnPrim, opacity: !file || guardando ? 0.5 : 1, marginLeft: 'auto' }}>
          {guardando ? 'Guardando…' : '✓ Guardar evidencia'}
        </button>
      </div>

      <div style={{ marginTop: 24, padding: 12, background: 'var(--bg-panel)', border: '1px dashed var(--border)', borderRadius: 8, fontSize: 11, color: 'var(--text-muted)' }}>
        ℹ <strong>Transcripción automática</strong>: hoy usa el endpoint <code>/api/transcribe</code> (Vite plugin
        que delega a OpenAI Whisper). Si no está activo, pegá la transcripción a mano. <strong>Captura de llamadas
        en vivo</strong> (telefonía SIP, grabación automática) está fuera del scope del MVP — requiere infra externa.
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 12 }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
      {children}
    </label>
  );
}
const inp: React.CSSProperties = { padding: '6px 10px', fontSize: 12, border: '1px solid var(--border)', borderRadius: 6, background: 'white', outline: 'none' };
const btnPrim: React.CSSProperties = { padding: '8px 14px', fontSize: 12, fontWeight: 600, background: 'var(--accent)', color: 'white', border: 'none', borderRadius: 6, cursor: 'pointer' };
const btnSec: React.CSSProperties = { padding: '8px 14px', fontSize: 12, fontWeight: 500, background: 'var(--bg-page)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer' };
