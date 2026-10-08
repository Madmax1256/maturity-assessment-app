// Paridad con el Excel V01: los casos se generan con tools/parity/make_cases.py, que escribe
// respuestas en el libro real y lo recalcula con LibreOffice. Aquí se comparan esos valores
// con el motor. Diferencias deliberadas (aprobadas) que el test reconoce:
//  - Con preguntas pendientes el Excel muestra "EVA" / "EVALUAR"; el motor da el promedio
//    parcial marcado como preliminar.
//  - Entre 99 % y 100 % el Excel ya muestra Nivel 5; el motor exige 100 % exacto.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MODEL_V01, SCORES, type DimensionCode } from '@fs/model';
import { computeResults, type EvaluationInput } from '@fs/engine';

interface ParityCase {
  id: string;
  partial: boolean;
  answers: (number | null)[];
  applies: boolean[];
  excel: { dimensions: (number | string)[]; dimensionLevels: (number | null)[]; global: number | string; globalLabel: string };
}

const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/parity.json', import.meta.url), 'utf8')) as { cases: ParityCase[] };
const LABEL_TO_LEVEL: Record<string, number> = { 'Inicial / Reactivo': 1, Dependiente: 2, Independiente: 3, Interdependiente: 4, Predictivo: 5 };

function toInput(c: ParityCase): EvaluationInput {
  const byIndex = [...MODEL_V01.questions].sort((a, b) => a.globalIndex - b.globalIndex);
  const answers: EvaluationInput['answers'] = {};
  c.answers.forEach((s, k) => { if (s != null) answers[byIndex[k]!.id] = { questionId: byIndex[k]!.id, score: SCORES[s]! }; });
  const dimensionApplies = Object.fromEntries(MODEL_V01.dimensions.map((d, i) => [d.code, c.applies[i]!])) as Record<DimensionCode, boolean>;
  return { modelId: 'V01', dimensionApplies, answers };
}

describe('paridad con el Excel V01 recalculado', () => {
  it('hay casos completos y parciales', () => {
    expect(fixture.cases.filter((c) => !c.partial).length).toBeGreaterThanOrEqual(10);
    expect(fixture.cases.some((c) => c.partial)).toBe(true);
  });

  for (const c of fixture.cases) {
    it(`${c.id}${c.partial ? ' (parcial)' : ''}`, () => {
      const r = computeResults(MODEL_V01, toInput(c));
      r.dimensions.forEach((d, i) => {
        const x = c.excel.dimensions[i];
        if (x === 'No Aplica') { expect(d.status).toBe('not_applicable'); return; }
        if (x === 'EVA') { expect(['partial', 'pending']).toContain(d.status); return; }
        expect(d.status).toBe('complete');
        expect(d.pct! / 100).toBeCloseTo(x as number, 9);
        const xl = c.excel.dimensionLevels[i]!;
        if (d.pct! > 99 && d.pct! < 100) expect(d.level!.n).toBe(4);
        else expect(d.level!.n).toBe(xl);
      });
      if (c.partial) {
        expect(c.excel.global).toBe('EVALUAR');
        expect(r.global.final).toBe(false);
      } else {
        expect(r.global.final).toBe(true);
        expect(r.global.pct! / 100).toBeCloseTo(c.excel.global as number, 9);
        if (!(r.global.pct! > 99 && r.global.pct! < 100)) expect(r.global.level!.n).toBe(LABEL_TO_LEVEL[c.excel.globalLabel]);
      }
    });
  }
});
