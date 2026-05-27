/**
 * Dataset de escenarios para stress test de Junior.
 *
 * 60+ escenarios cubriendo 20 dimensiones de prueba. El runner toma uno al
 * azar en cada turno (sin repetir hasta agotar la lista, después remix).
 *
 * Cada escenario:
 *   - cat: categoría (para agrupar en el reporte)
 *   - msg: el texto literal que se envía como si fuera Jhon
 *   - espera: lista de patrones que el resultado debería cumplir (opcional)
 *     · 'ARRAY:nombre>0' → el array debe tener al menos 1 objeto
 *     · 'ARRAY:nombre==0' → el array debe estar vacío
 *     · 'RESP:regex' → la respuesta debe matchear este regex (case-insensitive)
 *     · 'GUARD' → debe activarse el guard anti-ráfaga
 *     · 'NO-MIENTE' → si respuesta dice "ya hice X", el array correspondiente NO debe estar vacío
 *
 * El runner verifica las expectativas y cuenta hits/misses. El propósito NO es
 * que cada escenario pase — es generar variabilidad y detectar bugs por
 * desviación de patrón.
 */
export const ESCENARIOS = [
  // ─── 1. Preguntas simples / consulta ──────────────────────────────────
  { cat: 'consulta', msg: '¿cuántas tareas tengo pendientes?' },
  { cat: 'consulta', msg: '¿quién es Walter?' },
  { cat: 'consulta', msg: 'dame el estado de Peñon Marg' },
  { cat: 'consulta', msg: '¿qué cotizaciones tengo abiertas?' },
  { cat: 'consulta', msg: 'cuánto debe Pedro Bustos' },
  { cat: 'consulta', msg: 'listame las garantías abiertas' },
  { cat: 'consulta', msg: 'dame mi agenda de mañana' },
  { cat: 'consulta', msg: 'qué clientes tengo en bolsa de parqueo' },

  // ─── 2. Crear tarea transversal (sin cliente) ─────────────────────────
  { cat: 'tarea_trans', msg: 'recordame comprar rollos blackout mañana', espera: ['ARRAY:nuevasTareas>0'] },
  { cat: 'tarea_trans', msg: 'ponete una de pasar por el banco el viernes 9am', espera: ['ARRAY:nuevasTareas>0'] },
  { cat: 'tarea_trans', msg: 'acordame hablar con la contadora la semana que viene' },

  // ─── 3. Crear tarea de cliente (con nombre) ───────────────────────────
  { cat: 'tarea_cliente', msg: 'agendame llamar a Walter mañana 11am', espera: ['ARRAY:nuevasTareas>0'] },
  { cat: 'tarea_cliente', msg: 'pone tarea de enviar cotización a Nancy Bermudez el 28', espera: ['ARRAY:nuevasTareas>0'] },
  { cat: 'tarea_cliente', msg: 'creame una tarea para Sebastián Angeos: validar medidas de sala el lunes' },

  // ─── 4. Crear agendamiento con fecha+hora firme ───────────────────────
  { cat: 'agendamiento', msg: 'agendá visita de medidas con Walter el viernes 30 a las 3pm', espera: ['ARRAY:nuevosAgendamientos>0'] },
  { cat: 'agendamiento', msg: 'apuntá instalación a Pedro Bustos martes 2 de junio 10am en su casa', espera: ['ARRAY:nuevosAgendamientos>0'] },
  { cat: 'agendamiento', msg: 'reunión con Soranyi el jueves 4 de junio 4pm', espera: ['ARRAY:nuevosAgendamientos>0'] },

  // ─── 5. Operaciones AMBIGUAS — deben NO ejecutar ──────────────────────
  { cat: 'ambiguo', msg: 'limpia el checklist', espera: ['ARRAY:cierresChecklist==0', 'ARRAY:tareasCompletar==0', 'RESP:confirm|cuáles|listar|propon'] },
  { cat: 'ambiguo', msg: 'actualiza todo', espera: ['ARRAY:cierresChecklist==0', 'ARRAY:tareasCompletar==0'] },
  { cat: 'ambiguo', msg: 'repasa lo que está pendiente', espera: ['ARRAY:tareasCompletar==0'] },
  { cat: 'ambiguo', msg: 'haz una limpieza', espera: ['ARRAY:cierresChecklist==0'] },
  { cat: 'ambiguo', msg: 'organizame esto', espera: ['ARRAY:cierresChecklist==0'] },

  // ─── 6. Operaciones DESTRUCTIVAS específicas (con nombre/id) ──────────
  { cat: 'destructivo_ok', msg: 'cerrá el checklist de Vanessa Santamaria — ya terminamos la garantía', espera: ['ARRAY:cierresChecklist>0'] },
  { cat: 'destructivo_ok', msg: 'marcá hecha la tarea de cobrar saldo a Walter Estancia, ya la confirmé', espera: ['ARRAY:tareasCompletar>0'] },
  { cat: 'destructivo_ok', msg: 'ya envié la cotización a Oscar Vera, marca esa tarea como hecha', espera: ['ARRAY:tareasCompletar>0'] },

  // ─── 7. Acción masiva legítima — debe activar guard de 5 ──────────────
  { cat: 'masivo_guard', msg: 'cerrá los checklists de Rocio Romero, Julio Martinez, Jorge Pozo Azul, La Dulcería, Arboleda, Lagos Casa 64 Claudia, Nancy Bermudez y Walter — todos están terminados', espera: ['GUARD'] },
  { cat: 'masivo_guard', msg: 'completá las tareas #345, #386, #389, #393, #422, #423, #424, #445 — ya las hice todas', espera: ['GUARD'] },

  // ─── 8. Roles familiares — debe emitir notasPersona + memoria ─────────
  { cat: 'rol_familiar', msg: 'el contacto +573219222224 es mi tío Hernán, no es cliente', espera: ['ARRAY:notasPersona>0', 'ARRAY:memorias>0'] },
  { cat: 'rol_familiar', msg: '+573102345678 es mi primo Carlos, sacalo del flujo comercial', espera: ['ARRAY:notasPersona>0'] },
  { cat: 'rol_familiar', msg: '+573145566778 es la prima de mi esposa, marcala como familiar' },

  // ─── 9. Roles laborales — debe reclasificar a proveedor ───────────────
  { cat: 'rol_proveedor', msg: '+573199876543 es el ingeniero que diseña los soportes, proveedor de servicios', espera: ['ARRAY:notasPersona>0'] },
  { cat: 'rol_proveedor', msg: '+573156677889 es Don Mario el electricista que arregla las motorizadas', espera: ['ARRAY:notasPersona>0'] },

  // ─── 10. Frustración simulada (Jhon ya lo había dicho) ────────────────
  { cat: 'frustracion', msg: 'ya te dije tres veces que +573219222224 es mi tío, no me lo preguntes más' },
  { cat: 'frustracion', msg: 'mismo error, te lo repito: Don Leonel es el MECÁNICO, no cliente' },

  // ─── 11. Confirmación de listado previo ("sí, dale") ──────────────────
  { cat: 'confirm', msg: 'sí, dale' },
  { cat: 'confirm', msg: 'ok confirmo, procedé' },
  { cat: 'confirm', msg: 'todos esos sí, menos Walter' },

  // ─── 12. Cliente nuevo (dictado) ──────────────────────────────────────
  { cat: 'cliente_nuevo', msg: 'anotá un cliente: Pedro Ñoño Martinez, vino al local, quiere 4 blackout para sala-comedor, teléfono 3138899001', espera: ['ARRAY:nuevosClientes>0', 'ARRAY:correcciones>0'] },
  { cat: 'cliente_nuevo', msg: 'cliente nuevo: Sandra Pinilla, llamó por persianas para una oficina en Soacha' },

  // ─── 13. Cliente nuevo con nombre potencialmente duplicado ────────────
  { cat: 'cliente_dup', msg: 'anotá un cliente nuevo: Walter, llamó por una garantía', espera: ['RESP:ya existe|misma|persona|preguntar', 'ARRAY:nuevosClientes==0'] },
  { cat: 'cliente_dup', msg: 'cliente nuevo Maria Rivera, blackout para la sala' },

  // ─── 14. Fechas relativas ─────────────────────────────────────────────
  { cat: 'fecha_relativa', msg: 'tarea para Walter: llamar mañana' },
  { cat: 'fecha_relativa', msg: 'recordame el lunes hablar con Rocío Arévalo' },
  { cat: 'fecha_relativa', msg: 'agendame visita a Pedidos Cubides en 3 días a las 9' },
  { cat: 'fecha_relativa', msg: 'la semana que viene tengo que ir a Melgar' },

  // ─── 15. Información nueva sobre cliente (corrección) ─────────────────
  { cat: 'correccion', msg: 'Walter pagó otros 50 mil', espera: ['ARRAY:correcciones>0'] },
  { cat: 'correccion', msg: 'la instalación de Sebastián Angeos quedó hecha el martes' },
  { cat: 'correccion', msg: 'Peñon Marg confirmó que viene el viernes a las 10am al local' },
  { cat: 'correccion', msg: 'Jesús Barberi canceló, no compra' },

  // ─── 16. Cambios de tema bruscos ──────────────────────────────────────
  { cat: 'cambio_tema', msg: 'dejá eso. ¿cómo van las garantías?' },
  { cat: 'cambio_tema', msg: 'mejor antes contame de Pedidos Cubides' },

  // ─── 17. Edge cases ──────────────────────────────────────────────────
  { cat: 'edge', msg: 'ok' },
  { cat: 'edge', msg: '👍' },
  { cat: 'edge', msg: '¿?' },
  { cat: 'edge', msg: 'no sé, vos decime' },

  // ─── 18. Pregunta sobre evidencia / audio (debe decir "no puedo") ─────
  { cat: 'audio', msg: '¿qué dice el último audio de Walter?', espera: ['RESP:no puedo|no tengo acceso|no escuch|transcripción'] },
  { cat: 'audio', msg: 'leeme la última imagen que mandó Pedro Bustos', espera: ['RESP:no puedo|no veo|imagen'] },

  // ─── 19. Memoria persistente (preferencia explícita) ──────────────────
  { cat: 'memoria_pref', msg: 'a partir de ahora, dame siempre los montos en negrita', espera: ['ARRAY:memorias>0'] },
  { cat: 'memoria_pref', msg: 'cuando hables de Margarita, recordá siempre que es la socia del local de Melgar, no cliente' },

  // ─── 20. Verificación de cascada (completar tarea cancela agendamiento) ─
  { cat: 'cascada', msg: 'ya hice la visita de medidas con Walter, marcala como completada' },

  // ─── 21. Pregunta sobre el sistema mismo ──────────────────────────────
  { cat: 'meta', msg: '¿cuántos clientes tengo activos en total?' },
  { cat: 'meta', msg: '¿qué tareas tengo vencidas?' },
  { cat: 'meta', msg: '¿qué chats están sin responder?' },

  // ─── 22. Contradicción temporal (testear cómo maneja) ─────────────────
  { cat: 'contradiccion', msg: 'Pedro Bustos es mi hermano, sacalo del flujo comercial' },
  // NOTA: si después en el dataset aparece "anotá Pedro Bustos cliente nuevo", debería detectar contradicción

  // ─── 23. Mensaje muy largo ───────────────────────────────────────────
  { cat: 'largo', msg: 'mira te cuento, hoy fue un día complicado, vino el cliente del condominio del peñon, Margarita, ya sabes la socia de Melgar — bueno ella vino con su hermana Patricia que tiene un apartamento en Ricaurte y quiere cotizar persianas blackout para 2 ventanas chicas tipo 1.20x1.50 cada una, y también para la sala que es grande 3.50x2.80, el sistema lo prefiere motorizado, y le dije que pasaba el viernes a las 4 de la tarde a tomar medidas, así que anotá ese agendamiento, también la tarea de cotizarle después de la visita, y de paso registrá que Patricia es nueva cliente con teléfono 3145567788, vive en Ricaurte conjunto Las Brisas torre 3 apartamento 502' },

  // ─── 24. Pedido de informe / análisis ─────────────────────────────────
  { cat: 'informe', msg: 'dame un resumen de los clientes que tienen tareas vencidas hoy' },
  { cat: 'informe', msg: 'qué casos tengo en garantía abierta y cuántos días llevan' },
];

export const META = {
  total_escenarios: ESCENARIOS.length,
  categorias: [...new Set(ESCENARIOS.map(s => s.cat))].sort(),
};
