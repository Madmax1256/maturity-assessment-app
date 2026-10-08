// Sincronización iniciada por el usuario: sube los archivos pendientes, envía la cola en orden y
// aplica la respuesta. Nunca corre sola; la pantalla Sincronizar la llama después de que el
// evaluador confirma lo que va a salir de la tablet.

import { applyResults, markSynced, pendingAudit, pendingOps, pendingUploads, syncState, type Ctx, type OpResult } from './index';

export interface PushBody {
  deviceId: string;
  ops: { opId: string; seq: number; entity: string; entityKey: string; op: string; payload: unknown; baseVersion: number | null }[];
  audit: { id: string; at: string; action: string; entity: string | null; entityKey: string | null; detail: unknown }[];
}

export interface SyncTransport {
  /** De estas huellas, cuáles no tiene el servidor. */
  missingFiles(sha256: string[]): Promise<string[]>;
  uploadFile(sha256: string, mime: string, data: Uint8Array): Promise<void>;
  push(body: PushBody): Promise<{ results: OpResult[] }>;
}

export interface SyncReport {
  accepted: number;
  rejected: number;
  conflicts: number;
  filesUploaded: number;
  /** Archivos que no se pudieron leer o subir; su registro queda en cola para la próxima vez. */
  filesFailed: { id: string; reason: string }[];
}

const BATCH = 200;

export async function runSync(c: Ctx, t: SyncTransport, readFile: (localPath: string) => Promise<Uint8Array>): Promise<SyncReport> {
  const state = syncState(c.db);
  if (!state) throw new Error('La tablet no tiene identificador de dispositivo');
  const report: SyncReport = { accepted: 0, rejected: 0, conflicts: 0, filesUploaded: 0, filesFailed: [] };

  // 1. Archivos primero: el servidor solo acepta el registro de una evidencia cuyo archivo ya tiene.
  const skip = new Set<string>();
  const uploads = pendingUploads(c.db);
  const missing = new Set(uploads.length ? await t.missingFiles([...new Set(uploads.map((f) => f.sha256))]) : []);
  for (const f of uploads) {
    try {
      if (missing.has(f.sha256)) {
        await t.uploadFile(f.sha256, f.mime, await readFile(f.local_path));
        missing.delete(f.sha256);
        report.filesUploaded++;
      }
    } catch (e) {
      skip.add(f.op_id);
      report.filesFailed.push({ id: f.id, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // 2. La cola, en lotes y en orden.
  const toWire = (rows: ReturnType<typeof pendingAudit>) =>
    rows.map((a) => ({ id: a.id, at: a.at, action: a.action, entity: a.entity, entityKey: a.entity_key, detail: a.detail == null ? null : JSON.parse(a.detail) }));
  const sent = new Set<string>();
  for (;;) {
    const ops = pendingOps(c.db, BATCH + skip.size + sent.size).filter((o) => !skip.has(o.op_id) && !sent.has(o.op_id)).slice(0, BATCH);
    if (ops.length === 0) break;
    const { results } = await t.push({
      deviceId: state.device_id,
      ops: ops.map((o) => ({ opId: o.op_id, seq: o.seq, entity: o.entity, entityKey: o.entity_key, op: o.op, payload: JSON.parse(o.payload), baseVersion: o.base_version })),
      audit: [],
    });
    applyResults(c, results);
    for (const r of results) {
      if (r.status === 'accepted') report.accepted++;
      else if (r.status === 'rejected') report.rejected++;
      else report.conflicts++;
    }
    ops.forEach((o) => sent.add(o.op_id));
    if (ops.length < BATCH) break;
  }

  // 3. La bitácora al final, para que incluya lo que dejó esta misma sincronización.
  let lastAudit: number | null = null;
  for (let audit = pendingAudit(c.db); audit.length; audit = pendingAudit(c.db)) {
    await t.push({ deviceId: state.device_id, ops: [], audit: toWire(audit) });
    lastAudit = audit.at(-1)!.rowid;
    markSynced(c, lastAudit);
  }
  if (lastAudit == null) markSynced(c, null);
  return report;
}

/** Cliente HTTP de la API de sincronización (server/). */
export function httpTransport(baseUrl: string, getToken: () => Promise<string>, f: typeof fetch = fetch): SyncTransport {
  const url = (p: string) => `${baseUrl.replace(/\/$/, '')}${p}`;
  const headers = async (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${await getToken()}`, ...extra });
  const fail = async (r: Response) => {
    let detail = '';
    try { detail = ((await r.json()) as { detail?: string }).detail ?? ''; } catch { /* sin cuerpo */ }
    return new Error(detail || `El servidor respondió ${r.status}`);
  };
  return {
    async missingFiles(shas) {
      const r = await f(url('/v1/files/missing'), { method: 'POST', headers: await headers({ 'content-type': 'application/json' }), body: JSON.stringify({ sha256: shas }) });
      if (!r.ok) throw await fail(r);
      return ((await r.json()) as { missing: string[] }).missing;
    },
    async uploadFile(sha, mime, data) {
      const r = await f(url(`/v1/files/${sha}`), { method: 'PUT', headers: await headers({ 'content-type': mime }), body: data as unknown as BodyInit });
      if (!r.ok) throw await fail(r);
    },
    async push(body) {
      const r = await f(url('/v1/sync/push'), { method: 'POST', headers: await headers({ 'content-type': 'application/json' }), body: JSON.stringify(body) });
      if (!r.ok) throw await fail(r);
      return (await r.json()) as { results: OpResult[] };
    },
  };
}
