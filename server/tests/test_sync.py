import hashlib
import json
from pathlib import Path

import pytest

from app.config import Settings
from app.auth import Authenticator
from tests.conftest import Tablet

CATALOG = json.loads((Path(__file__).resolve().parents[2] / "packages/model/catalog/v01.json").read_text(encoding="utf-8"))
QUESTIONS = [(q["id"], q["dimension"]) for q in CATALOG["questions"]]
DIMS = [d["code"] for d in CATALOG["dimensions"]]


def statuses(results):
    return [r["status"] for r in results]


def test_health_and_auth(client):
    assert client.get("/health").json()["models"] == ["V01"]
    assert client.get("/v1/evaluations").status_code == 401
    assert client.get("/v1/evaluations", headers={"authorization": "Bearer otra-cosa"}).status_code == 401
    assert client.get("/v1/evaluations", headers={"authorization": "Bearer dev:ana"}).json() == []
    assert client.get("/v1/models/V01", headers={"authorization": "Bearer dev:ana"}).json()["id"] == "V01"


def test_entra_mode_requires_tenant_and_audience():
    with pytest.raises(RuntimeError):
        Authenticator(Settings(auth_mode="entra", entra_tenant_id="", entra_audience=""))


def test_push_creates_evaluation_and_answers(client):
    t = Tablet(client)
    ev, create = t.new_eval()
    res = t.push(create, t.scope(ev, "D1"), t.answer(ev, "D01-Q01", 75, note="Procedimiento vigente"))
    assert statuses(res) == ["accepted"] * 3
    versions = [r["rowVersion"] for r in res]
    assert versions == sorted(versions) and len(set(versions)) == 3
    detail = client.get(f"/v1/evaluations/{ev}", headers=t.h).json()
    assert detail["evaluation"]["owner_user_id"] == "ana"
    assert detail["answers"][0]["score"] == 75 and detail["answers"][0]["evidence_note"] == "Procedimiento vigente"
    assert client.get("/v1/evaluations", headers=t.h).json()[0]["answered"] == 1


def test_replayed_op_is_applied_once(client):
    t = Tablet(client)
    ev, create = t.new_eval()
    a = t.answer(ev, "D01-Q01", 50)
    first = t.push(create, a)
    again = t.push(create, a)
    assert again == first
    assert client.get(f"/v1/evaluations/{ev}", headers=t.h).json()["answers"][0]["score"] == 50


def test_consecutive_changes_from_same_tablet_do_not_conflict(client):
    t = Tablet(client)
    ev, create = t.new_eval()
    # Tres cambios offline sobre la misma pregunta, todos con base null (como los deja la tablet).
    res = t.push(create, t.answer(ev, "D01-Q01", 25), t.answer(ev, "D01-Q01", 50), t.answer(ev, "D01-Q01", 100))
    assert statuses(res) == ["accepted"] * 4
    assert client.get(f"/v1/evaluations/{ev}", headers=t.h).json()["answers"][0]["score"] == 100


def test_change_from_another_device_is_a_conflict_until_owner_decides(client):
    t1 = Tablet(client, device="tablet-1")
    ev, create = t1.new_eval()
    [_, acc] = t1.push(create, t1.answer(ev, "D01-Q01", 25))
    t2 = Tablet(client, device="tablet-2")
    [conf] = t2.push(t2.answer(ev, "D01-Q01", 75, base=None))
    assert conf["status"] == "conflict"
    assert conf["server"]["score"] == 25 and conf["server"]["rowVersion"] == acc["rowVersion"]
    # El propietario mantiene su versión: se reenvía sobre la versión del servidor.
    [ok] = t2.push(t2.answer(ev, "D01-Q01", 75, base=conf["server"]["rowVersion"]))
    assert ok["status"] == "accepted"
    assert client.get(f"/v1/evaluations/{ev}", headers=t1.h).json()["answers"][0]["score"] == 75


def test_only_owner_can_modify(client):
    ana = Tablet(client, "ana")
    ev, create = ana.new_eval()
    ana.push(create)
    luis = Tablet(client, "luis")
    [r] = luis.push(luis.answer(ev, "D01-Q01", 100))
    assert r["status"] == "rejected" and "propietario" in r["reason"]
    assert client.get(f"/v1/evaluations/{ev}", headers=luis.h).status_code == 404


def test_invalid_ops_are_rejected_without_stopping_the_batch(client):
    t = Tablet(client)
    ev, create = t.new_eval()
    res = t.push(create,
                 t.answer(ev, "D01-Q01", 30),
                 t.answer(ev, "D99-Q01", 50),
                 t.answer(ev, "D01-Q02", na="   "),
                 t.scope(ev, "D3", applies=False),
                 t.answer(ev, "D01-Q03", na="No hay contratistas"))
    assert statuses(res) == ["accepted", "rejected", "rejected", "rejected", "rejected", "accepted"]
    bad_model = t.new_eval(modelId="V99")[1]
    assert t.push(bad_model)[0]["status"] == "rejected"


def test_evidence_requires_uploaded_file(client):
    t = Tablet(client)
    ev, create = t.new_eval()
    t.push(create)
    data = b"\x89PNG foto de terreno"
    sha = hashlib.sha256(data).hexdigest()
    ev_op = t.op("evidence_file", "f1", {"id": "f1", "evaluationId": ev, "questionId": "D01-Q01", "kind": "photo", "mime": "image/png", "bytes": len(data), "sha256": sha})
    [r] = t.push(ev_op)
    assert r["status"] == "rejected" and "subido" in r["reason"]
    assert client.post("/v1/files/missing", json={"sha256": [sha]}, headers=t.h).json() == {"missing": [sha]}
    assert client.put(f"/v1/files/{sha}", content=b"otra cosa", headers={**t.h, "content-type": "image/png"}).status_code == 422
    assert client.put(f"/v1/files/{sha}", content=data, headers={**t.h, "content-type": "image/png"}).status_code == 201
    assert client.put(f"/v1/files/{sha}", content=data, headers={**t.h, "content-type": "image/png"}).status_code == 201
    assert client.post("/v1/files/missing", json={"sha256": [sha]}, headers=t.h).json() == {"missing": []}
    # Rechazos no quedan registrados: el mismo op_id se acepta una vez subido el archivo.
    [r] = t.push(ev_op)
    assert r["status"] == "accepted"
    got = client.get(f"/v1/files/{sha}", headers=t.h)
    assert got.status_code == 200 and got.content == data and got.headers["content-type"] == "image/png"
    assert client.get(f"/v1/files/{sha}", headers={"authorization": "Bearer dev:luis"}).status_code == 404


def test_close_requires_complete_evaluation_and_then_is_read_only(client):
    t = Tablet(client)
    ev, create = t.new_eval()
    t.push(create)
    [r] = t.push(t.op("evaluation", ev, {"id": ev, "closedAt": "2026-10-08T12:00:00Z"}, op="close"))
    assert r["status"] == "rejected" and "define si D1 aplica" in r["reason"]
    ops = [t.scope(ev, d, applies=d != "D12", just=None if d != "D12" else "Sin investigaciones en el periodo") for d in DIMS]
    ops += [t.answer(ev, q, 100) for q, d in QUESTIONS if d != "D12"]
    assert set(statuses(t.push(*ops))) == {"accepted"}
    [closed] = t.push(t.op("evaluation", ev, {"id": ev, "closedAt": "2026-10-08T12:00:00Z"}, op="close"))
    assert closed["status"] == "accepted"
    [again] = t.push(t.op("evaluation", ev, {"id": ev}, op="close"))
    assert again["status"] == "accepted" and again["rowVersion"] == closed["rowVersion"]
    [edit] = t.push(t.answer(ev, "D01-Q01", 0))
    assert edit["status"] == "rejected" and "cerrada" in edit["reason"]
    # El plan de acción sigue editable después del cierre.
    [act] = t.push(t.op("action_item", "a1", {"id": "a1", "evaluationId": ev, "questionId": "D01-Q01", "description": "Capacitar supervisores", "impact": 5, "effort": 2}))
    assert act["status"] == "accepted"
    [bad] = t.push(t.op("action_item", "a2", {"id": "a2", "evaluationId": ev, "questionId": None, "description": "x", "impact": 9, "effort": 2}))
    assert bad["status"] == "rejected"
    detail = client.get(f"/v1/evaluations/{ev}", headers=t.h).json()
    assert detail["evaluation"]["status"] == "closed" and detail["actions"][0]["impact"] == 5


def test_audit_log_is_received_once(client):
    t = Tablet(client)
    entry = {"id": "aud-1", "at": "2026-10-08T10:00:00Z", "action": "answer.score", "entity": "answer", "entityKey": "x|D01-Q01", "detail": {"score": 75}}
    r1 = client.post("/v1/sync/push", json={"deviceId": t.device, "ops": [], "audit": [entry]}, headers=t.h)
    r2 = client.post("/v1/sync/push", json={"deviceId": t.device, "ops": [], "audit": [entry]}, headers=t.h)
    assert r1.status_code == r2.status_code == 200
    import psycopg
    from tests.conftest import DB_URL
    with psycopg.connect(DB_URL) as conn:
        assert conn.execute("SELECT count(*) FROM audit_log WHERE id = 'aud-1'").fetchone()[0] == 1
        with pytest.raises(psycopg.errors.RaiseException):
            conn.execute("DELETE FROM audit_log")


def test_batch_size_is_limited(client):
    t = Tablet(client)
    ops = [t.answer("x", "D01-Q01", 0) for _ in range(501)]
    r = client.post("/v1/sync/push", json={"deviceId": t.device, "ops": ops}, headers=t.h)
    assert r.status_code == 413
