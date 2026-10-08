import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppProvider } from './app-state';
import { App } from './App';
import { openLocalDb } from './storage/local-db';
import { UNLINKED_USER, getLink } from '@fs/db';
import '@fs/ui';

const root = createRoot(document.getElementById('root')!);

openLocalDb()
  .then((local) => {
    // La tablet trabaja a nombre de la persona a quien se vinculó; antes de vincularla, con un
    // evaluador local cuyas evaluaciones pasan a esa persona al vincular.
    const userId = getLink(local.driver)?.user_id ?? UNLINKED_USER;
    root.render(<StrictMode><AppProvider local={local} userId={userId}><App /></AppProvider></StrictMode>);
  })
  .catch((e: unknown) => {
    console.error(e);
    root.render(<div className="main"><div className="card"><b>No se pudo abrir la base local.</b><p className="small muted">{e instanceof Error ? e.message : String(e)}</p></div></div>);
  });
