vision general a lo particular del visor.

Documento base de arquitectura operativa
Ecosistema empresarial + Visor PG para Persianas Girardot
1. Visión global del ecosistema

La empresa no debe funcionar como una suma de herramientas aisladas. La visión correcta es construir un ecosistema donde cada proyecto, sistema, agente, base de datos y canal de entrada tenga una función clara dentro de una arquitectura central.

El objetivo no es solamente automatizar tareas. El objetivo es crear una infraestructura empresarial donde la información entre por diferentes medios, sea procesada, validada, almacenada y consultada sin depender únicamente de la memoria humana.

La arquitectura general debe entenderse así:

1.1 Biblioteca empresarial

La biblioteca es el conocimiento técnico, comercial y operativo de la empresa.

No es CRM.
No es visor.
No es WhatsApp.
No es facturación.

Es el cerebro documental de la empresa.

Debe contener:

productos,
sistemas,
fichas técnicas,
precios,
garantías,
advertencias,
proveedores,
condiciones comerciales,
respuestas comerciales,
objeciones,
mantenimiento,
criterios por clima,
recomendaciones por uso,
reglas internas.

En Persianas Girardot, la biblioteca debe tener agentes especialistas por sistema:

Blackout,
Screen Solar,
Sheer Elegance,
Panel Japonés,
Enrollables,
Persianas Verticales,
Películas Solares,
Toldos,
Motores,
Domótica,
Rieles,
Mantenimientos,
Garantías.

La biblioteca responde preguntas de conocimiento.
No decide cierres comerciales.
No confirma pagos.
No actualiza saldos.
No reemplaza al CRM.

1.2 CRM rígido

El CRM es la verdad estructurada del negocio.

Debe funcionar incluso si los agentes fallan.

Debe contener:

clientes,
teléfonos,
inmuebles,
proyectos,
cotizaciones,
facturas,
abonos,
saldos,
instalaciones,
garantías,
postventa,
recompras,
referidos.

El CRM debe poder trabajar localmente, con base de datos propia, porque representa la memoria dura de la empresa.

El CRM no debe depender de la IA para existir.
La IA puede alimentar el CRM, pero la verdad final debe estar en registros estructurados.

1.3 Página web

La página web es una fuente de entrada.

Debe alimentar el ecosistema con:

formularios,
solicitudes de cotización,
datos de cliente,
producto de interés,
ciudad,
fotos,
mensajes,
origen del contacto,
intención comercial.

Todo lo que entre por la web debe reflejarse en el CRM y, si aplica, crear un proyecto o preproyecto.

1.4 Visor WhatsApp PG

El visor es la consola viva de operación basada en WhatsApp.

Su función principal no es ver chats.
Su función es convertir conversaciones de WhatsApp en operación empresarial.

El visor debe tomar mensajes, audios, imágenes, documentos y comprobantes, y transformarlos en:

eventos,
tareas,
evidencias,
cotizaciones,
cambios,
alertas,
estados,
validaciones,
datos de CRM,
decisiones pendientes.

El visor es el puente entre la conversación humana y el sistema estructurado.

1.5 Enjambre de agentes

Los agentes no deben ser una masa desordenada.

Deben dividirse en:

agentes de extracción objetiva,
agentes de producto,
agentes comerciales,
agentes técnicos,
agentes financieros,
agentes operativos,
agentes de garantía,
agentes de auditoría,
agente supervisor,
agente junior personal.

La regla es:

El agente propone.
El sistema documenta.
El humano valida lo crítico.
El CRM guarda la verdad.

1.6 Agente Junior personal

El agente junior es el secretario operativo de Jhon.

Debe poder consultar todo el sistema desde el celular.

Ejemplos:

cuánto debe un cliente,
cuál fue el último abono,
dirección de instalación,
estado de garantía,
cotización enviada,
sistema vendido,
próxima visita,
saldo pendiente,
cliente pendiente de reseña,
último mensaje importante.

Este agente no debe inventar.
Debe responder desde CRM, visor, evidencias y biblioteca.

1.7 Audio y transcripción futura

La capturadora de audio debe verse como una fuente documental futura.

Debe permitir:

grabar conversaciones,
transcribir,
detectar compromisos,
extraer datos,
crear eventos,
generar tareas,
alimentar el expediente.

Una llamada comercial importante debe terminar convertida en evidencia operativa.

1.8 Centro de control

El centro de control debe ser la capa superior donde se conecta todo:

biblioteca,
CRM,
visor,
web,
WhatsApp,
audios,
agentes,
validaciones,
métricas,
reportes,
alertas.

Este centro no es solo un dashboard.
Es la sala de mando del negocio.

2. Principio central del Visor PG

El Visor PG debe construirse bajo esta lógica:

WhatsApp / Web / Audio
↓
Captura cruda
↓
Normalización
↓
EVENTO_PG
↓
Agentes objetivos
↓
Buzón de validación
↓
CRM rígido
↓
Consulta Junior / Reportes / Operación

El visor no debe escribir verdades críticas directamente en el CRM sin control.

Todo dato que afecte:

dinero,
producción,
instalación,
garantía,
facturación,
responsabilidad técnica,
inventario,
saldo,
descuento,
medida final,

requiere validación humana.

3. Los 11 módulos del Visor PG
MÓDULO 1 — Núcleo base del visor

Este módulo es la columna estructural. Sin este núcleo, todo lo demás se vuelve desordenado.

1.1 Bandeja WhatsApp

Sirve para ver y capturar conversaciones reales.

Debe incluir:

chats activos,
chats archivados,
mensajes enviados,
mensajes recibidos,
audios,
fotos,
videos,
documentos,
comprobantes,
ubicaciones,
fechas,
horas,
remitente.

Por qué es importante:

Porque WhatsApp es la fuente viva del negocio. Ahí están las decisiones reales del cliente, los cambios, los pagos, las dudas y las promesas.

1.2 Identidad del cliente

Debe asociar cada chat con una persona real.

Debe registrar:

nombre,
teléfono,
alias,
empresa,
rol,
referido,
contacto alterno,
relación con otros clientes.

Por qué sirve:

Porque un número de WhatsApp no siempre representa al comprador real. Puede ser esposa, arquitecto, administrador, secretaria, familiar o instalador.

1.3 Inmueble

Debe registrar el lugar físico donde ocurre el proyecto.

Campos:

dirección,
ciudad,
barrio,
conjunto,
torre,
apartamento,
casa,
local,
oficina,
restricciones de ingreso,
administración,
parqueadero,
ascensor,
horarios permitidos.

Por qué sirve:

Porque en Persianas el inmueble define instalación, logística, medidas, garantías, rutas y riesgos.

1.4 Proyecto

El proyecto es la unidad central.

Un mismo cliente puede tener varios proyectos.
Un mismo inmueble puede tener varios proyectos.

Ejemplo:

proyecto blackout habitaciones,
proyecto screen sala,
proyecto mantenimiento,
proyecto garantía,
proyecto recompra.

Por qué sirve:

Porque no todo debe mezclarse en “cliente”. El cliente es una persona; el proyecto es una operación específica.

1.5 Timeline

Debe mostrar la historia completa.

Debe incluir:

primer contacto,
cotización,
cambios,
aceptación,
abono,
producción,
instalación,
garantía,
postventa,
reseña,
recompra.

Por qué sirve:

Porque permite reconstruir la realidad sin volver a leer 500 mensajes.

1.6 EVENTO_PG

Cada mensaje importante debe transformarse en evento.

Tipos:

dato,
tarea,
alerta,
evidencia,
cambio de estado,
solicitud de aprobación,
contradicción,
pago,
medida,
garantía,
variación.

Por qué sirve:

Porque el sistema no debe trabajar sobre mensajes sueltos. Debe trabajar sobre eventos estructurados.

1.7 Buzón de validación

Aquí llegan los eventos críticos.

Debe validar:

cotización ganadora,
abono,
descuento,
cambio de medida,
garantía,
saldo,
responsable,
instalación,
factura.

Por qué sirve:

Porque evita que la IA convierta inferencias en verdades definitivas.

MÓDULO 2 — Módulos comerciales

Este módulo permite entender cómo se vende, por qué se gana y por qué se pierde.

2.1 Cotizaciones

Debe almacenar:

código,
fecha,
cliente,
proyecto,
productos,
área,
valor,
vigencia,
estado,
versión,
asesor,
archivo enviado.

Estados:

propuesta,
negociando,
intención de cierre,
ganada,
perdida,
vencida.

Por qué sirve:

Porque un cliente puede tener muchas cotizaciones antes de comprar una.

2.2 Comparador de cotizaciones

Debe comparar versiones.

Ejemplo:

cotización 1: blackout,
cotización 2: screen,
cotización 3: sheer,
cotización 4: blackout con motor.

Debe mostrar:

diferencias de valor,
productos eliminados,
productos agregados,
descuentos,
cambios de medidas,
razón de descarte.

Por qué sirve:

Porque permite responder por qué de 10 cotizaciones compró una.

2.3 Objeciones comerciales

Debe clasificar objeciones reales.

Tipos:

precio,
calidad,
garantía,
tiempo,
competencia,
color,
diseño,
instalación,
desconfianza,
comparación con referido,
comparación con Homecenter,
comparación con otro proveedor.

Por qué sirve:

Porque permite entrenar mejores respuestas comerciales y detectar patrones de pérdida.

2.4 Seguimiento comercial

Debe mostrar:

clientes sin responder,
clientes calientes,
clientes fríos,
clientes pendientes de pago,
clientes que pidieron tiempo,
clientes que comparan,
clientes que deben llamarse.

Por qué sirve:

Porque muchas ventas no se pierden por precio, sino por falta de seguimiento.

2.5 Referidos

Debe conectar clientes.

Campos:

quién refiere,
a quién refiere,
fecha,
proyecto asociado,
compró o no compró,
beneficio,
seguimiento.

Por qué sirve:

Porque el referido es una fuente comercial fuerte y debe medirse.

2.6 Recompra

Debe detectar clientes que vuelven.

Casos:

mismo inmueble,
otro inmueble,
familiar,
oficina,
mantenimiento,
nuevo producto.

Por qué sirve:

Porque la recompra demuestra confianza y permite medir fidelización.

MÓDULO 3 — Módulos financieros

Este módulo controla dinero, pagos, saldos y rentabilidad real.

3.1 Facturación

Debe registrar:

número de factura,
proyecto,
cotización ganadora,
valor total,
fecha,
productos,
cliente,
estado.

Por qué sirve:

Porque la factura debe estar conectada con la cotización que realmente ganó.

3.2 Abonos y saldos

Debe registrar:

valor abonado,
fecha,
método de pago,
comprobante,
cuenta receptora,
saldo,
estado de validación.

Estados:

pendiente validación,
confirmado,
rechazado,
inconsistente.

Por qué sirve:

Porque el abono confirmado es el cierre real de la venta.

3.3 Matching cotización-factura

Debe sugerir qué cotización corresponde a qué factura.

Pero no debe confirmar automáticamente.

Debe mostrar:

coincidencia por cliente,
coincidencia por proyecto,
coincidencia por valor,
coincidencia por fecha,
diferencias,
evidencia WhatsApp.

Por qué sirve:

Porque hay descuentos, cambios y compras parciales.

3.4 Log de variaciones económicas

Debe registrar diferencias entre cotización y factura.

Tipos:

descuento,
cambio producto,
cambio medida,
motor agregado,
ventana eliminada,
instalación negociada,
cambio por garantía,
cambio por cliente.

Por qué sirve:

Porque no se debe borrar la historia. Se debe explicar la evolución.

3.5 Rentabilidad real

Debe medir:

valor venta,
descuentos,
costos de producto,
visitas extra,
garantías,
viáticos,
retrabajos,
tiempo operativo.

Por qué sirve:

Porque una venta grande puede no ser rentable si consume demasiada operación.

MÓDULO 4 — Módulos técnicos

Este módulo evita errores físicos, garantías y malas recomendaciones.

4.1 Medidas

Debe separar:

medida enviada por cliente,
medida tomada por empresa,
medida corregida,
medida final de producción,
medida instalada.

Por qué sirve:

Porque la responsabilidad cambia según quién tomó la medida.

4.2 Riesgo de medidas

Debe detectar:

medidas incompletas,
cambios,
contradicciones,
alto/ancho invertido,
vano irregular,
manijas,
guardaescobas,
obstáculos,
espacio insuficiente.

Por qué sirve:

Porque muchos errores de producción nacen en medidas mal tomadas.

4.3 Producto / sistema

Debe identificar el sistema vendido o cotizado:

blackout,
screen,
sheer,
panel,
vertical,
toldo,
película,
riel,
motor.

Por qué sirve:

Porque cada sistema tiene reglas, advertencias y garantías diferentes.

4.4 Advertencias técnicas

Debe insertar advertencias según producto y contexto.

Ejemplos:

blackout no da oscuridad absoluta sin tapaluces,
screen no bloquea visión total de noche,
sheer no equivale a blackout,
sistema guaya no reemplaza tapaluz,
medidas cliente tienen riesgo,
exterior requiere análisis de viento.

Por qué sirve:

Porque protege comercial y legalmente a la empresa.

4.5 Compatibilidad técnica

Debe validar:

tela compatible,
tubo compatible,
motor compatible,
soporte adecuado,
cenefa adecuada,
riel adecuado,
control adecuado.

Por qué sirve:

Porque evita vender configuraciones que luego fallan.

4.6 Biblioteca técnica conectada

Cada producto debe consultar su agente especialista.

Ejemplo:

Una cotización de screen exterior debe poder llamar al agente de Screen Solar y al agente de sistema guaya.

Por qué sirve:

Porque el visor no debe inventar técnica. Debe apoyarse en la biblioteca.

MÓDULO 5 — Módulos operativos

Este módulo convierte la venta en ejecución real.

5.1 Producción

Debe mostrar:

pendiente de abono,
pedido proveedor,
en producción,
listo para instalar,
retenido,
entregado,
instalado.

Por qué sirve:

Porque la venta no termina al pagar. Debe convertirse en producto instalado.

5.2 Instalaciones

Debe registrar visitas.

Cada visita debe tener:

fecha programada,
fecha real,
instalador,
resultado,
fotos,
pendientes,
incidencias.

Resultados:

completa,
parcial,
fallida,
reagendada.

Por qué sirve:

Porque una instalación puede necesitar varias visitas.

5.3 Agenda operativa

Debe organizar:

mediciones,
instalaciones,
mantenimientos,
garantías,
visitas técnicas,
rutas.

Por qué sirve:

Porque mejora coordinación y reduce pérdidas de tiempo.

5.4 Rutas y zonas

Debe clasificar por:

Girardot,
Ricaurte,
Melgar,
Bogotá,
condominios,
conjuntos,
zonas especiales.

Por qué sirve:

Porque permite agrupar visitas y reducir transporte.

5.5 Tareas

Debe crear pendientes desde mensajes.

Ejemplos:

llamar cliente,
enviar cotización,
confirmar pago,
pedir ficha técnica,
agendar instalación,
reclamar proveedor,
pedir reseña.

Por qué sirve:

Porque WhatsApp genera tareas que normalmente quedan perdidas.

5.6 Checklist de instalación

Debe validar:

Antes:

medidas,
producto,
accesorios,
herramientas,
dirección,
autorización.

Durante:

acceso,
instalación,
nivelación,
funcionamiento.

Después:

fotos,
explicación al cliente,
recibido,
saldo,
reseña.

Por qué sirve:

Porque estandariza calidad.

5.7 Entrega al cliente

Debe registrar quién recibió:

cliente,
familiar,
portería,
administrador,
empleado,
tercero.

Por qué sirve:

Porque si luego hay reclamo, se sabe quién recibió y qué se explicó.

MÓDULO 6 — Postventa

Este módulo protege reputación y recompra.

6.1 Garantías

Debe registrar:

fecha apertura,
producto,
causa declarada,
evidencia,
responsable probable,
costo,
solución,
fecha cierre.

Causas:

producto,
instalación,
cliente,
ambiente,
tercero,
construcción.

Por qué sirve:

Porque no todas las garantías son culpa de la empresa.

6.2 Mantenimientos

Debe registrar servicios como:

lavado,
perfilado,
cambio cadenilla,
cambio control,
cambio tubo,
nivelación,
ajuste soporte,
cambio peso inferior.

Por qué sirve:

Porque mantenimiento es recompra operativa.

6.3 Satisfacción post-instalación

Debe detectar:

cliente feliz,
cliente confundido,
cliente molesto,
cliente sin respuesta,
cliente pendiente de ajuste.

Por qué sirve:

Porque instalación terminada no significa cliente satisfecho.

6.4 Google Reviews

Debe controlar:

cliente apto para reseña,
solicitud enviada,
reseña recibida,
estrellas,
comentario,
fecha.

Por qué sirve:

Porque reputación digital alimenta nuevas ventas.

6.5 Reclamos sensibles

Debe marcar casos con riesgo:

cliente molesto,
garantía mal manejada,
daño costoso,
publicación negativa,
mala reseña,
incumplimiento.

Por qué sirve:

Porque algunos casos deben escalarse antes de volverse crisis.

MÓDULO 7 — Evidencias

Este módulo sostiene la verdad del sistema.

7.1 Archivo documental

Debe guardar:

fotos,
videos,
audios,
comprobantes,
facturas,
cotizaciones,
PDFs,
imágenes de medidas.

Por qué sirve:

Porque todo dato importante debe poder demostrarse.

7.2 Evidencia por evento

Cada evento debe apuntar a su evidencia.

Ejemplo:

Evento: abono confirmado.
Evidencia: comprobante + validación humana.

Evento: cambio de medida.
Evidencia: mensaje WhatsApp.

Por qué sirve:

Porque evita discusiones y alucinaciones.

7.3 Transcripción de audio

Debe convertir audios en texto estructurado.

Debe extraer:

cliente,
fecha,
compromiso,
medida,
producto,
pago,
tarea.

Por qué sirve:

Porque mucha información llega hablada.

7.4 Captura en vivo futura

Debe permitir integrar llamadas o conversaciones grabadas.

Por qué sirve:

Porque las decisiones importantes no siempre quedan escritas.

MÓDULO 8 — Agentes

Este módulo organiza el enjambre.

8.1 Panel de agentes

Debe mostrar:

agente,
acción realizada,
dato extraído,
evidencia,
confianza,
estado,
error,
corrección.

Por qué sirve:

Porque la IA debe ser visible y auditable.

8.2 Agente extractor

Extrae datos objetivos:

nombres,
teléfonos,
direcciones,
medidas,
fechas,
productos,
valores.

Por qué sirve:

Porque es la base de datos limpia.

8.3 Agente de medidas

Detecta:

medidas nuevas,
cambios,
inconsistencias,
riesgo de medición cliente.

Por qué sirve:

Porque medidas son una zona crítica de pérdida.

8.4 Agente de pagos

Detecta:

comprobantes,
abonos,
saldos,
métodos,
pagos pendientes.

Por qué sirve:

Porque dinero no puede quedar perdido en WhatsApp.

8.5 Agente de cotizaciones

Controla:

versiones,
cotización ganadora,
cotizaciones perdidas,
vencimientos,
cambios.

Por qué sirve:

Porque ahí se entiende la decisión comercial.

8.6 Agente de garantías

Detecta reclamos y casos postventa.

Por qué sirve:

Porque reduce riesgo reputacional.

8.7 Agente auditor

Revisa:

contradicciones,
datos sin evidencia,
inferencias débiles,
estados imposibles.

Por qué sirve:

Porque protege al sistema de la alucinación.

8.8 Gerente del enjambre

Coordina agentes.

Debe decidir:

qué agente actúa,
qué se escala,
qué se valida,
qué se bloquea.

Por qué sirve:

Porque muchos agentes sin gerente generan caos.

8.9 Agente Junior Jhon

Consulta todo el sistema.

Por qué sirve:

Porque es tu acceso directo desde el celular a la operación completa.

MÓDULO 9 — Control y seguridad

Este módulo protege la confiabilidad del sistema.

9.1 Permisos

Debe definir accesos:

Jhon,
administradores,
asesores,
instaladores,
contabilidad,
soporte.

Por qué sirve:

Porque no todos pueden modificar dinero, garantías o facturas.

9.2 Auditoría humana

Debe registrar:

quién modificó,
qué modificó,
cuándo,
por qué.

Por qué sirve:

Porque permite rastrear errores humanos.

9.3 Correcciones

Debe guardar:

dato anterior,
dato nuevo,
motivo,
evidencia,
responsable.

Por qué sirve:

Porque corregir también enseña al sistema.

9.4 Alertas de contradicción

Debe detectar:

dos medidas distintas,
dos valores distintos,
cliente duplicado,
pago no coincide,
estado imposible.

Por qué sirve:

Porque el negocio real tiene contradicciones.

9.5 Privacidad

Debe separar:

datos confirmados,
inferencias,
observaciones internas,
evidencia,
datos sensibles.

Por qué sirve:

Porque no todo lo que la IA interpreta debe volverse verdad del cliente.

9.6 Confianza del dato

Estados:

confirmado,
inferido,
dudoso,
alerta,
rechazado.

Por qué sirve:

Porque la calidad del dato es más importante que llenar campos.

MÓDULO 10 — Gerencial

Este módulo convierte operación en inteligencia empresarial.

10.1 Dashboard comercial

Debe mostrar:

cotizaciones enviadas,
ventas ganadas,
ventas perdidas,
tasa de cierre,
productos más cotizados,
objeciones frecuentes.

Por qué sirve:

Porque permite mejorar ventas.

10.2 Dashboard operativo

Debe mostrar:

instalaciones,
visitas fallidas,
mantenimientos,
garantías,
pendientes.

Por qué sirve:

Porque permite controlar ejecución.

10.3 Dashboard financiero

Debe mostrar:

abonos,
saldos,
cartera,
descuentos,
facturación.

Por qué sirve:

Porque evita perder dinero.

10.4 Dashboard de errores

Debe mostrar:

errores de medida,
garantías evitables,
retrabajos,
cambios tardíos.

Por qué sirve:

Porque permite mejorar procesos.

10.5 Dashboard de desgaste operativo

Debe medir:

muchos mensajes,
muchos cambios,
muchas visitas,
muchas garantías,
mucho tiempo humano.

Por qué sirve:

Porque no todos los clientes cuestan lo mismo operativamente.

10.6 Dashboard de productos

Debe mostrar:

qué se vende más,
qué deja más margen,
qué genera más garantía,
qué se cotiza y no se compra.

Por qué sirve:

Porque ayuda a enfocar catálogo y ventas.

10.7 Dashboard de reputación

Debe mostrar:

reseñas,
clientes felices,
clientes en riesgo,
garantías sensibles.

Por qué sirve:

Porque reputación genera ventas futuras.

MÓDULO 11 — Núcleo crítico que no se debe omitir

Estos son los componentes que deben existir sí o sí.

11.1 EVENTO_PG

Sin EVENTO_PG el sistema vuelve a ser solo chat.

11.2 Buzón de validación

Sin validación, la IA contamina el CRM.

11.3 Timeline

Sin timeline, se pierde la historia del cliente.

11.4 Medidas y riesgo

Sin control de medidas, se generan pérdidas.

11.5 Cotización ganadora

Sin esto, no se entiende qué se vendió realmente.

11.6 Log de variaciones

Sin log, se borra la evolución comercial.

11.7 Abonos y saldos

Sin esto, el sistema no sirve como operación real.

11.8 Evidencias

Sin evidencia, todo queda en opinión.

11.9 Instalaciones por visita

Sin visitas separadas, la operación queda falsa.

11.10 Garantías con causa raíz

Sin causa raíz, no se aprende de los errores.

11.11 Agente Junior

Sin agente junior, el sistema no aterriza en tu uso diario.

11.12 Auditoría de agentes

Sin auditoría, el enjambre puede inventar.

11.13 Desgaste operativo

Sin medir desgaste, no se sabe qué cliente fue rentable de verdad.

Conclusión operativa

El Visor PG debe ser diseñado como una consola central del Proyecto Persianas.

No debe ser:

solo WhatsApp,
solo CRM,
solo IA,
solo dashboard,
solo cotizaciones.

Debe ser el punto donde se conectan:

conversación,
cliente,
inmueble,
proyecto,
cotización,
pago,
instalación,
garantía,
evidencia,
agente,
validación,
decisión.

La frase base del sistema debe ser:

WhatsApp conversa.
El visor estructura.
Los agentes procesan.
El humano valida.
El CRM guarda.
El agente junior consulta.
La empresa aprende.