import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, type AuthMode, type Me } from './api';

/** Rutas con hash, para que recargar o compartir un enlace abra la misma pantalla. */
export type Route =
  | { page: 'panel' } | { page: 'evaluaciones' } | { page: 'evaluacion'; id: string }
  | { page: 'usuarios' } | { page: 'tablets' } | { page: 'modelo' } | { page: 'bitacora' };

export function parseRoute(hash: string): Route {
  const [p, id] = hash.replace(/^#\/?/, '').split('/');
  if (p === 'evaluaciones' && id) return { page: 'evaluacion', id: decodeURIComponent(id) };
  if (p === 'evaluaciones' || p === 'usuarios' || p === 'tablets' || p === 'modelo' || p === 'bitacora') return { page: p };
  return { page: 'panel' };
}
export const href = (r: Route) => (r.page === 'evaluacion' ? `#/evaluaciones/${encodeURIComponent(r.id)}` : `#/${r.page}`);

export function useRoute() {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => { setRoute(parseRoute(location.hash)); window.scrollTo(0, 0); };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return route;
}

/** Carga datos del servidor; reload() vuelve a pedirlos después de un cambio. */
export function useLoad<T>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    api<T>(path).then((data) => alive && setState({ data, error: null, loading: false }))
      .catch((e: unknown) => alive && setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }));
    return () => { alive = false; };
  }, [path, n]);
  return { ...state, reload: useCallback(() => setN((x) => x + 1), []) };
}

interface Session { me: Me; mode: AuthMode; toast(t: string): void; signOut(): void }
const Ctx = createContext<Session | null>(null);
export const SessionProvider = ({ value, children }: { value: Session; children: ReactNode }) => <Ctx.Provider value={value}>{children}</Ctx.Provider>;
export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession fuera de SessionProvider');
  return s;
}

export const isAuthError = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403);

export function Loading({ error, retry }: { error?: string | null; retry?: () => void }) {
  if (error) return <div className="card" role="alert"><b>No se pudo cargar.</b><p className="small muted" style={{ margin: '4px 0 8px' }}>{error}</p>{retry && <button className="btn" onClick={retry}>Reintentar</button>}</div>;
  return <div className="card muted" aria-busy="true">Cargando…</div>;
}
