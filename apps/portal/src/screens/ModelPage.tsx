import { MODEL_V01 } from '@fs/model';
import { PageHead, dimLabel } from '@fs/ui';
import type { ModelRow } from '../api';
import { fmtDate } from '../results';
import { Loading, useLoad } from '../state';

export function ModelPage() {
  const { data, error, reload } = useLoad<ModelRow[]>('/v1/models');
  return (
    <>
      <PageHead title="Modelo de evaluación" subtitle="Las preguntas, criterios y niveles se manejan como versiones. Cada evaluación queda ligada a la versión con que se hizo." />
      {!data ? <Loading error={error} retry={reload} /> : (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="tablewrap">
            <table className="dimtable">
              <thead><tr><th>Versión</th><th>Contenido</th><th>Importada</th><th>Evaluaciones</th></tr></thead>
              <tbody>
                {data.map((m) => (
                  <tr key={m.id}>
                    <td><b>{m.id}</b><br /><span className="small muted">{m.source?.file}</span></td>
                    <td className="small">{m.dimensions} dimensiones · {m.questions} preguntas · 5 niveles</td>
                    <td className="tnum">{fmtDate(m.source?.importedAt)}</td>
                    <td className="tnum">{m.evaluations}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="small muted">Una versión nueva se importa desde el Excel con la herramienta de importación, que valida el archivo y no carga nada si encuentra errores. La importación desde el portal queda para una versión posterior.</p>
      <div className="sec-t">Contenido de la V01</div>
      <div className="card">
        <div className="tablewrap">
          <table className="dimtable">
            <thead><tr><th>Dimensión</th><th>Subdimensiones</th><th>Preguntas</th><th>Nivel 5 se describe como</th></tr></thead>
            <tbody>
              {MODEL_V01.dimensions.map((d) => (
                <tr key={d.code}>
                  <td><b>{dimLabel(d.code, d.name)}</b></td>
                  <td className="tnum">{d.subdimensions.length || 'Sin subdimensiones'}</td>
                  <td className="tnum">{MODEL_V01.questions.filter((q) => q.dimension === d.code).length}</td>
                  <td className="small muted" style={{ minWidth: 260 }}>{d.levelDescriptors[4]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
