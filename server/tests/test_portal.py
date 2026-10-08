"""Roles, acceso y consultas del portal web."""

import psycopg
import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from tests.conftest import DB_URL, TABLES, Tablet

H = lambda u: {"authorization": f"Bearer dev:{u}"}  # noqa: E731


def test_roles_decide_what_each_person_sees(client):
    ana, luis = Tablet(client, "ana"), Tablet(client, "luis")
    ev_a, c_a = ana.new_eval(company="Minera A")
    ev_l, c_l = luis.new_eval(company="Puerto L")
    ana.push(c_a, ana.answer(ev_a, "D01-Q01", 75))
    luis.push(c_l)
    assert [e["company"] for e in client.get("/v1/evaluations", headers=H("ana")).json()] == ["Minera A"]
    assert client.get(f"/v1/evaluations/{ev_l}", headers=H("ana")).status_code == 404
    assert client.get("/v1/me", headers=H("admin")).json()["role"] == "administrador"
    every = client.get("/v1/evaluations?scores=true", headers=H("admin")).json()
    assert {e["company"] for e in every} == {"Minera A", "Puerto L"}
    a = next(e for e in every if e["id"] == ev_a)
    assert a["owner_name"] == "ana" and a["answers"] == [{"question_id": "D01-Q01", "score": 75, "not_applicable": False}]
    assert client.get(f"/v1/evaluations/{ev_l}", headers=H("admin")).status_code == 200
    # Un evaluador no entra a administración.
    assert client.get("/v1/admin/users", headers=H("ana")).status_code == 403


def test_supervisor_sees_all_but_cannot_administer(client):
    client.get("/v1/me", headers=H("sofia"))
    sofia_id = "sofia"
    assert client.patch(f"/v1/admin/users/{sofia_id}", json={"role": "supervisor"}, headers=H("admin")).status_code == 200
    ana = Tablet(client, "ana")
    ev, c = ana.new_eval()
    ana.push(c)
    assert len(client.get("/v1/evaluations", headers=H("sofia")).json()) == 1
    assert client.get("/v1/admin/devices", headers=H("sofia")).status_code == 403


def test_invitation_becomes_the_account_on_first_login(client):
    r = client.post("/v1/admin/users", json={"name": "Carla Rojas", "email": "carla", "role": "supervisor"}, headers=H("admin"))
    assert r.status_code == 422  # correo inválido
    r = client.post("/v1/admin/users", json={"name": "Carla Rojas", "email": "carla@vantaz.cl", "role": "supervisor"}, headers=H("admin"))
    assert r.status_code == 201
    assert client.post("/v1/admin/users", json={"name": "Otra", "email": "CARLA@vantaz.cl", "role": "evaluador"}, headers=H("admin")).status_code == 409
    users = client.get("/v1/admin/users", headers=H("admin")).json()
    assert next(u for u in users if u["email"] == "carla@vantaz.cl")["status"] == "invited"
    # En modo dev el correo del token es el propio usuario.
    me = client.get("/v1/me", headers=H("carla@vantaz.cl")).json()
    assert me == {"id": "carla@vantaz.cl", "name": "Carla Rojas", "email": "carla@vantaz.cl", "role": "supervisor"}


def test_disabled_person_cannot_enter_or_sync(client):
    ana = Tablet(client, "ana")
    ev, c = ana.new_eval()
    ana.push(c)
    assert client.patch("/v1/admin/users/ana", json={"status": "disabled"}, headers=H("admin")).status_code == 200
    assert client.get("/v1/me", headers=H("ana")).status_code == 403
    r = client.post("/v1/sync/push", json={"deviceId": ana.device, "ops": []}, headers=ana.h)
    assert r.status_code == 403
    assert client.patch("/v1/admin/users/admin", json={"status": "disabled"}, headers=H("admin")).status_code == 400


def test_revoked_tablet_cannot_sync(client):
    ana = Tablet(client, "ana", device="tab-perdida")
    ev, c = ana.new_eval()
    client.post("/v1/sync/push", json={"deviceId": ana.device, "appVersion": "0.4.0", "deviceModel": "Galaxy Tab S10 FE", "ops": [c]}, headers=ana.h)
    devs = client.get("/v1/admin/devices", headers=H("admin")).json()
    assert devs[0] | {"first_seen_at": None, "last_sync_at": None} == {
        "id": "tab-perdida", "model": "Galaxy Tab S10 FE", "app_version": "0.4.0", "status": "active", "first_seen_at": None,
        "last_sync_at": None, "revoked_at": None, "last_user_id": "ana", "last_user_name": "ana"}
    assert client.post("/v1/admin/devices/tab-perdida/revoke", headers=H("admin")).status_code == 200
    assert client.post("/v1/admin/devices/tab-perdida/revoke", headers=H("admin")).status_code == 404
    r = client.post("/v1/sync/push", json={"deviceId": "tab-perdida", "ops": [ana.answer(ev, "D01-Q01", 50)]}, headers=ana.h)
    assert r.status_code == 403 and "tablet" in r.json()["detail"]


def test_audit_log_records_admin_actions_and_syncs(client):
    ana = Tablet(client, "ana")
    ev, c = ana.new_eval()
    ana.push(c)
    client.post("/v1/admin/users", json={"name": "Pedro", "email": "pedro@vantaz.cl", "role": "evaluador"}, headers=H("admin"))
    log = client.get("/v1/admin/audit?limit=50", headers=H("admin")).json()
    actions = [x["action"] for x in log]
    assert "user.invite" in actions and "sync.push" in actions and "user.enrolled" in actions
    push = next(x for x in log if x["action"] == "sync.push")
    assert push["user_name"] == "ana" and push["detail"] == {"accepted": 1, "rejected": 0, "conflict": 0}


def test_models_list_counts_evaluations(client):
    ana = Tablet(client, "ana")
    ana.push(ana.new_eval()[1])
    [m] = client.get("/v1/models", headers=H("ana")).json()
    assert m["id"] == "V01" and m["questions"] == 128 and m["dimensions"] == 12 and m["evaluations"] == 1


def test_without_invitation_there_is_no_access(tmp_path):
    s = Settings(database_url=DB_URL, auth_mode="dev", blob_dir=tmp_path, bootstrap_admins=["admin"])
    with TestClient(create_app(s)) as c:
        with psycopg.connect(DB_URL, autocommit=True) as conn:
            conn.execute(f"TRUNCATE {TABLES}")
        r = c.get("/v1/me", headers=H("desconocido"))
        assert r.status_code == 403 and "invitación" in r.json()["detail"]
        assert c.get("/v1/me", headers=H("admin")).json()["role"] == "administrador"
