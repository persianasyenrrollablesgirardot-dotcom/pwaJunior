/**
 * Cliente DeepSeek con tope hard de costo, retry, timeout, log de uso.
 * Usado por todos los agentes IA del enjambre.
 *
 * Modelo: deepseek-chat
 *   - Pricing: $0.27/M tokens entrada · $1.10/M tokens salida (cached miss)
 *   - $0.07/M cached hit (prompts repetidos)
 *
 * Reglas duras (de ARQUITECTURA.md):
 *   R-costo: tope hard de $0.05 por invocación. Si excede → throw.
 *   R-anti-alucinación: el caller debe pasar el output por validador después.
 */

import 'dotenv/config';

const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? process.env.VITE_DEEPSEEK_API_KEY;

if (!DEEPSEEK_KEY) {
  throw new Error('Falta DEEPSEEK_API_KEY en .env');
}

// Pricing en USD por millón de tokens
const PRICING = {
  'deepseek-chat': {
    input_miss: 0.27 / 1_000_000,
    input_hit:  0.07 / 1_000_000,
    output:     1.10 / 1_000_000,
  },
} as const;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DeepSeekOptions {
  model?: 'deepseek-chat';
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: 'json_object' };
  /** Tope hard de costo en USD. Default $0.05 (R-costo). */
  costoLimiteUsd?: number;
  /** Reintentos en errores 429 / 5xx / timeout. Default 2. */
  reintentos?: number;
  /** Timeout en ms. Default 60s. */
  timeoutMs?: number;
  /** Etiqueta para logs (ej: 'A5_cotizaciones'). */
  agente?: string;
}

export interface DeepSeekResult {
  contenido: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  costo_usd: number;
  latencia_ms: number;
  intentos: number;
  modelo: string;
}

const COSTO_LIMITE_DEFAULT = 0.05;
const TIMEOUT_DEFAULT_MS   = 60_000;
const REINTENTOS_DEFAULT   = 2;

/**
 * Llama a DeepSeek y retorna el contenido + métricas.
 * Lanza error si: tope superado, falla tras N reintentos, timeout.
 */
export async function deepseekChat(opts: DeepSeekOptions): Promise<DeepSeekResult> {
  const model = opts.model ?? 'deepseek-chat';
  const tope = opts.costoLimiteUsd ?? COSTO_LIMITE_DEFAULT;
  const timeout = opts.timeoutMs ?? TIMEOUT_DEFAULT_MS;
  const maxIntentos = (opts.reintentos ?? REINTENTOS_DEFAULT) + 1;
  const tag = opts.agente ?? 'llm';

  const body: any = {
    model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.2,
  };
  if (opts.max_tokens) body.max_tokens = opts.max_tokens;
  if (opts.response_format) body.response_format = opts.response_format;

  let ultimoError: Error | null = null;

  for (let intento = 1; intento <= maxIntentos; intento++) {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);

    try {
      const r = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + DEEPSEEK_KEY,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      const latencia_ms = Date.now() - t0;

      if (r.status === 429 || r.status >= 500) {
        // Retry-able
        ultimoError = new Error(`DeepSeek HTTP ${r.status}`);
        if (intento < maxIntentos) {
          const backoff = Math.min(1000 * Math.pow(2, intento - 1), 8000);
          await new Promise(res => setTimeout(res, backoff));
          continue;
        }
        throw ultimoError;
      }

      if (!r.ok) {
        const errText = await r.text();
        throw new Error(`DeepSeek HTTP ${r.status}: ${errText.slice(0, 300)}`);
      }

      const j: any = await r.json();
      const u = j.usage || {};
      const tokens_in = u.prompt_tokens ?? 0;
      const tokens_out = u.completion_tokens ?? 0;
      const tokens_cached = u.prompt_cache_hit_tokens ?? 0;
      const tokens_uncached = tokens_in - tokens_cached;

      const pricing = PRICING[model];
      const costo_usd =
        tokens_uncached * pricing.input_miss +
        tokens_cached * pricing.input_hit +
        tokens_out * pricing.output;

      // Tope hard
      if (costo_usd > tope) {
        throw new Error(`[${tag}] ABORT: costo $${costo_usd.toFixed(6)} excede tope $${tope.toFixed(4)}`);
      }

      const contenido = j.choices?.[0]?.message?.content;
      if (typeof contenido !== 'string') {
        throw new Error(`[${tag}] respuesta sin contenido: ${JSON.stringify(j).slice(0, 200)}`);
      }

      console.log(`[${tag}] DeepSeek ✓ ${latencia_ms}ms · in=${tokens_in}(cached=${tokens_cached}) out=${tokens_out} · $${costo_usd.toFixed(6)} · intento=${intento}`);

      return {
        contenido,
        tokens_in,
        tokens_out,
        tokens_cached,
        costo_usd,
        latencia_ms,
        intentos: intento,
        modelo: model,
      };
    } catch (e: any) {
      clearTimeout(timer);
      ultimoError = e;
      if (e.name === 'AbortError') ultimoError = new Error(`DeepSeek timeout ${timeout}ms`);
      if (intento < maxIntentos && (e.name === 'AbortError' || e.message?.includes('fetch failed'))) {
        const backoff = Math.min(1000 * Math.pow(2, intento - 1), 8000);
        await new Promise(res => setTimeout(res, backoff));
        continue;
      }
      throw ultimoError;
    }
  }

  throw ultimoError ?? new Error('deepseekChat: fallo desconocido');
}
