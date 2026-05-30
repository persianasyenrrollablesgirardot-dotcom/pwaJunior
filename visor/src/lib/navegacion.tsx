/**
 * Context de navegación entre módulos.
 *
 * App.tsx provee `cambiarModulo(id)`. Cualquier panel que quiera saltar a otro módulo
 * (ej: M0 Captura → M1 Núcleo al click un chat procesado) usa el hook.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { ModuloId } from '../ui/Sidebar';

interface NavegacionAPI {
  moduloActivo: ModuloId;
  cambiarModulo: (id: ModuloId) => void;
}

const Ctx = createContext<NavegacionAPI | null>(null);

export function NavegacionProvider({
  moduloActivo, cambiarModulo, children,
}: { moduloActivo: ModuloId; cambiarModulo: (id: ModuloId) => void; children: ReactNode }) {
  return <Ctx.Provider value={{ moduloActivo, cambiarModulo }}>{children}</Ctx.Provider>;
}

export function useNavegacion(): NavegacionAPI {
  const v = useContext(Ctx);
  if (!v) throw new Error('useNavegacion() requiere <NavegacionProvider>');
  return v;
}
