import { useState, type ReactNode } from 'react';
import { vantazLogo } from '@fs/ui';
import { api, setToken, type AuthMode, type Me } from './api';

const MIN_PASSWORD = 10;

function Frame({ children, msg }: { children: ReactNode; msg: string | null }) {
  return (
    <main className="signin">
      <div className="card">
        <img src={vantazLogo} alt="Vantaz" height={36} />
        <h1>Diagnóstico de Fatiga y Somnolencia</h1>
        {children}
        {msg && <p className="small" role="alert" style={{ color: 'var(--action)', margin: '10px 0 0' }}>{msg}</p>}
      </div>
    </main>
  );
}

export function SignIn({ mode, onSignedIn, error }: { mode: AuthMode; onSignedIn(me: Me): void; error: string | null }) {
  const [user, setUser] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(error);

  const submit = async () => {
    if (!user.trim()) { setMsg('Escribe tu usuario.'); return; }
    if (mode === 'local' && !pw) { setMsg('Escribe tu clave.'); return; }
    setBusy(true);
    try {
      if (mode === 'local') {
        const r = await api<{ token: string }>('/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: user.trim(), password: pw }) });
        setToken(r.token);
      } else {
        setToken(`dev:${user.trim()}`);
      }
      onSignedIn(await api<Me>('/v1/me'));
    } catch (e) {
      setToken(null);
      setPw('');
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (mode === 'entra') {
    return <Frame msg={msg}><p className="small">El inicio de sesión con la cuenta Microsoft de la empresa se habilita cuando TI registre la aplicación en Entra ID.</p></Frame>;
  }
  return (
    <Frame msg={msg}>
      <p className="small muted">{mode === 'local' ? 'Entra con el usuario y la clave que te dio el administrador.' : 'Entrada de desarrollo, sin clave. Solo para pruebas.'}</p>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="field"><label htmlFor="si-user">Usuario</label>
          <input id="si-user" value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} /></div>
        {mode === 'local' && (
          <div className="field" style={{ marginTop: 10 }}><label htmlFor="si-pw">Clave</label>
            <input id="si-pw" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" /></div>
        )}
        <button className="btn primary" type="submit" disabled={busy} style={{ marginTop: 12, width: '100%' }}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </Frame>
  );
}

/** Cambio de clave. Con clave temporal es obligatorio antes de usar el portal. */
export function ChangePassword({ forced, onDone, onCancel }: { forced: boolean; onDone(): void; onCancel?(): void }) {
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const submit = async () => {
    if (pw.length < MIN_PASSWORD) { setMsg(`La clave nueva debe tener al menos ${MIN_PASSWORD} caracteres.`); return; }
    if (pw !== pw2) { setMsg('Las dos claves nuevas no coinciden.'); return; }
    setBusy(true);
    try {
      await api('/v1/me/password', { method: 'POST', body: JSON.stringify({ current: cur, password: pw }) });
      onDone();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div className="field"><label htmlFor="cp-cur">{forced ? 'Clave temporal' : 'Clave actual'}</label>
        <input id="cp-cur" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></div>
      <div className="field" style={{ marginTop: 10 }}><label htmlFor="cp-new">Clave nueva (mínimo {MIN_PASSWORD} caracteres)</label>
        <input id="cp-new" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></div>
      <div className="field" style={{ marginTop: 10 }}><label htmlFor="cp-new2">Repite la clave nueva</label>
        <input id="cp-new2" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></div>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        {onCancel && <button type="button" className="btn ghost" onClick={onCancel}>{forced ? 'Salir' : 'Cancelar'}</button>}
        <button className="btn primary" type="submit" disabled={busy}>{busy ? 'Guardando…' : 'Guardar clave'}</button>
      </div>
    </form>
  );
  if (!forced) return <>{form}{msg && <p className="small" role="alert" style={{ color: 'var(--action)', margin: '10px 0 0' }}>{msg}</p>}</>;
  return (
    <Frame msg={msg}>
      <p className="small muted">Tu clave es temporal. Elige una clave propia para continuar.</p>
      {form}
    </Frame>
  );
}
