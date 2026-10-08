import { listActions, saveAction } from '@fs/db';
import { priorityFor, suggestedGaps } from '@fs/engine';
import { MODEL_V01 } from '@fs/model';
import { useApp } from '../app-state';
import { useEvaluation } from '../use-evaluation';
import { PageHead, SCORE_COLORS } from '../ui';

export function Plan() {
  const { ctx, write } = useApp();
  const ev = useEvaluation();
  if (!ev) return null;
  const { row, input } = ev;
  const owner = row.owner_user_id === ctx.userId;
  const gaps = suggestedGaps(MODEL_V01, input);
  const actions = listActions(ctx.db, row.id);
  const byQ = new Map(actions.map((a) => [a.question_id, a]));
  const counts = [0, 0, 0, 0, 0];
  gaps.forEach((g) => { const a = byQ.get(g.question.id); counts[priorityFor(a?.impact, a?.effort) ?? 0]!++; });

  const save = (qid: string, patch: Partial<{ description: string; impact: number | null; effort: number | null }>) => {
    const cur = byQ.get(qid);
    const q = MODEL_V01.questions.find((x) => x.id === qid)!;
    write(() => saveAction(ctx, row.id, {
      id: cur?.id, questionId: qid,
      description: patch.description ?? cur?.description ?? q.criterion ?? q.text,
      impact: patch.impact !== undefined ? patch.impact : cur?.impact ?? null,
      effort: patch.effort !== undefined ? patch.effort : cur?.effort ?? null,
    }));
  };
  const sel = (qid: string, k: 'impact' | 'effort', v: number | null | undefined) => (
    <select className="minisel" aria-label={k === 'impact' ? 'Impacto' : 'Esfuerzo'} value={v ?? ''} disabled={!owner}
      onChange={(e) => save(qid, { [k]: e.target.value ? Number(e.target.value) : null })}>
      <option value="">—</option>
      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n} title={(k === 'impact' ? MODEL_V01.priority.impactLabels : MODEL_V01.priority.effortLabels)[n]}>{n}</option>)}
    </select>
  );

  return (
    <>
      <PageHead title="Plan de acción" subtitle="Brechas: preguntas con 50 % o menos. Asigna impacto y esfuerzo (1 a 5) para obtener la prioridad." />
      <div className="row" style={{ marginBottom: 14 }}>
        {[1, 2, 3, 4].map((p) => <span key={p} className={`prio p${p}`}>P{p}: {counts[p]}</span>)}
        <span className="prio p0">Sin evaluar: {counts[0]}</span>
      </div>
      <div className="card">
        <div className="tablewrap">
          <table className="dimtable">
            <thead><tr><th>Brecha</th><th>Actual</th><th>Impacto</th><th>Esfuerzo</th><th>Prioridad</th><th>Acción propuesta</th></tr></thead>
            <tbody>
              {gaps.length === 0 && <tr><td colSpan={6} className="muted">Aún no hay brechas. Aparecen aquí cuando una pregunta queda en 50 % o menos.</td></tr>}
              {gaps.map(({ question: q, pct }) => {
                const a = byQ.get(q.id);
                const pr = priorityFor(a?.impact, a?.effort);
                return (
                  <tr key={q.id}>
                    <td style={{ minWidth: 240 }}><span className="small muted">{q.dimension} · P{q.number}</span><br />{q.criterion || q.text}</td>
                    <td className="tnum"><span className="pill" style={{ background: SCORE_COLORS[pct / 25] }}>{pct}%</span></td>
                    <td>{sel(q.id, 'impact', a?.impact)}</td>
                    <td>{sel(q.id, 'effort', a?.effort)}</td>
                    <td>{pr ? <span className={`prio p${pr}`}>P{pr}</span> : <span className="prio p0">Evaluar</span>}</td>
                    <td style={{ minWidth: 200 }}>
                      <input className="minisel" style={{ width: '100%' }} aria-label="Acción propuesta" disabled={!owner} placeholder="Describe la acción"
                        key={`${q.id}-${a?.description ?? ''}`} defaultValue={a && a.description !== (q.criterion || q.text) ? a.description : ''}
                        onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== a?.description) save(q.id, { description: v }); }} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="small muted">Prioridad (Matriz de Prioridades de la V01): impacto 4–5 y esfuerzo 1–3 = P1 · impacto 4–5 y esfuerzo 4–5 = P2 · impacto 1–3 y esfuerzo 1–3 = P3 · resto = P4.</p>
    </>
  );
}
