/**
 * A1_OCR — wrapper de extracción de texto de imágenes + clasificación de tipo.
 *
 * Como con A1_AUDIO: la extensión ya pasó la imagen por Vision API
 * (gpt-4o-mini) y guardó la descripción en `mensajes.metadata.ai_text`.
 * Este agente NO re-procesa la imagen — solo lee lo que ya pagaste.
 *
 * Aporte propio (sin costo IA, solo regex sobre el ai_text):
 *   - Clasifica `tipo_imagen` para que el routing del PIPE_IMAGEN sepa qué
 *     ruta seguir:
 *       · "comprobante" → A5_COMPROB (validar pago)
 *       · "medida"      → A1_MEDIDAS + A6_MEDIDAS
 *       · "garantia"    → A8_GARANTIA
 *       · "cotizacion"  → cotización ajena (referencia externa)
 *       · "producto"    → foto del producto/instalación
 *       · "otro"        → no se sabe / no aplica
 *
 * Si no hay `ai_text` aún (Vision no se ha disparado), emite evento
 * pendiente con confianza=DUDOSO y motivo del estado.
 *
 * Usa procesarSinLLM. Costo: $0 por invocación.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AgenteHooks, ResultadoNoLLM } from '../lib/runner.js';
import { ValidacionError, type OutputAgente } from '../lib/validador.js';

const TIPOS_IMAGEN = ['comprobante', 'medida', 'garantia', 'cotizacion', 'producto', 'otro'] as const;
type TipoImagen = typeof TIPOS_IMAGEN[number];

interface DatosA1Ocr {
  canal_msg_id: string;
  texto_caption: string | null;   // caption del mensaje si lo tiene
  media_mime: string | null;
  metadata: any;
}

/**
 * Heurística regex sobre el ai_text + caption para clasificar la imagen.
 * Orden: el primero que matchea gana. Las reglas más específicas van primero.
 */
function clasificarTipoImagen(aiText: string, caption: string | null): { tipo: TipoImagen; confianza: 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO'; senales: string[] } {
  const full = ((aiText ?? '') + ' ' + (caption ?? '')).toLowerCase();
  const senales: string[] = [];

  // ─── COMPROBANTE: muy específico, alta confianza ───
  // Señales fuertes: nombre de banco + monto + número de referencia o cuenta
  const tieneBanco = /\b(bancolombia|davivienda|daviplata|nequi|banco\s+de\s+bogot[aá]|av\s*villas|bbva|colpatria|banco\s+caja\s+social|banco\s+popular|scotiabank|itau)\b/i.test(full);
  const tieneTransfer = /\b(transferencia|consignaci[oó]n|consigna|abono|transferi|pago\s+exitoso|operaci[oó]n\s+exitosa)\b/i.test(full);
  const tieneRef = /\b(referencia|n[uú]mero\s+de\s+operaci[oó]n|comprobante\s+#?\s*\d+|cus|nro|aprobaci[oó]n)\b/i.test(full);
  const tieneMonto = /\$\s*[\d.,]+|[\d.]{4,}\s*(?:pesos|cop)/i.test(full);

  if ((tieneBanco && tieneMonto) || (tieneTransfer && tieneMonto) || (tieneBanco && tieneRef)) {
    if (tieneBanco) senales.push('banco_mencionado');
    if (tieneTransfer) senales.push('palabra_transferencia');
    if (tieneRef) senales.push('numero_referencia');
    if (tieneMonto) senales.push('monto_visible');
    return { tipo: 'comprobante', confianza: 'CONFIRMADO', senales };
  }
  // Comprobante con menos señales
  if (tieneTransfer || (tieneBanco && /\d{4,}/.test(full))) {
    if (tieneTransfer) senales.push('palabra_transferencia');
    if (tieneBanco) senales.push('banco_mencionado');
    return { tipo: 'comprobante', confianza: 'INFERIDO', senales };
  }

  // ─── MEDIDA: foto/captura de cinta métrica o anotación ───
  const tieneMedida = /\b\d+(?:[.,]\d+)?\s*(?:cm|m|metros?|cms?|mts?)\b/i.test(full)
                  || /\d+\s*(?:x|×|por)\s*\d+/i.test(full)
                  || /\b(?:ancho|alto|largo|profundidad)\s*[:=]?\s*\d/i.test(full);
  const palabraMedida = /\b(?:medida|mide|miden|cinta\s+m[eé]trica|metro\s+l[aá]ser|fluxometro|fluxa)\b/i.test(full);
  if (tieneMedida && palabraMedida) {
    senales.push('numero_con_unidad', 'palabra_medida');
    return { tipo: 'medida', confianza: 'CONFIRMADO', senales };
  }
  if (tieneMedida) {
    senales.push('numero_con_unidad');
    return { tipo: 'medida', confianza: 'INFERIDO', senales };
  }
  if (palabraMedida) {
    senales.push('palabra_medida');
    return { tipo: 'medida', confianza: 'DUDOSO', senales };
  }

  // ─── GARANTÍA: falla / daño visible ───
  const palabraGarantia = /\b(?:da[ñn]ad[oa]|roto|romp[ie]|no\s+(?:sirve|funciona|cierra|abre|sube|baja)|qued[oó]\s+mal|falla|defect[oa]|reclamo|garant[ií]a)\b/i.test(full);
  if (palabraGarantia) {
    senales.push('palabra_falla');
    return { tipo: 'garantia', confianza: 'INFERIDO', senales };
  }

  // ─── COTIZACIÓN AJENA: foto/captura de cotización de competencia ───
  const palabraCot = /\b(?:cotizaci[oó]n|cotizar|presupuesto|propuesta\s+comercial|or[ií]gen\s+homecenter|sodimac|easy\b|catedral|el\s+arroyo)\b/i.test(full);
  if (palabraCot && /\$\s*[\d.,]+/.test(full)) {
    senales.push('palabra_cotizacion', 'monto');
    return { tipo: 'cotizacion', confianza: 'INFERIDO', senales };
  }

  // ─── PRODUCTO/INSTALACIÓN: foto del producto físico ───
  const palabraProd = /\b(?:persiana|cortina|enrollable|blackout|screen|sheer|panel\s+japon[eé]s|toldo|vertical|ventana|pel[ií]cula\s+solar|riel|motor|tela)\b/i.test(full);
  if (palabraProd) {
    senales.push('palabra_producto');
    return { tipo: 'producto', confianza: 'INFERIDO', senales };
  }

  // ─── Default ───
  return { tipo: 'otro', confianza: 'DUDOSO', senales: [] };
}

export const a1OcrHooks: AgenteHooks<DatosA1Ocr> = {
  async cargarContexto(sb, params) {
    const { data: evt, error: eErr } = await sb.from('evento_pg')
      .select('evidencia_ids, payload, canal_msg_id')
      .eq('id', params.evento_id)
      .single();
    if (eErr || !evt) throw new Error(`evento ${params.evento_id} no encontrado: ${eErr?.message}`);

    // Eventos originales (mensaje_entrante/saliente) traen canal_msg_id directo
    // en la columna; los eventos derivados de agentes traen evidencia_ids.msg_ids.
    // Tomar lo primero que exista.
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

    if (m.tipo !== 'imagen') {
      throw new Error(`mensaje ${msgIdPrincipal} no es imagen (tipo=${m.tipo}). A1_OCR solo procesa imágenes.`);
    }

    return {
      canal_msg_id: m.canal_msg_id,
      texto_caption: m.texto,           // caption del usuario al adjuntar la imagen
      media_mime: m.media_mime,
      metadata: m.metadata ?? {},
    };
  },

  async procesarSinLLM(_sb: SupabaseClient, datos: DatosA1Ocr, _agente, _params): Promise<ResultadoNoLLM> {
    const t0 = Date.now();
    const aiText: string | null = datos.metadata?.ai_text ?? null;
    const aiStatus: string | null = datos.metadata?.ai_status ?? null;
    const aiKind: string | null = datos.metadata?.ai_kind ?? null;

    let output: OutputAgente;

    if (aiText && typeof aiText === 'string' && aiText.trim().length > 0) {
      // Clasificar tipo de imagen
      const clasif = clasificarTipoImagen(aiText, datos.texto_caption);

      output = {
        tipo_evento: 'dato_extraido',
        confianza: clasif.confianza,
        payload: {
          tipo_subevento: 'ocr_imagen',
          tipo_imagen: clasif.tipo,        // PARA EL ROUTING del PIPE_IMAGEN
          texto_ocr: aiText.trim(),
          caption_cliente: datos.texto_caption,
          senales_clasificacion: clasif.senales,
          fuente: 'extension_vision',
          ai_kind: aiKind,
          media_mime: datos.media_mime,
          resumen: `Imagen tipo "${clasif.tipo}" (${clasif.confianza}) — ${aiText.trim().length} chars OCR`,
        },
        evidencia_msg_ids: [datos.canal_msg_id],
        reglas_aplicadas: ['R-001'],
      };
    } else {
      // Sin ai_text
      output = {
        tipo_evento: 'dato_extraido',
        confianza: 'DUDOSO',
        payload: {
          tipo_subevento: 'ocr_imagen_pendiente',
          tipo_imagen: 'otro',              // routing → ruta default (sin agente)
          texto_ocr: null,
          pendiente_ocr: true,
          motivo: aiStatus === 'failed' ? 'vision_extension_fallo'
                : aiStatus === 'queued' ? 'en_cola_extension'
                : aiStatus === 'skipped_cdn_lost' ? 'cdn_whatsapp_expiro'
                : aiStatus === 'skipped_no_media' ? 'sin_blob_imagen'
                : aiStatus === 'skipped_too_large' ? 'imagen_muy_grande'
                : aiStatus ? `extension_status:${aiStatus}`
                : 'no_disparada_aun',
          ai_status: aiStatus,
          caption_cliente: datos.texto_caption,
          media_mime: datos.media_mime,
          resumen: `Imagen sin OCR (${aiStatus ?? 'sin estado'}) — Jhon: dispará en Vistas globales > Transcripciones`,
        },
        evidencia_msg_ids: [datos.canal_msg_id],
        reglas_aplicadas: ['R-001'],
      };
    }

    return {
      output,
      costo_usd: 0,
      latencia_ms: Date.now() - t0,
      modelo: 'lookup_ai_text+heuristica',
    };
  },

  validarOutputEspecifico(out, datos) {
    const p = out.payload as any;
    const ok = p?.tipo_subevento === 'ocr_imagen' || p?.tipo_subevento === 'ocr_imagen_pendiente';
    if (!ok) throw new ValidacionError('schema',
      `payload.tipo_subevento debe ser ocr_imagen[_pendiente]; got ${p?.tipo_subevento}`);
    if (!TIPOS_IMAGEN.includes(p.tipo_imagen)) {
      throw new ValidacionError('schema',
        `tipo_imagen inválido: ${JSON.stringify(p.tipo_imagen)} (válidos: ${TIPOS_IMAGEN.join(',')})`);
    }
    if (!out.evidencia_msg_ids?.includes(datos.canal_msg_id)) {
      throw new ValidacionError('R-001', 'evidencia_msg_ids debe incluir el msg_id de la imagen');
    }
    if (p.tipo_subevento === 'ocr_imagen' && typeof p.texto_ocr !== 'string') {
      throw new ValidacionError('schema', 'ocr_imagen sin string texto_ocr');
    }
    // Coherencia: pendiente → siempre DUDOSO
    if (p.tipo_subevento === 'ocr_imagen_pendiente' && out.confianza !== 'DUDOSO') {
      throw new ValidacionError('coherencia-a1ocr',
        `ocr_imagen_pendiente requiere out.confianza='DUDOSO', recibido '${out.confianza}'`);
    }
    // Si hay OCR, confianza viene de clasificarTipoImagen y solo puede ser
    // CONFIRMADO/INFERIDO/DUDOSO (nunca ALERTA/RECHAZADO).
    if (p.tipo_subevento === 'ocr_imagen' &&
        !['CONFIRMADO', 'INFERIDO', 'DUDOSO'].includes(out.confianza)) {
      throw new ValidacionError('coherencia-a1ocr',
        `ocr_imagen requiere out.confianza ∈ {CONFIRMADO, INFERIDO, DUDOSO}, recibido '${out.confianza}'`);
    }
  },

  async postProcesar(_sb: SupabaseClient, _out, _ctx) {
    return;
  },
};

// Export helper para tests
export { clasificarTipoImagen };
