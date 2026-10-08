-- Base local de la tablet (SQLite; en el dispositivo se abre con SQLCipher y la llave vive en
-- Android Keystore). Sección 7 de la especificación.
-- Convenciones: ids UUID v7 generados en el dispositivo; row_version la asigna el servidor;
-- base_version es la versión sobre la que se hizo el cambio local; deleted = lápida.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_version (
  id TEXT PRIMARY KEY,            -- "V01"
  catalog_json TEXT NOT NULL,     -- catálogo completo, inmutable
  sha256 TEXT NOT NULL,
  published_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evaluation (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES model_version(id),
  company TEXT NOT NULL,
  site TEXT,
  evaluated_on TEXT NOT NULL,     -- fecha ISO
  owner_user_id TEXT NOT NULL,    -- un solo propietario edita (decisión 2026-10-08)
  interviewees TEXT,              -- JSON con la lista de entrevistados
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','closed')),
  closed_at TEXT,
  row_version INTEGER,            -- null hasta la primera sincronización
  base_version INTEGER,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dimension_scope (
  evaluation_id TEXT NOT NULL REFERENCES evaluation(id),
  dimension TEXT NOT NULL,        -- "D1" … "D12"
  applies INTEGER CHECK (applies IN (0,1)),  -- null = sin decidir
  justification TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (evaluation_id, dimension)
);

CREATE TABLE IF NOT EXISTS answer (
  evaluation_id TEXT NOT NULL REFERENCES evaluation(id),
  question_id TEXT NOT NULL,      -- "D01-Q01"
  score INTEGER CHECK (score IN (0,25,50,75,100)),
  not_applicable INTEGER NOT NULL DEFAULT 0 CHECK (not_applicable IN (0,1)),
  na_justification TEXT,
  evidence_note TEXT,
  row_version INTEGER,
  base_version INTEGER,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (evaluation_id, question_id),
  CHECK (NOT (not_applicable = 1 AND score IS NOT NULL)),
  CHECK (not_applicable = 0 OR length(trim(coalesce(na_justification,''))) > 0)
);

-- Evidencia: solo se agrega; nunca se modifica ni se borra físicamente.
CREATE TABLE IF NOT EXISTS evidence_file (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES evaluation(id),
  question_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('photo','document','audio_note')),
  local_path TEXT NOT NULL,       -- archivo cifrado en el almacenamiento de la app
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT,                    -- quién o qué documento lo respalda
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  uploaded_at TEXT,               -- null = falta subirlo
  withdrawn INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER IF NOT EXISTS evidence_file_no_delete BEFORE DELETE ON evidence_file
BEGIN SELECT RAISE(ABORT, 'La evidencia no se borra; se marca como retirada'); END;
CREATE TRIGGER IF NOT EXISTS evidence_file_immutable BEFORE UPDATE OF sha256, local_path, bytes, evaluation_id ON evidence_file
BEGIN SELECT RAISE(ABORT, 'La evidencia no se modifica'); END;

CREATE TABLE IF NOT EXISTS action_item (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES evaluation(id),
  question_id TEXT,
  description TEXT NOT NULL,
  impact INTEGER CHECK (impact BETWEEN 1 AND 5),
  effort INTEGER CHECK (effort BETWEEN 1 AND 5),
  owner TEXT,
  due_on TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  row_version INTEGER,
  base_version INTEGER,
  updated_at TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

-- Cola de salida: cada cambio local deja una operación en la misma transacción.
-- Nada sale del dispositivo sin que el usuario confirme la sincronización.
CREATE TABLE IF NOT EXISTS outbox (
  op_id TEXT PRIMARY KEY,         -- idempotencia: el servidor ignora un op_id ya aplicado
  seq INTEGER NOT NULL UNIQUE,    -- orden de envío
  entity TEXT NOT NULL CHECK (entity IN ('evaluation','dimension_scope','answer','evidence_file','action_item')),
  entity_key TEXT NOT NULL,       -- id o clave compuesta "evalId|D01-Q01"
  op TEXT NOT NULL CHECK (op IN ('upsert','delete','close')),
  payload TEXT NOT NULL,          -- JSON con el estado completo de la fila
  base_version INTEGER,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','rejected','conflict')),
  attempts INTEGER NOT NULL DEFAULT 0,
  result TEXT                     -- motivo del rechazo o versión del servidor en conflicto
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, seq);

CREATE TABLE IF NOT EXISTS sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  server_cursor TEXT,
  last_sync_at TEXT,
  last_sync_user TEXT,
  device_id TEXT NOT NULL
);

-- Bitácora local; se sube con la sincronización y no se edita.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT,
  entity_key TEXT,
  detail TEXT
);
CREATE TRIGGER IF NOT EXISTS audit_log_append_only BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'La bitácora no se edita'); END;
