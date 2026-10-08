import { describe, expect, it } from 'vitest';
import { MODEL_V01, questionsOf, type DimensionCode, type Score } from '@fs/model';
import { canClose, closureIssues, computeResults, levelFor, priorityFor, suggestedGaps, type EvaluationInput } from '@fs/engine';

const allApply = () => Object.fromEntries(MODEL_V01.dimensions.map((d) => [d.code, true])) as Record<DimensionCode, boolean>;

function evaluation(score: (qid: string, i: number) => Score | null, applies = allApply()): EvaluationInput {
  const answers: EvaluationInput['answers'] = {};
  MODEL_V01.questions.forEach((q, i) => { const s = score(q.id, i); if (s != null) answers[q.id] = { questionId: q.id, score: s, evidenceNote: 'nota' }; });
  return { modelId: 'V01', dimensionApplies: applies, answers };
}

describe('catálogo V01', () => {
  it('tiene la estructura auditada', () => {
    expect(MODEL_V01.dimensions).toHaveLength(12);
    expect(MODEL_V01.questions).toHaveLength(128);
    expect(MODEL_V01.dimensions.reduce((a, d) => a + d.subdimensions.length, 0)).toBe(44);
    expect(questionsOf(MODEL_V01, 'D12')).toHaveLength(13);
    expect(new Set(MODEL_V01.questions.map((q) => q.id)).size).toBe(128);
  });
});

describe('niveles', () => {
  const L = MODEL_V01.levels;
  it.each([
    [0, 1], [39, 1], [39.01, 2], [59, 2], [60, 3], [79, 3], [79.5, 4], [99, 4], [99.9, 4], [100, 5],
  ])('%s %% → nivel %s', (pct, n) => expect(levelFor(pct, L)!.n).toBe(n));
  it('sin dato no hay nivel', () => expect(levelFor(null, L)).toBeNull());
});

describe('resultados', () => {
  it('todo en 100 % da nivel 5 final', () => {
    const r = computeResults(MODEL_V01, evaluation(() => 100));
    expect(r.global).toMatchObject({ pct: 100, final: true });
    expect(r.global.level!.n).toBe(5);
  });

  it('una dimensión que no aplica queda fuera del global', () => {
    const applies = { ...allApply(), D1: false };
    const r = computeResults(MODEL_V01, evaluation((id) => (id.startsWith('D01') ? 0 : 100), applies));
    expect(r.dimensions[0]!.status).toBe('not_applicable');
    expect(r.global.pct).toBe(100);
    expect(r.global.dimensionsApplicable).toBe(11);
  });

  it('"No aplica" por pregunta sale del promedio de su dimensión', () => {
    const input = evaluation((id) => (id === 'D03-Q01' ? 0 : 100));
    input.answers['D03-Q01'] = { questionId: 'D03-Q01', notApplicable: { justification: 'Turno único diurno' } };
    const d3 = computeResults(MODEL_V01, input).dimensions.find((d) => d.code === 'D3')!;
    expect(d3).toMatchObject({ pct: 100, notApplicable: 1, status: 'complete' });
    expect(d3.applicable).toBe(d3.total - 1);
  });

  it('dimensión con todas sus preguntas No aplica no cuenta', () => {
    const input = evaluation(() => 50);
    for (const q of questionsOf(MODEL_V01, 'D12')) input.answers[q.id] = { questionId: q.id, notApplicable: { justification: 'Sin incidentes' } };
    const r = computeResults(MODEL_V01, input);
    expect(r.dimensions.find((d) => d.code === 'D12')!.status).toBe('all_not_applicable');
    expect(r.global).toMatchObject({ pct: 50, final: true, dimensionsApplicable: 11 });
  });

  it('con pendientes el resultado es preliminar y usa lo respondido', () => {
    const r = computeResults(MODEL_V01, evaluation((id, i) => (i % 2 ? 100 : null)));
    expect(r.global.final).toBe(false);
    expect(r.global.pct).toBe(100);
    expect(r.progress.pending).toBe(64);
  });

  it('método ponderado pesa por preguntas respondidas', () => {
    const input = evaluation((id) => (id.startsWith('D01') ? 100 : 0));
    const simple = computeResults(MODEL_V01, input).global.pct!;
    const weighted = computeResults(MODEL_V01, input, { globalMethod: 'weighted' }).global.pct!;
    expect(simple).toBeCloseTo(100 / 12, 9);
    expect(weighted).toBeCloseTo((17 * 100) / 128, 9);
  });

  it('rechaza calcular con otra versión del modelo', () => {
    expect(() => computeResults(MODEL_V01, { modelId: 'V02', dimensionApplies: {}, answers: {} })).toThrow();
  });
});

describe('plan de acción', () => {
  it.each([
    [5, 1, 1], [4, 3, 1], [4, 4, 2], [5, 5, 2], [3, 3, 3], [1, 1, 3], [3, 4, 4], [1, 5, 4],
  ])('impacto %s, esfuerzo %s → P%s', (i, e, p) => expect(priorityFor(i, e)).toBe(p));
  it('sin impacto o esfuerzo no hay prioridad', () => {
    expect(priorityFor(null, 3)).toBeNull();
    expect(priorityFor(6, 3)).toBeNull();
  });
  it('sugiere brechas de 50 % o menos, de menor a mayor', () => {
    const gaps = suggestedGaps(MODEL_V01, evaluation((id, i) => ([0, 25, 50, 75, 100] as Score[])[i % 5]!));
    expect(gaps.every((g) => g.pct <= 50)).toBe(true);
    expect(gaps[0]!.pct).toBe(0);
    expect(gaps.at(-1)!.pct).toBe(50);
  });
});

describe('validación de cierre', () => {
  it('bloquea pendientes, No aplica sin justificación y alcance sin decidir', () => {
    const input = evaluation((id) => (id === 'D02-Q01' ? null : 75));
    input.answers['D02-Q02'] = { questionId: 'D02-Q02', notApplicable: { justification: '  ' } };
    delete input.dimensionApplies.D5;
    const issues = closureIssues(MODEL_V01, input);
    expect(issues.map((i) => i.code)).toEqual(expect.arrayContaining(['pending_question', 'na_without_justification', 'dimension_undecided']));
    expect(canClose(issues)).toBe(false);
  });
  it('permite cerrar completa; la falta de evidencia solo advierte', () => {
    const input = evaluation(() => 75);
    input.answers['D01-Q01']!.evidenceNote = '';
    const issues = closureIssues(MODEL_V01, input);
    expect(issues).toEqual([expect.objectContaining({ severity: 'warn', code: 'missing_evidence', questionId: 'D01-Q01' })]);
    expect(canClose(issues)).toBe(true);
  });
});
