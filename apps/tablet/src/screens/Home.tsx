import { createEvaluation, listEvaluations, loadEvaluationInput } from '@fs/db';
import { computeResults } from '@fs/engine';
import { MODEL_V01 } from '@fs/model';
import { useApp } from '../app-state';
import { Bar, LevelPill, PageHead } from '@fs/ui';

export function Home() {
  const { ctx, rev, go, write } = useApp();
  void rev;
  const rows = listEvaluations(ctx.db).map((e) => {
    const r = computeResults(MODEL_V01, loadEvaluationInput(ctx.db, e.id));
    return { e, r };
  });

  const create = () => {
    let id = '';
    const ok = write(() => {
      id = createEvaluation(ctx, { modelId: MODEL_V01.id, company: 'Nueva evaluación', evaluatedOn: new Date().toISOString().slice(0, 10) });
    });
    if (ok) go('header', id);
  };

  return (
    <>
      <PageHead title="Mis evaluaciones" subtitle="Las evaluaciones se guardan cifradas en esta tablet y se envían al servidor solo cuando tú lo confirmas.">
        <button className="btn primary" onClick={create}>Nueva evaluación</button>
      </PageHead>
      {rows.length === 0 && (
        <div className="card">
          <b>Aún no hay evaluaciones en esta tablet.</b>
          <p className="muted small" style={{ margin: '4px 0 0' }}>Toca "Nueva evaluación" para registrar los antecedentes y empezar a responder.</p>
        </div>
      )}
      <div className="evlist">
        {rows.map(({ e, r }) => {
          const pr = r.progress.applicableQuestions ? Math.round((r.progress.answered / r.progress.applicableQuestions) * 100) : 0;
          return (
            <div className="ev" key={e.id}>
              <div style={{ minWidth: 0 }}>
                <h3>{e.company}</h3>
                <div className="meta"><span>{e.site || 'Sin faena'}</span><span className="tnum">{e.evaluated_on}</span><span>{e.status === 'closed' ? 'Cerrada' : 'En curso'}</span></div>
              </div>
              <div className="row">
                {e.pending_ops > 0
                  ? <span className="chip pend"><span className="dot" />{e.pending_ops} sin sincronizar</span>
                  : <span className="chip"><span className="dot" style={{ background: 'var(--ok)' }} />Sincronizada</span>}
                <button className="btn" onClick={() => go(e.status === 'closed' ? 'results' : 'capture', e.id)}>Abrir</button>
              </div>
              <div className="row small" style={{ gridColumn: '1 / -1' }}>
                <span style={{ flex: 1, minWidth: 120 }}><Bar value={pr} /></span>
                <span className="tnum muted">{r.progress.answered} de {r.progress.applicableQuestions} respondidas</span>
                <LevelPill level={r.global.level} pct={r.global.pct} prefix={r.global.final ? '' : 'Preliminar · '} />
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
