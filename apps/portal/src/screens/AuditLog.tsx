import { MODEL_V01 } from '@fs/model';
import { PageHead } from '@fs/ui';
import type { AuditRow } from '../api';
import { fmtDateTime } from '../results';
import { Loading, useLoad } from '../state';

const qLabel = (key: string | null) => {
  const qid = key?.split('|')[1];
  const q = MODEL_V01.questions.find((x) => x.id === qid);
  return q ? `${q.dimension} pregunta ${q.number}` : qid ?? '';
};

/** Frase legible para cada acción registrada (tablet o servidor). */
export function describe(a: AuditRow): string {
  const d = (a.detail ?? {}) as Record<string, unknown>;
  switch (a.action) {
    case 'sync.push': return `Sincronizó: ${d.accepted ?? 0} cambios aceptados${d.rejected ? `, ${d.rejected} rechazados` : ''}${d.conflict ? `, ${d.conflict} en conflicto` : ''}`;
    case 'sync.results': return 'Recibió la respuesta del servidor en la tablet';
    case 'sync.retry': return 'Volvió a poner en cola un cambio rechazado';
    case 'sync.conflict_resolved': return `Resolvió un conflicto en ${qLabel(a.entity_key)} (${d.choice === 'keep_local' ? 'mantuvo su respuesta' : 'aceptó la del servidor'})`;
    case 'evaluation.create': return 'Creó una evaluación';
    case 'evaluation.close': return 'Cerró una evaluación';
    case 'answer.score': return `Respondió ${qLabel(a.entity_key)}: ${d.score} %`;
    case 'answer.not_applicable': return `Marcó ${qLabel(a.entity_key)} como No aplica`;
    case 'answer.note': return `Escribió una nota de evidencia en ${qLabel(a.entity_key)}`;
    case 'answer.clear': return `Dejó pendiente ${qLabel(a.entity_key)}`;
    case 'evidence.add': return `Agregó evidencia${d.questionId ? ` en ${qLabel(`x|${String(d.questionId)}`)}` : ''}`;
    case 'user.invite': return `Invitó a ${String(d.email ?? '')} como ${String(d.role ?? '')}`;
    case 'user.update': return `Cambió ${d.role ? `el rol a ${String(d.role)}` : ''}${d.role && d.status ? ' y ' : ''}${d.status ? (d.status === 'disabled' ? 'quitó el acceso' : 'dio acceso') : ''} de ${a.entity_key ?? ''}`;
    case 'user.first_login': return 'Entró por primera vez (invitación aceptada)';
    case 'user.enrolled': return `Entró por primera vez como ${String(d.role ?? '')}`;
    case 'device.revoke': return `Quitó el acceso a la tablet ${(a.entity_key ?? '').slice(0, 8)}`;
    default: return a.action;
  }
}

export function AuditLog() {
  const { data, error, reload } = useLoad<AuditRow[]>('/v1/admin/audit?limit=300');
  return (
    <>
      <PageHead title="Bitácora" subtitle="Quién hizo qué y cuándo, en el portal y en las tablets (lo de las tablets llega al sincronizar). No se puede editar ni borrar." />
      {!data ? <Loading error={error} retry={reload} /> : (
        <div className="card">
          <div className="tablewrap">
            <table className="dimtable">
              <thead><tr><th>Fecha</th><th>Persona</th><th>Acción</th><th>Origen</th></tr></thead>
              <tbody>
                {data.length === 0 && <tr><td colSpan={4} className="muted">Sin registros todavía.</td></tr>}
                {data.map((a) => (
                  <tr key={a.id}>
                    <td className="tnum" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.at)}</td>
                    <td>{a.user_name ?? a.user_id}</td>
                    <td>{describe(a)}</td>
                    <td className="small muted">{a.device_id ? `Tablet ${a.device_id.slice(0, 8)}` : 'Servidor'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
