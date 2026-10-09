// Descarga de evaluaciones propias desde el servidor, para continuar en este equipo una evaluación
// iniciada en otro (tablet o computador). Corre dentro de la sincronización que el usuario confirma,
// después de enviar lo pendiente. Lo que aún no se envía desde aquí no se pisa: esas filas quedan
// como están y, si chocan, el conflicto se resuelve con la regla de siempre (decide el propietario).

import { transaction, type Ctx } from './index';

export interface PullData {
  cursor: number;
  evaluations: { id: string; model_id: string; company: string; site: string | null; evaluated_on: string; owner_user_id: string;
    interviewees: string[] | null; status: 'draft' | 'closed'; closed_at: string | null; row_version: number; updated_at: string }[];
  scopes: { evaluation_id: string; dimension: string; applies: boolean; justification: string | null; row_version: number }[];
  answers: { evaluation_id: string; question_id: string; score: number | null; not_applicable: boolean; na_justification: string | null;
    evidence_note: string | null; row_version: number; updated_by: string; updated_at: string }[];
  evidence: { id: string; evaluation_id: string; question_id: string | null; kind: string; mime: string; bytes: number; sha256: string;
    source: string | null; created_by: string; received_at: string }[];
  actions: { id: string; evaluation_id: string; question_id: string | null; description: string; impact: number | null; effort: number | null;
    owner: string | null; due_on: string | null; status: string; row_version: number; updated_at: string }[];
}

/** Marca de la evidencia que está en el servidor y no en este equipo. */
export const REMOTE_FILE = 'server:';

export function pullCursor(c: Ctx): number {
  return Number(c.db.get<{ value: string }>("SELECT value FROM sync_cursor WHERE name = 'pull'")?.value ?? 0);
}

/** Aplica lo descargado. Devuelve cuántas evaluaciones llegaron por primera vez a este equipo. */
export function applyPull(c: Ctx, d: PullData): number {
  const now = (c.now ?? (() => new Date().toISOString()))();
  return transaction(c.db, () => {
    const busy = new Set(c.db.all<{ entity_key: string }>("SELECT DISTINCT entity_key FROM outbox WHERE status IN ('pending','conflict')").map((r) => r.entity_key));
    const models = new Set(c.db.all<{ id: string }>('SELECT id FROM model_version').map((r) => r.id));
    const have = new Set<string>();
    const before = new Set(c.db.all<{ id: string }>('SELECT id FROM evaluation').map((r) => r.id));
    for (const e of d.evaluations) {
      if (!models.has(e.model_id)) continue;
      have.add(e.id);
      if (busy.has(e.id)) continue;
      c.db.run(`INSERT INTO evaluation (id, model_id, company, site, evaluated_on, owner_user_id, interviewees, status, closed_at, row_version, base_version, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (id) DO UPDATE SET company = excluded.company, site = excluded.site, evaluated_on = excluded.evaluated_on,
          interviewees = excluded.interviewees, status = excluded.status, closed_at = excluded.closed_at,
          row_version = excluded.row_version, base_version = excluded.base_version, updated_at = excluded.updated_at, deleted = 0`,
        [e.id, e.model_id, e.company, e.site, e.evaluated_on, e.owner_user_id, JSON.stringify(e.interviewees ?? []), e.status, e.closed_at,
          e.row_version, e.row_version, e.updated_at]);
    }
    for (const s of d.scopes) {
      if (!have.has(s.evaluation_id) || busy.has(`${s.evaluation_id}|${s.dimension}`)) continue;
      c.db.run(`INSERT INTO dimension_scope (evaluation_id, dimension, applies, justification, updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT (evaluation_id, dimension) DO UPDATE SET applies = excluded.applies, justification = excluded.justification, updated_at = excluded.updated_at`,
        [s.evaluation_id, s.dimension, s.applies ? 1 : 0, s.justification, now]);
    }
    for (const a of d.answers) {
      if (!have.has(a.evaluation_id) || busy.has(`${a.evaluation_id}|${a.question_id}`)) continue;
      c.db.run(`INSERT INTO answer (evaluation_id, question_id, score, not_applicable, na_justification, evidence_note, row_version, base_version, updated_by, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (evaluation_id, question_id) DO UPDATE SET score = excluded.score, not_applicable = excluded.not_applicable,
          na_justification = excluded.na_justification, evidence_note = excluded.evidence_note, row_version = excluded.row_version,
          base_version = excluded.base_version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
        [a.evaluation_id, a.question_id, a.score, a.not_applicable ? 1 : 0, a.na_justification, a.evidence_note, a.row_version, a.row_version, a.updated_by, a.updated_at]);
    }
    for (const f of d.evidence) {
      if (!have.has(f.evaluation_id)) continue;
      c.db.run(`INSERT INTO evidence_file (id, evaluation_id, question_id, kind, local_path, mime, bytes, sha256, source, created_by, created_at, uploaded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`,
        [f.id, f.evaluation_id, f.question_id, f.kind, REMOTE_FILE + f.sha256, f.mime, f.bytes, f.sha256, f.source, f.created_by, f.received_at, f.received_at]);
    }
    for (const x of d.actions) {
      if (!have.has(x.evaluation_id) || busy.has(x.id)) continue;
      c.db.run(`INSERT INTO action_item (id, evaluation_id, question_id, description, impact, effort, owner, due_on, status, row_version, base_version, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (id) DO UPDATE SET description = excluded.description, impact = excluded.impact, effort = excluded.effort, owner = excluded.owner,
          due_on = excluded.due_on, status = excluded.status, row_version = excluded.row_version, base_version = excluded.base_version, updated_at = excluded.updated_at`,
        [x.id, x.evaluation_id, x.question_id, x.description, x.impact, x.effort, x.owner, x.due_on, x.status, x.row_version, x.row_version, x.updated_at]);
    }
    c.db.run("INSERT INTO sync_cursor (name, value) VALUES ('pull', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value", [String(d.cursor)]);
    return [...have].filter((id) => !before.has(id)).length;
  });
}
