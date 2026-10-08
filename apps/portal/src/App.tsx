import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Dialog, vantazLogo } from '@fs/ui';
import { SESSION_EXPIRED, api, hasToken, loadAuthMode, setToken, type AuthMode, type Me } from './api';
import { ChangePassword, SignIn } from './account';
import { SessionProvider, href, useRoute, type Route } from './state';
import { Panel } from './screens/Panel';
import { Evaluations } from './screens/Evaluations';
import { EvaluationView } from './screens/EvaluationView';
import { Users } from './screens/Users';
import { Devices } from './screens/Devices';
import { ModelPage } from './screens/ModelPage';
import { AuditLog } from './screens/AuditLog';

const ICON: Record<string, ReactNode> = {
  panel: <path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z" />,
  evaluaciones: <path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />,
  usuarios: <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />,
  tablets: <path d="M5 2h14a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2" />,
  modelo: <path d="M4 6h16M4 12h16M4 18h10" />,
  bitacora: <path d="M12 8v4l3 3M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z" />,
};

const ROLE_LABEL = { administrador: 'Administrador', supervisor: 'Supervisor', evaluador: 'Evaluador' } as const;

export function App() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null);
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [changingPw, setChangingPw] = useState(false);
  const [toastText, setToast] = useState<string | null>(null);
  const toast = useCallback((t: string) => {
    setToast(t);
    window.setTimeout(() => setToast((c) => (c === t ? null : c)), 3000);
  }, []);
  const signOut = useCallback(() => {
    if (mode === 'local' && hasToken()) void api('/v1/auth/logout', { method: 'POST' }).catch(() => {});
    setToken(null); setMe(null); setChangingPw(false); location.hash = '#/panel';
  }, [mode]);

  useEffect(() => {
    void (async () => {
      const m = await loadAuthMode();
      if (hasToken()) {
        try { setMe(await api<Me>('/v1/me')); } catch (e) { setToken(null); setAuthError(e instanceof Error ? e.message : String(e)); }
      }
      setMode(m);
    })();
  }, []);

  useEffect(() => {
    const expired = () => { setToken(null); setMe(null); setAuthError('Tu sesión terminó. Vuelve a entrar.'); };
    addEventListener(SESSION_EXPIRED, expired);
    return () => removeEventListener(SESSION_EXPIRED, expired);
  }, []);

  if (!mode) return <main className="signin"><div className="card muted">Cargando…</div></main>;
  if (!me) return <SignIn mode={mode} onSignedIn={(m) => { setAuthError(null); setMe(m); }} error={authError} />;
  if (me.mustChangePassword) {
    return <ChangePassword forced onCancel={signOut} onDone={() => { setMe({ ...me, mustChangePassword: false }); toast('Clave guardada.'); }} />;
  }

  const admin = me.role === 'administrador';
  const page = route.page === 'evaluacion' ? 'evaluaciones' : route.page;
  const allowed = admin || !['usuarios', 'tablets', 'bitacora'].includes(route.page);
  const nav = (r: Route, label: string) => (
    <a className="nav" href={href(r)} aria-current={page === r.page ? 'page' : undefined}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[r.page]}</svg>
      <span>{label}</span>
    </a>
  );

  return (
    <SessionProvider value={{ me, mode, toast, signOut }}>
      <div className="app">
        <header className="top">
          <span className="logo"><img src={vantazLogo} alt="Vantaz" /></span>
          <h1>Diagnóstico de Fatiga y Somnolencia<small>Portal de seguimiento</small></h1>
          <span className="spacer" />
          <span className="chip"><span className="dot" />{me.name ?? me.email ?? me.id} · {ROLE_LABEL[me.role]}</span>
          {mode === 'local' && <button className="btn ghost" onClick={() => setChangingPw(true)}>Cambiar clave</button>}
          <button className="btn ghost" onClick={signOut}>Salir</button>
        </header>
        <div className="shell">
          <nav className="rail" aria-label="Secciones">
            {nav({ page: 'panel' }, 'Panel')}
            {nav({ page: 'evaluaciones' }, 'Evaluaciones')}
            <span className="lbl">Modelo</span>
            {nav({ page: 'modelo' }, 'Modelo de evaluación')}
            {admin && <>
              <span className="lbl">Administración</span>
              {nav({ page: 'usuarios' }, 'Usuarios y accesos')}
              {nav({ page: 'tablets' }, 'Tablets')}
              {nav({ page: 'bitacora' }, 'Bitácora')}
            </>}
          </nav>
          <main className="main">
            {!allowed ? <div className="card">Esta sección es solo para administradores.</div>
              : route.page === 'panel' ? <Panel />
              : route.page === 'evaluaciones' ? <Evaluations />
              : route.page === 'evaluacion' ? <EvaluationView id={route.id} />
              : route.page === 'usuarios' ? <Users />
              : route.page === 'tablets' ? <Devices />
              : route.page === 'modelo' ? <ModelPage />
              : <AuditLog />}
          </main>
        </div>
        {changingPw && (
          <Dialog title="Cambiar mi clave" onClose={() => setChangingPw(false)}>
            <ChangePassword forced={false} onCancel={() => setChangingPw(false)} onDone={() => { setChangingPw(false); toast('Clave cambiada.'); }} />
          </Dialog>
        )}
        {toastText && <div className="toast" role="status">{toastText}</div>}
      </div>
    </SessionProvider>
  );
}
