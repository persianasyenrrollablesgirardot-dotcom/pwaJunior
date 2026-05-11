import { useEffect, useState } from 'react';
import { Sidebar, type ModuloId } from './ui/Sidebar';
import { TopBar } from './ui/TopBar';
import { Modulo1 } from './panels/Modulo1';
import { Modulo2 } from './panels/Modulo2';
import { Modulo3 } from './panels/Modulo3';
import { Modulo4 } from './panels/Modulo4';
import { Modulo5 } from './panels/Modulo5';
import { Modulo6 } from './panels/Modulo6';
import { ModuloPlaceholder } from './panels/ModuloPlaceholder';
import { CentroControl } from './panels/CentroControl';
import { Captura } from './panels/Captura';
import { Clientes } from './panels/Clientes';
import { sincronizarKeysExtension } from './lib/extension';
import { ContextoActivoProvider } from './lib/contexto_activo';
import { NavegacionProvider } from './lib/navegacion';

const MODULOS: { id: ModuloId; nombre: string }[] = [
  { id: 'centro_control', nombre: 'Centro de Control' },
  { id: 'captura', nombre: 'Captura' },
  { id: 'clientes', nombre: 'Clientes' },
  { id: 'm1', nombre: '1 · Núcleo' },
  { id: 'm2', nombre: '2 · Comerciales' },
  { id: 'm3', nombre: '3 · Financieros' },
  { id: 'm4', nombre: '4 · Técnicos' },
  { id: 'm5', nombre: '5 · Operativos' },
  { id: 'm6', nombre: '6 · Postventa' },
  { id: 'm7', nombre: '7 · Evidencias' },
  { id: 'm8', nombre: '8 · Agentes' },
  { id: 'm9', nombre: '9 · Control y seguridad' },
  { id: 'm10', nombre: '10 · Gerencial' },
  { id: 'junior', nombre: 'Junior · asistente' },
];

export default function App() {
  const [modulo, setModulo] = useState<ModuloId>('m1');

  // Sync de keys Visor → extensión al arrancar (independiente del módulo activo).
  // Si la extensión no está conectada, falla silencioso y la próxima acción que la
  // necesite muestra el error explícito.
  useEffect(() => {
    sincronizarKeysExtension()
      .then(r => console.log('[VPG-INIT] sync keys extensión:', r))
      .catch(e => console.warn('[VPG-INIT] sync keys falló:', e.message));
  }, []);

  return (
    <ContextoActivoProvider>
      <NavegacionProvider moduloActivo={modulo} cambiarModulo={setModulo}>
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <Sidebar modulos={MODULOS} activo={modulo} onChange={setModulo} />
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <TopBar />
          <main style={{ flex: 1, overflow: 'auto', background: 'var(--bg-page)' }}>
            {modulo === 'centro_control' && <CentroControl />}
            {modulo === 'captura' && <Captura />}
            {modulo === 'clientes' && <Clientes />}
            {modulo === 'm1' && <Modulo1 />}
            {modulo === 'm2' && <Modulo2 />}
            {modulo === 'm3' && <Modulo3 />}
            {modulo === 'm4' && <Modulo4 />}
            {modulo === 'm5' && <Modulo5 />}
            {modulo === 'm6' && <Modulo6 />}
            {modulo !== 'centro_control' && modulo !== 'captura' && modulo !== 'clientes' && modulo !== 'm1' && modulo !== 'm2' && modulo !== 'm3' && modulo !== 'm4' && modulo !== 'm5' && modulo !== 'm6' && (
              <ModuloPlaceholder
                titulo={MODULOS.find(m => m.id === modulo)?.nombre ?? '?'}
                subtitulo="Pendiente — se construye después del MÓDULO 6"
              />
            )}
          </main>
        </div>
      </div>
      </NavegacionProvider>
    </ContextoActivoProvider>
  );
}
