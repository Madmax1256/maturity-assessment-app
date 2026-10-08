import { useState } from 'react';
import { Dialog, PageHead } from '@fs/ui';
import { api, type Role, type UserRow } from '../api';
import { fmtDateTime } from '../results';
import { Loading, useLoad, useSession } from '../state';

const ROLE: Record<Role, string> = { administrador: 'Administrador', supervisor: 'Supervisor', evaluador: 'Evaluador' };
const STATUS = { active: ['Activo', 'ok'], invited: ['Invitado', 'warn'], disabled: ['Sin acceso', 'bad'] } as const;

export function Users() {
  const { me, toast } = useSession();
  const { data, error, reload } = useLoad<UserRow[]>('/v1/admin/users');
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', role: 'evaluador' as Role });
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<UserRow | null>(null);

  const patch = async (u: UserRow, body: { role?: Role; status?: 'active' | 'disabled' }, ok: string) => {
    try { await api(`/v1/admin/users/${encodeURIComponent(u.id)}`, { method: 'PATCH', body: JSON.stringify(body) }); toast(ok); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  };
  const invite = async () => {
    if (!form.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) { setMsg('Escribe el nombre y un correo válido para continuar.'); return; }
    try {
      await api('/v1/admin/users', { method: 'POST', body: JSON.stringify({ ...form, name: form.name.trim(), email: form.email.trim() }) });
      setInviting(false); setForm({ name: '', email: '', role: 'evaluador' }); toast('Invitación registrada. La persona entra con su cuenta Microsoft de la empresa.'); reload();
    } catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
  };

  return (
    <>
      <PageHead title="Usuarios y accesos" subtitle="Cada persona entra con su cuenta Microsoft de la empresa. La app no guarda contraseñas propias.">
        <button className="btn primary" onClick={() => { setMsg(null); setInviting(true); }}>Invitar usuario</button>
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
                      <td style={{ minWidth: 220 }}><b>{u.name ?? u.id}</b>{self && <span className="small muted"> (tú)</span>}<br /><span className="small muted">{u.email ?? ''}</span></td>
                      <td>
                        <select className="minisel" aria-label={`Rol de ${u.name ?? u.id}`} value={u.role} disabled={self}
                          onChange={(e) => void patch(u, { role: e.target.value as Role }, 'Rol actualizado.')}>
                          {(Object.keys(ROLE) as Role[]).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}
                        </select>
                      </td>
                      <td><span className={`state ${cls}`}>{label}</span></td>
                      <td className="tnum">{u.status === 'invited' ? '—' : fmtDateTime(u.last_seen_at)}</td>
                      <td>{!self && u.status === 'active' && <button className="btn ghost" onClick={() => setConfirm(u)}>Quitar acceso</button>}
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
        <Dialog title="Invitar usuario" onClose={() => setInviting(false)}>
          <div className="field"><label htmlFor="inv-n">Nombre</label><input id="inv-n" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div className="field" style={{ marginTop: 10 }}><label htmlFor="inv-e">Correo de su cuenta Microsoft</label><input id="inv-e" type="email" placeholder="nombre@empresa.cl" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
          <div className="field" style={{ marginTop: 10 }}><label htmlFor="inv-r">Rol</label>
            <select id="inv-r" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>{(Object.keys(ROLE) as Role[]).map((r) => <option key={r} value={r}>{ROLE[r]}</option>)}</select></div>
          <p className="small" role={msg ? 'alert' : undefined} style={{ margin: '10px 0 0', color: msg ? 'var(--action)' : 'var(--fg-2)' }}>{msg ?? 'La invitación se activa la primera vez que la persona entra con esa cuenta.'}</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setInviting(false)}>Cancelar</button>
            <button className="btn primary" onClick={() => void invite()}>Registrar invitación</button>
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
