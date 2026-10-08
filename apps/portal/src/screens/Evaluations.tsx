import { useState } from 'react';
import type { Results } from '@fs/engine';
import { LEVEL_COLORS, PageHead, fmtPct } from '@fs/ui';
import type { EvaluationRow } from '../api';
import { daysSince, fmtDate, resultsOfRow } from '../results';
import { Loading, href, useLoad, useSession } from '../state';

export function EvalState({ e }: { e: EvaluationRow }) {
  if (e.status === 'closed') return <span className="state ok">Cerrada</span>;
  const d = daysSince(e.last_sync_at);
  return <span className={`state ${d != null && d > 7 ? 'warn' : ''}`}>En curso{d != null ? ` · sincronizada ${d === 0 ? 'hoy' : `hace ${d} días`}` : ''}</span>;
}

export function GlobalPill({ r }: { r: Results }) {
  const g = r.global;
  if (!g.level) return <span className="muted">—</span>;
  return <span className="pill" style={{ background: LEVEL_COLORS[g.level.n - 1] }}>{fmtPct(g.pct)} · N{g.level.n}</span>;
}

export function Evaluations() {
  const { me } = useSession();
  const { data, error, reload } = useLoad<EvaluationRow[]>('/v1/evaluations?scores=true');
  const [q, setQ] = useState('');
  const [st, setSt] = useState<'all' | 'draft' | 'closed'>('all');
  const sub = 'Lo que muestra el servidor. Los cambios que siguen en una tablet aparecen cuando el evaluador sincroniza.';
  if (!data) return <><PageHead title="Evaluaciones" subtitle={sub} /><Loading error={error} retry={reload} /></>;
  const needle = q.trim().toLowerCase();
  const rows = data
    .filter((e) => st === 'all' || e.status === st)
    .filter((e) => !needle || `${e.company} ${e.site ?? ''} ${e.owner_name ?? ''}`.toLowerCase().includes(needle))
    .map((e) => ({ e, r: resultsOfRow(e) }));

  return (
    <>
      <PageHead title="Evaluaciones" subtitle={sub} />
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="field" style={{ flex: '1 1 220px' }}><label htmlFor="f-q">Buscar</label><input id="f-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Empresa, faena o evaluador" /></div>
        <div className="field"><label htmlFor="f-st">Estado</label>
          <select id="f-st" value={st} onChange={(e) => setSt(e.target.value as typeof st)}><option value="all">Todas</option><option value="draft">En curso</option><option value="closed">Cerradas</option></select></div>
      </div>
      <div className="card">
        <div className="tablewrap">
          <table className="dimtable">
            <thead><tr><th>Empresa y faena</th>{me.role !== 'evaluador' && <th>Evaluador</th>}<th>Fecha</th><th>Estado</th><th>Avance</th><th>Madurez global</th></tr></thead>
            <tbody>
              {rows.length === 0 && <tr><td colSpan={6} className="muted">{data.length ? 'Ninguna evaluación coincide con el filtro.' : 'Aún no hay evaluaciones en el servidor.'}</td></tr>}
              {rows.map(({ e, r }) => {
                const done = r.progress.answered + r.progress.notApplicable, all = done + r.progress.pending;
                const pr = all ? Math.round((done / all) * 100) : 0;
                return (
                  <tr key={e.id}>
                    <td style={{ minWidth: 200 }}><a className="linkbtn" href={href({ page: 'evaluacion', id: e.id })}>{e.company}</a><br /><span className="small muted">{e.site ?? 'Sin faena'}</span></td>
                    {me.role !== 'evaluador' && <td>{e.owner_name ?? e.owner_user_id}</td>}
                    <td className="tnum">{fmtDate(e.evaluated_on)}</td>
                    <td style={{ minWidth: 160 }}><EvalState e={e} /></td>
                    <td style={{ minWidth: 110 }}><div className="bar"><i style={{ width: `${pr}%` }} /></div><span className="small muted tnum">{pr} %</span></td>
                    <td><GlobalPill r={r} />{!r.global.final && r.global.level && <><br /><span className="small muted">Preliminar</span></>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
