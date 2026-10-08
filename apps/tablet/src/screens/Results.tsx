import { useState } from 'react';
import { closeEvaluation } from '@fs/db';
import { canClose, closureIssues } from '@fs/engine';
import { MODEL_V01 } from '@fs/model';
import { useApp } from '../app-state';
import { useEvaluation } from '../use-evaluation';
import { Dialog, LEVEL_COLORS, LevelPill, PageHead, dimLabel, fmtPct } from '../ui';

function Chart({ dims }: { dims: { code: string; pct: number | null; complete: boolean; applies: boolean; level: number | null }[] }) {
  const W = 700, H = 300, padL = 40, padB = 58, padT = 14, padR = 10, iw = W - padL - padR, ih = H - padT - padB, bw = iw / dims.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumplimiento por dimensión">
      {[0, 40, 60, 80, 100].map((v) => {
        const y = padT + ih * (1 - v / 100);
        return <g key={v}><line x1={padL} x2={W - padR} y1={y} y2={y} stroke="var(--line)" strokeDasharray={v ? '3 4' : undefined} />
          <text x={padL - 6} y={y + 4} textAnchor="end" fontSize="11" fill="var(--fg-3)">{v}%</text></g>;
      })}
      {dims.map((d, i) => {
        const x = padL + i * bw + bw * 0.18, w = bw * 0.64;
        const color = d.level ? LEVEL_COLORS[d.level - 1] : 'var(--pending)';
        return (
          <g key={d.code}>
            {d.applies && d.pct != null ? (() => {
              const h = (ih * d.pct) / 100, y = padT + ih - h;
              return <>
                <rect x={x} y={y} width={w} height={Math.max(h, 1)} rx="3" fill={color} fillOpacity={d.complete ? 1 : 0.45} stroke={d.complete ? 'none' : color} strokeDasharray={d.complete ? undefined : '3 2'} />
                <text x={x + w / 2} y={y - 5} textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--fg)">{Math.round(d.pct)}</text>
              </>;
            })() : <text x={x + w / 2} y={padT + ih - 6} textAnchor="middle" fontSize="10" fill="var(--fg-3)">{d.applies ? 'pend.' : 'N/A'}</text>}
            <text x={x + w / 2} y={H - padB + 18} textAnchor="middle" fontSize="12" fontWeight="700" fill="var(--fg-2)">{d.code}</text>
          </g>
        );
      })}
      <text x={padL} y={H - 8} fontSize="11" fill="var(--fg-3)">Barras punteadas: dimensión con preguntas pendientes (resultado preliminar)</text>
    </svg>
  );
}

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

      <div className="res-top">
        <div className="card gauge">
          <span className="small muted">Madurez global</span>
          <span className="big tnum">{fmtPct(g.pct)}</span>
          {g.level && <span><span className="pill" style={{ background: LEVEL_COLORS[g.level.n - 1] }}>Nivel {g.level.n} · {g.level.name}</span></span>}
          <div className="lvl-scale">{MODEL_V01.levels.map((l) => <div key={l.n} style={{ background: LEVEL_COLORS[l.n - 1] }} className={g.level?.n === l.n ? 'on' : ''} />)}</div>
          <div className="lvl-scale-l tnum"><span>0–39</span><span>40–59</span><span>60–79</span><span>80–99</span><span>100</span></div>
          <span className="small muted tnum">{g.dimensionsComplete} de {g.dimensionsApplicable} dimensiones completas</span>
        </div>
        <div className="card chart">
          <Chart dims={results.dimensions.map((d) => ({ code: d.code, pct: d.pct, complete: d.status === 'complete', applies: d.status !== 'not_applicable' && d.status !== 'all_not_applicable', level: d.level?.n ?? null }))} />
        </div>
      </div>

      {row.status === 'draft' && (blocks.length > 0 || warns.length > 0) && (
        <div className="card" style={{ marginBottom: 16 }}>
          <b>Antes de cerrar</b>
          {blocks.length > 0 && <p className="small" style={{ margin: '6px 0' }}>{blocks.length} pendientes impiden cerrar. {blocks.slice(0, 4).map((b) => b.message).join(' · ')}{blocks.length > 4 ? ' · …' : ''}</p>}
          {warns.length > 0 && <p className="small muted" style={{ margin: '6px 0' }}>{warns.length} preguntas sin evidencia registrada (no impide cerrar).</p>}
          {blocks.some((b) => b.code === 'dimension_undecided') && <button className="linkbtn" onClick={() => go('header')}>Definir alcance en Antecedentes</button>}
        </div>
      )}

      <div className="card">
        <div className="tablewrap">
          <table className="dimtable">
            <thead><tr><th>Dimensión</th><th>Cumplimiento</th><th>Nivel</th><th>Qué significa</th></tr></thead>
            <tbody>
              {results.dimensions.map((d) => {
                const def = MODEL_V01.dimensions.find((x) => x.code === d.code)!;
                return (
                  <tr key={d.code}>
                    <td><b>{dimLabel(d.code, def.name)}</b>{d.status === 'partial' && <><br /><span className="small muted">Preliminar</span></>}</td>
                    <td className="tnum">{d.status === 'not_applicable' ? 'No aplica' : d.status === 'all_not_applicable' ? 'Todas No aplica' : d.pct == null ? 'Pendiente' : fmtPct(d.pct)}
                      {d.notApplicable > 0 && <><br /><span className="small muted">{d.notApplicable} No aplica</span></>}</td>
                    <td>{d.level ? <LevelPill level={d.level} /> : '—'}</td>
                    <td className="small muted" style={{ minWidth: 240 }}>{d.level ? def.levelDescriptors[d.level.n - 1] : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

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
