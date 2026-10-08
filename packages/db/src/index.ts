// Repositorio local. Cada escritura guarda la fila y su operación de salida en una sola
// transacción, para que nunca quede un cambio sin encolar ni una operación sin cambio.
// El driver es una interfaz mínima: en la tablet lo implementa el plugin SQLite de Capacitor
// (con SQLCipher); en pruebas, node:sqlite.

import type { Score } from '@fs/model';

export type Param = string | number | null;

export interface Driver {
  exec(sql: string): void;
  run(sql: string, params?: Param[]): void;
  get<T = Record<string, unknown>>(sql: string, params?: Param[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, params?: Param[]): T[];
}

export const SCHEMA_VERSION = 1;

export function migrate(db: Driver, schemaSql: string, now = new Date().toISOString()) {
  db.exec(schemaSql);
  const row = db.get<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
  if ((row?.v ?? 0) < SCHEMA_VERSION) db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [SCHEMA_VERSION, now]);
}

export function transaction<T>(db: Driver, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** UUID v7: prefijo de tiempo en ms, ordenable, generado en el dispositivo sin servidor. */
export function uuidv7(now = Date.now(), rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const b = rand(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) b[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export interface Ctx {
  db: Driver;
  userId: string;
  now?: () => string;
  newId?: () => string;
}

const nowOf = (c: Ctx) => (c.now ?? (() => new Date().toISOString()))();
const idOf = (c: Ctx) => (c.newId ?? (() => uuidv7()))();

type Entity = 'evaluation' | 'dimension_scope' | 'answer' | 'evidence_file' | 'action_item';

function enqueue(c: Ctx, entity: Entity, key: string, op: 'upsert' | 'delete' | 'close', payload: unknown, baseVersion: number | null) {
  const next = (c.db.get<{ s: number | null }>('SELECT max(seq) AS s FROM outbox')?.s ?? 0) + 1;
  c.db.run('INSERT INTO outbox (op_id, seq, entity, entity_key, op, payload, base_version, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [idOf(c), next, entity, key, op, JSON.stringify(payload), baseVersion, nowOf(c)]);
}

function audit(c: Ctx, action: string, entity: Entity, key: string, detail?: unknown) {
  c.db.run('INSERT INTO audit_log (id, at, user_id, action, entity, entity_key, detail) VALUES (?,?,?,?,?,?,?)',
    [idOf(c), nowOf(c), c.userId, action, entity, key, detail == null ? null : JSON.stringify(detail)]);
}

function assertEditable(c: Ctx, evaluationId: string) {
  const ev = c.db.get<{ status: string; owner_user_id: string }>('SELECT status, owner_user_id FROM evaluation WHERE id = ? AND deleted = 0', [evaluationId]);
  if (!ev) throw new Error('La evaluación no existe en este dispositivo');
  if (ev.status === 'closed') throw new Error('La evaluación está cerrada y es de solo lectura');
  if (ev.owner_user_id !== c.userId) throw new Error('Solo el evaluador propietario puede editar esta evaluación');
}

export interface NewEvaluation {
  modelId: string;
  company: string;
  site?: string | null;
  evaluatedOn: string;
  interviewees?: string[];
}

export function createEvaluation(c: Ctx, e: NewEvaluation): string {
  const id = idOf(c);
  const at = nowOf(c);
  transaction(c.db, () => {
    c.db.run('INSERT INTO evaluation (id, model_id, company, site, evaluated_on, owner_user_id, interviewees, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      [id, e.modelId, e.company, e.site ?? null, e.evaluatedOn, c.userId, JSON.stringify(e.interviewees ?? []), at]);
    enqueue(c, 'evaluation', id, 'upsert', { id, ...e, ownerUserId: c.userId, status: 'draft' }, null);
    audit(c, 'evaluation.create', 'evaluation', id);
  });
  return id;
}

export function setDimensionScope(c: Ctx, evaluationId: string, dimension: string, applies: boolean, justification?: string) {
  assertEditable(c, evaluationId);
  if (!applies && !justification?.trim()) throw new Error('Para excluir una dimensión escribe la justificación');
  transaction(c.db, () => {
    c.db.run(`INSERT INTO dimension_scope (evaluation_id, dimension, applies, justification, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT (evaluation_id, dimension) DO UPDATE SET applies = excluded.applies, justification = excluded.justification, updated_at = excluded.updated_at`,
      [evaluationId, dimension, applies ? 1 : 0, justification ?? null, nowOf(c)]);
    enqueue(c, 'dimension_scope', `${evaluationId}|${dimension}`, 'upsert', { evaluationId, dimension, applies, justification: justification ?? null }, null);
  });
}

export type AnswerChange =
  | { kind: 'score'; score: Score }
  | { kind: 'not_applicable'; justification: string }
  | { kind: 'note'; evidenceNote: string }
  /** Deja la pregunta pendiente otra vez (por ejemplo, al quitar un "No aplica"). */
  | { kind: 'clear' };

export function saveAnswer(c: Ctx, evaluationId: string, questionId: string, change: AnswerChange) {
  assertEditable(c, evaluationId);
  if (change.kind === 'not_applicable' && !change.justification.trim()) throw new Error('"No aplica" requiere justificación');
  transaction(c.db, () => {
    const prev = c.db.get<{ score: number | null; not_applicable: number; na_justification: string | null; evidence_note: string | null; row_version: number | null }>(
      'SELECT score, not_applicable, na_justification, evidence_note, row_version FROM answer WHERE evaluation_id = ? AND question_id = ?', [evaluationId, questionId]);
    const next = {
      score: prev?.score ?? null, not_applicable: prev?.not_applicable ?? 0,
      na_justification: prev?.na_justification ?? null, evidence_note: prev?.evidence_note ?? null,
    };
    if (change.kind === 'score') Object.assign(next, { score: change.score, not_applicable: 0, na_justification: null });
    if (change.kind === 'not_applicable') Object.assign(next, { score: null, not_applicable: 1, na_justification: change.justification });
    if (change.kind === 'note') next.evidence_note = change.evidenceNote;
    if (change.kind === 'clear') Object.assign(next, { score: null, not_applicable: 0, na_justification: null });
    const base = prev?.row_version ?? null;
    c.db.run(`INSERT INTO answer (evaluation_id, question_id, score, not_applicable, na_justification, evidence_note, row_version, base_version, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,NULL,?,?,?)
      ON CONFLICT (evaluation_id, question_id) DO UPDATE SET score = excluded.score, not_applicable = excluded.not_applicable,
        na_justification = excluded.na_justification, evidence_note = excluded.evidence_note, base_version = excluded.base_version,
        updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      [evaluationId, questionId, next.score, next.not_applicable, next.na_justification, next.evidence_note, base, c.userId, nowOf(c)]);
    enqueue(c, 'answer', `${evaluationId}|${questionId}`, 'upsert', { evaluationId, questionId, score: next.score, notApplicable: !!next.not_applicable, naJustification: next.na_justification, evidenceNote: next.evidence_note }, base);
    audit(c, `answer.${change.kind}`, 'answer', `${evaluationId}|${questionId}`, change);
  });
}

export interface NewEvidence {
  evaluationId: string;
  questionId?: string | null;
  kind: 'photo' | 'document' | 'audio_note';
  localPath: string;
  mime: string;
  bytes: number;
  sha256: string;
  source?: string | null;
}

export function addEvidence(c: Ctx, f: NewEvidence): string {
  assertEditable(c, f.evaluationId);
  const id = idOf(c);
  transaction(c.db, () => {
    c.db.run(`INSERT INTO evidence_file (id, evaluation_id, question_id, kind, local_path, mime, bytes, sha256, source, created_by, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [id, f.evaluationId, f.questionId ?? null, f.kind, f.localPath, f.mime, f.bytes, f.sha256, f.source ?? null, c.userId, nowOf(c)]);
    enqueue(c, 'evidence_file', id, 'upsert', { id, ...f, localPath: undefined }, null);
    audit(c, 'evidence.add', 'evidence_file', id, { questionId: f.questionId, bytes: f.bytes });
  });
  return id;
}

export function closeEvaluation(c: Ctx, evaluationId: string) {
  assertEditable(c, evaluationId);
  transaction(c.db, () => {
    const at = nowOf(c);
    c.db.run("UPDATE evaluation SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?", [at, at, evaluationId]);
    enqueue(c, 'evaluation', evaluationId, 'close', { id: evaluationId, closedAt: at }, null);
    audit(c, 'evaluation.close', 'evaluation', evaluationId);
  });
}

export interface PendingSummary {
  operations: number;
  files: number;
  fileBytes: number;
  evaluations: number;
}

/** Lo que se le muestra al usuario antes de confirmar: "Se enviarán N cambios y M fotos (X MB)". */
export function pendingSummary(db: Driver): PendingSummary {
  const ops = db.get<{ n: number; e: number }>(
    `SELECT count(*) AS n, count(DISTINCT CASE WHEN entity = 'evaluation' THEN entity_key ELSE substr(entity_key, 1, instr(entity_key || '|', '|') - 1) END) AS e
     FROM outbox WHERE status = 'pending'`)!;
  const files = db.get<{ n: number; b: number | null }>('SELECT count(*) AS n, sum(bytes) AS b FROM evidence_file WHERE uploaded_at IS NULL AND withdrawn = 0')!;
  return { operations: ops.n, evaluations: ops.e, files: files.n, fileBytes: files.b ?? 0 };
}

export interface OutboxOp {
  op_id: string; seq: number; entity: Entity; entity_key: string; op: string; payload: string; base_version: number | null;
}

export function pendingOps(db: Driver, limit = 200): OutboxOp[] {
  return db.all<OutboxOp>("SELECT op_id, seq, entity, entity_key, op, payload, base_version FROM outbox WHERE status = 'pending' ORDER BY seq LIMIT ?", [limit]);
}

export type OpResult =
  | { opId: string; status: 'accepted'; rowVersion: number }
  | { opId: string; status: 'rejected'; reason: string }
  | { opId: string; status: 'conflict'; server: unknown };

/** Aplica la respuesta del servidor a un lote. Un op_id repetido se trata igual (idempotente). */
export function applyResults(c: Ctx, results: OpResult[]) {
  transaction(c.db, () => {
    for (const r of results) {
      const op = c.db.get<OutboxOp>('SELECT op_id, entity, entity_key FROM outbox WHERE op_id = ?', [r.opId]);
      if (!op) continue;
      if (r.status === 'accepted') {
        c.db.run("UPDATE outbox SET status = 'sent', attempts = attempts + 1, result = NULL WHERE op_id = ?", [r.opId]);
        if (op.entity === 'answer') {
          const [ev, q] = op.entity_key.split('|');
          c.db.run('UPDATE answer SET row_version = ?, base_version = ? WHERE evaluation_id = ? AND question_id = ?', [r.rowVersion, r.rowVersion, ev!, q!]);
        }
        if (op.entity === 'evaluation') c.db.run('UPDATE evaluation SET row_version = ?, base_version = ? WHERE id = ?', [r.rowVersion, r.rowVersion, op.entity_key]);
        if (op.entity === 'evidence_file') c.db.run('UPDATE evidence_file SET uploaded_at = coalesce(uploaded_at, ?) WHERE id = ?', [nowOf(c), op.entity_key]);
      } else {
        c.db.run('UPDATE outbox SET status = ?, attempts = attempts + 1, result = ? WHERE op_id = ?',
          [r.status, JSON.stringify(r.status === 'rejected' ? { reason: r.reason } : { server: r.server }), r.opId]);
      }
    }
    audit(c, 'sync.results', 'evaluation', '*', { accepted: results.filter((r) => r.status === 'accepted').length, rejected: results.filter((r) => r.status === 'rejected').length, conflicts: results.filter((r) => r.status === 'conflict').length });
  });
}

/** El propietario resuelve un conflicto de respuesta: mantiene la suya (se reenvía sobre la versión del servidor) o acepta la del servidor. */
export function resolveAnswerConflict(c: Ctx, opId: string, choice: 'keep_local' | 'take_server', server: { score: Score | null; notApplicable: boolean; naJustification: string | null; evidenceNote: string | null; rowVersion: number }) {
  transaction(c.db, () => {
    const op = c.db.get<OutboxOp>("SELECT * FROM outbox WHERE op_id = ? AND status = 'conflict' AND entity = 'answer'", [opId]);
    if (!op) throw new Error('No hay un conflicto pendiente con ese identificador');
    const [ev, q] = op.entity_key.split('|');
    if (choice === 'take_server') {
      c.db.run(`UPDATE answer SET score = ?, not_applicable = ?, na_justification = ?, evidence_note = ?, row_version = ?, base_version = ?, updated_at = ? WHERE evaluation_id = ? AND question_id = ?`,
        [server.score, server.notApplicable ? 1 : 0, server.naJustification, server.evidenceNote, server.rowVersion, server.rowVersion, nowOf(c), ev!, q!]);
      c.db.run("UPDATE outbox SET status = 'sent', result = ? WHERE op_id = ?", [JSON.stringify({ resolvedWith: 'server' }), opId]);
    } else {
      c.db.run('UPDATE answer SET base_version = ? WHERE evaluation_id = ? AND question_id = ?', [server.rowVersion, ev!, q!]);
      c.db.run("UPDATE outbox SET status = 'sent', result = ? WHERE op_id = ?", [JSON.stringify({ resolvedWith: 'local' }), opId]);
      enqueue(c, 'answer', op.entity_key, 'upsert', JSON.parse(op.payload), server.rowVersion);
    }
    audit(c, 'sync.conflict_resolved', 'answer', op.entity_key, { choice });
  });
}

// ---------- Lecturas para la interfaz ----------

export interface EvaluationRow {
  id: string; model_id: string; company: string; site: string | null; evaluated_on: string; owner_user_id: string;
  interviewees: string; status: 'draft' | 'closed'; closed_at: string | null; updated_at: string;
}

export function listEvaluations(db: Driver): (EvaluationRow & { pending_ops: number })[] {
  return db.all(`SELECT e.*, (SELECT count(*) FROM outbox o WHERE o.status = 'pending'
      AND (o.entity_key = e.id OR o.entity_key LIKE e.id || '|%' OR json_extract(o.payload, '$.evaluationId') = e.id)) AS pending_ops
    FROM evaluation e WHERE e.deleted = 0 ORDER BY e.evaluated_on DESC, e.updated_at DESC`);
}

export function getEvaluation(db: Driver, id: string): EvaluationRow | undefined {
  return db.get<EvaluationRow>('SELECT * FROM evaluation WHERE id = ? AND deleted = 0', [id]);
}

export function updateEvaluationHeader(c: Ctx, id: string, h: { company: string; site: string | null; evaluatedOn: string; interviewees: string[] }) {
  assertEditable(c, id);
  if (!h.company.trim()) throw new Error('La empresa es obligatoria');
  transaction(c.db, () => {
    c.db.run('UPDATE evaluation SET company = ?, site = ?, evaluated_on = ?, interviewees = ?, updated_at = ? WHERE id = ?',
      [h.company.trim(), h.site, h.evaluatedOn, JSON.stringify(h.interviewees), nowOf(c), id]);
    const ev = c.db.get<{ row_version: number | null }>('SELECT row_version FROM evaluation WHERE id = ?', [id]);
    enqueue(c, 'evaluation', id, 'upsert', { id, ...h }, ev?.row_version ?? null);
  });
}

/** Entrada del motor de cálculo a partir de lo guardado en la tablet. */
export function loadEvaluationInput(db: Driver, id: string) {
  const ev = getEvaluation(db, id);
  if (!ev) throw new Error('La evaluación no existe en este dispositivo');
  const scopes = db.all<{ dimension: string; applies: number | null }>('SELECT dimension, applies FROM dimension_scope WHERE evaluation_id = ?', [id]);
  const answers = db.all<{ question_id: string; score: number | null; not_applicable: number; na_justification: string | null; evidence_note: string | null }>(
    'SELECT question_id, score, not_applicable, na_justification, evidence_note FROM answer WHERE evaluation_id = ?', [id]);
  const files = db.all<{ question_id: string; n: number }>('SELECT question_id, count(*) AS n FROM evidence_file WHERE evaluation_id = ? AND withdrawn = 0 AND question_id IS NOT NULL GROUP BY question_id', [id]);
  const fileCount = new Map(files.map((f) => [f.question_id, f.n]));
  return {
    modelId: ev.model_id,
    dimensionApplies: Object.fromEntries(scopes.filter((s) => s.applies != null).map((s) => [s.dimension, s.applies === 1])),
    answers: Object.fromEntries(answers.map((a) => [a.question_id, {
      questionId: a.question_id,
      score: a.score as Score | null,
      notApplicable: a.not_applicable ? { justification: a.na_justification ?? '' } : null,
      evidenceNote: a.evidence_note,
      attachments: fileCount.get(a.question_id) ?? 0,
    }])),
  };
}

export function dimensionJustifications(db: Driver, id: string): Record<string, string | null> {
  return Object.fromEntries(db.all<{ dimension: string; justification: string | null }>('SELECT dimension, justification FROM dimension_scope WHERE evaluation_id = ?', [id]).map((r) => [r.dimension, r.justification]));
}

export function listEvidence(db: Driver, evaluationId: string, questionId: string) {
  return db.all<{ id: string; kind: string; mime: string; bytes: number; local_path: string; created_at: string }>(
    'SELECT id, kind, mime, bytes, local_path, created_at FROM evidence_file WHERE evaluation_id = ? AND question_id = ? AND withdrawn = 0 ORDER BY created_at', [evaluationId, questionId]);
}

// ---------- Plan de acción ----------

export interface ActionInput {
  questionId: string | null;
  description: string;
  impact: number | null;
  effort: number | null;
  owner?: string | null;
  dueOn?: string | null;
  status?: 'open' | 'in_progress' | 'done' | 'cancelled';
}

export function saveAction(c: Ctx, evaluationId: string, a: ActionInput & { id?: string }): string {
  const ev = c.db.get<{ owner_user_id: string }>('SELECT owner_user_id FROM evaluation WHERE id = ? AND deleted = 0', [evaluationId]);
  if (!ev) throw new Error('La evaluación no existe en este dispositivo');
  if (ev.owner_user_id !== c.userId) throw new Error('Solo el evaluador propietario puede editar esta evaluación');
  for (const [k, v] of [['impacto', a.impact], ['esfuerzo', a.effort]] as const) {
    if (v != null && !(Number.isInteger(v) && v >= 1 && v <= 5)) throw new Error(`El ${k} va de 1 a 5`);
  }
  const id = a.id ?? idOf(c);
  transaction(c.db, () => {
    const prev = c.db.get<{ row_version: number | null }>('SELECT row_version FROM action_item WHERE id = ?', [id]);
    c.db.run(`INSERT INTO action_item (id, evaluation_id, question_id, description, impact, effort, owner, due_on, status, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET description = excluded.description, impact = excluded.impact, effort = excluded.effort,
        owner = excluded.owner, due_on = excluded.due_on, status = excluded.status, updated_at = excluded.updated_at`,
      [id, evaluationId, a.questionId, a.description, a.impact, a.effort, a.owner ?? null, a.dueOn ?? null, a.status ?? 'open', nowOf(c)]);
    enqueue(c, 'action_item', id, 'upsert', { id, evaluationId, ...a }, prev?.row_version ?? null);
  });
  return id;
}

export function listActions(db: Driver, evaluationId: string) {
  return db.all<{ id: string; question_id: string | null; description: string; impact: number | null; effort: number | null; owner: string | null; due_on: string | null; status: string }>(
    'SELECT id, question_id, description, impact, effort, owner, due_on, status FROM action_item WHERE evaluation_id = ? AND deleted = 0 ORDER BY updated_at', [evaluationId]);
}
