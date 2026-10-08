// Catálogo versionado del modelo de evaluación (RF-01, RN-T01).
// Una evaluación guarda la versión del modelo con que se hizo; el catálogo nunca se edita en sitio.

export type Score = 0 | 25 | 50 | 75 | 100;
export const SCORES: readonly Score[] = [0, 25, 50, 75, 100] as const;

export type DimensionCode = `D${number}`;

export interface LevelDef {
  n: 1 | 2 | 3 | 4 | 5;
  name: string;
  /** Límite superior inclusivo en % (Escala J21:J25). El nivel 5 exige exactamente 100. */
  upper: number;
  color: string;
}

export interface Subdimension {
  code: string; // p. ej. "S01.1"
  name: string;
}

export interface Dimension {
  code: DimensionCode; // "D1" … "D12"
  order: number;
  name: string; // nombre sin prefijo, p. ej. "Gobernanza, organización y liderazgo"
  sourceLabel: string; // texto original de la Rúbrica, p. ej. "D1. Gobernanza, …"
  subdimensions: Subdimension[];
  /** Descriptor de cada nivel 1..5 (hoja Escala). */
  levelDescriptors: [string, string, string, string, string];
}

export interface Question {
  id: string; // "D01-Q01", estable entre versiones mientras no cambie el sentido
  dimension: DimensionCode;
  number: number; // N° Preg. dentro de la dimensión
  globalIndex: number; // 1..128, orden de la Rúbrica
  subdimension: string | null; // código de subdimensión; null en D12
  criterion: string;
  text: string;
  evidenceExamples: string | null;
  evidenceType: string | null;
  method: string | null;
  evaluationLevel: string | null; // Design / Implementation / Functioning
  consequence: string | null;
  controlType: string | null;
  focus: string | null;
  causalPoint: string | null;
  risk: string | null;
  unwantedEvent: string | null;
  control: string | null;
  controlPurpose: string | null;
  /** Texto de los 5 criterios, en orden 0 %, 25 %, 50 %, 75 %, 100 %. */
  rubric: [string, string, string, string, string];
}

export interface PriorityRule {
  /** Impacto y esfuerzo se puntúan 1..5 (Matriz de Prioridades B21:C32). */
  impactLabels: Record<number, string>;
  effortLabels: Record<number, string>;
}

export interface Model {
  id: string; // "V01"
  title: string;
  source: { file: string; importedAt: string; sha256: string };
  levels: [LevelDef, LevelDef, LevelDef, LevelDef, LevelDef];
  dimensions: Dimension[];
  questions: Question[];
  priority: PriorityRule;
}
