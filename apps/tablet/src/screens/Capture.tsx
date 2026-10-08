import { useEffect, useMemo, useState } from 'react';
import { addEvidence, listEvidence, saveAnswer } from '@fs/db';
import { questionPct } from '@fs/engine';
import { MODEL_V01, SCORES, type Question } from '@fs/model';
import { useApp } from '../app-state';
import { readEvidenceUrl, storeEvidenceFile } from '../storage/evidence-store';
import { useEvaluation } from '../use-evaluation';
import { Dialog, PageHead, SCORE_COLORS, dimLabel } from '@fs/ui';

export function Capture() {
  const { ctx, write, toast, go } = useApp();
  const ev = useEvaluation();
  const applying = useMemo(() => (ev ? MODEL_V01.questions.filter((q) => ev.input.dimensionApplies[q.dimension] !== false) : []), [ev]);
  const isOpen = (q: Question) => { const a = ev?.input.answers[q.id]; return !(a && (a.notApplicable || questionPct(a) != null)); };
  const [qid, setQid] = useState<string | null>(null);
  const [naOpen, setNaOpen] = useState(false);
  const [naText, setNaText] = useState('');
  const [thumbs, setThumbs] = useState<{ id: string; url: string | null; mime: string }[]>([]);

  const q = applying.find((x) => x.id === qid) ?? applying.find(isOpen) ?? applying[0];
  const a = q ? ev?.input.answers[q.id] : undefined;
  const files = ev && q ? listEvidence(ctx.db, ev.row.id, q.id) : [];
  const filesKey = files.map((f) => f.id).join(',');
  // Fija la pregunta mostrada: al responderla deja de estar pendiente y no debe saltar a otra.
  useEffect(() => { if (!qid && q) setQid(q.id); }, [qid, q]);

  useEffect(() => {
    let alive = true;
    const urls: string[] = [];
    Promise.all(files.map(async (f) => ({ id: f.id, mime: f.mime, url: f.mime.startsWith('image/') ? await readEvidenceUrl(f.local_path) : null })))
      .then((t) => { if (alive) { setThumbs(t); t.forEach((x) => x.url && urls.push(x.url)); } else t.forEach((x) => x.url && URL.revokeObjectURL(x.url)); });
    return () => { alive = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filesKey]);

  if (!ev) return null;
  if (!q) return <><PageHead title="Preguntas" /><div className="card">Ninguna dimensión aplica. Revisa el alcance en Antecedentes.</div></>;
  const { row, results, editable } = ev;
  const dim = MODEL_V01.dimensions.find((d) => d.code === q.dimension)!;
  const dimQs = applying.filter((x) => x.dimension === q.dimension);
  const sub = dim.subdimensions.find((s) => s.code === q.subdimension);
  const p = results.progress;

  const move = (dir: -1 | 1) => {
    const k = applying.findIndex((x) => x.id === q.id);
    const next = applying[k + dir];
    if (next) { setQid(next.id); window.scrollTo(0, 0); }
  };
  const nextPending = () => {
    const k = applying.findIndex((x) => x.id === q.id);
    const next = applying.slice(k + 1).find((x) => x.id !== q.id && isOpen(x)) ?? applying.find((x) => x.id !== q.id && isOpen(x));
    if (next) { setQid(next.id); window.scrollTo(0, 0); } else { toast('No quedan preguntas pendientes.'); go('results'); }
  };
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    for (const f of [...list]) {
      try {
        const stored = await storeEvidenceFile(f);
        write(() => addEvidence(ctx, { evaluationId: row.id, questionId: q.id, kind: f.type.startsWith('image/') ? 'photo' : 'document', ...stored }));
      } catch (e) { toast(e instanceof Error ? e.message : 'No se pudo guardar el archivo'); }
    }
    toast('Evidencia guardada en la tablet.');
  };

  return (
    <>
      <PageHead title="Preguntas" subtitle={<span className="tnum">{p.answered} de {p.applicableQuestions} respondidas{p.notApplicable ? ` · ${p.notApplicable} No aplica` : ''} · se guarda en la tablet al instante</span>} />
      <div className="cap">
        <div className="dimlist" role="list">
          {results.dimensions.map((d) => {
            const def = MODEL_V01.dimensions.find((x) => x.code === d.code)!;
            const applies = d.status !== 'not_applicable';
            const pr = d.applicable ? Math.round((d.answered / d.applicable) * 100) : 0;
            return (
              <button key={d.code} className={`dimbtn ${applies ? '' : 'na'}`} aria-current={q.dimension === d.code} disabled={!applies}
                onClick={() => { const f = applying.find((x) => x.dimension === d.code && isOpen(x)) ?? applying.find((x) => x.dimension === d.code); if (f) setQid(f.id); }}>
                <span className="nm">{dimLabel(d.code, def.name)}</span>
                <span className="pc tnum">{applies ? `${d.answered}/${d.applicable}` : 'No aplica'}</span>
                <span className="bar"><i style={{ width: `${pr}%` }} /></span>
              </button>
            );
          })}
        </div>

        <div className="card" style={{ minWidth: 0 }}>
          <div className="qdots" aria-label="Preguntas de la dimensión">
            {dimQs.map((x) => {
              const ax = ev.input.answers[x.id];
              return <button key={x.id} title={`Pregunta ${x.number}`} aria-current={x.id === q.id}
                className={ax?.notApplicable ? 'nax' : questionPct(ax) != null ? 'done' : ''} onClick={() => setQid(x.id)}>{x.number}</button>;
            })}
          </div>
          <div className="qhead">
            <span className="tag">{dimLabel(dim.code, dim.name)}</span>
            <span className="tag">{sub ? `${sub.code} · ${sub.name}` : 'Sin subdimensión'}</span>
            {q.evidenceType && <span className="tag">Evidencia: {q.evidenceType}</span>}
          </div>
          <div className="small muted">Pregunta {q.number} de {dimQs.length}{q.criterion ? ` · Criterio: ${q.criterion}` : ''}</div>
          <p className="qtext">{q.text}</p>
          {q.evidenceExamples && <details className="evid"><summary>Evidencia posible{q.method ? ` · ${q.method}` : ''}</summary><p>{q.evidenceExamples}</p></details>}

          {a?.notApplicable ? (
            <div className="conflict" style={{ borderColor: 'var(--na)' }}>
              <b>Marcada como No aplica.</b> Esta pregunta queda fuera del promedio de {dim.code}.
              <p className="small" style={{ margin: '8px 0 0' }}>Justificación: {a.notApplicable.justification}</p>
              {editable && <div className="row" style={{ marginTop: 10 }}><button className="btn" onClick={() => write(() => saveAnswer(ctx, row.id, q.id, { kind: 'clear' }))}>Volver a evaluar esta pregunta</button></div>}
            </div>
          ) : (
            <>
              <div className="opts" role="group" aria-label="Nivel de cumplimiento">
                {q.rubric.map((t, j) => (
                  <button key={j} className="opt" aria-pressed={a?.score === SCORES[j]} disabled={!editable}
                    onClick={() => write(() => saveAnswer(ctx, row.id, q.id, { kind: 'score', score: SCORES[j]! }))}>
                    <span className="sc tnum" style={{ background: SCORE_COLORS[j] }}>{SCORES[j]}%</span><span className="tx">{t}</span>
                  </button>
                ))}
              </div>
              {editable && <div className="na-row"><button className="btn ghost small" onClick={() => { setNaText(''); setNaOpen(true); }}>Marcar No aplica</button></div>}
            </>
          )}

          <div className="sec-t">Evidencia observada</div>
          <div className="field">
            <label htmlFor="note">Nota de evidencia o entrevista</label>
            <textarea id="note" key={`${q.id}-${a?.evidenceNote ?? ''}`} defaultValue={a?.evidenceNote ?? ''} disabled={!editable}
              placeholder="Qué viste, a quién entrevistaste, qué documento revisaste"
              onBlur={(e) => { if (e.target.value !== (a?.evidenceNote ?? '')) write(() => saveAnswer(ctx, row.id, q.id, { kind: 'note', evidenceNote: e.target.value })); }} />
          </div>
          {editable && (
            <div className="attach">
              <label className="btn" htmlFor="photo">Tomar foto o adjuntar archivo</label>
              <input id="photo" type="file" accept="image/*,.pdf" capture="environment" multiple hidden onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
            </div>
          )}
          <div className="thumbs">
            {thumbs.map((t) => t.url ? <img key={t.id} src={t.url} alt="Evidencia adjunta" /> : <span key={t.id} className="tag">Documento</span>)}
          </div>

          <div className="qnav">
            <button className="btn" onClick={() => move(-1)}>Anterior</button>
            <button className="btn primary" onClick={nextPending}>Siguiente pendiente</button>
          </div>
        </div>
      </div>

      {naOpen && (
        <Dialog title="Marcar como No aplica" onClose={() => setNaOpen(false)}>
          <p className="small muted">La pregunta saldrá del promedio de su dimensión. Escribe por qué no aplica en esta faena.</p>
          <div className="field"><label htmlFor="na-just">Justificación</label><textarea id="na-just" value={naText} onChange={(e) => setNaText(e.target.value)} /></div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setNaOpen(false)}>Cancelar</button>
            <button className="btn primary" onClick={() => { if (write(() => saveAnswer(ctx, row.id, q.id, { kind: 'not_applicable', justification: naText }))) setNaOpen(false); }}>Marcar No aplica</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
