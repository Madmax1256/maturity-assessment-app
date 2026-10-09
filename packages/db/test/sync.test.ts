import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  addEvidence, applyPull, clearLink, listEvidence, loadEvaluationInput, pullCursor, type PullData, closeEvaluation, getLink, saveLink, createEvaluation, listConflicts, listRejected, migrate, pendingAudit, pendingSummary, resolveAnswerConflict,
  retryRejected, runSync, saveAction, saveAnswer, setDimensionScope, syncState, type Ctx, type Driver, type OpResult, type Param, type PushBody, type SyncTransport,
} from '@fs/db';

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

/** Servidor falso: acepta todo salvo lo que se le indique, y registra el orden de las llamadas. */
class FakeServer implements SyncTransport {
  calls: string[] = [];
  files = new Map<string, Uint8Array>();
  pushes: PushBody[] = [];
  version = 100;
  decide: (op: PushBody['ops'][number]) => OpResult | null = () => null;
  pull?: (since: number) => Promise<PullData>;
  async missingFiles(shas: string[]) { this.calls.push(`missing ${shas.join(',')}`); return shas.filter((x) => !this.files.has(x)); }
  async uploadFile(sha: string, _mime: string, data: Uint8Array) { this.calls.push(`put ${sha}`); this.files.set(sha, data); }
  async push(body: PushBody) {
    this.calls.push(`push ${body.ops.length}/${body.audit.length}`);
    this.pushes.push(body);
    return { results: body.ops.map((o) => this.decide(o) ?? { opId: o.opId, status: 'accepted' as const, rowVersion: ++this.version }) };
  }
}

let c: Ctx;
let ev: string;
let srv: FakeServer;
const read = async (p: string) => new TextEncoder().encode(`contenido de ${p}`);

beforeEach(() => {
  const db = memoryDriver();
  migrate(db, SCHEMA);
  db.run("INSERT INTO model_version (id, catalog_json, sha256, published_at) VALUES ('V01', '{}', 'x', '2026-10-08')");
  db.run("INSERT INTO sync_state (id, device_id) VALUES (1, 'tab-s10fe-01')");
  let t = 0;
  c = { db, userId: 'evaluador', now: () => new Date(Date.UTC(2026, 9, 8, 12, 0, t++)).toISOString() };
  ev = createEvaluation(c, { modelId: 'V01', company: 'Minera', evaluatedOn: '2026-10-08' });
  srv = new FakeServer();
});

describe('runSync', () => {
  it('sube los archivos antes de enviar la cola y deja todo sincronizado', async () => {
    setDimensionScope(c, ev, 'D1', true);
    saveAnswer(c, ev, 'D01-Q01', { kind: 'score', score: 75 });
    addEvidence(c, { evaluationId: ev, questionId: 'D01-Q01', kind: 'photo', localPath: 'evidence/abc', mime: 'image/jpeg', bytes: 10, sha256: 'abc' });
    const r = await runSync(c, srv, read);
    expect(r).toEqual({ accepted: 4, rejected: 0, conflicts: 0, filesUploaded: 1, filesFailed: [], downloaded: 0 });
    expect(srv.calls.slice(0, 3)).toEqual(['missing abc', 'put abc', 'push 4/0']);
    expect(srv.pushes[0]!.ops.map((o) => o.seq)).toEqual([1, 2, 3, 4]);
    expect(pendingSummary(c.db)).toMatchObject({ operations: 0, files: 0 });
    expect(c.db.get<{ row_version: number }>('SELECT row_version FROM answer')!.row_version).toBe(103);
    expect(syncState(c.db)!.last_sync_at).not.toBeNull();
  });

  it('no vuelve a subir un archivo que el servidor ya tiene', async () => {
    srv.files.set('abc', new Uint8Array([1]));
    addEvidence(c, { evaluationId: ev, questionId: null, kind: 'document', localPath: 'evidence/abc', mime: 'application/pdf', bytes: 1, sha256: 'abc' });
    const r = await runSync(c, srv, read);
    expect(r.filesUploaded).toBe(0);
    expect(srv.calls).not.toContain('put abc');
  });

  it('si un archivo no se puede subir, su registro queda en cola y el resto se envía', async () => {
    saveAnswer(c, ev, 'D01-Q01', { kind: 'score', score: 50 });
    addEvidence(c, { evaluationId: ev, questionId: 'D01-Q01', kind: 'photo', localPath: 'evidence/roto', mime: 'image/jpeg', bytes: 3, sha256: 'roto' });
    const r = await runSync(c, srv, async () => { throw new Error('No se pudo leer el archivo'); });
    expect(r.filesFailed).toEqual([{ id: expect.any(String), reason: 'No se pudo leer el archivo' }]);
    expect(r.accepted).toBe(2);
    expect(pendingSummary(c.db)).toMatchObject({ operations: 1, files: 1 });
    // La próxima vez, con el archivo legible, se completa.
    const r2 = await runSync(c, srv, read);
    expect(r2).toMatchObject({ accepted: 1, filesUploaded: 1, filesFailed: [] });
    expect(pendingSummary(c.db).operations).toBe(0);
  });

  it('envía en lotes de 200 respetando el orden', async () => {
    for (let i = 0; i < 450; i++) saveAnswer(c, ev, 'D01-Q01', { kind: 'note', evidenceNote: `nota ${i}` });
    await runSync(c, srv, read);
    expect(srv.pushes.filter((p) => p.ops.length).map((p) => p.ops.length)).toEqual([200, 200, 51]);
    const seqs = srv.pushes.flatMap((p) => p.ops.map((o) => o.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('la bitácora se envía una sola vez, incluida la línea de esta sincronización', async () => {
    saveAnswer(c, ev, 'D01-Q01', { kind: 'score', score: 25 });
    await runSync(c, srv, read);
    const sentAudit = srv.pushes.flatMap((p) => p.audit.map((a) => a.action));
    expect(sentAudit).toEqual(['evaluation.create', 'answer.score', 'sync.results']);
    expect(pendingAudit(c.db)).toHaveLength(0);
    srv.pushes = [];
    await runSync(c, srv, read);
    expect(srv.pushes).toHaveLength(0);
  });

  it('muestra rechazos y conflictos, y permite resolverlos', async () => {
    saveAnswer(c, ev, 'D01-Q01', { kind: 'score', score: 75 });
    saveAction(c, ev, { questionId: 'D01-Q01', description: 'Capacitar', impact: 5, effort: 2 });
    srv.decide = (o) => {
      if (o.entity === 'answer') return { opId: o.opId, status: 'conflict', server: { score: 25, notApplicable: false, naJustification: null, evidenceNote: 'otra tablet', rowVersion: 7 } };
      if (o.entity === 'action_item') return { opId: o.opId, status: 'rejected', reason: 'El impacto va de 1 a 5' };
      return null;
    };
    const r = await runSync(c, srv, read);
    expect(r).toMatchObject({ accepted: 1, rejected: 1, conflicts: 1 });
    const [conf] = listConflicts(c.db);
    expect(conf!.local.score).toBe(75);
    expect(conf!.server).toMatchObject({ score: 25, rowVersion: 7 });
    const [rej] = listRejected(c.db);
    expect(rej!.reason).toBe('El impacto va de 1 a 5');

    resolveAnswerConflict(c, conf!.op_id, 'keep_local', conf!.server);
    retryRejected(c, rej!.op_id);
    srv.decide = () => null;
    const r2 = await runSync(c, srv, read);
    expect(r2.accepted).toBe(2);
    expect(srv.pushes.at(-2)!.ops.find((o) => o.entity === 'answer')!.baseVersion).toBe(7);
    expect(listConflicts(c.db)).toHaveLength(0);
    expect(listRejected(c.db)).toHaveLength(0);
  });

  it('una evaluación cerrada también se sincroniza', async () => {
    setDimensionScope(c, ev, 'D1', false, 'No aplica en esta faena');
    closeEvaluation(c, ev);
    const r = await runSync(c, srv, read);
    expect(r.accepted).toBe(3);
    expect(srv.pushes[0]!.ops.at(-1)).toMatchObject({ entity: 'evaluation', op: 'close' });
  });
});

describe('vinculación con el servidor', () => {
  const link = { server_url: 'http://192.168.1.20:8000', token: 'fs_abc', user_id: 'ana', user_name: 'Ana' };

  it('pasa las evaluaciones del evaluador local a la persona vinculada', () => {
    saveLink(c, link);
    expect(getLink(c.db)).toMatchObject(link);
    const ana: Ctx = { ...c, userId: 'ana' };
    expect(c.db.get<{ owner_user_id: string }>('SELECT owner_user_id FROM evaluation WHERE id = ?', [ev])!.owner_user_id).toBe('ana');
    saveAnswer(ana, ev, 'D01-Q01', { kind: 'score', score: 50 });
    expect(c.db.all('SELECT * FROM audit_log WHERE action = ?', ['device.linked'])).toHaveLength(1);
  });

  it('no cambia de persona ni se desvincula con cambios sin enviar', async () => {
    saveLink(c, link);
    expect(() => saveLink(c, { ...link, user_id: 'luis', user_name: 'Luis' })).toThrow(/cambios sin enviar/);
    expect(() => clearLink(c)).toThrow(/cambios sin enviar/);
    // La misma persona puede volver a vincularse (por ejemplo, con un token nuevo).
    saveLink(c, { ...link, token: 'fs_nuevo' });
    expect(getLink(c.db)!.token).toBe('fs_nuevo');
    await runSync({ ...c, userId: 'ana' }, srv, read);
    clearLink(c);
    expect(getLink(c.db)).toBeUndefined();
    saveLink(c, { ...link, user_id: 'luis', user_name: 'Luis' });
    expect(getLink(c.db)!.user_id).toBe('luis');
  });
});

describe('traer avances de otro equipo', () => {
  const remote = (over: Partial<PullData> = {}): PullData => ({
    cursor: 210,
    evaluations: [{ id: 'ev-pc', model_id: 'V01', company: 'Minera PC', site: null, evaluated_on: '2026-10-08', owner_user_id: 'evaluador',
      interviewees: ['Ana'], status: 'draft', closed_at: null, row_version: 200, updated_at: '2026-10-08T15:00:00Z' }],
    scopes: [{ evaluation_id: 'ev-pc', dimension: 'D1', applies: true, justification: null, row_version: 201 }],
    answers: [{ evaluation_id: 'ev-pc', question_id: 'D01-Q01', score: 50, not_applicable: false, na_justification: null, evidence_note: 'del PC',
      row_version: 202, updated_by: 'evaluador', updated_at: '2026-10-08T15:01:00Z' }],
    evidence: [{ id: 'f-pc', evaluation_id: 'ev-pc', question_id: 'D01-Q01', kind: 'photo', mime: 'image/jpeg', bytes: 5, sha256: 'feed',
      source: null, created_by: 'evaluador', received_at: '2026-10-08T15:02:00Z' }],
    actions: [],
    ...over,
  });

  it('una evaluación iniciada en otro equipo queda lista para continuar aquí', async () => {
    srv.pull = async () => remote();
    const r = await runSync(c, srv, read);
    expect(r.downloaded).toBe(1);
    expect(pullCursor(c)).toBe(210);
    const input = loadEvaluationInput(c.db, 'ev-pc');
    expect(input.answers['D01-Q01']).toMatchObject({ score: 50, evidenceNote: 'del PC', attachments: 1 });
    expect(listEvidence(c.db, 'ev-pc', 'D01-Q01')[0]!.local_path).toBe('server:feed');
    // Se sigue respondiendo aquí y el cambio sale sobre la versión del servidor.
    saveAnswer(c, 'ev-pc', 'D01-Q01', { kind: 'score', score: 75 });
    await runSync(c, srv, read);
    const sent = srv.pushes.at(-2)!.ops.find((o) => o.entity === 'answer')!;
    expect(sent.baseVersion).toBe(202);
  });

  it('no pisa lo que este equipo aún no envía', () => {
    applyPull(c, remote());
    saveAnswer(c, 'ev-pc', 'D01-Q01', { kind: 'score', score: 100 });
    const n = applyPull(c, remote({ answers: [{ ...remote().answers[0]!, score: 0, row_version: 300 }] }));
    expect(n).toBe(0);
    expect(loadEvaluationInput(c.db, 'ev-pc').answers['D01-Q01']!.score).toBe(100);
  });
});
