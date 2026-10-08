import { useState } from 'react';
import { closeEvaluation } from '@fs/db';
import { canClose, closureIssues } from '@fs/engine';
import { MODEL_V01 } from '@fs/model';
import { useApp } from '../app-state';
import { useEvaluation } from '../use-evaluation';
import { Dialog, DimensionTable, PageHead, ResultsSummary } from '@fs/ui';

export function Results() {
  const { ctx, write, go } = useApp();
  const ev = useEvaluation();
  const [confirm, setConfirm] = useState(false);
  if (!ev) return null;
  const { row, input, results, editable } = ev;
  const g = results.global;
  const issues = closureIssues(MODEL_V01, input);
  const blocks = issues.filter((i) => i.severity === 'block');
  const warns = issues.filter((i) => i.severity === 'warn');

  return (
    <>
      <PageHead title="Resultados" subtitle={`${row.status === 'closed' ? 'Evaluación cerrada.' : g.final ? 'Todas las preguntas respondidas.' : `Resultado preliminar: faltan ${results.progress.pending} preguntas.`} Global = promedio simple de las dimensiones que aplican.`}>
        {editable && <button className="btn primary" disabled={!canClose(issues)} onClick={() => setConfirm(true)}>Cerrar evaluación</button>}
      </PageHead>

      <ResultsSummary results={results} />

      {row.status === 'draft' && (blocks.length > 0 || warns.length > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <b>Antes de cerrar</b>
          {blocks.length > 0 && <p className="small" style={{ margin: '6px 0' }}>{blocks.length} pendientes impiden cerrar. {blocks.slice(0, 4).map((b) => b.message).join(' · ')}{blocks.length > 4 ? ' · …' : ''}</p>}
          {warns.length > 0 && <p className="small muted" style={{ margin: '6px 0' }}>{warns.length} preguntas sin evidencia registrada (no impide cerrar).</p>}
          {blocks.some((b) => b.code === 'dimension_undecided') && <button className="linkbtn" onClick={() => go('header')}>Definir alcance en Antecedentes</button>}
        </div>
      )}

      <DimensionTable results={results} />

      {confirm && (
        <Dialog title="Cerrar evaluación" onClose={() => setConfirm(false)}>
          <p className="small">Al cerrar, la evaluación queda de solo lectura en esta tablet y sus resultados pasan a ser oficiales cuando la sincronices.{warns.length ? ` Hay ${warns.length} preguntas sin evidencia registrada.` : ''}</p>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setConfirm(false)}>Cancelar</button>
            <button className="btn primary" onClick={() => { if (write(() => closeEvaluation(ctx, row.id), 'Evaluación cerrada.')) setConfirm(false); }}>Cerrar evaluación</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
