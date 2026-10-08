import { computeResults, type EvaluationInput } from '@fs/engine';
import { MODEL_V01, type Score } from '@fs/model';
import type { EvaluationDetail, EvaluationRow } from './api';

/** Arma la entrada del motor con lo que guarda el servidor; el cálculo es el mismo de la tablet. */
export function toInput(row: Pick<EvaluationRow, 'model_id'>, scopes: { dimension: string; applies: boolean }[],
  answers: { question_id: string; score: number | null; not_applicable: boolean; na_justification?: string | null; evidence_note?: string | null }[],
  attachments: Map<string, number> = new Map()): EvaluationInput {
  return {
    modelId: row.model_id,
    dimensionApplies: Object.fromEntries(scopes.map((s) => [s.dimension, s.applies])),
    answers: Object.fromEntries(answers.map((a) => [a.question_id, {
      questionId: a.question_id,
      score: a.score as Score | null,
      notApplicable: a.not_applicable ? { justification: a.na_justification ?? '' } : null,
      evidenceNote: a.evidence_note ?? null,
      attachments: attachments.get(a.question_id) ?? 0,
    }])),
  };
}

export const resultsOfRow = (e: EvaluationRow) => computeResults(MODEL_V01, toInput(e, e.scopes ?? [], e.answers ?? []));

export function resultsOfDetail(d: EvaluationDetail) {
  const files = new Map<string, number>();
  d.evidence.forEach((f) => f.question_id && files.set(f.question_id, (files.get(f.question_id) ?? 0) + 1));
  const input = toInput(d.evaluation, d.scopes, d.answers, files);
  return { input, results: computeResults(MODEL_V01, input) };
}

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '—';
export const fmtDateTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' }) : '—';
export const daysSince = (iso: string | null | undefined) => (iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000) : null);
