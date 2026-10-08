import { levelFor } from '@fs/engine';
import { MODEL_V01 } from '@fs/model';
import { LEVEL_COLORS, PageHead, dimLabel, fmtPct } from '@fs/ui';
import type { DeviceRow, EvaluationRow } from '../api';
import { daysSince, fmtDate, resultsOfRow } from '../results';
import { Loading, href, useLoad, useSession } from '../state';
import { EvalState, GlobalPill } from './Evaluations';

export function Panel() {
  const { me } = useSession();
  const evals = useLoad<EvaluationRow[]>('/v1/evaluations?scores=true');
  const devices = useLoad<DeviceRow[]>(me.role === 'administrador' ? '/v1/admin/devices' : null);
  if (!evals.data) return <><PageHead title="Panel" /><Loading error={evals.error} retry={evals.reload} /></>;

  const rows = evals.data.map((e) => ({ e, r: resultsOfRow(e) }));
  const closed = rows.filter((x) => x.e.status === 'closed');
  const avg = closed.length ? closed.reduce((a, x) => a + (x.r.global.pct ?? 0), 0) / closed.length : null;
  const stale = devices.data?.filter((d) => d.status === 'active' && (daysSince(d.last_sync_at) ?? 99) > 7).length;
  const dimAvg = MODEL_V01.dimensions.map((d) => {
    const v = closed.map((x) => x.r.dimensions.find((r) => r.code === d.code)!).filter((r) => r.pct != null).map((r) => r.pct!);
    return { d, pct: v.length ? v.reduce((a, b) => a + b, 0) / v.length : null, n: v.length };
  }).filter((x) => x.pct != null).sort((a, b) => a.pct! - b.pct!);

  return (
    <>
      <PageHead title="Panel" subtitle={me.role === 'evaluador' ? 'Resumen de tus evaluaciones que ya llegaron al servidor.' : 'Resumen de todas las evaluaciones que ya llegaron al servidor.'} />
      <div className="kpis">
        <div className="kpi"><b className="tnum">{rows.length - closed.length}</b><span>Evaluaciones en curso</span></div>
        <div className="kpi"><b className="tnum">{closed.length}</b><span>Evaluaciones cerradas</span></div>
        <div className="kpi"><b className="tnum">{fmtPct(avg)}</b><span>Madurez promedio de las cerradas</span></div>
        {stale != null && <div className="kpi"><b className="tnum" style={{ color: stale ? 'var(--warn)' : undefined }}>{stale}</b><span>Tablets activas con más de 7 días sin sincronizar</span></div>}
      </div>
      <div className="grid2">
        <div className="card">
          <h3 className="card-t">Dimensiones más débiles (cerradas)</h3>
          {dimAvg.length === 0 && <p className="small muted">Aparecen cuando haya evaluaciones cerradas.</p>}
          {dimAvg.slice(0, 5).map(({ d, pct, n }) => (
            <div key={d.code} style={{ margin: '8px 0' }}>
              <div className="row small" style={{ justifyContent: 'space-between' }}><span>{dimLabel(d.code, d.name)}</span><span className="tnum">{fmtPct(pct)} · {n} eval.</span></div>
              <div className="bar"><i style={{ width: `${pct}%`, background: LEVEL_COLORS[(levelFor(pct, MODEL_V01.levels)?.n ?? 1) - 1] }} /></div>
            </div>
          ))}
        </div>
        <div className="card">
          <h3 className="card-t">Últimas evaluaciones</h3>
          {rows.length === 0 && <p className="small muted">Aún no hay evaluaciones en el servidor. Llegan cuando un evaluador sincroniza su tablet.</p>}
          <div className="steps">
            {rows.slice(0, 6).map(({ e, r }) => (
              <div className="op" key={e.id} style={{ gridTemplateColumns: 'minmax(0,1fr) auto' }}>
                <span><a className="linkbtn" href={href({ page: 'evaluacion', id: e.id })}>{e.company}</a><br />
                  <span className="small muted">{fmtDate(e.evaluated_on)} · <EvalState e={e} /></span></span>
                <GlobalPill r={r} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
