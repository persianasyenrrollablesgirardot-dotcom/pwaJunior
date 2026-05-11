/**
 * Cliente OpenAI para Whisper (audios) + Vision (imágenes).
 * Usado por el agente Transcribor.
 *
 * Pricing actual (mayo 2026):
 *   - Whisper: $0.006/minuto de audio
 *   - gpt-4o-mini con imagen: $0.15/M tokens entrada · $0.60/M tokens salida
 *     (una imagen low-detail ≈ 85 tokens, high-detail ≈ 170+)
 *
 * Reglas duras:
 *   R-costo: tope hard $0.05/invocación. Si excede → throw.
 *   R-anti-alucinación: el caller debe validar el output.
 */

import 'dotenv/config';
import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import { createHash } from 'node:crypto';

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) throw new Error('Falta OPENAI_API_KEY en .env');

const client = new OpenAI({ apiKey: OPENAI_KEY });

const COSTO_LIMITE_DEFAULT = 0.05;

// ─── WHISPER (transcripción de audios) ────────────────────────────────────

export interface WhisperOptions {
  audioBuffer: Buffer;
  mimetype?: string;          // 'audio/ogg', 'audio/mpeg', 'audio/wav'
  filename?: string;          // hint para Whisper
  /** Idioma esperado (mejora precisión). Default: 'es'. */
  language?: string;
  /** Tope hard en USD. Default $0.05. */
  costoLimiteUsd?: number;
  /** Etiqueta para logs. */
  agente?: string;
}

export interface WhisperResult {
  texto: string;
  duracion_segundos: number;
  costo_usd: number;
  latencia_ms: number;
  sha256: string;
  modelo: 'whisper-1';
}

const PRICING_WHISPER_PER_SECOND = 0.006 / 60;  // $0.0001 / segundo

/**
 * Transcribe un audio con Whisper.
 * Calcula costo a partir de duración estimada + tope hard.
 */
export async function whisperTranscribe(opts: WhisperOptions): Promise<WhisperResult> {
  const tag = opts.agente ?? 'whisper';
  const tope = opts.costoLimiteUsd ?? COSTO_LIMITE_DEFAULT;
  const sha256 = createHash('sha256').update(opts.audioBuffer).digest('hex');
  const t0 = Date.now();

  // Estimación de duración: asumimos ~1 byte por 6ms de audio comprimido
  // (después corregimos con la duración real del response — Whisper la devuelve)
  const ext = opts.mimetype?.split('/')[1] ?? 'ogg';
  const filename = opts.filename ?? `audio_${sha256.slice(0, 8)}.${ext}`;

  const fileObj = await toFile(opts.audioBuffer, filename, { type: opts.mimetype });

  const r: any = await client.audio.transcriptions.create({
    file: fileObj,
    model: 'whisper-1',
    language: opts.language ?? 'es',
    response_format: 'verbose_json',  // incluye duración
  });

  const latencia_ms = Date.now() - t0;
  const duracion_segundos = r.duration ?? 0;
  const costo_usd = duracion_segundos * PRICING_WHISPER_PER_SECOND;

  if (costo_usd > tope) {
    throw new Error(`[${tag}] ABORT: costo $${costo_usd.toFixed(6)} excede tope $${tope.toFixed(4)} (audio de ${duracion_segundos}s)`);
  }

  console.log(`[${tag}] Whisper ✓ ${latencia_ms}ms · ${duracion_segundos.toFixed(1)}s audio · $${costo_usd.toFixed(6)}`);

  return {
    texto: r.text ?? '',
    duracion_segundos,
    costo_usd,
    latencia_ms,
    sha256,
    modelo: 'whisper-1',
  };
}

// ─── VISION (descripción de imágenes) ────────────────────────────────────

export interface VisionOptions {
  imageDataUrl?: string;          // 'data:image/jpeg;base64,...'
  imageUrl?: string;              // URL pública
  imageBuffer?: Buffer;           // bytes crudos (los convertimos a data url)
  mimetype?: string;              // 'image/jpeg', 'image/png'
  prompt?: string;                // qué pedirle al modelo
  detail?: 'low' | 'high' | 'auto';
  costoLimiteUsd?: number;
  agente?: string;
  max_tokens?: number;
}

export interface VisionResult {
  descripcion: string;
  tokens_in: number;
  tokens_out: number;
  costo_usd: number;
  latencia_ms: number;
  sha256: string | null;
  modelo: 'gpt-4o-mini';
}

const VISION_PROMPT_DEFAULT = `Eres asistente de Persianas Girardot (Safra), Colombia.
Describe la imagen en español, máximo 150 palabras.
Si hay TEXTO visible, transcríbelo literalmente (números, fechas, montos, referencias).
Si es comprobante de pago: extrae monto, banco, cuenta destino, referencia, fecha.
Si es persiana/cortina: tipo (blackout, screen, sheer, enrollable, panel japonés), color, ubicación.
Si es ventana/espacio: dimensiones aproximadas y tipo de espacio (sala, alcoba, oficina).
Sé directo, sin saludos.`;

const PRICING_VISION = {
  input: 0.15 / 1_000_000,
  output: 0.60 / 1_000_000,
};

export async function visionDescribe(opts: VisionOptions): Promise<VisionResult> {
  const tag = opts.agente ?? 'vision';
  const tope = opts.costoLimiteUsd ?? COSTO_LIMITE_DEFAULT;
  const detail = opts.detail ?? 'low';
  const t0 = Date.now();

  let imageInput: { url: string };
  let sha256: string | null = null;

  if (opts.imageUrl) {
    imageInput = { url: opts.imageUrl };
  } else if (opts.imageDataUrl) {
    imageInput = { url: opts.imageDataUrl };
    const base64 = opts.imageDataUrl.split(',')[1];
    if (base64) sha256 = createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
  } else if (opts.imageBuffer) {
    sha256 = createHash('sha256').update(opts.imageBuffer).digest('hex');
    const mime = opts.mimetype ?? 'image/jpeg';
    imageInput = { url: `data:${mime};base64,${opts.imageBuffer.toString('base64')}` };
  } else {
    throw new Error('vision: requiere imageUrl | imageDataUrl | imageBuffer');
  }

  const r = await client.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: opts.prompt ?? VISION_PROMPT_DEFAULT },
        { type: 'image_url', image_url: { url: imageInput.url, detail } },
      ],
    }],
    max_tokens: opts.max_tokens ?? 250,
    temperature: 0.2,
  });

  const latencia_ms = Date.now() - t0;
  const u = r.usage!;
  const tokens_in = u.prompt_tokens ?? 0;
  const tokens_out = u.completion_tokens ?? 0;
  const costo_usd = tokens_in * PRICING_VISION.input + tokens_out * PRICING_VISION.output;

  if (costo_usd > tope) {
    throw new Error(`[${tag}] ABORT: costo $${costo_usd.toFixed(6)} excede tope $${tope.toFixed(4)}`);
  }

  const descripcion = r.choices[0]?.message?.content;
  if (typeof descripcion !== 'string') {
    throw new Error(`[${tag}] vision sin contenido: ${JSON.stringify(r).slice(0, 200)}`);
  }

  console.log(`[${tag}] Vision ✓ ${latencia_ms}ms · in=${tokens_in} out=${tokens_out} · $${costo_usd.toFixed(6)} · detail=${detail}`);

  return {
    descripcion,
    tokens_in,
    tokens_out,
    costo_usd,
    latencia_ms,
    sha256,
    modelo: 'gpt-4o-mini',
  };
}
