# SUPABASE — Visor PG

> Estado del proyecto Supabase usado por Visor_PG.
> Credenciales sensibles viven en `.env` (gitignored).

**Última actualización:** 2026-05-07

---

## Decisión

**Reusamos el Supabase existente** `olububjdvboiqgmihsmk` (el que tenía el Visor viejo).

**Por qué reusar y no crear nuevo:**
- Jhon delegó la tarea ("vos lo hacés siempre"). Yo no tengo acceso para crear proyectos en supabase.com (eso requiere login web del dueño).
- El histórico viejo no servía (caos del v1+v3) → borrarlo es liberador, no pérdida.
- El descifrado HKDF de la extensión sigue funcionando, así que en horas hay datos nuevos.

**Cómo se hizo limpio:**
1. Borradas 54 tablas del Visor viejo + Junior Wasap viejo (DROP CASCADE).
2. Preservadas 3 tablas `knowledge_*` del Bibliotecario_Safra (proyecto separado que comparte este Supabase).
3. Aplicado schema nuevo de Visor_PG (21 tablas + 3 vistas + 16 triggers + 6 ámbitos + 12 sistemas Safra).

---

## Estado actual del Supabase

**Project ref:** `olububjdvboiqgmihsmk`
**URL:** `https://olububjdvboiqgmihsmk.supabase.co`
**Region:** us-east-1

### 24 tablas total

**21 tablas del Visor_PG:**
- `usuarios`, `ambitos`
- `personas`, `inmuebles`, `proyectos`, `rol_persona_inmueble`
- `chats`, `chat_ambito_historial`, `mensajes`
- `evento_pg` (columna vertebral, sección 13 ARQUITECTURA.md)
- `buzon_validacion`
- `agentes_definicion`, `agentes_definicion_historial`
- `memoria_local`, `memoria_global_especialista`
- `correcciones`, `notas_libres`
- `tags`, `tag_asignacion`
- `dead_letter_queue`, `personas_merge_log`

**Catálogos seedados (sección 14 ARQUITECTURA.md):**
- `sistemas_safra` — 12 sistemas (blackout, screen_solar, sheer_elegance, panel_japones, enrollables, verticales, peliculas_solares, toldos, motores, domotica, rieles, cadenillas)
- `zonas_instalacion` — 5 zonas (Girardot urbano, Ricaurte, Melgar, Bogotá, otros)
- `causas_garantia` — 6 causas (producto, instalacion, cliente, ambiente, tercero, construccion)
- `tipos_objecion` — 12 tipos
- `configuracion_sistema` — topes de costo, lease, retry, soft delete, SLA

**3 tablas de la Biblioteca (intactas — del proyecto Bibliotecario_Safra):**
- `knowledge_contributions`
- `knowledge_queries`
- `knowledge_safra`

### 3 vistas de lectura (CQRS ligero, sección 15 ARQUITECTURA.md)
- `vw_clientes_resumen` — resumen por persona con conteo de proyectos y eventos
- `vw_buzon_pendientes` — buzón de validación con datos enriquecidos
- `vw_timeline_proyecto` — línea de tiempo cronológica por proyecto

### Triggers automáticos (16)
- `updated_at` automático en 7 tablas
- TSV automático para FTS en personas, mensajes, evento_pg, notas_libres
- Versionado automático de prompts (al UPDATE de `agentes_definicion` se snapshot la versión anterior)

### Realtime publication
Suscripciones en vivo habilitadas en: `evento_pg`, `buzon_validacion`, `mensajes`, `chats`, `personas`, `proyectos`.

### RLS (Row Level Security)
Habilitado en 9 tablas con políticas MVP abiertas (solo Jhon usa el sistema). Cuando se agreguen otros usuarios, se cambian las políticas a granulares por rol+ámbito.

---

## Credenciales (cómo se cargan)

`.env` en raíz del proyecto contiene:
```
VITE_SUPABASE_URL          # URL pública (visible al frontend)
VITE_SUPABASE_ANON_KEY     # Key pública (visible al frontend)
SUPABASE_SERVICE_ROLE_KEY  # Key privada para scripts Node (NO en frontend)
SUPABASE_DB_PASSWORD       # Password del Postgres directo (para apply_migration.mjs)
VITE_DEEPSEEK_API_KEY      # API key de DeepSeek (LLM principal)
```

**Importante:** `.env` está copiado del proyecto viejo. Mismas credenciales = misma BD = el cambio es solo en el contenido de las tablas.

---

## Cómo aplicar migraciones nuevas

Desde la raíz del proyecto:
```bash
node apply_migration.mjs supabase/migrations/<archivo>.sql
```

El script auto-detecta la región probando varios pooler endpoints; en este Supabase específicamente solo funciona el host **direct** (`db.olububjdvboiqgmihsmk.supabase.co:5432`).

---

## Migraciones aplicadas (orden)

| # | Archivo | Qué hizo |
|---|---|---|
| - | `000_inventario.sql` | (Read-only, no migra) Inventario para auditoría |
| 1 | `001_drop_viejo.sql` | Borró las 54 tablas del Visor viejo + Junior Wasap viejo |
| 2 | `002_schema_inicial.sql` | Schema completo del MÓDULO 1 (21 tablas + 3 vistas + 16 triggers + RLS + Realtime) |
| 3 | `003_seed_catalogos.sql` | Catálogos: sistemas Safra, zonas, causas garantía, objeciones, configuración |

---

## Otros proyectos que comparten este Supabase

| Proyecto | Tablas suyas |
|---|---|
| **Visor_PG** (este) | 21 tablas + 5 catálogos = 26 |
| Bibliotecario_Safra | `knowledge_contributions`, `knowledge_queries`, `knowledge_safra` |

**Importante para futuro:** si en el futuro Bibliotecario_Safra necesita cambios de schema, esos cambios se aplican con sus propios scripts. Nosotros NO tocamos las `knowledge_*`.

---

## Backup y restauración

**Pendiente (FASE de hardening):**
- [ ] Configurar backup diario automático en Supabase Pro
- [ ] Probar UNA vez restauración antes de meter datos reales
- [ ] Documentar procedimiento en `docs/PROCEDIMIENTO_RESTAURACION.md`
