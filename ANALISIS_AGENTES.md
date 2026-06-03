# Análisis de calidad — Enjambre Visor_PG (32 agentes, sin Junior)

**Corrida autónoma iniciada:** 2026-05-30 · SOLO LECTURA (no se modifica nada).
**Método:** señales/heurística sobre Supabase `olububjdvboiqgmihsmk`. Las transcripciones se evalúan por señales (no hay fuente original para comparar palabra por palabra).

## Universo de datos
- 93 tarjetas · 1.895 mensajes vivos · 15.892 eventos vivos
- Media: 204 audios · 138 imágenes · 31 documentos · 8 videos
- `evento_pg` tiene: `agente_origen`, `confianza`, `payload`, `tipo_evento`, `estado`, `costo_usd`, `intentos_agente` → permite auditar cada agente.

## Índice de progreso (qué ya se cubrió)
- [x] Transcripción AUDIO ✅ (ciclo 1)
- [x] Transcripción IMÁGENES ✅ (ciclo 2)
- [x] Transcripción PDF/documentos ✅ (ciclo 3)
- [x] Panorama global de agentes ✅ (ciclo 4)
- [x] A1_* (OCR, AUDIO, ENTIDADES, MEDIDAS, MONTOS) ✅ (ciclo 4)
- [x] A2_* (AMBITO, INTENCION, NOCLIENTE, ROL) ✅ (ciclo 5)
- [x] A3_* (IDENTIDAD, INMUEBLE, GEO, GRAFO) ✅ (ciclo 6)
- [x] A4_* (COTIZ, OBJECIONES, RECOMPRA, REFERIDOS, COMPAT) ✅ (ciclo 7)
- [x] A5_* (ABONO, COMPROB, CARTERA, RENTAB) ✅ (ciclo 8)
- [x] A6_* (MEDIDAS, RIESGO) ✅ (ciclo 9)
- [x] A7_* (TAREAS, ESTADO, RUTAS) ✅ (ciclo 10)
- [x] A8_* (GARANTIA, RECLAMO, SATIS, REPUT) ✅ (ciclo 11)
- [x] Resumen priorizado final ✅ (ciclo 11) — **LOOP COMPLETO**

---

## Hallazgos

### 🔴 ALTO — Transcripciones de audio no llegan a `mensajes.texto` (134 de 161)
- **161** audios tienen `metadata.ai_text` (transcripción hecha y **ya pagada a Whisper**).
- **134** están `ai_status=processed` pero con `texto` vacío o `[audio]` → la transcripción quedó **solo en metadata**, no en la columna `texto`.
- Solo **27** tienen el texto copiado correctamente.
- **Impacto:** los agentes del pipeline leen `mensajes.texto`; ~83% del contenido de audios es **invisible** para ellos. Se pierden cotizaciones, deudas, pedidos. Ejemplos reales hallados: *"mire joncito ya que el cliente ya va en camino…"*, *"¿ustedes ya manejan persiana…?"*, *"él debía $150"*.
- **Causa probable:** el flujo de procesamiento en **tiempo real** (worker/extensión `processMediaWithAI`/`syncToVisorPG`) escribe `ai_text` en metadata pero NO actualiza `texto`. El botón manual "transcribir" (`actualizarMensajeEnSupabase`) sí lo copia → de ahí los 27 OK.
- **Recomendación:** que el flujo en tiempo real copie `ai_text` → `texto` (con prefijo 🎤), igual que `actualizarMensajeEnSupabase`. Luego marcar esos 134 mensajes para re-derivar (sintesis/reprocesar) y que los agentes los reanalicen con el texto ya visible. **Verificar antes de aplicar.**

### 🟡 MEDIO — 33 audios sin pasar por IA (`ai_status` ausente)
- 33 de 204 audios nunca tienen `ai_status` → no se intentó transcribir. Revisar si fueron omitidos por regla (burst/forwarded) o por un hueco del flujo en tiempo real.

### ⚪ ESPERADO (no es bug) — 10 audios placeholder CDN
- 10 audios con `skipped_cdn_lost` (CDN de WhatsApp borró el archivo tras >17d). Irrecuperable por diseño; correcto.

---

### IMÁGENES (139 · 98 processed)
**Contraste clave:** las 98 imágenes processed tienen el `ai_text` copiado correctamente a `texto` (0 huérfanas). → **confirma que el bug de los 134 audios es específico del path de AUDIO/Whisper en tiempo real**, no del de Vision.

### 🟡 MEDIO — Vision rechaza describir ~5 imágenes
- 5 imágenes con `ai_text` tipo *"No puedo describir la imagen"*, *"No puedo identificar a las personas"*, *"No puedo ayudar con eso"* → gpt-4o-mini rechazó y el **rechazo se guardó como si fuera la transcripción**. Contamina el contexto de la tarjeta con texto inútil.
- **Recomendación:** detectar respuestas-rechazo (regex `no puedo (describir|identificar|ayudar)`) y (a) reintentar con prompt reforzado ("describí objetivamente lo visible: textos, medidas, productos, montos; no identifiques personas"), o (b) marcarlas como no-procesadas en vez de guardar el rechazo.

### 🟡 MEDIO — 32 imágenes sin pasar por IA (`ai_status` ausente)
- Igual que en audios (33). Hay un gap en el flujo en tiempo real que deja media sin intentar procesar. Revisar la rama de media del worker / la cola de la extensión.

---

### PDFs / DOCUMENTOS (31 · 23 processed) — el resumen funciona bien
Los resúmenes son correctos y útiles: facturas, recibos y cotizaciones de "Persianas Y Enrrollables Girardot" bien identificadas. 21/23 con el texto copiado a `texto`.

### 🟡 MEDIO — `media_mime` ausente en 27 de 31 documentos
- 27/31 docs tienen `media_mime` null. La clasificación de PDF (`clasificarMediaChat` usa `media.mimetype.includes('pdf')`) depende del mime; sin él, un documento puede **omitirse del procesamiento** o no recortarse a 2 págs. Frágil aunque 23 igual se procesaron.
- **Recomendación:** guardar `media_mime` al capturar; fallback por extensión del `file_name`.

### 🟢 BAJO — nombre de archivo vacío en el texto del PDF
- El texto sale `📎  — RESUMEN: …` sin el nombre (doble espacio). `file_name` no se captura/persiste. Cosmético, pero ayuda a identificar el documento.

### 🟡 menor — 2 PDFs con `ai_text` huérfano + 4 sin `ai_status`
- 2 docs repiten el patrón audio (ai_text sin copiar a texto); 4 nunca procesados.

---
**Resumen media (3/3 cubierto):** el bug grande es **audios** (134 huérfanos). Imágenes y PDFs copian bien el texto salvo casos puntuales. Patrón transversal: ~33 audios + 32 imágenes + 4 docs **sin `ai_status`** → hueco del flujo en tiempo real que deja media sin intentar. Y `media_mime` no se persiste en documentos.

---

## AGENTES — panorama global (15.979 eventos auditados)

### ✅ CORRECCIÓN (2026-05-30) — la confianza NO está rota (error de mi análisis)
- En el ciclo 4 reporté `confianza = "--"` porque mi script la trató como NÚMERO; en realidad es un **enum de texto** y la columna `evento_pg.confianza` **SÍ está poblada**: verificado sobre 3.000 eventos → CONFIRMADO 802 · DUDOSO 145 · RECHAZADO 40 · INFERIDO 13. **No hay bug de confianza; no requiere fix.**
- La "confianza granular en payload" (`confianza_ambito`, etc.) es solo una copia del mismo enum por agente; no se pierde información. Hallazgo retirado.

### 🔵 4 agentes con CERO eventos — CAUSA INVESTIGADA (2026-05-30): NO es bug
- **A4_RECOMPRA, A5_CARTERA, A5_RENTAB, A7_RUTAS** están activos y registrados, pero son **batch-oriented** (no corren por mensaje, no están en `PIPE_MENSAJE_COMERCIAL`). **Falta el orquestador batch (cron) que los dispare — nunca se construyó.** Ningún worker los invoca (verificado).
- Además, 3 de 4 **no tendrían datos** sobre los que correr aún:
  - **A7_RUTAS:** 0 instalaciones agendadas → nada que optimizar.
  - **A5_RENTAB:** sin costos cargados → nada que calcular.
  - **A4_RECOMPRA:** condición "cotización ganada ≥6 meses"; hay 7 ganadas pero todas recientes (sistema de mayo 2026) → no dispararía hasta dentro de meses.
  - **A5_CARTERA:** ✅ ÚNICO con datos (15 abonos → saldos cobrables). Es el candidato a activar primero.
- **Recomendación:** no construir los 4 crons ahora (3 no tienen datos = trabajo desperdiciado). Si se quiere activar uno ya, **A5_CARTERA** (recordatorios de cobro). Los otros 3 se activan cuando el negocio genere instalaciones/costos/antigüedad. Lo ideal a futuro: un único worker batch (cron diario/semanal) que itere personas y dispare estos 4 según corresponda.

### 🟡 MEDIO — agentes core con muy pocos disparos
- **A4_COTIZ 34**, **A5_COMPROB 9**, **A8_GARANTIA 13**, **A5_ABONO 42**, **A4_COMPAT 43**. Cotización y comprobantes son centrales del negocio; 9–34 eventos parece sub-disparo. Revisar sus condiciones de activación vs cuántos mensajes realmente los ameritan.
- A1_OCR procesó 96 (de 138 imágenes); A1_AUDIO 189 (de 204) — coherente con los media sin `ai_status`.

### A1_* — extracción (MONTOS, MEDIDAS, ENTIDADES, AUDIO, OCR)

### 🔴 ALTO (cascada del bug de audio) — A1 extrae vacío en mensajes sin texto
- Las muestras recientes de **A1_MONTOS, A1_MEDIDAS y A1_ENTIDADES** salen vacías (`0 extraídos` / `No se extrajeron entidades`). Parte es legítimo (charla sin montos/medidas), **pero coincide con los audios cuyo texto quedó huérfano**: si el mensaje de audio no tiene `texto`, A1 no tiene nada que leer → extrae 0 → la tarjeta queda pobre.
- **Es un efecto en cascada del bug 🔴 de audios:** arreglar el copiado `ai_text`→`texto` y re-derivar debería recuperar montos/medidas/entidades de ~134 audios con contenido comercial.
- **Por verificar (próximo refinamiento):** medir la tasa de extracción de A1 sobre mensajes que SÍ contienen `$`/medidas en el texto, para separar "sin datos" de "falla de extracción".
- Positivo: en la muestra no aparecieron montos imposibles (>50M COP) ni medidas con dígitos absurdos → cuando A1 extrae, los valores son plausibles.

### A2_* — routing / clasificación

### 🟡 MEDIO — A2_INTENCION cae en "otro" el 69%
- 206/300 intenciones = `otro`. Las útiles son minoría (cotizar 12, pagar 6, consulta_estado 5, queja 5, saludo 23). Taxonomía demasiado gruesa o clasificación pobre → poca señal para priorizar.
- **Recomendación:** ampliar la taxonomía con categorías frecuentes del negocio (pedir_medida/visita, reclamo_garantía, seguimiento, referido, negociar_precio) y agregar ejemplos few-shot en el prompt. (Parte del "otro" también puede venir de mensajes de audio sin texto — cascada del bug 🔴.)

### 🟡 MEDIO — A2_ROL deja 16% en "desconocido"
- rol_emisor: cliente 246 (82%), **desconocido 47 (16%)**, familiar 4. Cuando el rol no se resuelve, los agentes downstream pierden el "quién habla". Revisar correlación con grupos y con contactos @lid sin nombre.

### 🟢 OBSERVACIÓN — A2_NOCLIENTE asume "cliente" el 93%
- es_cliente=true en 280/300; solo 12 marcados no-cliente. Ante poca evidencia asume cliente ("asumimos cliente potencial"). Es conservador (evita perder clientes), pero **verificar falsos negativos**: spam/logística/restaurantes colados como clientes. Cruzar con los `no_cliente_tags` que detecta la extensión.

### A3_* — identidad / inmueble / geo / grafo

### 🟡 MEDIO — A3_GEO / A3_INMUEBLE / A3_GRAFO: ~96–99% "sin hallazgo" pero corren en cada mensaje
- A3_GEO 247/250 sin menciones (**0 ciudades/zonas en 250 mensajes**), A3_INMUEBLE 245/250 vacíos, A3_GRAFO 246/250 vacíos. Cada uno corre en 800+ mensajes y extrae en <4%.
- Parte es legítimo (mensajes sueltos) + cascada del bug de audio (sin texto → nada). Pero **3 llamadas LLM por mensaje para <4% de rendimiento = costo/latencia altos**.
- **Recomendaciones:** (a) **gatear** estos agentes con una pre-señal en vez de correrlos siempre: A3_GEO solo si hay lugar/dirección detectado, A3_INMUEBLE solo si hay conjunto/torre/apto, A3_GRAFO solo si hay nombres de terceros. (b) **Revisar el prompt de A3_GEO**: 0 zonas detectadas en 250 mensajes es sospechoso para un negocio con costos de traslado — verificar que reconozca barrios/conjuntos de Girardot y alrededores.

### 🟢 OK — A3_IDENTIDAD funciona
- 241/250 "sin duplicados detectados" (esperado), con `persona_actual_id` resuelto. Dedup conservador, correcto.

### A4_* — comerciales

### 🔴 ALTO (¡crítico!) — A4_COTIZ bloqueado por falso positivo del guard "Safra"
- Los **34** eventos de A4_COTIZ son TODOS `regla_violada: R-anti-contaminacion`: *"payload menciona 'Safra' que pertenece a OTRO cliente. Cross-cliente leak detectado."* Ninguna cotización real emitida.
- **Causa:** "Safra" NO es otro cliente — **es el catálogo de productos del propio negocio (Safra 2026)**. El guard anti-contaminación lo trata como nombre de cliente ajeno y **bloquea toda cotización que mencione productos Safra**.
- **Impacto:** el agente de cotización —core del negocio— está **efectivamente inutilizado**. Explica el "sub-disparo" visto en el panorama: no es que no se dispare, es que el guard lo mata cada vez.
- **Recomendación (URGENTE):** sacar "Safra" (y todos los nombres del catálogo/negocio propio) de la lista de clientes del guard `R-anti-contaminacion`; mantener una whitelist de términos del negocio. Revisar `agentes/` donde se evalúa esa regla.

### 🟡 MEDIO — A4_REFERIDOS: 0 referidos en 200 mensajes
- 200/200 `hay_referidos:false`. Nunca detecta referidos. Puede ser legítimo, pero para un negocio que vive del boca-a-boca conviene verificar el prompt (¿reconoce "me lo recomendó", "dígale que va de parte de…"?). Posible sub-detección.

### 🟢 OK / pocos disparos — A4_OBJECIONES y A4_COMPAT
- A4_OBJECIONES 181/200 "sin objeciones" (conservador, razonable). A4_COMPAT 34/43 "sin config técnica" (pocos disparos, plausible).

### 🔴 ALTO — A4_RECOMPRA: 0 eventos (confirmado)
- Nunca produjo salida. Junto a A5_CARTERA/A5_RENTAB/A7_RUTAS, revisar si está inactivo o su disparo es inalcanzable.

### A5_* — financiero

### 🟢 BIEN — A5_COMPROB es de alta calidad (pero solo 9 disparos)
- Cuando dispara, excelente: detecta montos, compara con saldo esperado y alerta diferencias. Ejemplos reales: *"$140.000 coincide con saldo esperado"*, *"$285.000 menor al saldo $571.200 — puede ser abono parcial"*, *"Bre-B $323.350 sin cotización activa con saldo"*.
- **Pocos disparos (9):** muchos comprobantes llegan como **imagen/PDF**; si esa media no se procesó (bug de transcripción / `ai_status` ausente), A5_COMPROB no los ve. → ligado al bug de media. Arreglar transcripción + re-derivar debería aumentar sus disparos.

### 🟢 OK — A5_ABONO
- 42 eventos, campos correctos (`hay_abono`, `monto_coincide_saldo`). Conservador (mayoría "no confirma pago"). Correcto.

### 🔴 ALTO — A5_CARTERA y A5_RENTAB: 0 eventos (muertos, confirmado)
- Sin un solo evento. Cartera (saldos/deudas) y Rentabilidad (márgenes) son financieros core → el negocio no tiene visibilidad automática de cartera ni rentabilidad. Revisar activación/condición de disparo.

### A6_* — técnico

### 🟢 BIEN (estructura) — A6_MEDIDAS con esquema rico
- Campos: `alto_m, ancho_m, ambiente, quien_midio, bandera_riesgo, alertas_tecnicas, medidas_adicionales`. `quien_midio` es valioso (responsabilidad en garantías). Cuando extrae, las medidas están en rango (0 absurdas).
- Muestras recientes vacías → **cascada del bug de audio**: las medidas se dictan mucho por nota de voz. Al arreglar el copiado de audio, debería capturar bastante más.

### 🟡 MEDIO — A6_RIESGO: 299/300 "sin riesgos técnicos"
- Casi nunca detecta riesgo. Puede ser legítimo (el riesgo real se evalúa en visita), pero para instalación (alturas, 2º piso, vidrio, falta de anclaje) conviene reforzar el prompt para captar señales en texto: *"muy alto", "segundo piso", "sin dónde anclar", "vidrio/terraza"*. Posible sub-detección.

### A7_* — operativo

### 🟢 OK estructura — A7_TAREAS
- 300 eventos, esquema simple (`tareas`, `resumen`). Muestras recientes sin tareas (cascada audio + mensajes sin acción). Funciona.

### 🟡 MEDIO — A7_ESTADO casi siempre "sin datos" (27 eventos)
- Genera `respuesta_propuesta.texto_whatsapp` pero con `estado_actual="desconocido"/"sin_datos"` → no tiene de dónde leer el estado real de producción/instalación, así que propone seguimientos genéricos ("Hola, estoy revisando…"). Solo aporta si se le conecta una fuente de estado real (producción/agenda de instalación).

### 🔴 ALTO — A7_RUTAS: 0 eventos (4º agente muerto, confirmado)
- Completa el grupo de **4 muertos**: A4_RECOMPRA, A5_CARTERA, A5_RENTAB, A7_RUTAS.

### A8_* — postventa

### 🔴 ALTO — A8_REPUT 100% bloqueado por el guard anti-alucinación
- Los **300** eventos son `regla_violada: R-anti-alucinacion`: *"confianza=CONFIRMADO requiere evidencia_msg_ids (al menos 1 msg_id citado)"*. El agente marca CONFIRMADO pero **no cita los msg_ids de evidencia** → el guard lo rechaza siempre. A8_REPUT **inutilizado** (mismo patrón "el guard mata al agente" que A4_COTIZ).
- **Recomendación:** que A8_REPUT incluya `evidencia_msg_ids` cuando confirme, o que baje a confianza no-CONFIRMADO si no tiene cita.

### 🔴 ALTO — el guard "Safra" también golpea A8_GARANTIA (es transversal)
- Al menos un evento de A8_GARANTIA es rechazo `R-anti-contaminacion` por "Safra". → el falso positivo del catálogo **no es exclusivo de A4_COTIZ: bloquea a CUALQUIER agente** cuyo output mencione productos Safra. Sube la prioridad del fix del guard.

### 🟢 BIEN — A8_RECLAMO de alta calidad (37)
- Detecta reclamos reales con motivo y severidad: *"Reclamo por extravío de dos cajas de cortinas, cliente molesto pero sin amenaza pública, severidad media"*. Muy útil para postventa.

### 🟢 OK — A8_SATIS (300)
- `aplica:false` "sin instalación reciente". Correcto estructuralmente, pero (como A7_ESTADO) **depende de saber si hubo instalación** — sin datos de producción/instalación, casi nunca aplica.

---

# 🏁 RESUMEN FINAL PRIORIZADO

**Cobertura:** 3/3 clases de media + panorama global + los 32 agentes (sin Junior). ~16.000 eventos auditados. Solo lectura.

**Diagnóstico de fondo:** dos *familias* de problemas explican casi todo — (A) **guards que matan a sus propios agentes** por falsos positivos, y (B) **media (sobre todo audio) que no llega como texto a los agentes**, degradando en cascada a los extractores.

## 🔴 ALTO impacto (arreglar primero)
1. **Guard "Safra" = falso positivo transversal.** `R-anti-contaminacion` trata el catálogo propio "Safra" como cliente ajeno → bloquea TODA salida que lo mencione. Mata A4_COTIZ (34/34) y golpea A8_GARANTIA (y potencialmente cualquier agente comercial). → **whitelist de términos del negocio.** Es el fix de mayor retorno: revive la cotización automática.
2. **A8_REPUT 100% bloqueado por `R-anti-alucinacion`** (no cita `evidencia_msg_ids`). → el agente debe citar msg_ids o no marcar CONFIRMADO.
3. **134/161 audios: transcripción hecha pero no llega a `mensajes.texto`.** Los agentes quedan ciegos al 83% de los audios. Degrada en cascada a A1 (montos/medidas/entidades), A6_MEDIDAS y A5_COMPROB. → copiar `ai_text`→`texto` en el flujo de tiempo real + re-derivar los 134.
4. **4 agentes muertos (0 eventos):** A4_RECOMPRA, A5_CARTERA, A5_RENTAB, A7_RUTAS. Cartera y rentabilidad son financieros core. → revisar registro/condición de disparo.

## 🟡 MEDIO impacto
5. **`confianza` no se promueve a la columna `evento_pg.confianza`** (existe fragmentada en el payload: `confianza_ambito`, etc.). → normalizarla habilita priorización/buzón por confianza.
6. **~69 media sin `ai_status`** (33 audios + 32 imágenes + 4 docs): hueco del flujo en tiempo real que deja media sin intentar procesar.
7. **A2_INTENCION cae en "otro" el 69%** → taxonomía gruesa; ampliar categorías + few-shot.
8. **A3_GEO/INMUEBLE/GRAFO**: corren en cada mensaje, aciertan <4% → gatear con pre-señal (ahorro de costo/latencia). **A3_GEO no detectó ninguna zona** en 250 mensajes (revisar prompt para barrios/conjuntos).
9. **A2_ROL: 16% "desconocido"** (pierde el "quién habla"); correlacionar con grupos y @lid sin nombre.
10. **A6_RIESGO: 299/300 "sin riesgos"** → posible sub-detección de riesgos de instalación (alturas, 2º piso, vidrio, anclaje).
11. **A7_ESTADO y A8_SATIS dependen de un estado de producción/instalación que no existe** → solo aportan si se conecta esa fuente.
12. **~5 imágenes rechazadas por Vision** ("No puedo describir…") guardadas como si fueran transcripción → detectar y reintentar/descartar.
13. **`media_mime` ausente en 27/31 documentos** → clasificación de PDF frágil; guardar mime / fallback por extensión.
14. **A4_REFERIDOS: 0 referidos en 200** → posible sub-detección en un negocio de boca-a-boca.

## 🟢 BAJO impacto
15. Nombre de archivo PDF vacío en el texto (`📎  — RESUMEN:`).
16. **A2_NOCLIENTE asume cliente el 93%** (conservador) → verificar falsos negativos (spam/logística colados).

## ✅ Lo que FUNCIONA bien (no tocar)
- **A5_COMPROB** (montos vs saldo, abonos parciales), **A8_RECLAMO** (motivo+severidad), **A3_IDENTIDAD** (dedup), **A5_ABONO**, **A6_MEDIDAS** (esquema rico con `quien_midio`), y los **resúmenes de PDF** (facturas/recibos/cotizaciones). Cuando los datos llegan limpios y el guard no interfiere, los agentes producen salidas de buena calidad.

## Orden sugerido de ataque
1º guard "Safra" (revive cotización) → 2º copiado audio→texto + re-derivar → 3º A8_REPUT evidencia → 4º revivir/retirar los 4 agentes muertos → 5º normalizar confianza → luego los 🟡.
