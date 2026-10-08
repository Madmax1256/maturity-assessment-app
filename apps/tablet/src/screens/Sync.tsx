import { useState } from 'react';
import { httpTransport, listConflicts, listRejected, pendingOps, pendingSummary, resolveAnswerConflict, retryRejected, runSync, syncState, type SyncReport } from '@fs/db';
import { useApp } from '../app-state';
import { readEvidenceBytes } from '../storage/evidence-store';
import { SYNC_URL, deviceInfo, getToken, syncConfigured } from '../sync-config';
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
  const configured = syncConfigured();

  const sync = async () => {
    setBusy(true);
    try {
      const r = await runSync(ctx, httpTransport(SYNC_URL, getToken), readEvidenceBytes, deviceInfo());
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
      {!online && <div className="card" style={{ marginBottom: 14, borderColor: 'var(--warn)' }}><b>Sin conexión.</b> <span className="muted">Puedes seguir evaluando; todo queda guardado y cifrado en la tablet.</span></div>}

      {last && (
        <div className="card" style={{ marginBottom: 14 }}>
          <b>Resultado del último envío</b>
          <p className="small" style={{ margin: '4px 0 0' }}>
            {last.accepted} cambios aceptados{last.filesUploaded ? `, ${last.filesUploaded} archivos subidos` : ''}
            {last.rejected ? `, ${last.rejected} rechazados` : ''}{last.conflicts ? `, ${last.conflicts} en conflicto` : ''}.
            {last.filesFailed.length ? ` ${last.filesFailed.length} archivos no se pudieron subir y quedan en cola: ${last.filesFailed[0]!.reason}.` : ''}
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
        <div className="card"><b>Todo está sincronizado.</b><p className="small muted" style={{ margin: '4px 0 0' }}>No hay cambios pendientes en esta tablet.</p></div>
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
            <p className="small" style={{ margin: '4px 0 10px' }}>Se enviarán {s.operations} cambios{s.files ? ` y ${s.files} archivos (${mb} MB)` : ''} al servidor de Vantaz.</p>
            <div className="row">
              <button className="btn primary" disabled={!online || !configured || busy} onClick={() => void sync()}>{busy ? 'Sincronizando…' : 'Confirmar y sincronizar'}</button>
              {!configured && <span className="small muted">Esta tablet aún no tiene servidor de sincronización configurado; los cambios quedan guardados aquí.</span>}
            </div>
          </div>
        </>
      )}
    </>
  );
}
