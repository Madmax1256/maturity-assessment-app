import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addEvidence, applyResults, closeEvaluation, createEvaluation, getEvaluation, listActions, listEvaluations, loadEvaluationInput,
  migrate, pendingOps, pendingSummary, resolveAnswerConflict, saveAction, saveAnswer, setDimensionScope, updateEvaluationHeader, uuidv7, type Ctx, type Driver, type Param,
} from '@fs/db';

// node:sqlite se carga en tiempo de ejecución para que el empaquetador no intente resolverlo.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (p: string) => { exec(s: string): void; prepare(s: string): { run(...p: Param[]): unknown; get(...p: Param[]): unknown; all(...p: Param[]): unknown[] } };
};
const SCHEMA = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8');

function memoryDriver(): Driver {
  const db = new DatabaseSync(':memory:');
  return {
    exec: (s) => db.exec(s),
    run: (s, p = []) => { db.prepare(s).run(...p); },
    get: (s, p = []) => db.prepare(s).get(...p) as never,
    all: (s, p = []) => db.prepare(s).all(...p) as never,
  };
}

let c: Ctx;
let evalId: string;
beforeEach(() => {
  const db = memoryDriver();
  migrate(db, SCHEMA);
  db.run("INSERT INTO model_version (id, catalog_json, sha256, published_at) VALUES ('V01', '{}', 'x', '2026-10-08')");
  db.run("INSERT INTO sync_state (id, device_id) VALUES (1, 'tab-s10fe-01')");
  let t = 0;
  c = { db, userId: 'evaluador', now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, t++)).toISOString() };
  evalId = createEvaluation(c, { modelId: 'V01', company: 'Empresa de ejemplo', evaluatedOn: '2026-10-08' });
});

describe('uuid v7', () => {
  it('tiene versión 7 y se ordena por tiempo', () => {
    const a = uuidv7(1_700_000_000_000), b = uuidv7(1_700_000_000_001);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a < b).toBe(true);
  });
});

describe('guardado local con cola de salida', () => {
  it('cada cambio deja una operación en la cola, en orden', () => {
    saveAnswer(c, evalId, 'D01-Q01', { kind: 'score', score: 75 });
    saveAnswer(c, evalId, 'D01-Q01', { kind: 'note', evidenceNote: 'Matriz RACI vigente' });
    setDimensionScope(c, evalId, 'D8', false, 'La faena no usa tecnología de monitoreo');
    const ops = pendingOps(c.db);
    expect(ops.map((o) => o.entity)).toEqual(['evaluation', 'answer', 'answer', 'dimension_scope']);
    expect(ops.map((o) => o.seq)).toEqual([1, 2, 3, 4]);
    expect(JSON.parse(ops[2]!.payload)).toMatchObject({ score: 75, evidenceNote: 'Matriz RACI vigente' });
  });

  it('"No aplica" exige justificación y borra el puntaje', () => {
    expect(() => saveAnswer(c, evalId, 'D03-Q03', { kind: 'not_applicable', justification: ' ' })).toThrow();
    saveAnswer(c, evalId, 'D03-Q03', { kind: 'score', score: 50 });
    saveAnswer(c, evalId, 'D03-Q03', { kind: 'not_applicable', justification: 'Turno único diurno' });
    const row = c.db.get<{ score: number | null; not_applicable: number }>("SELECT score, not_applicable FROM answer WHERE question_id = 'D03-Q03'");
    expect(row).toEqual({ score: null, not_applicable: 1 });
    saveAnswer(c, evalId, 'D03-Q03', { kind: 'clear' });
    expect(c.db.get("SELECT score, not_applicable, na_justification FROM answer WHERE question_id = 'D03-Q03'")).toEqual({ score: null, not_applicable: 0, na_justification: null });
  });

  it('excluir una dimensión exige justificación', () => {
    expect(() => setDimensionScope(c, evalId, 'D8', false)).toThrow();
  });

  it('si falla la escritura no queda operación huérfana', () => {
    const before = pendingOps(c.db).length;
    expect(() => saveAnswer(c, evalId, 'D01-Q01', { kind: 'score', score: 30 as never })).toThrow();
    expect(pendingOps(c.db).length).toBe(before);
  });

  it('solo el propietario edita y una evaluación cerrada es de solo lectura', () => {
    expect(() => saveAnswer({ ...c, userId: 'otro' }, evalId, 'D01-Q01', { kind: 'score', score: 25 })).toThrow(/propietario/);
    closeEvaluation(c, evalId);
    expect(() => saveAnswer(c, evalId, 'D01-Q01', { kind: 'score', score: 25 })).toThrow(/cerrada/);
  });
});

describe('evidencia', () => {
  it('se agrega, cuenta para el resumen y no se puede borrar ni alterar', () => {
    const id = addEvidence(c, { evaluationId: evalId, questionId: 'D01-Q01', kind: 'photo', localPath: 'ev/1.enc', mime: 'image/jpeg', bytes: 2_500_000, sha256: 'abc' });
    expect(pendingSummary(c.db)).toMatchObject({ files: 1, fileBytes: 2_500_000 });
    expect(() => c.db.run('DELETE FROM evidence_file WHERE id = ?', [id])).toThrow();
    expect(() => c.db.run("UPDATE evidence_file SET sha256 = 'zzz' WHERE id = ?", [id])).toThrow();
  });
});

describe('resultado de la sincronización', () => {
  it('marca aceptadas, guarda rechazos y conflictos, y es idempotente', () => {
    saveAnswer(c, evalId, 'D01-Q01', { kind: 'score', score: 75 });
    saveAnswer(c, evalId, 'D01-Q02', { kind: 'score', score: 50 });
    const [opEval, op1, op2] = pendingOps(c.db);
    const results = [
      { opId: opEval!.op_id, status: 'accepted' as const, rowVersion: 1 },
      { opId: op1!.op_id, status: 'accepted' as const, rowVersion: 7 },
      { opId: op2!.op_id, status: 'conflict' as const, server: { score: 25, rowVersion: 3 } },
    ];
    applyResults(c, results);
    applyResults(c, results);
    expect(pendingOps(c.db)).toHaveLength(0);
    expect(c.db.get("SELECT row_version FROM answer WHERE question_id = 'D01-Q01'")).toEqual({ row_version: 7 });
    expect(c.db.get('SELECT status, attempts FROM outbox WHERE op_id = ?', [op2!.op_id])).toEqual({ status: 'conflict', attempts: 2 });
  });

  it('el propietario resuelve el conflicto manteniendo su respuesta o tomando la del servidor', () => {
    saveAnswer(c, evalId, 'D02-Q04', { kind: 'score', score: 75 });
    saveAnswer(c, evalId, 'D02-Q05', { kind: 'score', score: 75 });
    const [, a, b] = pendingOps(c.db);
    applyResults(c, [{ opId: a!.op_id, status: 'conflict', server: {} }, { opId: b!.op_id, status: 'conflict', server: {} }]);
    const server = { score: 50 as const, notApplicable: false, naJustification: null, evidenceNote: 'Revisor', rowVersion: 9 };

    resolveAnswerConflict(c, a!.op_id, 'keep_local', server);
    const resent = pendingOps(c.db).filter((o) => o.entity === 'answer');
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatchObject({ entity_key: `${evalId}|D02-Q04`, base_version: 9 });

    resolveAnswerConflict(c, b!.op_id, 'take_server', server);
    expect(c.db.get("SELECT score, evidence_note, row_version FROM answer WHERE question_id = 'D02-Q05'")).toEqual({ score: 50, evidence_note: 'Revisor', row_version: 9 });
  });
});

describe('bitácora', () => {
  it('registra las acciones y no se puede editar', () => {
    saveAnswer(c, evalId, 'D01-Q01', { kind: 'score', score: 75 });
    const rows = c.db.all<{ action: string }>('SELECT action FROM audit_log ORDER BY at');
    expect(rows.map((r) => r.action)).toEqual(['evaluation.create', 'answer.score']);
    expect(() => c.db.run("UPDATE audit_log SET action = 'x'")).toThrow();
  });
});

describe('lecturas para la interfaz', () => {
  it('arma la entrada del motor con alcance, respuestas, No aplica y evidencia', () => {
    setDimensionScope(c, evalId, 'D1', true);
    setDimensionScope(c, evalId, 'D8', false, 'Sin tecnología de monitoreo');
    saveAnswer(c, evalId, 'D01-Q01', { kind: 'score', score: 75 });
    saveAnswer(c, evalId, 'D01-Q02', { kind: 'not_applicable', justification: 'No hay contratistas' });
    addEvidence(c, { evaluationId: evalId, questionId: 'D01-Q01', kind: 'photo', localPath: 'ev/1.enc', mime: 'image/jpeg', bytes: 10, sha256: 'a' });
    const input = loadEvaluationInput(c.db, evalId);
    expect(input.dimensionApplies).toEqual({ D1: true, D8: false });
    expect(input.answers['D01-Q01']).toMatchObject({ score: 75, attachments: 1 });
    expect(input.answers['D01-Q02']).toMatchObject({ score: null, notApplicable: { justification: 'No hay contratistas' } });
  });

  it('lista evaluaciones con sus cambios pendientes', () => {
    saveAnswer(c, evalId, 'D01-Q01', { kind: 'score', score: 75 });
    const [row] = listEvaluations(c.db);
    expect(row).toMatchObject({ id: evalId, company: 'Empresa de ejemplo', pending_ops: 2 });
  });

  it('edita antecedentes y exige empresa', () => {
    updateEvaluationHeader(c, evalId, { company: 'Otra', site: 'Faena', evaluatedOn: '2026-10-09', interviewees: ['Jefe de turno'] });
    expect(getEvaluation(c.db, evalId)).toMatchObject({ company: 'Otra', site: 'Faena', interviewees: '["Jefe de turno"]' });
    expect(() => updateEvaluationHeader(c, evalId, { company: ' ', site: null, evaluatedOn: '2026-10-09', interviewees: [] })).toThrow();
  });

  it('guarda y actualiza acciones del plan validando impacto y esfuerzo', () => {
    const id = saveAction(c, evalId, { questionId: 'D01-Q01', description: 'Definir RACI', impact: 5, effort: 2 });
    saveAction(c, evalId, { id, questionId: 'D01-Q01', description: 'Definir RACI por nivel', impact: 5, effort: 3, status: 'in_progress' });
    expect(listActions(c.db, evalId)).toEqual([expect.objectContaining({ id, description: 'Definir RACI por nivel', effort: 3, status: 'in_progress' })]);
    expect(() => saveAction(c, evalId, { questionId: null, description: 'x', impact: 7, effort: 1 })).toThrow();
  });
});
