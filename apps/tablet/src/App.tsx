import { useEffect, useState, type ReactNode } from 'react';
import { pendingSummary } from '@fs/db';
import { useApp, type View } from './app-state';
import { useEvaluation } from './use-evaluation';
import { vantazLogo as logo } from '@fs/ui';
import { Home } from './screens/Home';
import { Header } from './screens/Header';
import { Capture } from './screens/Capture';
import { Results } from './screens/Results';
import { Plan } from './screens/Plan';
import { Sync } from './screens/Sync';

const ICON: Record<View, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z" />,
  header: <path d="M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h8" />,
  capture: <path d="M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />,
  results: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  plan: <path d="M4 6h16M4 12h10M4 18h7M18 15l3 3-3 3" />,
  sync: <path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3M18 3v4h-4M6 21v-4h4" />,
};

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false);
    addEventListener('online', up); addEventListener('offline', down);
    return () => { removeEventListener('online', up); removeEventListener('offline', down); };
  }, []);
  return on;
}

export function App() {
  const { ctx, view, go, rev, toastText } = useApp();
  void rev;
  const ev = useEvaluation();
  const online = useOnline();
  const pend = pendingSummary(ctx.db);

  const nav = (v: View, label: string, needsEval = false) => (
    <button className="nav" aria-current={view === v ? 'page' : undefined} disabled={needsEval && !ev} onClick={() => go(v)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{ICON[v]}</svg>
      <span>{label}</span>
      {v === 'sync' && pend.operations > 0 && <span className="count tnum">{pend.operations}</span>}
    </button>
  );

  return (
    <div className="app">
      <header className="top">
        <span className="logo"><img src={logo} alt="Vantaz" /></span>
        <h1>Diagnóstico de Fatiga y Somnolencia<small>{ev ? `${ev.row.company}${ev.row.site ? ` · ${ev.row.site}` : ''}${ev.row.status === 'closed' ? ' · cerrada' : ''}` : 'Modelo V01'}</small></h1>
        <span className="spacer" />
        <span className={`chip ${online ? 'on' : 'off'}`}><span className="dot" />{online ? 'Con conexión' : 'Sin conexión'}</span>
        {pend.operations > 0 && <button className="chip pend" onClick={() => go('sync')}><span className="dot" />{pend.operations} cambios por sincronizar</button>}
      </header>
      <div className="shell">
        <nav className="rail" aria-label="Secciones">
          {nav('home', 'Evaluaciones')}
          <span className="lbl">Evaluación abierta</span>
          {nav('header', 'Antecedentes', true)}
          {nav('capture', 'Preguntas', true)}
          {nav('results', 'Resultados', true)}
          {nav('plan', 'Plan de acción', true)}
          <span className="lbl">Tablet</span>
          {nav('sync', 'Sincronizar')}
        </nav>
        <main className="main">
          {view === 'home' && <Home />}
          {view === 'header' && <Header />}
          {view === 'capture' && <Capture />}
          {view === 'results' && <Results />}
          {view === 'plan' && <Plan />}
          {view === 'sync' && <Sync online={online} />}
        </main>
      </div>
      {toastText && <div className="toast" role="status">{toastText}</div>}
    </div>
  );
}
