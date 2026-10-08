import { useState } from 'react';
import { dimensionJustifications, setDimensionScope, updateEvaluationHeader } from '@fs/db';
import { MODEL_V01, type DimensionCode } from '@fs/model';
import { useApp } from '../app-state';
import { useEvaluation } from '../use-evaluation';
import { Dialog, PageHead, dimLabel } from '@fs/ui';

export function Header() {
  const { ctx, write } = useApp();
  const ev = useEvaluation();
  const [excluding, setExcluding] = useState<DimensionCode | null>(null);
  const [just, setJust] = useState('');
  if (!ev) return null;
  const { row, input, editable } = ev;
  const interviewees: string[] = JSON.parse(row.interviewees || '[]');
  const justs = dimensionJustifications(ctx.db, row.id);

  const saveHeader = (patch: Partial<{ company: string; site: string | null; evaluatedOn: string; interviewees: string[] }>) =>
    write(() => updateEvaluationHeader(ctx, row.id, { company: row.company, site: row.site, evaluatedOn: row.evaluated_on, interviewees, ...patch }));

  const field = (id: string, label: string, value: string, onSave: (v: string) => void, type = 'text') => (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} defaultValue={value} disabled={!editable} key={`${id}-${value}`}
        onBlur={(e) => { if (e.target.value !== value) onSave(e.target.value); }} />
    </div>
  );

  return (
    <>
      <PageHead title="Antecedentes" subtitle="Datos de la evaluación y dimensiones que aplican a esta faena." />
      <div className="card">
        <div className="grid2">
          {field('f-company', 'Empresa', row.company, (v) => saveHeader({ company: v }))}
          {field('f-site', 'Faena o sitio', row.site ?? '', (v) => saveHeader({ site: v || null }))}
          {field('f-date', 'Fecha de evaluación', row.evaluated_on, (v) => saveHeader({ evaluatedOn: v }), 'date')}
          {field('f-int', 'Entrevistados (separados por coma)', interviewees.join(', '), (v) => saveHeader({ interviewees: v.split(',').map((s) => s.trim()).filter(Boolean) }))}
        </div>
      </div>

      <div className="sec-t">¿Qué dimensiones aplican?</div>
      <p className="small muted" style={{ marginTop: -4 }}>Decide cada una antes de cerrar. Una dimensión que no aplica queda fuera del puntaje global y necesita justificación.</p>
      <div className="grid2">
        {MODEL_V01.dimensions.map((d) => {
          const v = input.dimensionApplies[d.code];
          const n = MODEL_V01.questions.filter((q) => q.dimension === d.code).length;
          return (
            <div className="toggle" key={d.code} style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
              <span><b>{dimLabel(d.code, d.name)}</b><br /><span className="small muted">{n} preguntas{v === false && justs[d.code] ? ` · No aplica: ${justs[d.code]}` : ''}</span></span>
              <div className="row" role="group" aria-label={`¿Aplica ${d.code}?`}>
                <button className={`btn ${v === true ? 'primary' : ''}`} disabled={!editable} aria-pressed={v === true}
                  onClick={() => write(() => setDimensionScope(ctx, row.id, d.code, true))}>Aplica</button>
                <button className={`btn ${v === false ? 'primary' : ''}`} disabled={!editable} aria-pressed={v === false}
                  onClick={() => { setJust(''); setExcluding(d.code); }}>No aplica</button>
                {v === undefined && <span className="small" style={{ color: 'var(--warn)' }}>Sin decidir</span>}
              </div>
            </div>
          );
        })}
      </div>

      {excluding && (
        <Dialog title={`${excluding} no aplica`} onClose={() => setExcluding(null)}>
          <p className="small muted">Escribe por qué esta dimensión no aplica en esta faena.</p>
          <div className="field"><label htmlFor="dim-just">Justificación</label><textarea id="dim-just" value={just} onChange={(e) => setJust(e.target.value)} /></div>
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
            <button className="btn ghost" onClick={() => setExcluding(null)}>Cancelar</button>
            <button className="btn primary" onClick={() => { if (write(() => setDimensionScope(ctx, row.id, excluding, false, just))) setExcluding(null); }}>Marcar No aplica</button>
          </div>
        </Dialog>
      )}
    </>
  );
}
