-- ============================================================================
-- 001_drop_viejo.sql
-- Limpia el Supabase del Visor viejo + Junior Wasap viejo.
-- Preserva tablas knowledge_* (del Bibliotecario_Safra, proyecto separado).
-- Aplicado: 2026-05-07 — inicio del proyecto Visor_PG
-- ============================================================================

BEGIN;

-- v1 (enjambre viejo)
DROP TABLE IF EXISTS chat_history CASCADE;
DROP TABLE IF EXISTS chat_summaries CASCADE;
DROP TABLE IF EXISTS chat_resumen CASCADE;
DROP TABLE IF EXISTS contacto_memoria CASCADE;
DROP TABLE IF EXISTS ws_chat_insights CASCADE;
DROP TABLE IF EXISTS ws_client_profiles CASCADE;
DROP TABLE IF EXISTS ws_commitments CASCADE;
DROP TABLE IF EXISTS ws_extractions CASCADE;

-- v3 (enjambre nuevo del Visor + Junior Wasap)
DROP TABLE IF EXISTS agent_config CASCADE;
DROP TABLE IF EXISTS agent_events CASCADE;
DROP TABLE IF EXISTS agent_inbox CASCADE;
DROP TABLE IF EXISTS agent_logs CASCADE;
DROP TABLE IF EXISTS agentes_definicion CASCADE;
DROP TABLE IF EXISTS alertas_contradiccion CASCADE;
DROP TABLE IF EXISTS buzon_aprobacion CASCADE;
DROP TABLE IF EXISTS chat_authorizations CASCADE;
DROP TABLE IF EXISTS correcciones CASCADE;
DROP TABLE IF EXISTS cotizaciones CASCADE;
DROP TABLE IF EXISTS crm_interacciones CASCADE;
DROP TABLE IF EXISTS desgaste_operativo CASCADE;
DROP TABLE IF EXISTS evento_wa CASCADE;
DROP TABLE IF EXISTS facturas CASCADE;
DROP TABLE IF EXISTS garantias CASCADE;
DROP TABLE IF EXISTS geografia_negocio CASCADE;
DROP TABLE IF EXISTS inmuebles CASCADE;
DROP TABLE IF EXISTS log_variaciones CASCADE;
DROP TABLE IF EXISTS medidas CASCADE;
DROP TABLE IF EXISTS memoria_confianza_cliente CASCADE;
DROP TABLE IF EXISTS memoria_global_especialista CASCADE;
DROP TABLE IF EXISTS memoria_local CASCADE;
DROP TABLE IF EXISTS notas_libres CASCADE;
DROP TABLE IF EXISTS permisos_usuario CASCADE;
DROP TABLE IF EXISTS personas CASCADE;
DROP TABLE IF EXISTS proyectos CASCADE;
DROP TABLE IF EXISTS rol_inmueble CASCADE;
DROP TABLE IF EXISTS secretario_chat CASCADE;
DROP TABLE IF EXISTS secretario_items CASCADE;
DROP TABLE IF EXISTS senales_chat CASCADE;
DROP TABLE IF EXISTS tarea_enjambre CASCADE;
DROP TABLE IF EXISTS telemetria_enjambre CASCADE;
DROP TABLE IF EXISTS visitas_instalacion CASCADE;

-- WhatsApp captura (del Visor viejo)
DROP TABLE IF EXISTS wa_abonos CASCADE;
DROP TABLE IF EXISTS wa_chats CASCADE;
DROP TABLE IF EXISTS wa_compromisos CASCADE;
DROP TABLE IF EXISTS wa_cotizaciones CASCADE;
DROP TABLE IF EXISTS wa_facturas CASCADE;
DROP TABLE IF EXISTS wa_garantia_tickets CASCADE;
DROP TABLE IF EXISTS wa_garantias CASCADE;
DROP TABLE IF EXISTS wa_mantenimientos CASCADE;
DROP TABLE IF EXISTS wa_negocio_patterns CASCADE;
DROP TABLE IF EXISTS wa_postventa_eventos CASCADE;
DROP TABLE IF EXISTS wa_processed_messages CASCADE;
DROP TABLE IF EXISTS wa_raw_captures CASCADE;
DROP TABLE IF EXISTS wa_safra_catalogo CASCADE;

-- Verificación: contar tablas restantes (deben ser 3 knowledge_*)
SELECT
  json_build_object(
    'tablas_restantes', (SELECT json_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'),
    'count', (SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE')
  ) as resultado;

COMMIT;
