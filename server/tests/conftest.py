import os
import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app

DB_URL = os.environ.get("FS_TEST_DATABASE_URL", "postgresql://postgres@localhost:5432/fs_test")
TABLES = "applied_op, audit_log, action_item, evidence_file, blob_object, answer, dimension_scope, evaluation, device, app_user"


@pytest.fixture(scope="session")
def app(tmp_path_factory):
    s = Settings(database_url=DB_URL, auth_mode="dev", blob_dir=tmp_path_factory.mktemp("blobs"),
                 bootstrap_admins=["admin"], auto_enroll_role="evaluador")
    return create_app(s)


@pytest.fixture(scope="session")
def _client(app):
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def client(_client):
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        conn.execute(f"TRUNCATE {TABLES}")
    return _client


class Tablet:
    """Simula una tablet: arma operaciones como las deja la cola de salida de @fs/db."""

    def __init__(self, client, user="ana", device=None):
        self.c, self.user, self.device, self.seq = client, user, device or f"dev-{uuid.uuid4().hex[:8]}", 0
        self.h = {"authorization": f"Bearer dev:{user}"}

    def op(self, entity, key, payload, op="upsert", base=None, op_id=None):
        self.seq += 1
        return {"opId": op_id or uuid.uuid4().hex, "seq": self.seq, "entity": entity, "entityKey": key, "op": op, "payload": payload, "baseVersion": base}

    def push(self, *ops, audit=()):
        r = self.c.post("/v1/sync/push", json={"deviceId": self.device, "ops": list(ops), "audit": list(audit)}, headers=self.h)
        assert r.status_code == 200, r.text
        return r.json()["results"]

    def new_eval(self, ev_id=None, **kw):
        ev_id = ev_id or uuid.uuid4().hex
        p = {"id": ev_id, "modelId": "V01", "company": "Minera Prueba", "site": "Norte", "evaluatedOn": "2026-10-08", "interviewees": ["Jefe de turno"], **kw}
        return ev_id, self.op("evaluation", ev_id, p)

    def answer(self, ev_id, q, score=None, na=None, note=None, base=None):
        return self.op("answer", f"{ev_id}|{q}", {"evaluationId": ev_id, "questionId": q, "score": score, "notApplicable": na is not None,
                                                   "naJustification": na, "evidenceNote": note}, base=base)

    def scope(self, ev_id, d, applies=True, just=None):
        return self.op("dimension_scope", f"{ev_id}|{d}", {"evaluationId": ev_id, "dimension": d, "applies": applies, "justification": just})
