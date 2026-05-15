/**
 * A1_AUDIO — wrapper de transcripción de audios al pipeline.
 *
 * Realidad operativa: el worker_pipeline_v2 corre SERVER-SIDE y NO puede
 * descargar el binario de audio de WhatsApp (las URLs CDN expiran y requieren
 * cookies de la sesión del usuario). La transcripción real la hace la EXTENSIÓN
 * del lado del browser usando el botón "Transcribir media" (F2.3), que llama
 * a Whisper vía /api/transcribe y guarda el texto en `mensajes.metadata.ai_text`.
 *
 * Este agente:
 *   - Si el mensaje audio ya tiene `metadata.ai_text` → emite evento dato_extraido
 *     con la transcripción + duración estimada (cero costo, no llama a Whisper).
 *   - Si NO tiene transcripción → emite evento dato_extraido con
 *     pendiente_transcripcion=true y confianza=DUDOSO. El pipeline continúa.
 *     Jhon va a Vistas globales → Transcripciones y dispara la transcripción
 *     manualmente; en la próxima corrida A1_AUDIO encuentra el texto y lo emite.
 *
 * Usa procesarSinLLM (no pasa por DeepSeek — ahorra tokens innecesarios).
 *
 * FUTURO (v2): si subimos blobs de audio a Supabase Storage al ingestar,
 * A1_AUDIO podría llamar a whisperTranscribe() directamente con el buffer.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks, ResultadoNoLLM } from '../lib/runner.js';
import { ValidacionError, type OutputAgente } from '../lib/validador.js';

interface DatosA1Audio {
  canal_msg_id: string;
  texto_caption: string | null;
  tipo: string;
  media_mime: string | null;
  metadata: any;
}

export const a1AudioHooks: AgenteHooks<DatosA1Audio> = {
  async cargarContexto(sb, params) {
    const { data: evt, error: eErr } = await sb.from('evento_pg')
      .select('evidencia_ids, ts_canal, payload, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    if (eErr || !evt) throw new Error(`evento ${params.evento_id} no encontrado: ${eErr?.message}`);

    // Eventos originales (mensaje_entrante/saliente) traen canal_msg_id directo;
    // eventos derivados traen evidencia_ids.msg_ids. Tomar el primero disponible.
    const evidIds = (evt.evidencia_ids as any)?.msg_ids ?? [];
    const msgIdPrincipal: string | null = evidIds[0] ?? evt.canal_msg_id ?? null;
    if (!msgIdPrincipal) throw new Error(`evento ${params.evento_id} sin canal_msg_id ni evidencia_ids.msg_ids`);

    const { data: m, error: mErr } = await sb.from('mensajes')
      .select('canal_msg_id, tipo, texto, media_mime, metadata')
      .eq('chat_id', params.chat_id)
      .eq('canal_msg_id', msgIdPrincipal)
      .is('deleted_at', null)
      .single();
    if (mErr || !m) throw new Error(`mensaje ${msgIdPrincipal} no encontrado: ${mErr?.message}`);

    if (m.tipo !== 'audio') {
      throw new Error(`mensaje ${msgIdPrincipal} no es audio (tipo=${m.tipo}). A1_AUDIO solo procesa audios.`);
    }

    return {
      canal_msg_id: m.canal_msg_id,
      texto_caption: m.texto, // los audios suelen no tener caption, pero por las dudas
      tipo: m.tipo,
      media_mime: m.media_mime,
      metadata: m.metadata ?? {},
    };
  },

  async procesarSinLLM(_sb: SupabaseClient, datos: DatosA1Audio, _agente, _params): Promise<ResultadoNoLLM> {
    const t0 = Date.now();
    const aiText: string | null = datos.metadata?.ai_text ?? null;
    const aiStatus: string | null = datos.metadata?.ai_status ?? null;
    const duracion: number | null = datos.metadata?.duration ?? datos.metadata?.duration_seconds ?? null;

    let output: OutputAgente;

    if (aiText && typeof aiText === 'string' && aiText.trim().length > 0) {
      // Caso feliz: ya hay transcripción de la extensión.
      // Coherencia: CONFIRMADO (dato listo downstream, no aporta revisar humano).
      output = {
        tipo_evento: 'dato_extraido',
        confianza: 'CONFIRMADO',
        payload: {
          tipo_subevento: 'transcripcion_audio',
          transcripcion: aiText.trim(),
          duracion_segundos: duracion,
          idioma_estimado: 'es',
          fuente: 'extension_whisper',
          ai_status: aiStatus,
          resumen: `Audio transcrito (${aiText.trim().length} chars${duracion ? `, ~${Math.round(duracion)}s` : ''})`,
        },
        evidencia_msg_ids: [datos.canal_msg_id],
        reglas_aplicadas: ['R-001'],
      };
    } else {
      // Sin transcripción: emitir evento "pendiente". Confianza DUDOSO permite
      // payload sin evidencia citable de texto (el msg_id sigue siendo del audio).
      output = {
        tipo_evento: 'dato_extraido',
        confianza: 'DUDOSO',
        payload: {
          tipo_subevento: 'transcripcion_audio_pendiente',
          transcripcion: null,
          pendiente_transcripcion: true,
          motivo: aiStatus === 'failed' ? 'transcripcion_extension_fallo'
                : aiStatus === 'queued' ? 'en_cola_extension'
                : aiStatus === 'skipped_cdn_lost' ? 'cdn_whatsapp_expiro'
                : aiStatus === 'skipped_no_media' ? 'sin_blob_audio'
                : aiStatus === 'skipped_too_large' ? 'audio_muy_grande'
                : aiStatus ? `extension_status:${aiStatus}`
                : 'no_disparada_aun',
          ai_status: aiStatus,
          duracion_segundos: duracion,
          media_mime: datos.media_mime,
          resumen: `Audio sin transcribir (${aiStatus ?? 'sin estado'}) — Jhon: dispará en Vistas globales > Transcripciones`,
        },
        evidencia_msg_ids: [datos.canal_msg_id],
        reglas_aplicadas: ['R-001'],
      };
    }

    return {
      output,
      costo_usd: 0,                  // cero — solo lee BD
      latencia_ms: Date.now() - t0,
      modelo: 'lookup_ai_text',
    };
  },

  validarOutputEspecifico(out, datos) {
    const payload = out.payload as any;
    const ok = payload?.tipo_subevento === 'transcripcion_audio' || payload?.tipo_subevento === 'transcripcion_audio_pendiente';
    if (!ok) throw new ValidacionError('schema',
      `payload.tipo_subevento debe ser transcripcion_audio[_pendiente]; got ${payload?.tipo_subevento}`);
    if (!out.evidencia_msg_ids?.includes(datos.canal_msg_id)) {
      throw new ValidacionError('R-001', 'evidencia_msg_ids debe incluir el msg_id del audio');
    }
    if (payload.tipo_subevento === 'transcripcion_audio' && typeof payload.transcripcion !== 'string') {
      throw new ValidacionError('schema', 'transcripcion_audio sin string transcripcion');
    }
    // Coherencia mecánica:
    //   - transcripcion_audio (con texto) → CONFIRMADO (dato listo, sin buzón)
    //   - transcripcion_audio_pendiente   → DUDOSO (Jhon dispara transcripción manual)
    if (payload.tipo_subevento === 'transcripcion_audio' && out.confianza !== 'CONFIRMADO') {
      throw new ValidacionError('coherencia-a1au',
        `transcripcion_audio requiere out.confianza='CONFIRMADO', recibido '${out.confianza}'`);
    }
    if (payload.tipo_subevento === 'transcripcion_audio_pendiente' && out.confianza !== 'DUDOSO') {
      throw new ValidacionError('coherencia-a1au',
        `transcripcion_audio_pendiente requiere out.confianza='DUDOSO', recibido '${out.confianza}'`);
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    // L1: solo emite evento. La transcripción ya vive en mensajes.metadata.ai_text.
    // El pipeline puede re-procesar el evento como tipo=texto en una fase posterior
    // (responsabilidad del worker, no de este agente).
    return;
  },
};
