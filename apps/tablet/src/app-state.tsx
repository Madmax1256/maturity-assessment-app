import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { Ctx } from '@fs/db';
import type { LocalDb } from './storage/local-db';

export type View = 'home' | 'header' | 'capture' | 'results' | 'plan' | 'sync';

interface AppState {
  ctx: Ctx;
  /** Cambia la persona de la tablet al vincularla con el servidor. */
  setUserId(id: string): void;
  local: LocalDb;
  view: View;
  evaluationId: string | null;
  /** Sube cada vez que algo cambia en la base, para que las pantallas vuelvan a leer. */
  rev: number;
  go(view: View, evaluationId?: string | null): void;
  /** Ejecuta una escritura; si falla, muestra el motivo y no cambia nada. */
  write(fn: () => void, okMessage?: string): boolean;
  toast(text: string): void;
  toastText: string | null;
}

const Ctx = createContext<AppState | null>(null);

export function AppProvider({ local, userId: initialUser, children }: { local: LocalDb; userId: string; children: ReactNode }) {
  const [userId, setUserId] = useState(initialUser);
  const [view, setView] = useState<View>('home');
  const [evaluationId, setEvaluationId] = useState<string | null>(null);
  const [rev, setRev] = useState(0);
  const [toastText, setToast] = useState<string | null>(null);
  const toast = useCallback((t: string) => {
    setToast(t);
    window.setTimeout(() => setToast((cur) => (cur === t ? null : cur)), 2600);
  }, []);
  const ctx: Ctx = { db: local.driver, userId };
  const write = useCallback((fn: () => void, ok?: string) => {
    try {
      fn();
      setRev((r) => r + 1);
      if (ok) toast(ok);
      return true;
    } catch (e) {
      toast(e instanceof Error ? e.message : 'No se pudo guardar');
      return false;
    }
  }, [toast]);
  const go = useCallback((v: View, id?: string | null) => {
    if (id !== undefined) setEvaluationId(id);
    setView(v);
    window.scrollTo(0, 0);
  }, []);
  return <Ctx.Provider value={{ ctx, setUserId, local, view, evaluationId, rev, go, write, toast, toastText }}>{children}</Ctx.Provider>;
}

export function useApp() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp fuera de AppProvider');
  return v;
}
