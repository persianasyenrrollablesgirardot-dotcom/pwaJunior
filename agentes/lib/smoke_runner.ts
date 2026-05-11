/**
 * Smoke test del runner.ts con un evento real de BD.
 * Usa el agente TEST_ECO (shadow=true, no escribe a tablas de negocio).
 *
 * Uso: npx tsx agentes/lib/smoke_runner.ts
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { ejecutarAgente, cargarAgenteDefinicion, type AgenteHooks } from './runner.js';

const sb = createClient(process.env.VITE_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

interface DatosEco {
  texto_chat: string;
}

const hooks: AgenteHooks<DatosEco> = {
  async cargarContexto(sb, params) {
    const { data: msgs } = await sb
      .from('mensajes')
      .select('texto')
      .eq('chat_id', params.chat_id)
      .is('deleted_at', null)
      .limit(5);
    const texto = (msgs ?? []).map(m => m.texto ?? '').join(' | ').slice(0, 500);
    return { texto_chat: texto };
  },
  construirPrompt(datos, agente) {
    return [
      { role: 'system', content: agente.prompt_especifico },
      { role: 'user', content: `Texto del chat (5 primeros mensajes): "${datos.texto_chat}". Responde según las instrucciones.` },
    ];
  },
  async postProcesar(sb, out, ctx) {
    // En modo shadow no se llama. En modo activo escribiríamos a tabla de negocio aquí.
    console.log(`  postProcesar invocado (NO debería en shadow): ${ctx.agente.codigo}`);
  },
};

async function main() {
  console.log('=== Cargando agente TEST_ECO desde BD ===');
  const agente = await cargarAgenteDefinicion(sb, 'TEST_ECO');
  console.log('  Agente:', JSON.stringify({
    codigo: agente.codigo, nombre: agente.nombre, shadow: agente.shadow, version: agente.version,
  }));

  // Buscar un evento real de BD
  const { data: evt } = await sb
    .from('evento_pg')
    .select('id, chat_id, persona_id, proyecto_id, ambito')
    .eq('estado', 'IDENTIFICADO')
    .not('persona_id', 'is', null)
    .order('id', { ascending: false })
    .limit(1)
    .single();

  if (!evt) {
    console.error('No hay eventos IDENTIFICADO en BD. Procesar un chat primero.');
    process.exit(1);
  }
  console.log('  Evento target:', JSON.stringify(evt));

  console.log('\n=== Ejecutando runner ===');
  const r = await ejecutarAgente(
    sb, agente,
    {
      evento_id: evt.id,
      chat_id: evt.chat_id!,
      persona_id: evt.persona_id!,
      proyecto_id: evt.proyecto_id,
      ambito: evt.ambito,
    },
    hooks
  );

  console.log('\n=== Resultado ===');
  console.log('  ok:', r.ok);
  console.log('  shadow:', r.shadow);
  console.log('  costo:', '$' + r.costo_usd.toFixed(6));
  console.log('  latencia:', r.latencia_ms + 'ms');
  console.log('  fue_al_buzon:', r.fue_al_buzon);
  if (r.output) console.log('  output:', JSON.stringify(r.output));
  if (r.error) console.log('  error:', r.error);

  // Verificar que se creó el evento_pg shadow
  const { data: evtNew } = await sb
    .from('evento_pg')
    .select('id, agente_origen, shadow, payload')
    .eq('agente_origen', 'TEST_ECO')
    .order('id', { ascending: false })
    .limit(1)
    .single();
  console.log('\n=== evento_pg creado (shadow) ===');
  console.log('  ', JSON.stringify(evtNew));

  process.exit(0);
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
