// Modo de la app: 'real' (queries Supabase) o 'demo' (datos fake).
// Por default 'real'. El usuario puede toggle con localStorage.

import { useEffect, useState } from 'react';
import { supabase, supabaseConfigured } from './supabase';

export type Modo = 'real' | 'demo';

const STORAGE_KEY = 'visor_pg_modo';

export function getModoInicial(): Modo {
  if (!supabaseConfigured) return 'demo';
  const stored = localStorage.getItem(STORAGE_KEY) as Modo | null;
  return stored ?? 'real';
}

export function setModo(modo: Modo) {
  localStorage.setItem(STORAGE_KEY, modo);
}

export function useModo(): [Modo, (m: Modo) => void] {
  const [modo, setModoState] = useState<Modo>(getModoInicial());
  return [
    modo,
    (m: Modo) => {
      setModo(m);
      setModoState(m);
    },
  ];
}

// Hook que conecta Realtime de Supabase a un callback (re-fetch on change).
// F1.22 fix I3+I7: debounce 500ms para evitar refetch en cascada cuando llegan
// múltiples INSERTs seguidos. Y early return si table es '__noop__' (no abrir
// canal WebSocket inútil).
export function useRealtimeRefetch(table: string, refetch: () => void, modo: Modo) {
  useEffect(() => {
    if (modo !== 'real') return;
    if (!table || table === '__noop__') return;   // sin tabla, no abrir canal

    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedRefetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; refetch(); }, 500);
    };

    const ch = supabase
      .channel(`refetch-${table}`)
      .on('postgres_changes', { event: '*', schema: 'public', table }, debouncedRefetch)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      ch.unsubscribe();
    };
  }, [table, modo]);
}

// Hook genérico de fetch + realtime.
//
// Bug histórico (2026-05-09): si en modo 'real' el state inicial era `fallback`
// (fake.personas con ids 1-5), cualquier consumer que verifique "id existe en lista"
// fallaba durante el primer render (datos aún cargando) — ej. Identidad limpiaba
// ctx.personaActivaId pensando que era stale.
// Fix: en modo 'real' arranca con array/objeto vacío del shape de fallback.
export function useDatos<T>(
  fetcher: () => Promise<T>,
  fallback: T,
  modo: Modo,
  realtimeTable?: string,
): { datos: T; cargando: boolean; error: string | null; refetch: () => void } {
  const initial: T = modo === 'demo'
    ? fallback
    : (Array.isArray(fallback) ? ([] as unknown as T) : fallback);
  const [datos, setDatos] = useState<T>(initial);
  const [cargando, setCargando] = useState(modo === 'real');
  const [error, setError] = useState<string | null>(null);

  const refetch = () => {
    if (modo === 'demo') {
      setDatos(fallback);
      setCargando(false);
      return;
    }
    setCargando(true);
    fetcher()
      .then(d => { setDatos(d); setError(null); })
      .catch(e => { setError(e.message ?? String(e)); })
      .finally(() => setCargando(false));
  };

  useEffect(() => { refetch(); }, [modo]);
  useRealtimeRefetch(realtimeTable ?? '__noop__', refetch, modo);

  return { datos, cargando, error, refetch };
}
