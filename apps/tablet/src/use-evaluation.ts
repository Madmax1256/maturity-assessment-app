import { useMemo } from 'react';
import { getEvaluation, loadEvaluationInput } from '@fs/db';
import { computeResults } from '@fs/engine';
import { MODEL_V01 } from '@fs/model';
import { useApp } from './app-state';

/** Evaluación abierta, su entrada para el motor y sus resultados, releídos cuando cambia la base. */
export function useEvaluation() {
  const { ctx, evaluationId, rev } = useApp();
  return useMemo(() => {
    if (!evaluationId) return null;
    const row = getEvaluation(ctx.db, evaluationId);
    if (!row) return null;
    const input = loadEvaluationInput(ctx.db, evaluationId);
    const results = computeResults(MODEL_V01, input);
    return { row, input, results, editable: row.status === 'draft' && row.owner_user_id === ctx.userId };
    // rev fuerza la relectura después de cada escritura
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.db, ctx.userId, evaluationId, rev]);
}
