import { useState } from 'react';
import { Dialog, PageHead } from '@fs/ui';
import { api, type Role, type UserRow } from '../api';
import { fmtDateTime } from '../results';
import { Loading, useLoad, useSession } from '../state';

const ROLE: Record<Role, string> = { administrador: 'Administrador', supervisor: 'Supervisor', evaluador: 'Evaluador' };
const STATUS = { active: ['Activo', 'ok'], invited: ['Invitado', 'warn'], disabled: ['Sin acceso', 'bad'] } as const;
const USERNAME = /^[A-Za-z0-9._-]{3,40}$/;

/** Clave temporal legible para dictarla o anotarla; la persona la cambia al entrar. */
function tempPassword() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(12));
  const s = [...r].map((x) => abc[x % abc.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });

export function Users() {
  const { me, mode, toast } = useSession();
  const local = mode === 'local';
  const [resetFor, setResetFor] = useState<{ u: UserRow; pw: string } | null>(null);
  const [pairing, setPairing] = useState<{ u: UserRow; code: string; expiresAt: string; serverUrls: string[] } | null>(null);
  const { data, error, reload } = useLoad<UserRow[]>('/v1/admin/users');
  const [inviting, setInviting] = useState(false);
  const blank = { name: '', email: '', username: '', password: '', role: 'evaluador' as Role };
  const [form, setForm] = useState(blank);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<UserRow | null>(null);

  const patch = async (u: UserRow, body: { role?: Role; status?: 'active' | 'disabled' }, ok: string) => {
    try { await api(`/v1/admin/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: JSON.stringify(body) }); toast(ok); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  };
  const invite = async () => {
    const email = form.email.trim();
    if (local) {
      if (!form.name.trim() || !USERNAME.test(form.username.trim())) { setMsg('Escribe el nombre y un usuario de 3 a 40 letras o números, sin espacios.'); return; }
      if (form.password.length < 10) { setMsg('La clave inicial debe tener al menos 10 caracteres.'); return; }
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setMsg('El correo no es válido. Puedes dejarlo vacío.'); return; }
    } else if (!form.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { setMsg('Escribe el nombre y un correo válido para continuar.'); return; }
    const body = local
      ? { name: form.name.trim(), username: form.username.trim(), password: form.password, role: form.role, email: email || null }
      : { name: form.name.trim(), email, role: form.role };
    try {
      await api('/v1/admin/users', { method: 'POST', body: JSON.stringify(body) });
      setInviting(false); setForm(blank); reload();
      toast(local ? 'Usuario creado. Entrégale su usuario y clave inicial; deberá cambiarla al entrar.' : 'Invitación registrada. La persona entra con su cuenta Microsoft de la empresa.');
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };
  const resetPassword = async () => {
    if (!resetFor) return;
    try {
      await api(`/v1/admin/users/${encodeURIComponent(resetFor.u.id)}/password`, { method: 'POST', body: JSON.stringify({ password: resetFor.pw }) });
      setResetFor(null); reload(); toast('Clave temporal guardada. La persona deberá cambiarla al entrar.');
    } catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  };
  const newPairingCode = async (u: UserRow) => {
    try { setPairing({ u, ...(await api<{ code: string; expiresAt: string; serverUrls: string[] }>(`/v1/admin/users/${encodeURIComponent(u.id)}/pairing-code`, { method: 'POST' })) }); }
    catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <>
      <PageHead title="Usuarios y accesos" subtitle={local
        ? 'Cada persona entra con el usuario y la clave que le creas aquí. Las tablets se vinculan a una persona con un código de un solo uso.'
        : 'Cada persona entra con su cuenta Microsoft de la empresa. La app no guarda contraseñas propias.'}>
        <button className="btn primary" onClick={() => { setMsg(null); setForm({ ...blank, password: tempPassword() }); setInviting(true); }}>{local ? 'Crear usuario' : 'Invitar usuario'}</button>
      </PageHead>
      {!data ? <Loading error={error} retry={reload} /> : (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="tablewrap">
            <table className="dimtable">
              <thead><tr><th>Persona</th><th>Rol</th><th>Estado</th><th>Último acceso</th><th></th></tr></thead>
              <tbody>
                {data.map((u) => {
                  const self = u.id === me.id;
                  const [label, cls] = STATUS[u.status];
                  return (
                    <tr key={u.id}>
                      <td style={{ minWidth: 220 }}><b>{u.name ?? u.id}</b>{self && <span className="small muted"> (tú)</span>}<br /><span className="small muted">{local && u.username ? `usuario ${u.username}` : ''}{local && u.username && u.email ? ' · ' : ''}{u.email ?? ''}</span></td>
                      <td>
                        <select className="minisel" aria-label={`Rol de ${u.name ?? u.id}`} value={u.role} disabled={self}
                          onChange={(e) => void patch(u, { role: e.target.value as Role }, 'Rol actualizado.')}>
                          {(Object.keys(ROLE) as Role[]).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}
                        </select>
                      </td>
                      <td><span className={`state ${cls}`}>{label}</span>{local && u.status === 'active' && u.must_change_password && <><br /><span className="small muted">Clave temporal</span></>}</td>
                      <td className="tnum">{u.status === 'invited' ? '—' : fmtDateTime(u.last_seen_at)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {local && u.status === 'active' && <button className="btn ghost" onClick={() => void newPairingCode(u)}>Vincular tablet</button>}
                        {local && !self && u.status === 'active' && <button className="btn ghost" onClick={() => setResetFor({ u, pw: tempPassword() })}>Nueva clave</button>}
                        {!self && u.status === 'active' && <button className="btn ghost" onClick={() => setConfirm(u)}>Quitar acceso</button>}
                        {!self && u.status === 'disabled' && <button className="btn ghost" onClick={() => void patch(u, { status: 'active' }, 'Acceso habilitado.')}>Dar acceso</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="sec-t">Qué puede hacer cada rol</div>
      <div className="grid2">
        <div className="card"><span className="role adm">Administrador</span><p className="small" style={{ margin: '8px 0 0' }}>Gestiona usuarios y tablets, ve todas las evaluaciones y la bitácora. No edita respuestas.</p></div>
        <div className="card"><span className="role">Supervisor</span><p className="small" style={{ margin: '8px 0 0' }}>Sigue el avance y ve los resultados de todas las evaluaciones.</p></div>
        <div className="card"><span className="role">Evaluador</span><p className="small" style={{ margin: '8px 0 0' }}>Crea y responde sus evaluaciones en la tablet; ve sus resultados aquí.</p></div>
        <div className="card soon"><span className="role">Revisor y Cliente · V2</span><p className="small" style={{ margin: '8px 0 0' }}>Revisión con comentarios por pregunta y acceso del cliente a sus resultados.</p></div>
      </div>

      {inviting && (
        <Dialog title={local ? 'Crear usuario' : 'Invitar usuario'} onClose={() => setInviting(false)}>
          <div className="field"><label htmlFor="inv-n">Nombre</label><input id="inv-n" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          {local && <>
            <div className="field" style={{ marginTop: 10 }}><label htmlFor="inv-u">Usuario</label><input id="inv-u" placeholder="por ejemplo, ana.perez" autoCapitalize="none" spellCheck={false} value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
            <div className="field" style={{ marginTop: 10 }}><label htmlFor="inv-p">Clave inicial</label><input id="inv-p" className="tnum" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></div>
          </>}
          <div className="field" style={{ marginTop: 10 }}><label htmlFor="inv-e">{local ? 'Correo (opcional)' : 'Correo de su cuenta Microsoft'}</label><input id="inv-e" type="email" placeholder="nombre@empresa.cl" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="field" style={{ marginTop: 10 }}><label htmlFor="inv-r">Rol</label>
            <select id="inv-r" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{(Object.keys(ROLE) as Role[]).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select></div>
          <p className="small" role={msg ? 'alert' : undefined} style={{ margin: '10px 0 0', color: msg ? 'var(--action)' : 'var(--fg-2)' }}>{msg ?? (local ? 'Anota la clave inicial y entrégasela a la persona. Al entrar por primera vez deberá cambiarla.' : 'La invitación se activa la primera vez que la persona entra con esa cuenta.')}</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setInviting(false)}>Cancelar</button>
            <button className="btn primary" onClick={() => void invite()}>{local ? 'Crear usuario' : 'Registrar invitación'}</button>
          </div>
        </Dialog>
      )}
      {resetFor && (
        <Dialog title="Nueva clave temporal" onClose={() => setResetFor(null)}>
          <p className="small">{resetFor.u.name ?? resetFor.u.id} deberá cambiarla al entrar. Sus sesiones abiertas en el portal se cierran; su tablet sigue vinculada.</p>
          <div className="field"><label htmlFor="rp-p">Clave temporal</label><input id="rp-p" className="tnum" value={resetFor.pw} onChange={(e) => setResetFor({ ...resetFor, pw: e.target.value })} /></div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setResetFor(null)}>Cancelar</button>
            <button className="btn primary" disabled={resetFor.pw.length < 10} onClick={() => void resetPassword()}>Guardar clave</button>
          </div>
        </Dialog>
      )}
      {pairing && (
        <Dialog title="Vincular tablet" onClose={() => setPairing(null)}>
          <p className="small">En la tablet de {pairing.u.name ?? pairing.u.id}, abre <b>Sincronizar</b>, escribe la dirección de este servidor y este código:</p>
          <p className="paircode tnum" aria-label="Código de vinculación">{pairing.code}</p>
          <p className="small muted">Sirve una sola vez y vence a las {fmtTime(pairing.expiresAt)}. La tablet queda vinculada a esta persona hasta que la desvincules en Tablets.</p>
          <p className="small muted">Dirección de este servidor en la red: {pairing.serverUrls.length
            ? pairing.serverUrls.map((u, i) => <span key={u}>{i > 0 && ' o '}<b className="tnum">{u}</b></span>)
            : <b className="tnum">{location.origin}</b>}. La tablet debe estar conectada a la misma red Wi‑Fi.</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn primary" onClick={() => setPairing(null)}>Listo</button>
          </div>
        </Dialog>
      )}
      {confirm && (
        <Dialog title="Quitar acceso" onClose={() => setConfirm(null)}>
          <p className="small">{confirm.name ?? confirm.id} ya no podrá entrar al portal ni sincronizar su tablet. Sus evaluaciones se conservan y puedes devolverle el acceso después.</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setConfirm(null)}>Cancelar</button>
            <button className="btn primary" onClick={() => { void patch(confirm, { status: 'disabled' }, 'Acceso quitado.'); setConfirm(null); }}>Quitar acceso</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
