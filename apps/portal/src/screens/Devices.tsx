import { useState } from 'react';
import { Dialog, PageHead } from '@fs/ui';
import { api, type DeviceRow } from '../api';
import { daysSince, fmtDateTime } from '../results';
import { Loading, useLoad, useSession } from '../state';

declare const __APP_VERSION__: string;

export function Devices() {
  const { toast } = useSession();
  const { data, error, reload } = useLoad<DeviceRow[]>('/v1/admin/devices');
  const [confirm, setConfirm] = useState<DeviceRow | null>(null);
  const revoke = async (d: DeviceRow) => {
    try { await api(`/v1/admin/devices/${encodeURIComponent(d.id)}/revoke`, { method: 'POST' }); toast('Acceso de la tablet quitado.'); reload(); }
    catch (e) { toast(e instanceof Error ? e.message : String(e)); }
  };
  return (
    <>
      <PageHead title="Tablets" subtitle="Tablets que han sincronizado con el servidor. Los datos en cada tablet están cifrados; si una se pierde, quita su acceso aquí." />
      {!data ? <Loading error={error} retry={reload} /> : (
        <div className="card">
          <div className="tablewrap">
            <table className="dimtable">
              <thead><tr><th>Tablet</th><th>Último evaluador</th><th>Versión de la app</th><th>Última sincronización</th><th>Estado</th><th></th></tr></thead>
              <tbody>
                {data.length === 0 && <tr><td colSpan={6} className="muted">Ninguna tablet ha sincronizado todavía.</td></tr>}
                {data.map((d) => {
                  const days = daysSince(d.last_sync_at);
                  return (
                    <tr key={d.id}>
                      <td><b>{d.model ?? 'Tablet'}</b><br /><span className="small muted">{d.id.slice(0, 8)}</span></td>
                      <td>{d.last_user_name ?? d.last_user_id ?? '—'}</td>
                      <td className="tnum">{d.app_version ?? '—'}{d.app_version && d.app_version !== __APP_VERSION__ && <><br /><span className="small" style={{ color: 'var(--warn)' }}>Distinta a la actual ({__APP_VERSION__})</span></>}</td>
                      <td className="tnum">{fmtDateTime(d.last_sync_at)}{days != null && <><br /><span className="small" style={{ color: days > 7 ? 'var(--warn)' : 'var(--fg-2)' }}>{days === 0 ? 'hoy' : `hace ${days} días`}</span></>}</td>
                      <td><span className={`state ${d.status === 'active' ? 'ok' : 'bad'}`}>{d.status === 'active' ? 'Activa' : 'Acceso quitado'}</span></td>
                      <td>{d.status === 'active' && <button className="btn ghost" onClick={() => setConfirm(d)}>Quitar acceso</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="small muted">El portal no ve los cambios que siguen en una tablet hasta que su evaluador sincroniza. Por eso se muestra la fecha de la última sincronización.</p>
      {confirm && (
        <Dialog title="Quitar acceso a esta tablet" onClose={() => setConfirm(null)}>
          <p className="small">{confirm.model ?? 'Tablet'}{confirm.last_user_name ? `, usada por ${confirm.last_user_name}` : ''}. La tablet ya no podrá sincronizar. Lo que tenga sin enviar queda en la tablet, cifrado, y no llegará al servidor.</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setConfirm(null)}>Cancelar</button>
            <button className="btn primary" onClick={() => { void revoke(confirm); setConfirm(null); }}>Quitar acceso</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
