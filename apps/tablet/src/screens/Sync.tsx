import { pendingOps, pendingSummary } from '@fs/db';
import { useApp } from '../app-state';
import { PageHead } from '../ui';

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

export function Sync({ online }: { online: boolean }) {
  const { ctx, rev } = useApp();
  void rev;
  const s = pendingSummary(ctx.db);
  const ops = pendingOps(ctx.db, 500);
  const mb = (s.fileBytes / 1024 / 1024).toLocaleString('es-CL', { maximumFractionDigits: 1 });

  return (
    <>
      <PageHead title="Sincronizar" subtitle="Nada se envía solo. Revisa lo que saldrá de esta tablet y confirma." />
      {!online && <div className="card" style={{ marginBottom: 14, borderColor: 'var(--warn)' }}><b>Sin conexión.</b> <span className="muted">Puedes seguir evaluando; todo queda guardado y cifrado en la tablet.</span></div>}
      {ops.length === 0 ? (
        <div className="card"><b>Todo está sincronizado.</b><p className="muted small" style={{ margin: '4px 0 0' }}>No hay cambios pendientes en esta tablet.</p></div>
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
            <p className="small" style={{ margin: '4px 0 10px' }}>Se enviarán {s.operations} cambios{s.files ? ` y ${s.files} archivos (${mb} MB)` : ''}.</p>
            <div className="row">
              <button className="btn primary" disabled>Confirmar y sincronizar</button>
              <span className="small muted">El servidor de sincronización llega en el siguiente incremento; por ahora los cambios quedan guardados en la tablet.</span>
            </div>
          </div>
        </>
      )}
    </>
  );
}
