import { useState } from 'react';
import { clearLink, getLink, httpTransport, listConflicts, saveLink, listRejected, pendingOps, pendingSummary, resolveAnswerConflict, retryRejected, runSync, syncState, type SyncReport } from '@fs/db';
import { useApp } from '../app-state';
import { readEvidenceBytes } from '../storage/evidence-store';
import { deviceInfo, normalizeServerUrl, pairWithServer, syncTarget } from '../sync-config';
import { PageHead } from '@fs/ui';

const ENTITY: Record<string, string> = {
  evaluation: 'Evaluación', dimension_scope: 'Alcance', answer: 'Respuesta', evidence_file: 'Evidencia', action_item: 'Plan de acción',
};

function describe(entity: string, key: string, op: string, payload: string) {
  const p = JSON.parse(payload) as Record<string, unknown>;
  if (entity === 'answer') {
    const q = key.split('|')[1];
    if (p.notApplicable) return `${q} marcada No aplica`;
    if (p.score != null) return `${q}: ${p.score} %${p.evidenceNote ? ' con nota' : ''}`;
    return `${q}: nota de evidencia`;
  }
  if (entity === 'evaluation') return op === 'close' ? 'Evaluación cerrada' : `Antecedentes: ${p.company ?? ''}`;
  if (entity === 'dimension_scope') return `${p.dimension} ${p.applies ? 'aplica' : 'no aplica'}`;
  if (entity === 'evidence_file') return `Archivo de ${Math.round(Number(p.bytes ?? 0) / 1024)} KB${p.questionId ? ` en ${p.questionId}` : ''}`;
  return String(p.description ?? '');
}

const answerText = (a: { score: number | null; notApplicable: boolean; naJustification: string | null }) =>
  a.notApplicable ? `No aplica (${a.naJustification ?? ''})` : a.score == null ? 'Sin responder' : `${a.score} %`;

const fmtWhen = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' }) : 'nunca');

/** Vincula la tablet con el servidor del computador usando el código que entrega el administrador. */
function PairCard({ online }: { online: boolean }) {
  const { ctx, setUserId, write, toast } = useApp();
  // Servida por el propio servidor (/tablet/ en el computador): la dirección ya se conoce.
  const [url, setUrl] = useState(() => (location.protocol.startsWith('http') && location.pathname.startsWith('/tablet') ? location.host : ''));
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const pair = async () => {
    const server = normalizeServerUrl(url);
    if (!server) { setMsg('Escribe la dirección del servidor, por ejemplo 192.168.1.20:8000.'); return; }
    if (code.replace(/[^A-Za-z0-9]/g, '').length !== 8) { setMsg('El código tiene 8 letras y números, por ejemplo ABCD-2345.'); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await pairWithServer(server, code, syncState(ctx.db)!.device_id);
      const ok = write(() => saveLink(ctx, { server_url: server, token: r.token, user_id: r.user.id, user_name: r.user.name }));
      if (ok) { setUserId(r.user.id); toast(`Tablet vinculada a ${r.user.name ?? r.user.id}.`); }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <b>Vincular esta tablet</b>
      <p className="small muted" style={{ margin: '4px 0 10px' }}>Pide al administrador un código en el portal (Usuarios y accesos, Vincular tablet). La tablet debe estar en la misma red Wi‑Fi que el computador del servidor.</p>
      <form onSubmit={(e) => { e.preventDefault(); void pair(); }}>
        <div className="grid2">
          <div className="field"><label htmlFor="pair-url">Dirección del servidor</label>
            <input id="pair-url" inputMode="url" placeholder="192.168.1.20:8000" autoCapitalize="none" spellCheck={false} value={url} onChange={(e) => setUrl(e.target.value)} /></div>
          <div className="field"><label htmlFor="pair-code">Código</label>
            <input id="pair-code" placeholder="ABCD-2345" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} /></div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn primary" type="submit" disabled={busy || !online}>{busy ? 'Vinculando…' : 'Vincular'}</button>
          {msg && <span className="small" role="alert" style={{ color: 'var(--action)' }}>{msg}</span>}
        </div>
      </form>
    </div>
  );
}

export function Sync({ online }: { online: boolean }) {
  const { ctx, rev, write, toast } = useApp();
  void rev;
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SyncReport | null>(null);
  const s = pendingSummary(ctx.db);
  const ops = pendingOps(ctx.db, 500);
  const conflicts = listConflicts(ctx.db);
  const rejected = listRejected(ctx.db);
  const st = syncState(ctx.db);
  const mb = (s.fileBytes / 1024 / 1024).toLocaleString('es-CL', { maximumFractionDigits: 1 });
  const target = syncTarget(ctx.db);
  const link = getLink(ctx.db);
  const configured = target != null;

  const sync = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const r = await runSync(ctx, httpTransport(target.url, async () => target.token), readEvidenceBytes, deviceInfo());
      setLast(r);
      write(() => {}, r.rejected || r.conflicts || r.filesFailed.length ? 'Sincronización terminada con observaciones.' : 'Sincronización completa.');
    } catch (e) {
      toast(`No se pudo sincronizar: ${e instanceof Error ? e.message : String(e)}. Los cambios siguen guardados en la tablet.`);
      write(() => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="Sincronizar" subtitle={`Nada se envía solo. Revisa lo que saldrá de esta tablet y confirma. Última sincronización: ${fmtWhen(st?.last_sync_at)}.`} />
      {!configured && <PairCard online={online} />}
      {link && (
        <div className="card row" style={{ marginBottom: 14, flexWrap: 'wrap' }}>
          <span style={{ flex: 1, minWidth: 0 }}><b>Vinculada a {link.user_name ?? link.user_id}</b><br /><span className="small muted tnum">Servidor {link.server_url}</span></span>
          <button className="btn ghost" disabled={ops.length > 0} title={ops.length > 0 ? 'Sincroniza antes de desvincular' : undefined}
            onClick={() => write(() => clearLink(ctx), 'Tablet desvinculada. Puedes vincularla con un código nuevo.')}>Desvincular</button>
        </div>
      )}
      {!online && <div className="card" style={{ marginBottom: 14, borderColor: 'var(--warn)' }}><b>Sin conexión.</b> <span className="muted">Puedes seguir evaluando; todo queda guardado y cifrado en la tablet.</span></div>}

      {last && (
        <div className="card" style={{ marginBottom: 14 }}>
          <b>Resultado del último envío</b>
          <p className="small" style={{ margin: '4px 0 0' }}>
            {last.accepted} cambios aceptados{last.filesUploaded ? `, ${last.filesUploaded} archivos subidos` : ''}
            {last.rejected ? `, ${last.rejected} rechazados` : ''}{last.conflicts ? `, ${last.conflicts} en conflicto` : ''}.
            {last.filesFailed.length ? ` ${last.filesFailed.length} archivos no se pudieron subir y quedan en cola: ${last.filesFailed[0]!.reason}.` : ''}
            {last.downloaded ? ` Llegaron ${last.downloaded} evaluaciones iniciadas en otro equipo.` : ' Los avances hechos en tus otros equipos quedaron al día.'}
          </p>
        </div>
      )}

      {conflicts.length > 0 && (
        <div className="card conflict" style={{ marginBottom: 14 }}>
          <b>Respuestas cambiadas desde otro dispositivo</b>
          <p className="small muted" style={{ margin: '4px 0 10px' }}>Elige cuál queda. Si mantienes la tuya, se enviará en la próxima sincronización.</p>
          {conflicts.map((cf) => (
            <div className="op" key={cf.op_id} style={{ flexWrap: 'wrap' }}>
              <span style={{ minWidth: 0, flex: 1 }}><b>{cf.entity_key.split('|')[1]}</b>: tuya {answerText(cf.local)} · servidor {answerText(cf.server)}</span>
              <button className="btn" onClick={() => write(() => resolveAnswerConflict(ctx, cf.op_id, 'keep_local', cf.server), 'Se mantendrá tu respuesta.')}>Mantener la mía</button>
              <button className="btn ghost" onClick={() => write(() => resolveAnswerConflict(ctx, cf.op_id, 'take_server', cf.server), 'Se usó la respuesta del servidor.')}>Usar la del servidor</button>
            </div>
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <div className="card" style={{ marginBottom: 14, borderColor: 'var(--warn)' }}>
          <b>Cambios que el servidor no aceptó</b>
          {rejected.map((r) => (
            <div className="op" key={r.op_id} style={{ flexWrap: 'wrap' }}>
              <span style={{ minWidth: 0, flex: 1 }}>{ENTITY[r.entity]}: {describe(r.entity, r.entity_key, r.op, r.payload)}<br /><span className="small muted">{r.reason}</span></span>
              <button className="btn ghost" onClick={() => write(() => retryRejected(ctx, r.op_id), 'Quedó en cola otra vez.')}>Reintentar</button>
            </div>
          ))}
        </div>
      )}

      {ops.length === 0 ? (
        <div className="card">
          <b>No hay cambios pendientes en este equipo.</b>
          <p className="small muted" style={{ margin: '4px 0 10px' }}>Si avanzaste una evaluación en otro equipo (tablet o computador), tráela para continuarla aquí.</p>
          <button className="btn primary" disabled={!online || !configured || busy} onClick={() => void sync()}>{busy ? 'Trayendo…' : 'Traer avances del servidor'}</button>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 14 }}>
            <div className="steps">
              {ops.map((o, i) => (
                <div className="op" key={o.op_id}><span className="ico tnum">{i + 1}</span><span>{ENTITY[o.entity]}: {describe(o.entity, o.entity_key, o.op, o.payload)}</span><span className="small muted tnum">#{o.seq}</span></div>
              ))}
            </div>
          </div>
          <div className="confirm">
            <b>Antes de enviar</b>
            <p className="small" style={{ margin: '4px 0 10px' }}>Se enviarán {s.operations} cambios{s.files ? ` y ${s.files} archivos (${mb} MB)` : ''} al servidor{link ? ` (${link.server_url})` : ''}. Después se traerán los avances hechos en tus otros equipos.</p>
            <div className="row">
              <button className="btn primary" disabled={!online || !configured || busy} onClick={() => void sync()}>{busy ? 'Sincronizando…' : 'Confirmar y sincronizar'}</button>
              {!configured && <span className="small muted">Vincula la tablet para poder enviar. Mientras tanto, los cambios quedan guardados aquí.</span>}
            </div>
          </div>
        </>
      )}
    </>
  );
}
