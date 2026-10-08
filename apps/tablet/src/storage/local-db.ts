// Base local de la tablet: SQLite compilado a WebAssembly (sql.js) dentro de la app.
// Toda la base vive en memoria mientras la app está abierta y, después de cada cambio, se
// guarda una copia cifrada con AES-GCM en el almacenamiento del dispositivo. La llave se
// genera una vez, no es exportable y queda guardada aparte (en Android, protegida por el
// Keystore a través del almacén del WebView; ver docs de despliegue).
//
// Se eligió sql.js en vez de un plugin nativo porque su API es síncrona, igual que el
// repositorio de @fs/db: el mismo código y las mismas pruebas sirven en tablet, navegador y CI.

import initSqlJs, { type Database, type SqlValue } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { migrate, type Driver, type Param } from '@fs/db';
import schemaSql from '../../../../packages/db/src/schema.sql?raw';
import { MODEL_V01 } from '@fs/model';
import { idbGet, idbSet } from './idb';

const DB_KEY = 'fs-db-v1';
const KEY_KEY = 'fs-db-key-v1';

async function getKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(KEY_KEY);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await idbSet(KEY_KEY, key);
  return key;
}

async function seal(key: CryptoKey, data: Uint8Array) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return { iv, ct };
}

async function open(key: CryptoKey, sealed: { iv: Uint8Array; ct: Uint8Array }) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: sealed.iv }, key, sealed.ct));
}

function toRow(cols: string[], vals: SqlValue[]) {
  const o: Record<string, unknown> = {};
  cols.forEach((c, i) => { o[c] = vals[i]; });
  return o;
}

export interface LocalDb {
  driver: Driver;
  /** Guarda la copia cifrada. Se llama sola después de cada escritura. */
  flush(): Promise<void>;
}

export async function openLocalDb(): Promise<LocalDb> {
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const key = await getKey();
  const stored = await idbGet<{ iv: Uint8Array; ct: Uint8Array }>(DB_KEY);
  const db: Database = stored ? new SQL.Database(await open(key, stored)) : new SQL.Database();

  let dirty = false;
  let saving: Promise<void> | null = null;
  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    const sealed = await seal(key, db.export());
    await idbSet(DB_KEY, sealed);
  };
  const schedule = () => {
    dirty = true;
    saving = (saving ?? Promise.resolve()).then(flush);
  };

  const driver: Driver = {
    exec(sql) {
      db.exec(sql);
      if (/^\s*(COMMIT|INSERT|UPDATE|DELETE|CREATE)/i.test(sql)) schedule();
    },
    run(sql, params: Param[] = []) {
      db.run(sql, params as SqlValue[]);
      schedule();
    },
    get(sql, params: Param[] = []) {
      const st = db.prepare(sql);
      try {
        st.bind(params as SqlValue[]);
        return (st.step() ? toRow(st.getColumnNames(), st.get()) : undefined) as never;
      } finally { st.free(); }
    },
    all(sql, params: Param[] = []) {
      const st = db.prepare(sql);
      const out: Record<string, unknown>[] = [];
      try {
        st.bind(params as SqlValue[]);
        while (st.step()) out.push(toRow(st.getColumnNames(), st.get()));
      } finally { st.free(); }
      return out as never;
    },
  };

  migrate(driver, schemaSql);
  if (!driver.get("SELECT 1 FROM model_version WHERE id = 'V01'")) {
    driver.run('INSERT INTO model_version (id, catalog_json, sha256, published_at) VALUES (?,?,?,?)',
      [MODEL_V01.id, JSON.stringify(MODEL_V01), MODEL_V01.source.sha256, MODEL_V01.source.importedAt]);
  }
  if (!driver.get('SELECT 1 FROM sync_state WHERE id = 1')) {
    driver.run('INSERT INTO sync_state (id, device_id) VALUES (1, ?)', [crypto.randomUUID()]);
  }
  schedule();
  await saving;
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void flush(); });
  return { driver, flush };
}
