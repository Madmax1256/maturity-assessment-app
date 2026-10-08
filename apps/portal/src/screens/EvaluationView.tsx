import { useEffect, useState } from 'react';
import { priorityFor, questionPct } from '@fs/engine';
import { MODEL_V01, SCORES } from '@fs/model';
import { DimensionTable, PageHead, ResultsSummary, SCORE_COLORS, dimLabel } from '@fs/ui';
import { fileUrl, type EvaluationDetail } from '../api';
import { fmtDate, fmtDateTime, resultsOfDetail } from '../results';
import { Loading, href, useLoad } from '../state';

const ACTION_STATUS: Record<string, string> = { open: 'Abierta', in_progress: 'En curso', done: 'Hecha', cancelled: 'Cancelada' };

function Thumb({ sha, mime }: { sha: string; mime: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!mime.startsWith('image/')) return;
    let u: string | null = null, alive = true;
    fileUrl(sha).then((x) => { u = x; if (alive) setUrl(x); else URL.revokeObjectURL(x); }).catch(() => {});
    return () => { alive = false; if (u) URL.revokeObjectURL(u); };
  }, [sha, mime]);
  const open = async () => { const x = await fileUrl(sha); window.open(x, '_blank', 'noopener'); };
  return url ? <button className="thumbbtn" onClick={() => void open()} aria-label="Abrir evidencia"><img src={url} alt="Evidencia" /></button>
    : <button className="tag" onClick={() => void open()}>{mime.startsWith('image/') ? 'Foto' : 'Documento'}</button>;
}

export function EvaluationView({ id }: { id: string }) {
  const { data, error, reload } = useLoad<EvaluationDetail>(`/v1/evaluations/${encodeURIComponent(id)}`);
  const back = <div className="row" style={{ marginBottom: 10 }}><a className="linkbtn" href={href({ page: 'evaluaciones' })}>← Evaluaciones</a></div>;
  if (!data) return <>{back}<Loading error={error} retry={reload} /></>;
  const { evaluation: e } = data;
  const { input, results } = resultsOfDetail(data);
  const answers = new Map(data.answers.map((a) => [a.question_id, a]));
  const files = (q: string) => data.evidence.filter((f) => f.question_id === q);
  const excluded = data.scopes.filter((s) => !s.applies);
  const qText = (qid: string | null) => { const q = MODEL_V01.questions.find((x) => x.id === qid); return q ? `${q.dimension} · P${q.number}` : 'General'; };

  return (
    <>
      {back}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="row">
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, fontSize: 20 }}>{e.company}</h2>
            <span className="small muted">{e.site ?? 'Sin faena'} · {fmtDate(e.evaluated_on)} · {e.owner_name ?? e.owner_user_id} · {e.status === 'closed' ? `cerrada el ${fmtDate(e.closed_at)}` : 'en curso'}</span>
          </div>
        </div>
        {e.interviewees?.length > 0 && <p className="small" style={{ margin: '8px 0 0' }}>Entrevistados: {e.interviewees.join(', ')}</p>}
        <p className="small muted" style={{ margin: '8px 0 0' }}>Vista de solo lectura. Las respuestas solo las cambia el evaluador propietario desde su tablet.{e.status !== 'closed' ? ' Mientras no se cierre, el resultado es preliminar.' : ''}</p>
      </div>

      <PageHead title="Resultados" subtitle={`${results.global.final ? 'Todas las preguntas respondidas.' : `Resultado preliminar: faltan ${results.progress.pending} preguntas.`} Global = promedio simple de las dimensiones que aplican.`} />
      <ResultsSummary results={results} />
      <DimensionTable results={results} />
      {excluded.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h3 className="card-t">Dimensiones que no aplican</h3>
          {excluded.map((s) => { const d = MODEL_V01.dimensions.find((x) => x.code === s.dimension); return <p key={s.dimension} className="small" style={{ margin: '4px 0' }}><b>{d ? dimLabel(d.code, d.name) : s.dimension}:</b> {s.justification}</p>; })}
        </div>
      )}

      <div className="sec-t">Respuestas y evidencia</div>
      {MODEL_V01.dimensions.filter((d) => input.dimensionApplies[d.code] !== false).map((d) => {
        const qs = MODEL_V01.questions.filter((q) => q.dimension === d.code);
        const n = qs.filter((q) => answers.has(q.id) && (answers.get(q.id)!.not_applicable || answers.get(q.id)!.score != null)).length;
        return (
          <details className="card qblock" key={d.code}>
            <summary><b>{dimLabel(d.code, d.name)}</b> <span className="small muted tnum">{n} de {qs.length} respondidas</span></summary>
            <div className="tablewrap">
              <table className="dimtable">
                <thead><tr><th>Pregunta</th><th>Respuesta</th><th>Evidencia</th></tr></thead>
                <tbody>
                  {qs.map((q) => {
                    const a = answers.get(q.id);
                    const pct = questionPct(input.answers[q.id]);
                    const fs = files(q.id);
                    return (
                      <tr key={q.id}>
                        <td style={{ minWidth: 260 }}><span className="small muted">P{q.number}{q.criterion ? ` · ${q.criterion}` : ''}</span><br />{q.text}</td>
                        <td style={{ minWidth: 120 }}>{a?.not_applicable ? <><span className="tag">No aplica</span><br /><span className="small muted">{a.na_justification}</span></>
                          : pct != null ? <span className="pill" style={{ background: SCORE_COLORS[SCORES.indexOf(pct as never)] }}>{pct} %</span> : <span className="muted small">Pendiente</span>}</td>
                        <td style={{ minWidth: 180 }}>{a?.evidence_note && <p className="small" style={{ margin: '0 0 6px' }}>{a.evidence_note}</p>}
                          {fs.length > 0 && <div className="thumbs">{fs.map((f) => <Thumb key={f.id} sha={f.sha256} mime={f.mime} />)}</div>}
                          {!a?.evidence_note && fs.length === 0 && <span className="muted small">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </details>
        );
      })}

      <div className="sec-t">Plan de acción</div>
      <div className="card">
        <div className="tablewrap">
          <table className="dimtable">
            <thead><tr><th>Brecha</th><th>Acción</th><th>Impacto</th><th>Esfuerzo</th><th>Prioridad</th><th>Responsable</th><th>Estado</th></tr></thead>
            <tbody>
              {data.actions.length === 0 && <tr><td colSpan={7} className="muted">El evaluador aún no registra acciones.</td></tr>}
              {data.actions.map((a) => { const p = priorityFor(a.impact, a.effort); return (
                <tr key={a.id}>
                  <td className="small">{qText(a.question_id)}</td>
                  <td style={{ minWidth: 220 }}>{a.description}</td>
                  <td className="tnum">{a.impact ?? '—'}</td><td className="tnum">{a.effort ?? '—'}</td>
                  <td>{p ? <span className={`prio p${p}`}>P{p}</span> : <span className="prio p0">Evaluar</span>}</td>
                  <td>{a.owner ?? '—'}{a.due_on ? <><br /><span className="small muted">{fmtDate(a.due_on)}</span></> : null}</td>
                  <td>{ACTION_STATUS[a.status] ?? a.status}</td>
                </tr>
              ); })}
            </tbody>
          </table>
        </div>
      </div>
      <p className="small muted">Última actualización en el servidor: {fmtDateTime(e.updated_at)}.</p>
    </>
  );
}
