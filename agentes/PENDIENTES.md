# Pendientes del rollout productivo de agentes

Registro vivo de lo que falta validar / observar conforme cada agente se activa
en productivo. Cuando un pendiente se resuelve, mover a "Resueltos" abajo
(o borrar si la resolución es trivial).

---

## Agentes productivos hoy

| Agente | Capa | Activado | Cubre vacío | Cubre con-datos |
|---|---|---|---|---|
| A1_ENTIDADES  | L1 | 2026-05-13 | ✓ | parcial (caso "cortinas girardot" borderline) |
| A1_MEDIDAS    | L1 | 2026-05-14 | ✓ | NO probado con tráfico real |
| A1_MONTOS     | L1 | 2026-05-14 | ✓ | NO probado con tráfico real |
| A2_INTENCION  | L2 | 2026-05-13 | ✓ | ✓ (urgente, pagar, otro) |
| A2_AMBITO     | L2 | 2026-05-14 | ✓ | ✓ (sin cambio CONFIRMADO + DUDOSO en chats cortos) — falta probar cambio_propuesto=true |
| A2_ROL        | L2 | 2026-05-14 | ✓ | ✓ (default cliente CONFIRMADO en chats individuales) — falta probar grupos con familiar/admin/técnico |
| A2_NOCLIENTE  | L2 | 2026-05-14 | ✓ | ✓ (chats reales detectados, chats cortos van a DUDOSO/buzón) — falta probar no-cliente real (restaurante, spam, etc.) |

**L2 routing 100% productivo.** Pipeline `PIPE_MENSAJE_COMERCIAL` actualizado para incluir A2_NOCLIENTE en fase 'clasificar'.

| A4_COTIZ      | L4 | 2026-05-14 | ✓ | ✓ (ev679 "Cotizar esas 3 opciones" → 1 item blackout sala → buzón) — falta validar items con medidas/color explícitos |

| A5_ABONO      | L5 | 2026-05-14 | ✓ | parcial (ev863 "Cancelo saldo cortinas girardot" sin monto → DUDOSO al buzón sin entidad) — falta camino con monto explícito |
| A5_COMPROB    | L5 | 2026-05-14 | ✓ | ✓ E2E completo: ev707 comprobante $750.000 → INFERIDO al buzón con entidad → aprobar → abono aparece en M3.2 Abonos asociado a cotización |
| A4_OBJECIONES | L4 | 2026-05-14 | ✓ | parcial — ev727 "presupuesto no nos alcanza" → detectado precio/fuerte → buzón sin entidad (chat 22 sin cotización activa). Falta probar caso con cotización activa para validar INSERT shadow. |
| A7_TAREAS     | L7 | 2026-05-14 | ✓ | parcial — ev777/ev689/ev805 todos CONFIRMADO sin tareas (LLM conservador). Falta validar caso con tarea explícita ("llamame mañana", "vengan el viernes") para confirmar INSERT shadow en tabla tareas. |
| A6_MEDIDAS    | L6 | 2026-05-14 | ✓ | parcial — ev679/ev777/ev827/ev834 todos CONFIRMADO sin medida (mensajes en texto sin dimensiones). Falta validar caso con medida explícita "2.40 x 1.80" para confirmar INSERT shadow + R-013#1 disparando ALERTA. |
| A8_GARANTIA   | L8 | 2026-05-14 | ✓ | sin tráfico — BD actual no tiene mensajes texto con reportes de falla post-instalación. Activación lista; el caso INSERT shadow + ALERTA se validará cuando aparezca un mensaje "no funciona", "se rompió", etc. |
| A8_RECLAMO    | L8 | 2026-05-14 | ✓ | parcial — ev834 ("Es urgente, ayer me quedé esperando") → CONFIRMADO (no es reclamo sensible, sin amenaza pública). Falta validar caso con amenaza real ("voy a poner mala reseña", "llamo a la fiscal") → severidad=critica → out.confianza=ALERTA prio 1. |
| A4_COMPAT     | L4 | 2026-05-14 | ✓ | parcial — ev679 → CONFIRMADO sin config técnica. Falta validar caso con config rara ("blackout con voile") → ALERTA crítica. No escribe a tabla de negocio (solo emite alertas al buzón). |
| A7_ESTADO     | L7 | 2026-05-14 | ✓ | ✓ ev805 "instale el miércoles 3:00pm" → DUDOSO AL BUZÓN con respuesta WA propuesta + tarea seguimiento. Nunca CONFIRMADO (respuestas WA requieren aprobación humana). No escribe a tabla. |
| A8_SATIS      | L8 | 2026-05-14 | ✓ | parcial — ev777/ev689/ev827 → CONFIRMADO no-aplica (sin instalación reciente en BD). Pipeline: agregado a _default y consulta_estado. Caso B con instalación reciente + "quedó hermoso" se validará con tráfico post-venta real. |
| A8_REPUT      | L8 | 2026-05-14 | ✓ | parcial — ev777/ev827 → CONFIRMADO apto=false (sin satisfaccion 'feliz' registrada). Pipeline: agregado a _default. Bug fix: fallback msg_id al último del chat si evento sin evidencia_ids. Caso B (apto=true con plantilla Google) se validará cuando exista satisfaccion 'feliz' aprobada. |
| A6_RIESGO     | L6 | 2026-05-14 | ✓ | parcial — ev679/ev777 → CONFIRMADO sin riesgos (chats sin inmueble/sistemas asociados en BD). Pipeline: cotizar + _default. No escribe tabla (solo alerta al buzón). Caso B (toldo Melgar + viento, vano alto, etc.) se validará con tráfico real con inmueble registrado. |
| A3_IDENTIDAD  | L3 | 2026-05-14 | ✓ | ✓ ev777/ev827/ev834 → CONFIRMADO sin duplicados (BD con 5 personas no parecidas). Bug P-005 resuelto con fallback msg_id al último del chat. No escribe tabla (fusión manual). |
| A3_INMUEBLE   | L3 | 2026-05-14 | ✓ | ✓ ev777/ev834/ev863 → CONFIRMADO sin menciones de conjunto en mensajes. Catálogo 324 conjuntos cacheado en prompt (~8K tokens cached). No escribe tabla (vincular conjunto a inmueble es decisión manual UI M1.2). |
| A3_GEO        | L3 | 2026-05-14 | ✓ | ✓ ev777/ev834/ev863 → CONFIRMADO sin menciones geográficas. LLM correctamente NO trató "cortinas girardot" como zona (es empresa, no lugar). No escribe tabla. |
| A3_GRAFO      | L3 | 2026-05-14 | ✓ | ✓ ev777/ev834/ev863 → CONFIRMADO sin terceros mencionados. postProcesar inserta PRIMERA mención shadow=true en personas_mencionadas. Caso B con "mi esposa"/"el administrador"/etc se validará con tráfico real. |
| A1_AUDIO      | L1 | 2026-05-14 | ✓ | ✓ ev811 audio sin transcripción → DUDOSO AL BUZÓN, costo $0 (procesarSinLLM). PIPE_AUDIO activado productivo. Caso CONFIRMADO (con ai_text) se validará cuando Jhon dispare transcripción desde Vistas globales > Transcripciones. |
| A1_OCR        | L1 | 2026-05-14 | ✓ | ✓ ev707 imagen con OCR → CONFIRMADO clasificado como "comprobante" → ruteado a A5_COMPROB. PIPE_IMAGEN ya productivo. Costo $0 (procesarSinLLM con heurística regex sobre ai_text). |

**L1 extracción 100% productivo (5/5).** PIPE_AUDIO + PIPE_IMAGEN productivos. PIPE_MENSAJE_COMERCIAL productivo.

| A4_RECOMPRA   | L4 | 2026-05-14 | ✓ (batch) | activo en BD pero no validado E2E — es batch, no se invoca por mensaje individual. Requiere trigger periódico (cron / UI "Buscar candidatos recompra") que aún no existe. postProcesar inserta tarea shadow=true cuando es_candidato=true. |
| A4_REFERIDOS  | L4 | 2026-05-14 | ✓ | ✓ ev679/ev777 → CONFIRMADO sin señales de referido. Pipeline: cotizar + _default. Caso B ("vengo de parte de X", "le recomendaré a mi vecino") se validará con tráfico real. |
| A5_CARTERA    | L5 | 2026-05-14 | ✓ (batch) | activo en BD pero no validado E2E — es batch, no se invoca por mensaje individual. Requiere trigger periódico (cron / UI "Buscar candidatos a recordatorio de cobro") que aún no existe. Coherencia mecánica determinista (sinSaldo/deudaInsuf/conversaActiva → no candidato, todo OK → INFERIDO + plantilla WA). NUNCA CONFIRMADO (humano decide enviar). postProcesar no-op (la plantilla pasa al buzón; al aprobar Jhon crea la tarea manualmente o se podría engancharse a A7_TAREAS). |
| A5_RENTAB     | L5 | 2026-05-14 | ✓ (batch) | activo en BD pero no validado E2E — es batch trigger por evento 'costo' o 'cambio_estado' de cotización ganada. Coherencia mecánica determinista (sinCostos→DUDOSO, margen<0→ALERTA, margen_pct<10%→ALERTA, sano→INFERIDO, nunca CONFIRMADO). Validación re-calcula venta/variaciones/costo/margen y exige match con tolerancia $1. postProcesar no-op (las alertas van al buzón directo). |
| A7_RUTAS      | L7 | 2026-05-14 | ✓ (batch) | activo en BD pero no validado E2E — es batch sobre horizonte 14d de instalaciones programadas sin fecha_real. Coherencia mecánica (sinInstalaciones→DUDOSO + rutas/sueltas vacías; con instalaciones→INFERIDO; nunca CONFIRMADO). Valida formato hora_sugerida ventana 08:00-17:00, duracion_estimada [30,480] min, ids existen, sin duplicados entre rutas y sueltas. postProcesar no-op (al aprobar Jhon, las rutas se traducen a hora_programada + tareas; UI / cron de disparo pendiente). |
| A10_JUNIOR    | L10 | 2026-05-14 | ✓ (especial) | activo en BD pero no validado E2E — agente conversacional: responde preguntas que Jhon escribe al WhatsApp del negocio desde su propio celular. Coherencia mecánica (ambiguedad=true→DUDOSO, false→INFERIDO, nunca CONFIRMADO porque la respuesta SIEMPRE va al buzón para que Jhon apruebe antes de enviarla). Anti-alucinación dura: montos ≥$1000 citados en respuesta_whatsapp deben existir (±$100) en datos cargados. **No agregado a pipelines** — falta trigger detector de mensajes propios de Jhon al WhatsApp del negocio (probable: chat con ámbito='interno_equipo' + dirección='entrante' de un número específico de Jhon). |

**L4 comerciales 100% productivo (5/5):** A4_COTIZ, A4_OBJECIONES, A4_COMPAT, A4_RECOMPRA (batch), A4_REFERIDOS.

**L3 identidad 100% productivo.** Bug P-005 resuelto en F27/F28 (resolverMsgId extendido para sufijo).

**Cobertura pipeline A7_TAREAS:** agregado a rutas `cotizar`, `_default`, `urgente`, `consulta_estado` (todas las donde tareas pueden surgir).

**Regla A5_COMPROB:** R-009 NUNCA CONFIRMADO con hay_comprobante=true. Coherencia: hay_comprobante=false → CONFIRMADO no-buzón, OCR confuso o monto_visible=null → DUDOSO, mismatch saldo → ALERTA, OK → INFERIDO. postProcesar inserta abono shadow=true cuando hay monto_visible; el método se mapea al enum (bancolombia/nequi/daviplata/efectivo/transferencia/tarjeta/consignacion) o cae a 'transferencia'. Si la cotización activa tiene saldo $0 (cotización aprobada sin precio aún), el LLM detecta mismatch y lo flagea en notas.

**Regla A5_ABONO:** R-001 NUNCA CONFIRMADO con hay_abono=true. Coherencia: hay_abono=false → CONFIRMADO no-buzón, monto=null/solo_foto → DUDOSO, claro → INFERIDO. postProcesar inserta abono shadow=true sólo si monto presente (campo NOT NULL en BD).

**Regla A4_COTIZ:** todas las cotizaciones van al buzón (CONFIRMADO prohibido). Flujo completo end-to-end validado 2026-05-14:
mensaje "Cotizar 3 opciones" → A4_COTIZ propone item Blackout/sala/tapaluz → cotización shadow + item shadow + ítem buzón vinculado → Jhon aprueba en UI → RPC `aprobar_buzon_atomic` levanta `cotizaciones.shadow=false` → aparece en M2.1 Cotizaciones lista para editar precio.

**Patrón A4_COTIZ replicable a otros agentes que escriben tablas de negocio (A4_OBJECIONES, A5_ABONO, A5_COMPROB, A6_MEDIDAS, A7_TAREAS, A8_GARANTIA, A8_RECLAMO, etc.):**
1. `postProcesar` inserta la fila en la tabla de negocio con `shadow=true` + `agente_origen` + `confianza`.
2. Retorna `{entidad_tipo, entidad_id}` para que el runner los vincule al ítem del buzón.
3. La RPC `aprobar_buzon_atomic` ya soporta los enums (cotizacion, abono, factura, medida, instalacion, tarea, garantia, mantenimiento, satisfaccion, google_review, reclamo, evidencia, costo, produccion_orden).
4. Si la tabla tiene hijos cuyo display depende del shadow del padre, dejar los hijos shadow=true también — al levantar shadow del padre, los hijos aparecen porque el query del frontend filtra por padre.

Pipeline `PIPE_MENSAJE_COMERCIAL`: `activo=true, shadow=false`.
El resto de agentes sigue cada uno con `shadow=true` propio.

---

## Pendientes activos

### P-001 — Validar A1_MEDIDAS con tráfico real
Solo se probó el camino `medidas=[] → CONFIRMADO`. Falta confirmar:
- Mensaje tipo "2.40 x 1.80 m" → 1 medida → INFERIDO/DUDOSO → buzón.
- Mensaje tipo "como 2 metros" → 1 medida DUDOSO → buzón con prioridad.
**Acción cuando aparezca tráfico real:** revisar primera invocación en M8 Agentes
y verificar que el ítem aparezca en buzón.

### P-002 — Validar A1_MONTOS con tráfico real
Idem P-001 para montos:
- "$850.000" → 1 monto → INFERIDO → buzón.
- "1.5M", "850 lucas" → jerga colombiana → INFERIDO → buzón.
- "como 800 mil" → DUDOSO → buzón con prioridad.

### P-003 — A1_ENTIDADES borderline: empresas implícitas
El prompt reforzado (2026-05-13) hizo al LLM más conservador: ya no detecta
"cortinas girardot" como empresa implícita (lo trataba como ambiguo).
**Observar:** si Jhon ve nombres de empresas REALES que se pierden, agregar al
prompt: "ante duda razonable, INCLUÍ la entidad con confianza_individual=DUDOSO".
Por ahora no se hace porque podría inflar el buzón con falsos positivos.

### P-004 — Activar resto de agentes uno por uno
Pendientes de pasar a productivo siguiendo el mismo playbook (coherencia + ValidacionError + resolverMsgId):
- L2: A2_AMBITO, A2_NOCLIENTE, A2_ROL
- L3: A3_IDENTIDAD, A3_INMUEBLE, A3_GEO, A3_GRAFO
- L4: A4_COTIZ, A4_OBJECIONES, A4_RECOMPRA, A4_REFERIDOS, A4_COMPAT
- L5: A5_ABONO, A5_COMPROB, A5_CARTERA, A5_RENTAB
- L6: A6_MEDIDAS, A6_RIESGO
- L7: A7_TAREAS, A7_ESTADO, A7_RUTAS
- L8: A8_GARANTIA, A8_RECLAMO, A8_SATIS, A8_REPUT
- L10: A10_JUNIOR
- L1 audio/imagen: A1_AUDIO, A1_OCR (cuando llegue tráfico de media)

### P-006 — Probar A2_AMBITO con cambio_propuesto=true
Solo se validó el camino `cambio_propuesto=false` (chats con ámbito ya correcto).
Falta confirmar:
- Chat erróneamente marcado como `comercial` que en realidad es `proveedor` → A2_AMBITO
  debe proponer cambio → out.confianza=INFERIDO forzado → AL BUZÓN.
- Verificar que el ítem del buzón muestra `ambito_propuesto` ≠ `ambito_actual`.
**Cómo reproducir:** cambiar manualmente un chat de comercial a personal_otros y
reprocesar — el agente debería detectar el conflicto.

### P-008 — Validar A5_ABONO con mensaje texto + monto
En BD actual no hay mensajes texto "ya transferí $X" (todos vinieron como imagen de comprobante → A5_COMPROB). Cuando aparezca uno real validar que:
- A5_ABONO inserta abono en BD con shadow=true, estado_validacion='pendiente'
- Aprobar en el buzón promueve a shadow=false → aparece en M3.2 Abonos
- monto_coincide_saldo se calcula bien si hay cotización activa

### P-007 — Probar A2_ROL en grupos
Solo se validó el camino "chat individual → cliente + CONFIRMADO".
Falta confirmar:
- Mensaje en grupo de "soy la esposa de X" → familiar + CONFIRMADO → buzón.
- Mensaje en grupo de "soy administrador del conjunto" → admin + CONFIRMADO → buzón.
- Mensaje en grupo sin señal → desconocido + DUDOSO → buzón.
**Bloqueante:** no hay chats tipo=grupo en BD aún.

### P-005 — Bug pre-existente A3_INMUEBLE (A3_IDENTIDAD ya resuelto en F27)
Detectado en E2E inicial: emiten msg_id vacío `''` o repiten el msg_id sin variantes.
Validador anti-alucinación los atrapa correctamente (RECHAZADO), pero indica un
problema de prompt. Revisar cuando toque activarlos en productivo.

---

## Resueltos

### R-001 — Bug prefijo `true_`/`false_` en msg_ids (2026-05-14, ampliado 2026-05-14 en F28)
LLM truncaba msg_ids interpretando el prefix como booleano literal.
Fix v1: helper `resolverMsgId()` tolera prefijo simple `true_X` / `false_X`.
Fix v2 (F28): el LLM también trunca toda la parte `false_NUMBER@`, citando solo
`lid_XXX`. resolverMsgId ahora busca por sufijo cuando el citado contiene
`lid_` / `broadcast_` / empieza con `msg_`. Aplicado en validador general +
A1_ENTIDADES + A1_MEDIDAS + A1_MONTOS + A2_INTENCION + A4_COTIZ + A4_COMPAT +
A4_OBJECIONES + A5_ABONO + A5_COMPROB + A6_MEDIDAS + A6_RIESGO + A7_ESTADO +
A7_TAREAS + A8_GARANTIA + A8_RECLAMO + A8_SATIS + A8_REPUT + A3_IDENTIDAD +
A3_INMUEBLE.

### R-002 — `Error` plano vs `ValidacionError` (2026-05-13)
Validadores específicos lanzaban `Error` plano → runner no los capturaba como
ValidacionError → invocación quedaba `ok=true` pero sin evento_pg insertado.
Fix: migrar todos los throws de `validarOutputEspecifico` a `ValidacionError`.
Aplicado en A1_ENTIDADES, A1_MEDIDAS, A1_MONTOS, A2_INTENCION.
