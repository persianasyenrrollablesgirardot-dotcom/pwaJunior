// ============================================================================
// Datos FAKE convincentes para mockup MÓDULO 1.
// Reemplazar con queries reales a Supabase cuando F1.7 esté listo.
// ============================================================================

export type Ambito = 'comercial' | 'proveedor' | 'personal_familia' | 'personal_amigos' | 'personal_otros' | 'interno_equipo';
export type ProyectoEstado = 'abierto' | 'en_progreso' | 'ganado' | 'perdido' | 'cerrado' | 'en_garantia';
export type Confianza = 'CONFIRMADO' | 'INFERIDO' | 'DUDOSO' | 'ALERTA';
export type DireccionMsg = 'entrante' | 'saliente';
export type TipoMsg = 'texto' | 'imagen' | 'audio' | 'documento' | 'ubicacion';

export interface Persona {
  id: number;
  nombre: string;
  alias?: string;
  telefono?: string;
  email?: string;
  ambito: Ambito;
  ciudad?: string;
  rol?: string;
  notas?: string;
  tags?: string[];
  empresa?: string;
  referido_por_persona_id?: number;
  contacto_alterno_nombre?: string;
  contacto_alterno_telefono?: string;
}

export interface Inmueble {
  id: number;
  direccion: string;
  ciudad: string;
  barrio?: string;
  conjunto?: string;
  torre?: string;
  apartamento?: string;
  tipo: string;
  notas?: string;
  restricciones_ingreso?: string;
  administracion_contacto?: string;
  parqueadero?: boolean;
  ascensor?: boolean;
  horarios_permitidos?: string;
}

export interface Proyecto {
  id: number;
  persona_id: number;
  inmueble_id?: number;
  ambito: Ambito;
  nombre: string;
  estado: ProyectoEstado;
  origen: string;
  fecha_apertura: string;
  prioridad: number;
}

export type IaEstado = 'crudo' | 'autorizado_pendiente' | 'procesado' | 'bloqueado';

export interface Chat {
  id: number;
  canal: 'whatsapp' | 'web' | 'email' | 'audio';
  titulo: string;
  ambito: Ambito;
  ambito_confirmado: boolean;
  proyecto_id?: number;
  persona_id?: number;
  ultimo_mensaje_preview: string;
  ultimo_mensaje_ts: string;
  no_leidos: number;
  // Política IA (PARTE VI ARQUITECTURA)
  ia_estado: IaEstado;
  ia_autorizado: boolean;
  ia_historico_procesado: boolean;
  ia_bloqueado: boolean;
  ia_bloqueado_motivo?: string;
  ia_costo_acumulado_usd: number;
  mensajes_total: number;
}

export interface Mensaje {
  id: number;
  chat_id: number;
  direccion: DireccionMsg;
  tipo: TipoMsg;
  texto?: string;
  ts: string;
  autor_nombre?: string;
}

export interface EventoPG {
  id: number;
  tipo_evento: string;
  estado: 'NUEVO' | 'IDENTIFICADO' | 'EN_PROCESO' | 'PROCESADO' | 'AMBIGUO';
  ambito: Ambito;
  persona_id?: number;
  proyecto_id?: number;
  payload_resumen: string;
  evidencia_msg_ids: number[];
  agente_origen?: string;
  confianza?: Confianza;
  prioridad: number;
  ts_canal: string;
  ts_creado: string;
}

export interface ItemBuzon {
  id: number;
  evento_id: number;
  persona_nombre: string;
  proyecto_nombre?: string;
  ambito: Ambito;
  tipo_decision: string;
  resumen: string;
  detalle: Record<string, any>;
  evidencia_msg_ids: number[];
  reglas_aplicadas: string[];
  prioridad: number;
  horas_pendiente: number;
  agente_origen: string;
  confianza: Confianza;
}

// ============================================================================
// PERSONAS — 5 fake convincentes
// ============================================================================

export const personas: Persona[] = [
  {
    id: 1,
    nombre: 'Pedro Martínez',
    telefono: '+57 322 545 8821',
    email: 'pedromartinez@gmail.com',
    ambito: 'comercial',
    ciudad: 'Girardot',
    rol: 'comprador',
    notas: 'Conjunto Mirador del Río · Torre 3 · Apto 502. Quiere blackout para 2 alcobas + screen para sala. Me lo recomendó Ana Pérez.',
    tags: ['referido', 'caliente'],
  },
  {
    id: 2,
    nombre: 'María Rodríguez',
    telefono: '+57 311 778 4499',
    email: 'maria.r.arq@gmail.com',
    ambito: 'comercial',
    ciudad: 'Girardot',
    rol: 'arquitecta',
    notas: 'Arquitecta. Cliente recurrente. Trabaja con varios proyectos en Conjunto Bahía. Pago siempre puntual.',
    tags: ['VIP', 'recurrente'],
  },
  {
    id: 3,
    nombre: 'Carlos Buitrago',
    telefono: '+57 320 111 2233',
    ambito: 'comercial',
    ciudad: 'Ricaurte',
    rol: 'comprador',
    notas: 'Solicitó cotización por web. Persianas verticales para oficina. Pendiente de medición.',
    tags: ['web_lead'],
  },
  {
    id: 4,
    nombre: 'Distribuidora Telas Bogotá',
    telefono: '+57 1 350 4040',
    email: 'pedidos@distritelas.com.co',
    ambito: 'proveedor',
    ciudad: 'Bogotá',
    rol: 'proveedor',
    notas: 'Proveedor principal de tela blackout. Pedidos los lunes, entrega miércoles.',
    tags: ['proveedor_principal'],
  },
  {
    id: 5,
    nombre: 'Sara Cubides',
    telefono: '+57 322 700 1122',
    ambito: 'personal_familia',
    rol: 'hija',
    notas: 'Mi hija. Ámbito familia.',
  },
];

// ============================================================================
// INMUEBLES
// ============================================================================

export const inmuebles: Inmueble[] = [
  {
    id: 1,
    direccion: 'Cra 10 # 35-20',
    ciudad: 'Girardot',
    conjunto: 'Mirador del Río',
    torre: '3',
    apartamento: '502',
    tipo: 'apartamento',
    notas: 'Conjunto con horario de instalación 8am-5pm. Parqueadero visitantes nivel sótano. Ascensor disponible.',
  },
  {
    id: 2,
    direccion: 'Cl 22 # 14-08',
    ciudad: 'Girardot',
    conjunto: 'Bahía',
    torre: '2',
    apartamento: '801',
    tipo: 'apartamento',
    notas: 'Cliente recurrente · 4to proyecto en este conjunto.',
  },
  {
    id: 3,
    direccion: 'Av 7 # 10-50 Local 3',
    ciudad: 'Ricaurte',
    tipo: 'oficina',
    notas: 'Oficina comercial. Acceso libre en horario hábil.',
  },
];

// ============================================================================
// PROYECTOS
// ============================================================================

export const proyectos: Proyecto[] = [
  {
    id: 1,
    persona_id: 1,
    inmueble_id: 1,
    ambito: 'comercial',
    nombre: 'Blackout alcobas + Screen sala',
    estado: 'en_progreso',
    origen: 'whatsapp_inbound',
    fecha_apertura: '2026-05-02T14:30:00Z',
    prioridad: 2,
  },
  {
    id: 2,
    persona_id: 2,
    inmueble_id: 2,
    ambito: 'comercial',
    nombre: 'Sheer + Blackout 4 ambientes',
    estado: 'ganado',
    origen: 'whatsapp_inbound',
    fecha_apertura: '2026-04-15T10:00:00Z',
    prioridad: 3,
  },
  {
    id: 3,
    persona_id: 3,
    inmueble_id: 3,
    ambito: 'comercial',
    nombre: 'Persianas verticales oficina',
    estado: 'abierto',
    origen: 'web_form',
    fecha_apertura: '2026-05-06T09:15:00Z',
    prioridad: 5,
  },
];

// ============================================================================
// CHATS (bandeja WhatsApp)
// ============================================================================

export const chats: Chat[] = [
  {
    id: 1, canal: 'whatsapp', titulo: 'Pedro Martínez',
    ambito: 'comercial', ambito_confirmado: true,
    proyecto_id: 1, persona_id: 1,
    ultimo_mensaje_preview: 'Listo Jhon, mañana te confirmo el horario para la medición',
    ultimo_mensaje_ts: '2026-05-07T14:22:00Z', no_leidos: 0,
    ia_estado: 'procesado', ia_autorizado: true, ia_historico_procesado: true, ia_bloqueado: false,
    ia_costo_acumulado_usd: 0.018, mensajes_total: 23,
  },
  {
    id: 2, canal: 'whatsapp', titulo: 'María Rodríguez · Arq.',
    ambito: 'comercial', ambito_confirmado: true,
    proyecto_id: 2, persona_id: 2,
    ultimo_mensaje_preview: '[Comprobante de pago — $2.450.000]',
    ultimo_mensaje_ts: '2026-05-07T11:45:00Z', no_leidos: 1,
    ia_estado: 'procesado', ia_autorizado: true, ia_historico_procesado: true, ia_bloqueado: false,
    ia_costo_acumulado_usd: 0.034, mensajes_total: 47,
  },
  {
    id: 3, canal: 'web', titulo: 'Carlos Buitrago (web)',
    ambito: 'comercial', ambito_confirmado: false,
    proyecto_id: 3, persona_id: 3,
    ultimo_mensaje_preview: 'Necesito cotización para 5 ventanas de oficina',
    ultimo_mensaje_ts: '2026-05-06T09:15:00Z', no_leidos: 2,
    ia_estado: 'crudo', ia_autorizado: false, ia_historico_procesado: false, ia_bloqueado: false,
    ia_costo_acumulado_usd: 0, mensajes_total: 8,
  },
  {
    id: 4, canal: 'whatsapp', titulo: 'Distri Telas',
    ambito: 'proveedor', ambito_confirmado: true,
    persona_id: 4,
    ultimo_mensaje_preview: 'Pedido confirmado, entrega miércoles',
    ultimo_mensaje_ts: '2026-05-06T16:00:00Z', no_leidos: 0,
    ia_estado: 'autorizado_pendiente', ia_autorizado: true, ia_historico_procesado: false, ia_bloqueado: false,
    ia_costo_acumulado_usd: 0, mensajes_total: 156,
  },
  {
    id: 5, canal: 'whatsapp', titulo: 'Sara (hija)',
    ambito: 'personal_familia', ambito_confirmado: true,
    persona_id: 5,
    ultimo_mensaje_preview: 'Pa, recuerda que mañana es el cumple de tía',
    ultimo_mensaje_ts: '2026-05-07T08:00:00Z', no_leidos: 1,
    ia_estado: 'crudo', ia_autorizado: false, ia_historico_procesado: false, ia_bloqueado: false,
    ia_costo_acumulado_usd: 0, mensajes_total: 312,
  },
  {
    id: 6, canal: 'whatsapp', titulo: 'Spam (número desconocido)',
    ambito: 'personal_otros', ambito_confirmado: false,
    ultimo_mensaje_preview: 'Promoción especial, tasas bajas...',
    ultimo_mensaje_ts: '2026-05-05T22:30:00Z', no_leidos: 0,
    ia_estado: 'bloqueado', ia_autorizado: false, ia_historico_procesado: false, ia_bloqueado: true,
    ia_bloqueado_motivo: 'Spam recurrente', ia_costo_acumulado_usd: 0, mensajes_total: 4,
  },
];

// ============================================================================
// MENSAJES (timeline conversación de chat 1 — Pedro)
// ============================================================================

export const mensajes: Mensaje[] = [
  { id: 1, chat_id: 1, direccion: 'entrante', tipo: 'texto', texto: 'Hola buenas tardes, me dieron tu contacto. Necesito cortinas para mi apartamento', ts: '2026-05-02T14:30:00Z' },
  { id: 2, chat_id: 1, direccion: 'saliente', tipo: 'texto', texto: 'Hola Pedro, con mucho gusto. ¿Para qué espacios necesitas y en qué ciudad?', ts: '2026-05-02T14:35:00Z' },
  { id: 3, chat_id: 1, direccion: 'entrante', tipo: 'texto', texto: 'Estoy en Girardot, conjunto Mirador del Río. Necesito blackout para 2 alcobas y algo para la sala que deje pasar luz pero no se vea de afuera', ts: '2026-05-02T14:40:00Z' },
  { id: 4, chat_id: 1, direccion: 'saliente', tipo: 'texto', texto: 'Para sala te recomiendo screen solar al 5%, deja pasar luz pero no se ve de afuera durante el día. ¿Tienes las medidas?', ts: '2026-05-02T14:42:00Z' },
  { id: 5, chat_id: 1, direccion: 'entrante', tipo: 'imagen', texto: '[Foto de la sala con dimensiones marcadas]', ts: '2026-05-02T14:50:00Z' },
  { id: 6, chat_id: 1, direccion: 'entrante', tipo: 'texto', texto: 'Las medidas de la sala son 2.40 ancho x 1.80 alto, son dos ventanas iguales', ts: '2026-05-02T14:51:00Z' },
  { id: 7, chat_id: 1, direccion: 'saliente', tipo: 'texto', texto: 'Perfecto. Para que sea preciso me toca ir a tomar las medidas. ¿Cuándo te queda bien? Voy mañana o pasado.', ts: '2026-05-02T14:55:00Z' },
  { id: 8, chat_id: 1, direccion: 'entrante', tipo: 'texto', texto: 'Mañana sábado en la mañana te queda bien?', ts: '2026-05-02T15:00:00Z' },
  { id: 9, chat_id: 1, direccion: 'saliente', tipo: 'texto', texto: 'Sí, ¿9am?', ts: '2026-05-02T15:01:00Z' },
  { id: 10, chat_id: 1, direccion: 'entrante', tipo: 'texto', texto: 'Listo Jhon, mañana te confirmo el horario para la medición', ts: '2026-05-07T14:22:00Z' },
];

// ============================================================================
// EVENTOS PG (timeline del proyecto 1)
// ============================================================================

export const eventos: EventoPG[] = [
  { id: 101, tipo_evento: 'mensaje_entrante', estado: 'PROCESADO', ambito: 'comercial', persona_id: 1, proyecto_id: 1, payload_resumen: 'Pedro pide cortinas para apartamento', evidencia_msg_ids: [1], prioridad: 5, ts_canal: '2026-05-02T14:30:00Z', ts_creado: '2026-05-02T14:30:01Z' },
  { id: 102, tipo_evento: 'inferencia',       estado: 'PROCESADO', ambito: 'comercial', persona_id: 1, proyecto_id: 1, payload_resumen: 'Sistema inferido: Blackout (alcobas) + Screen Solar (sala)', evidencia_msg_ids: [3, 4], agente_origen: 'A2', confianza: 'INFERIDO', prioridad: 3, ts_canal: '2026-05-02T14:42:00Z', ts_creado: '2026-05-02T14:43:10Z' },
  { id: 103, tipo_evento: 'medida',           estado: 'PROCESADO', ambito: 'comercial', persona_id: 1, proyecto_id: 1, payload_resumen: 'Medida sala: 2.40 × 1.80 (dada por cliente, RIESGO)', evidencia_msg_ids: [6], agente_origen: 'A6', confianza: 'INFERIDO', prioridad: 3, ts_canal: '2026-05-02T14:51:00Z', ts_creado: '2026-05-02T14:52:00Z' },
  { id: 104, tipo_evento: 'tarea',            estado: 'PROCESADO', ambito: 'comercial', persona_id: 1, proyecto_id: 1, payload_resumen: 'Agendar visita de medición sábado 9am', evidencia_msg_ids: [7, 8, 9], agente_origen: 'A7', confianza: 'CONFIRMADO', prioridad: 2, ts_canal: '2026-05-02T15:01:00Z', ts_creado: '2026-05-02T15:02:00Z' },
  { id: 105, tipo_evento: 'mensaje_entrante', estado: 'NUEVO',     ambito: 'comercial', persona_id: 1, proyecto_id: 1, payload_resumen: 'Pedro confirma horario mañana', evidencia_msg_ids: [10], prioridad: 5, ts_canal: '2026-05-07T14:22:00Z', ts_creado: '2026-05-07T14:22:01Z' },
];

// ============================================================================
// BUZÓN DE VALIDACIÓN
// ============================================================================

export const buzon: ItemBuzon[] = [
  {
    id: 201,
    evento_id: 102,
    persona_nombre: 'Pedro Martínez',
    proyecto_nombre: 'Blackout alcobas + Screen sala',
    ambito: 'comercial',
    tipo_decision: 'sistema_inferido',
    resumen: 'Agente A2 infiere sistema: Blackout (alcobas) + Screen Solar 5% (sala)',
    detalle: { sistemas: ['blackout', 'screen_solar'], ambientes: ['alcoba_1', 'alcoba_2', 'sala'] },
    evidencia_msg_ids: [3, 4],
    reglas_aplicadas: ['R-013#3'],
    prioridad: 3,
    horas_pendiente: 2,
    agente_origen: 'A2',
    confianza: 'INFERIDO',
  },
  {
    id: 202,
    evento_id: 103,
    persona_nombre: 'Pedro Martínez',
    proyecto_nombre: 'Blackout alcobas + Screen sala',
    ambito: 'comercial',
    tipo_decision: 'medida_riesgo',
    resumen: 'Medida 2.40×1.80 dada por cliente (RIESGO_MEDICION_CLIENTE)',
    detalle: { ancho: 2.40, alto: 1.80, ambiente: 'sala', quien_midio: 'cliente' },
    evidencia_msg_ids: [6],
    reglas_aplicadas: ['R-013#1', 'R-013#5'],
    prioridad: 2,
    horas_pendiente: 4,
    agente_origen: 'A6',
    confianza: 'INFERIDO',
  },
  {
    id: 203,
    evento_id: 999,
    persona_nombre: 'María Rodríguez',
    proyecto_nombre: 'Sheer + Blackout 4 ambientes',
    ambito: 'comercial',
    tipo_decision: 'abono_pendiente_validacion',
    resumen: 'Foto de comprobante recibida — $2.450.000. Validar antes de cambiar estado a CONFIRMADO',
    detalle: { monto: 2450000, metodo_inferido: 'transferencia_bancolombia' },
    evidencia_msg_ids: [50],
    reglas_aplicadas: ['R-001', 'R-009'],
    prioridad: 1,
    horas_pendiente: 1,
    agente_origen: 'A_pagos',
    confianza: 'INFERIDO',
  },
];

// ============================================================================
// MAPS de acceso rápido
// ============================================================================

export const personaById = (id: number) => personas.find(p => p.id === id);
export const proyectoById = (id: number) => proyectos.find(p => p.id === id);
export const inmuebleById = (id: number) => inmuebles.find(i => i.id === id);
export const chatById = (id: number) => chats.find(c => c.id === id);
export const mensajesByChat = (chatId: number) => mensajes.filter(m => m.chat_id === chatId);
export const eventosByProyecto = (proyectoId: number) => eventos.filter(e => e.proyecto_id === proyectoId);
export const proyectosByPersona = (personaId: number) => proyectos.filter(p => p.persona_id === personaId);

// ============================================================================
// HELPERS de formato
// ============================================================================

export function formatTs(iso: string): string {
  const d = new Date(iso);
  const hoy = new Date();
  const esMismoDia = d.toDateString() === hoy.toDateString();
  const ayer = new Date(hoy); ayer.setDate(ayer.getDate() - 1);
  const esAyer = d.toDateString() === ayer.toDateString();

  const hora = d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (esMismoDia) return hora;
  if (esAyer) return `Ayer ${hora}`;
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' }) + ' ' + hora;
}

export function formatCOP(n: number): string {
  return n.toLocaleString('es-CO', { style: 'currency', currency: 'COP', minimumFractionDigits: 0 });
}

export function ambitoLabel(a: Ambito): string {
  const map: Record<Ambito, string> = {
    'comercial': 'Comercial',
    'proveedor': 'Proveedor',
    'personal_familia': 'Familia',
    'personal_amigos': 'Amigos',
    'personal_otros': 'Personal',
    'interno_equipo': 'Equipo',
  };
  return map[a];
}

export function ambitoColor(a: Ambito): string {
  const map: Record<Ambito, string> = {
    'comercial': '#007aff',
    'proveedor': '#5856d6',
    'personal_familia': '#ff2d55',
    'personal_amigos': '#ff9500',
    'personal_otros': '#8e8e93',
    'interno_equipo': '#34c759',
  };
  return map[a];
}

export function confianzaColor(c?: Confianza): string {
  if (!c) return '#8e8e93';
  const map: Record<Confianza, string> = {
    'CONFIRMADO': '#34c759',
    'INFERIDO': '#007aff',
    'DUDOSO': '#ff9500',
    'ALERTA': '#ff3b30',
  };
  return map[c];
}
