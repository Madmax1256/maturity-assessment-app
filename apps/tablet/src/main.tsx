import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './app-state';
import { App } from './App';
import { openLocalDb } from './storage/local-db';
import '@fs/ui';

const root = createRoot(document.getElementById('root')!);

openLocalDb()
  .then((local) => {
    // El inicio de sesión con Entra ID llega con el servidor de sincronización; mientras tanto
    // la tablet trabaja con un evaluador local.
    root.render(<StrictMode><AppProvider local={local} userId="evaluador"><App /></AppProvider></StrictMode>);
  })
  .catch((e: unknown) => {
    console.error(e);
    root.render(<div className="main"><div className="card"><b>No se pudo abrir la base local.</b><p className="small muted">{e instanceof Error ? e.message : String(e)}</p></div></div>);
  });
