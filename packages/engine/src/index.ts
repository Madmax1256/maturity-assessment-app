// Motor de cálculo compartido (tablet, portal y servidor). Funciones puras, sin E/S.
//
// Reglas de la V01 (RN-01 a RN-12 de la especificación) con las correcciones y decisiones
// aprobadas por Max el 2026-10-08:
//  - % de pregunta = posición del criterio elegido: 0, 25, 50, 75 o 100.
//  - "No aplica" por pregunta, con justificación obligatoria; sale del promedio de su dimensión.
//  - % de dimensión = promedio de sus preguntas respondidas que aplican. El Excel muestra "EVA"
//    mientras falte una; aquí se entrega el promedio parcial marcado como preliminar.
//  - Global = promedio simple de las dimensiones que aplican y tienen resultado (igual que
//    INICIO!J36); el método ponderado por preguntas queda configurable.
//  - Nivel = cantidad de límites superados + 1 (Escala J21:J24), pero el Nivel 5 exige 100 % exacto.
//  - Prioridad de acción por impacto y esfuerzo 1..5 (Matriz de Prioridades O5:S16).

import type { DimensionCode, LevelDef, Model, Question, Score } from '@fs/model';

export interface Answer {
  questionId: string;
  score?: Score | null;
  notApplicable?: { justification: string } | null;
  evidenceNote?: string | null;
  attachments?: number;
}

export interface EvaluationInput {
  modelId: string;
  /** true = aplica, false = no aplica, undefined = sin decidir (el Excel lo trata como "sí"). */
  dimensionApplies: Partial<Record<DimensionCode, boolean>>;
  answers: Record<string, Answer>;
}

export type GlobalMethod = 'simple' | 'weighted';

export interface EngineConfig {
  globalMethod: GlobalMethod;
}

export const DEFAULT_CONFIG: EngineConfig = { globalMethod: 'simple' };

export type DimensionStatus = 'not_applicable' | 'all_not_applicable' | 'pending' | 'partial' | 'complete';

export interface DimensionResult {
  code: DimensionCode;
  applies: boolean;
  status: DimensionStatus;
  total: number;
  answered: number;
  notApplicable: number;
  pending: number;
  /** Preguntas que cuentan para el promedio (total − No aplica). */
  applicable: number;
  pct: number | null;
  level: LevelDef | null;
}

export interface GlobalResult {
  pct: number | null;
  level: LevelDef | null;
  /** true cuando todas las dimensiones que aplican están completas. */
  final: boolean;
  method: GlobalMethod;
  dimensionsCounted: number;
  dimensionsComplete: number;
  dimensionsApplicable: number;
}

export interface Progress {
  applicableQuestions: number;
  answered: number;
  notApplicable: number;
  pending: number;
}

export interface Results {
  modelId: string;
  dimensions: DimensionResult[];
  global: GlobalResult;
  progress: Progress;
}

const isScore = (v: unknown): v is Score => v === 0 || v === 25 || v === 50 || v === 75 || v === 100;

/** % de una pregunta, o null si está pendiente o no aplica. */
export function questionPct(a: Answer | undefined): number | null {
  if (!a || a.notApplicable) return null;
  return isScore(a.score) ? a.score : null;
}

export function levelFor(pct: number | null, levels: Model['levels']): LevelDef | null {
  if (pct == null || Number.isNaN(pct)) return null;
  if (pct >= levels[4].upper) return levels[4];
  // Límites de los niveles 1..4; un valor sobre el límite del 4 sin llegar a 100 sigue en 4.
  const passed = levels.slice(0, 4).filter((l) => l.upper < pct).length;
  return levels[Math.min(passed, 3)]!;
}

function appliesOf(input: EvaluationInput, code: DimensionCode) {
  return input.dimensionApplies[code] !== false;
}

export function dimensionResult(model: Model, input: EvaluationInput, code: DimensionCode): DimensionResult {
  const qs = model.questions.filter((q) => q.dimension === code);
  const applies = appliesOf(input, code);
  let sum = 0, answered = 0, na = 0;
  for (const q of qs) {
    const a = input.answers[q.id];
    if (a?.notApplicable) { na++; continue; }
    const p = questionPct(a);
    if (p != null) { sum += p; answered++; }
  }
  const applicable = qs.length - na;
  const pending = applicable - answered;
  const base = { code, total: qs.length, answered, notApplicable: na, pending, applicable };
  if (!applies) return { ...base, applies, status: 'not_applicable', pct: null, level: null };
  if (applicable === 0) return { ...base, applies, status: 'all_not_applicable', pct: null, level: null };
  const pct = answered ? sum / answered : null;
  const status: DimensionStatus = answered === 0 ? 'pending' : pending > 0 ? 'partial' : 'complete';
  return { ...base, applies, status, pct, level: levelFor(pct, model.levels) };
}

export function computeResults(model: Model, input: EvaluationInput, config: EngineConfig = DEFAULT_CONFIG): Results {
  if (input.modelId !== model.id) throw new Error(`La evaluación usa el modelo ${input.modelId} y se intentó calcular con ${model.id}`);
  const dimensions = model.dimensions.map((d) => dimensionResult(model, input, d.code));
  const counted = dimensions.filter((d) => d.pct != null);
  const relevant = dimensions.filter((d) => d.status !== 'not_applicable' && d.status !== 'all_not_applicable');
  let pct: number | null = null;
  if (counted.length) {
    if (config.globalMethod === 'simple') {
      pct = counted.reduce((a, d) => a + d.pct!, 0) / counted.length;
    } else {
      const n = counted.reduce((a, d) => a + d.answered, 0);
      pct = counted.reduce((a, d) => a + d.pct! * d.answered, 0) / n;
    }
  }
  const complete = relevant.filter((d) => d.status === 'complete').length;
  const progress = relevant.reduce<Progress>((p, d) => ({
    applicableQuestions: p.applicableQuestions + d.applicable,
    answered: p.answered + d.answered,
    notApplicable: p.notApplicable + d.notApplicable,
    pending: p.pending + d.pending,
  }), { applicableQuestions: 0, answered: 0, notApplicable: 0, pending: 0 });
  return {
    modelId: model.id,
    dimensions,
    global: {
      pct, level: levelFor(pct, model.levels), final: relevant.length > 0 && complete === relevant.length,
      method: config.globalMethod, dimensionsCounted: counted.length, dimensionsComplete: complete, dimensionsApplicable: relevant.length,
    },
    progress,
  };
}

// ---------- Plan de acción ----------

export type Priority = 1 | 2 | 3 | 4;

/** RN-12: impacto ≥4 y esfuerzo ≤3 → P1; ≥4 y ≥4 → P2; ≤3 y ≤3 → P3; resto → P4. null si falta un dato. */
export function priorityFor(impact: number | null | undefined, effort: number | null | undefined): Priority | null {
  const ok = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;
  if (!ok(impact) || !ok(effort)) return null;
  if (impact >= 4 && effort <= 3) return 1;
  if (impact >= 4 && effort >= 4) return 2;
  if (impact <= 3 && effort <= 3) return 3;
  return 4;
}

/** Brechas sugeridas: preguntas que aplican con 50 % o menos, de menor a mayor puntaje. */
export function suggestedGaps(model: Model, input: EvaluationInput, threshold = 50): { question: Question; pct: number }[] {
  return model.questions
    .filter((q) => appliesOf(input, q.dimension))
    .map((q) => ({ question: q, pct: questionPct(input.answers[q.id]) }))
    .filter((x): x is { question: Question; pct: number } => x.pct != null && x.pct <= threshold)
    .sort((a, b) => a.pct - b.pct || a.question.globalIndex - b.question.globalIndex);
}

// ---------- Validación de cierre (RF de cierre) ----------

export interface ClosureIssue {
  severity: 'block' | 'warn';
  code: 'dimension_undecided' | 'pending_question' | 'na_without_justification' | 'missing_evidence' | 'nothing_applies';
  dimension?: DimensionCode;
  questionId?: string;
  message: string;
}

export function closureIssues(model: Model, input: EvaluationInput): ClosureIssue[] {
  const out: ClosureIssue[] = [];
  const applying = model.dimensions.filter((d) => input.dimensionApplies[d.code] !== false);
  if (applying.length === 0) out.push({ severity: 'block', code: 'nothing_applies', message: 'Ninguna dimensión aplica; no hay nada que evaluar' });
  for (const d of model.dimensions) {
    if (input.dimensionApplies[d.code] === undefined) {
      out.push({ severity: 'block', code: 'dimension_undecided', dimension: d.code, message: `Define si ${d.code} aplica` });
    }
  }
  for (const q of model.questions) {
    if (input.dimensionApplies[q.dimension] === false) continue;
    const a = input.answers[q.id];
    if (a?.notApplicable) {
      if (!a.notApplicable.justification?.trim()) out.push({ severity: 'block', code: 'na_without_justification', dimension: q.dimension, questionId: q.id, message: `${q.id} está marcada No aplica sin justificación` });
      continue;
    }
    if (questionPct(a) == null) { out.push({ severity: 'block', code: 'pending_question', dimension: q.dimension, questionId: q.id, message: `${q.id} sin responder` }); continue; }
    if (!a?.evidenceNote?.trim() && !a?.attachments) out.push({ severity: 'warn', code: 'missing_evidence', dimension: q.dimension, questionId: q.id, message: `${q.id} no tiene evidencia registrada` });
  }
  return out;
}

export const canClose = (issues: ClosureIssue[]) => !issues.some((i) => i.severity === 'block');
