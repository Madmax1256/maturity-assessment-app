-- Base central (PostgreSQL). Recibe lo que cada tablet envía cuando el evaluador confirma la
-- sincronización. row_version es global y creciente: lo asigna el servidor en cada cambio.
-- Sección 7 de la especificación.

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE SEQUENCE IF NOT EXISTS row_version_seq;

CREATE TABLE IF NOT EXISTS app_user (
  id TEXT PRIMARY KEY,               -- oid de Entra ID (o usuario de desarrollo)
  name TEXT,
  email TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device (
  id TEXT PRIMARY KEY,               -- device_id generado por la tablet
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sync_at TIMESTAMPTZ,
  last_user_id TEXT REFERENCES app_user(id)
);

CREATE TABLE IF NOT EXISTS evaluation (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  company TEXT NOT NULL,
  site TEXT,
  evaluated_on DATE NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES app_user(id),
  interviewees JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','closed')),
  closed_at TIMESTAMPTZ,
  row_version BIGINT NOT NULL,
  last_device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dimension_scope (
  evaluation_id TEXT NOT NULL REFERENCES evaluation(id),
  dimension TEXT NOT NULL,
  applies BOOLEAN NOT NULL,
  justification TEXT,
  row_version BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (evaluation_id, dimension),
  CHECK (applies OR length(trim(coalesce(justification, ''))) > 0)
);

CREATE TABLE IF NOT EXISTS answer (
  evaluation_id TEXT NOT NULL REFERENCES evaluation(id),
  question_id TEXT NOT NULL,
  score SMALLINT CHECK (score IN (0,25,50,75,100)),
  not_applicable BOOLEAN NOT NULL DEFAULT false,
  na_justification TEXT,
  evidence_note TEXT,
  row_version BIGINT NOT NULL,
  last_device_id TEXT,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (evaluation_id, question_id),
  CHECK (NOT (not_applicable AND score IS NOT NULL)),
  CHECK (NOT not_applicable OR length(trim(coalesce(na_justification, ''))) > 0)
);

-- Evidencia: solo se agrega. El archivo se sube antes que su registro y se verifica por sha256.
CREATE TABLE IF NOT EXISTS evidence_file (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES evaluation(id),
  question_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('photo','document','audio_note')),
  mime TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT,
  created_by TEXT NOT NULL,
  row_version BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn BOOLEAN NOT NULL DEFAULT false
);
CREATE OR REPLACE FUNCTION evidence_file_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'La evidencia no se borra; se marca como retirada'; END IF;
  IF NEW.sha256 <> OLD.sha256 OR NEW.bytes <> OLD.bytes OR NEW.evaluation_id <> OLD.evaluation_id THEN
    RAISE EXCEPTION 'La evidencia no se modifica';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS evidence_file_guard ON evidence_file;
CREATE TRIGGER evidence_file_guard BEFORE UPDATE OR DELETE ON evidence_file FOR EACH ROW EXECUTE FUNCTION evidence_file_guard();

-- Archivos recibidos, direccionados por contenido. Un mismo archivo enviado dos veces se guarda una vez.
CREATE TABLE IF NOT EXISTS blob_object (
  sha256 TEXT PRIMARY KEY,
  bytes BIGINT NOT NULL,
  mime TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_item (
  id TEXT PRIMARY KEY,
  evaluation_id TEXT NOT NULL REFERENCES evaluation(id),
  question_id TEXT,
  description TEXT NOT NULL,
  impact SMALLINT CHECK (impact BETWEEN 1 AND 5),
  effort SMALLINT CHECK (effort BETWEEN 1 AND 5),
  owner TEXT,
  due_on DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled')),
  row_version BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotencia: cada op_id se aplica una sola vez; un reenvío recibe la misma respuesta.
CREATE TABLE IF NOT EXISTS applied_op (
  op_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  result JSONB NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bitácora: la de cada tablet más la del servidor. Solo se agrega.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL,
  user_id TEXT NOT NULL,
  device_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_key TEXT,
  detail JSONB,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'La bitácora no se edita'; END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS audit_log_guard ON audit_log;
CREATE TRIGGER audit_log_guard BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_guard();

INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;

-- Versión 2: roles y acceso (portal web), estado de las tablets.
-- Cada persona entra con su cuenta Microsoft; el rol y el acceso se administran aquí.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'evaluador';
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS invited_by TEXT;
DO $$ BEGIN
  ALTER TABLE app_user ADD CONSTRAINT app_user_role_chk CHECK (role IN ('administrador','supervisor','evaluador'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE app_user ADD CONSTRAINT app_user_status_chk CHECK (status IN ('active','invited','disabled'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS app_user_email ON app_user (lower(email)) WHERE email IS NOT NULL;

ALTER TABLE device ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE device ADD COLUMN IF NOT EXISTS app_version TEXT;
ALTER TABLE device ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE device ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
ALTER TABLE device ADD COLUMN IF NOT EXISTS revoked_by TEXT;
DO $$ BEGIN
  ALTER TABLE device ADD CONSTRAINT device_status_chk CHECK (status IN ('active','revoked'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;

-- Versión 3: modo local (FS_AUTH_MODE=local). Usuario y clave propios en lugar de Entra ID;
-- sesiones del portal y tokens de tablet. Solo se guardan hashes.
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE app_user ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS app_user_username ON app_user (lower(username)) WHERE username IS NOT NULL;

CREATE TABLE IF NOT EXISTS auth_token (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('web', 'device')),
  device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_token_user ON auth_token (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS pairing_code (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  device_id TEXT
);

INSERT INTO schema_migrations (version) VALUES (3) ON CONFLICT DO NOTHING;
