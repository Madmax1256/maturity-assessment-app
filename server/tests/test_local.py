"""Modo local: usuario y clave en el portal, tablets vinculadas con código, sin Entra ID."""

import uuid

import psycopg
import pytest
from fastapi.testclient import TestClient

from app import local_auth as la
from app.admin_cli import create_admin
from app.config import Settings
from app.main import create_app
from tests.conftest import DB_URL, TABLES

PW = "clave-segura-1"


@pytest.fixture(scope="module")
def _local(tmp_path_factory):
    portal = tmp_path_factory.mktemp("portal")
    (portal / "index.html").write_text("<!doctype html><title>Portal</title>", encoding="utf-8")
    s = Settings(database_url=DB_URL, auth_mode="local", blob_dir=tmp_path_factory.mktemp("blobs"), portal_dir=portal)
    with TestClient(create_app(s)) as c:
        yield c


@pytest.fixture()
def c(_local):
    with psycopg.connect(DB_URL, autocommit=True) as conn:
        conn.execute(f"TRUNCATE {TABLES}")
    create_admin(DB_URL, "max", "Max", PW)
    _local.app.state.throttle.reset()
    return _local


def login(c, user, pw):
    r = c.post("/v1/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200, r.text
    return {"authorization": f"Bearer {r.json()['token']}"}, r.json()


def make_user(c, admin, username="ana", role="evaluador", pw="temporal-123"):
    r = c.post("/v1/admin/users", json={"name": username.title(), "username": username, "password": pw, "role": role}, headers=admin)
    assert r.status_code == 201, r.text


def pair(c, admin, user, device):
    code = c.post(f"/v1/admin/users/{user}/pairing-code", headers=admin).json()["code"]
    r = c.post("/v1/auth/pair", json={"code": code.lower().replace("-", " "), "deviceId": device, "deviceModel": "SM-X210", "appVersion": "0.5.0"})
    assert r.status_code == 200, r.text
    return {"authorization": f"Bearer {r.json()['token']}"}, r.json()


def test_admin_signs_in_and_portal_is_served(c):
    assert c.get("/v1/auth/config").json() == {"mode": "local"}
    assert "Portal" in c.get("/").text
    h, body = login(c, "MAX", PW)
    assert body["mustChangePassword"] is False
    me = c.get("/v1/me", headers=h).json()
    assert me["role"] == "administrador" and me["authMode"] == "local"
    # Los tokens de desarrollo no sirven en modo local.
    assert c.get("/v1/me", headers={"authorization": "Bearer dev:max"}).status_code == 401


def test_wrong_password_and_lockout(c):
    for _ in range(la.MAX_FAILS):
        assert c.post("/v1/auth/login", json={"username": "max", "password": "otra-clave-x"}).status_code == 401
    assert c.post("/v1/auth/login", json={"username": "max", "password": PW}).status_code == 429
    with psycopg.connect(DB_URL) as conn:
        n = conn.execute("SELECT count(*) FROM audit_log WHERE action = 'auth.login_failed'").fetchone()[0]
    assert n == la.MAX_FAILS


def test_new_person_must_change_temporary_password(c):
    admin, _ = login(c, "max", PW)
    assert c.post("/v1/admin/users", json={"name": "Ana", "username": "ana", "password": "corta", "role": "evaluador"}, headers=admin).status_code == 400
    make_user(c, admin)
    assert c.post("/v1/admin/users", json={"name": "Ana 2", "username": "ANA", "password": "temporal-123", "role": "evaluador"}, headers=admin).status_code == 409
    h, body = login(c, "ana", "temporal-123")
    assert body["mustChangePassword"] is True
    assert c.get("/v1/me", headers=h).json()["mustChangePassword"] is True
    assert c.post("/v1/admin/users/ana/pairing-code", headers=h).status_code == 403
    assert c.get("/v1/evaluations", headers=h).status_code == 403
    assert c.post("/v1/me/password", json={"current": "mala-clave-00", "password": "nueva-clave-ana"}, headers=h).status_code == 400
    assert c.post("/v1/me/password", json={"current": "temporal-123", "password": "nueva-clave-ana"}, headers=h).status_code == 200
    assert c.get("/v1/evaluations", headers=h).status_code == 200
    assert c.post("/v1/auth/login", json={"username": "ana", "password": "temporal-123"}).status_code == 401
    login(c, "ana", "nueva-clave-ana")


def test_reset_password_closes_sessions(c):
    admin, _ = login(c, "max", PW)
    make_user(c, admin)
    h, _ = login(c, "ana", "temporal-123")
    assert c.post("/v1/admin/users/ana/password", json={"password": "otra-temporal-1"}, headers=admin).status_code == 200
    assert c.get("/v1/me", headers=h).status_code == 401
    _, body = login(c, "ana", "otra-temporal-1")
    assert body["mustChangePassword"] is True


def test_tablet_pairs_with_one_time_code_and_syncs(c):
    admin, _ = login(c, "max", PW)
    make_user(c, admin)
    th, body = pair(c, admin, "ana", "tab-1")
    assert body["user"] == {"id": "ana", "name": "Ana", "role": "evaluador"}
    ev = uuid.uuid4().hex
    op = {"opId": uuid.uuid4().hex, "seq": 1, "entity": "evaluation", "entityKey": ev, "op": "upsert", "baseVersion": None,
          "payload": {"id": ev, "modelId": "V01", "company": "Minera", "evaluatedOn": "2026-10-08", "interviewees": []}}
    r = c.post("/v1/sync/push", json={"deviceId": "tab-1", "ops": [op]}, headers=th)
    assert r.status_code == 200 and r.json()["results"][0]["status"] == "accepted"
    assert c.get("/v1/evaluations", headers=admin).json()[0]["owner_user_id"] == "ana"
    # El token sirve solo para su tablet.
    assert c.post("/v1/sync/push", json={"deviceId": "tab-2", "ops": []}, headers=th).status_code == 403
    dev = c.get("/v1/admin/devices", headers=admin).json()[0]
    assert dev["model"] == "SM-X210" and dev["app_version"] == "0.5.0" and dev["last_user_id"] == "ana"


def test_pairing_code_is_single_use(c):
    admin, _ = login(c, "max", PW)
    make_user(c, admin)
    code = c.post("/v1/admin/users/ana/pairing-code", headers=admin).json()["code"]
    assert len(code) == 9 and code[4] == "-"
    assert c.post("/v1/auth/pair", json={"code": code, "deviceId": "tab-1"}).status_code == 200
    assert c.post("/v1/auth/pair", json={"code": code, "deviceId": "tab-2"}).status_code == 400
    assert c.post("/v1/auth/pair", json={"code": "AAAA-BBBB", "deviceId": "tab-3"}).status_code == 400
    with psycopg.connect(DB_URL) as conn:
        conn.execute("UPDATE pairing_code SET expires_at = now() - interval '1 minute'")
        conn.commit()
    code2 = c.post("/v1/admin/users/ana/pairing-code", headers=admin).json()["code"]
    with psycopg.connect(DB_URL) as conn:
        conn.execute("UPDATE pairing_code SET expires_at = now() - interval '1 minute' WHERE used_at IS NULL")
        conn.commit()
    assert c.post("/v1/auth/pair", json={"code": code2, "deviceId": "tab-4"}).status_code == 400


def test_revoking_tablet_or_person_stops_the_token(c):
    admin, _ = login(c, "max", PW)
    make_user(c, admin)
    make_user(c, admin, "luis")
    th, _ = pair(c, admin, "ana", "tab-1")
    assert c.post("/v1/admin/devices/tab-1/revoke", headers=admin).status_code == 200
    r = c.post("/v1/sync/push", json={"deviceId": "tab-1", "ops": []}, headers=th)
    assert r.status_code == 403 and "desvinculada" in r.json()["detail"]
    # Un código nuevo vuelve a habilitar la tablet.
    th2, _ = pair(c, admin, "ana", "tab-1")
    assert c.post("/v1/sync/push", json={"deviceId": "tab-1", "ops": []}, headers=th2).status_code == 200
    lh, _ = pair(c, admin, "luis", "tab-2")
    assert c.patch("/v1/admin/users/luis", json={"status": "disabled"}, headers=admin).status_code == 200
    assert c.post("/v1/sync/push", json={"deviceId": "tab-2", "ops": []}, headers=lh).status_code == 403
    assert c.post("/v1/admin/users/luis/pairing-code", headers=admin).status_code == 400


def test_logout_and_admin_only(c):
    admin, _ = login(c, "max", PW)
    make_user(c, admin)
    c.post("/v1/me/password", json={"current": "temporal-123", "password": "nueva-clave-ana"}, headers=login(c, "ana", "temporal-123")[0])
    h, _ = login(c, "ana", "nueva-clave-ana")
    assert c.post("/v1/admin/users/max/pairing-code", headers=h).status_code == 403
    assert c.post("/v1/auth/logout", headers=h).status_code == 200
    assert c.get("/v1/me", headers=h).status_code == 401


def test_console_reset_keeps_history(c):
    create_admin(DB_URL, "max", "Max", "clave-nueva-22")
    assert c.post("/v1/auth/login", json={"username": "max", "password": PW}).status_code == 401
    login(c, "max", "clave-nueva-22")
    with pytest.raises(ValueError):
        create_admin(DB_URL, "max", "Max", "corta")
