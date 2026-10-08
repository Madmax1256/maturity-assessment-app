"""API de sincronización y consulta. Ejecutar desde server/: uvicorn app.main:create_app --factory"""

from __future__ import annotations

import hashlib
import mimetypes
import uuid
from pathlib import Path
import re
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

from .access import Account, audit, resolve_account
from . import local_auth as la
from .backup import start_scheduler
from .auth import Authenticator, User
from .catalog import load_catalogs
from .config import Settings
from .storage import LocalBlobStore
from .sync import Applier, Op

SHA_RE = re.compile(r"^[0-9a-f]{64}$")


class OpIn(BaseModel):
    opId: str = Field(min_length=1, max_length=64)
    seq: int
    entity: Literal["evaluation", "dimension_scope", "answer", "evidence_file", "action_item"]
    entityKey: str = Field(min_length=1, max_length=200)
    op: Literal["upsert", "delete", "close"]
    payload: dict[str, Any]
    baseVersion: int | None = None


class AuditIn(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    at: str
    action: str = Field(max_length=100)
    entity: str | None = None
    entityKey: str | None = None
    detail: Any = None


class MissingIn(BaseModel):
    sha256: list[str] = Field(max_length=1000)


class InviteIn(BaseModel):
    """Modo entra: invitación por correo. Modo local: usuario y clave inicial (la persona la cambia al entrar)."""
    name: str = Field(min_length=1, max_length=200)
    email: str | None = Field(default=None, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=200)
    username: str | None = Field(default=None, pattern=r"^[A-Za-z0-9._-]{3,40}$")
    password: str | None = Field(default=None, max_length=200)
    role: Literal["administrador", "supervisor", "evaluador"]


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)


class PairIn(BaseModel):
    code: str = Field(min_length=8, max_length=20)
    deviceId: str = Field(min_length=1, max_length=64)
    deviceModel: str | None = Field(default=None, max_length=120)
    appVersion: str | None = Field(default=None, max_length=40)


class PasswordIn(BaseModel):
    password: str = Field(min_length=1, max_length=200)
    current: str | None = Field(default=None, max_length=200)


class UserPatch(BaseModel):
    role: Literal["administrador", "supervisor", "evaluador"] | None = None
    status: Literal["active", "disabled"] | None = None


class PushIn(BaseModel):
    deviceId: str = Field(min_length=1, max_length=64)
    appVersion: str | None = Field(default=None, max_length=40)
    deviceModel: str | None = Field(default=None, max_length=120)
    ops: list[OpIn] = []
    audit: list[AuditIn] = []


def create_app(settings: Settings | None = None) -> FastAPI:
    s = settings or Settings()
    auth = Authenticator(s)
    catalogs = load_catalogs(s.catalog_dir)
    blobs = LocalBlobStore(s.blob_dir)
    pool = ConnectionPool(s.database_url, kwargs={"row_factory": dict_row}, open=False, min_size=1, max_size=10)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        pool.open(wait=True)
        with pool.connection() as conn:
            conn.execute((Path(__file__).parent / "schema.sql").read_text(encoding="utf-8"))
        stop = start_scheduler(s.database_url, s.blob_dir, s.backup_dir, s.backup_keep, s.pg_bin) if s.backup_dir else None
        yield
        if stop:
            stop.set()
        pool.close()

    app = FastAPI(title="Diagnóstico F&S: sincronización", version="0.5.1", lifespan=lifespan)
    # La app de la tablet (Capacitor) llama desde https://localhost; en modo local se permite por omisión.
    origins = s.cors_origins or (["https://localhost", "capacitor://localhost"] if s.auth_mode == "local" else [])
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
                           allow_headers=["authorization", "content-type"])
    app.state.pool, app.state.blobs = pool, blobs

    local = s.auth_mode == "local"
    throttle = app.state.throttle = la.LoginThrottle()
    # Con clave temporal, la sesión del portal solo sirve para cambiarla.
    TEMP_PASSWORD_PATHS = {"/v1/me", "/v1/me/password", "/v1/auth/logout"}

    def current_user(request: Request) -> Account:
        with pool.connection() as conn:
            if local:
                t = la.lookup_token(conn, auth.bearer(request))
                request.state.token = t
                u = User(id=t.user_id)
            else:
                request.state.token = None
                u = auth(request)
            a = resolve_account(conn, u, s)
        if local and a.must_change_password and t.kind == "web" and request.url.path not in TEMP_PASSWORD_PATHS:
            raise HTTPException(403, "Debes cambiar tu clave temporal antes de seguir.")
        return a

    def require_local() -> None:
        if not local:
            raise HTTPException(404, "Disponible solo en modo local")

    def revoke_tokens(conn, user_id: str, kind: str | None = None, keep: str | None = None) -> None:
        conn.execute("""UPDATE auth_token SET revoked_at = now() WHERE user_id = %s AND revoked_at IS NULL
                        AND (%s::text IS NULL OR kind = %s) AND (%s::text IS NULL OR token_hash <> %s)""",
                     (user_id, kind, kind, keep, keep))

    def admin_user(a: Account = Depends(current_user)) -> Account:
        if not a.is_admin:
            raise HTTPException(403, "Solo un administrador puede hacer esto")
        return a

    def visible(a: Account, alias: str = "e") -> tuple[str, tuple]:
        return ("TRUE", ()) if a.sees_all else (f"{alias}.owner_user_id = %s", (a.id,))

    @app.get("/health")
    def health():
        with pool.connection() as conn:
            conn.execute("SELECT 1")
        return {"ok": True, "models": sorted(catalogs)}

    # ---------- inicio de sesión en modo local ----------

    @app.get("/v1/auth/config")
    def auth_config():
        return {"mode": s.auth_mode}

    @app.post("/v1/auth/login")
    def login(body: LoginIn, request: Request):
        require_local()
        name = body.username.strip().lower()
        throttle.check(name)
        with pool.connection() as conn:
            row = conn.execute("SELECT id, status, password_hash, must_change_password FROM app_user WHERE lower(username) = %s",
                               (name,)).fetchone()
            ok = la.verify_password(body.password, row["password_hash"] if row else None) and row["status"] == "active"
            if not ok:
                throttle.fail(name)
                audit(conn, row["id"] if row else name, "auth.login_failed", "app_user", row["id"] if row else None,
                      {"ip": request.client.host if request.client else None})
        if not ok:
            raise HTTPException(401, "Usuario o clave incorrectos")
        throttle.ok(name)
        with pool.connection() as conn:
            token = la.new_token()
            conn.execute("INSERT INTO auth_token (token_hash, user_id, kind, expires_at) VALUES (%s, %s, 'web', now() + make_interval(hours => %s))",
                         (la.token_hash(token), row["id"], la.WEB_SESSION_HOURS))
            audit(conn, row["id"], "auth.login", "app_user", row["id"])
        return {"token": token, "mustChangePassword": row["must_change_password"]}

    @app.post("/v1/auth/logout")
    def logout(request: Request, user: Account = Depends(current_user)):
        require_local()
        with pool.connection() as conn:
            conn.execute("UPDATE auth_token SET revoked_at = now() WHERE token_hash = %s", (la.token_hash(auth.bearer(request)),))
        return {"ok": True}

    @app.post("/v1/auth/pair")
    def pair(body: PairIn, request: Request):
        """La tablet canjea el código de un solo uso por su propio token."""
        require_local()
        key = "pair:" + (request.client.host if request.client else "?")
        throttle.check(key)
        code = la.normalize_code(body.code)
        with pool.connection() as conn:
            pc = conn.execute("""SELECT p.user_id, u.name, u.role, u.status FROM pairing_code p JOIN app_user u ON u.id = p.user_id
                                 WHERE p.code_hash = %s AND p.used_at IS NULL AND p.expires_at > now() FOR UPDATE OF p""",
                              (la.token_hash(code),)).fetchone()
            if not pc or pc["status"] != "active":
                throttle.fail(key)
                raise HTTPException(400, "El código no es válido o ya venció. Pide uno nuevo al administrador.")
            throttle.ok(key)
            conn.execute("UPDATE pairing_code SET used_at = now(), device_id = %s WHERE code_hash = %s", (body.deviceId, la.token_hash(code)))
            conn.execute("""INSERT INTO device (id, last_user_id, app_version, model) VALUES (%s, %s, %s, %s)
                            ON CONFLICT (id) DO UPDATE SET status = 'active', revoked_at = NULL, revoked_by = NULL,
                            last_user_id = excluded.last_user_id, app_version = coalesce(excluded.app_version, device.app_version),
                            model = coalesce(excluded.model, device.model)""",
                         (body.deviceId, pc["user_id"], body.appVersion, body.deviceModel))
            conn.execute("UPDATE auth_token SET revoked_at = now() WHERE device_id = %s AND revoked_at IS NULL", (body.deviceId,))
            token = la.new_token()
            conn.execute("INSERT INTO auth_token (token_hash, user_id, kind, device_id) VALUES (%s, %s, 'device', %s)",
                         (la.token_hash(token), pc["user_id"], body.deviceId))
            audit(conn, pc["user_id"], "device.pair", "device", body.deviceId, {"model": body.deviceModel})
        return {"token": token, "user": {"id": pc["user_id"], "name": pc["name"], "role": pc["role"]}}

    @app.post("/v1/me/password")
    def change_password(body: PasswordIn, request: Request, user: Account = Depends(current_user)):
        require_local()
        la.check_password_policy(body.password)
        with pool.connection() as conn:
            row = conn.execute("SELECT password_hash FROM app_user WHERE id = %s", (user.id,)).fetchone()
            if not la.verify_password(body.current or "", row["password_hash"]):
                raise HTTPException(400, "La clave actual no es correcta")
            if body.password == body.current:
                raise HTTPException(400, "La clave nueva debe ser distinta de la actual")
            conn.execute("UPDATE app_user SET password_hash = %s, must_change_password = false WHERE id = %s",
                         (la.hash_password(body.password), user.id))
            revoke_tokens(conn, user.id, "web", keep=la.token_hash(auth.bearer(request)))
            audit(conn, user.id, "auth.password_changed", "app_user", user.id)
        return {"ok": True}

    @app.get("/v1/models/{model_id}")
    def model(model_id: str, _: Account = Depends(current_user)):
        c = catalogs.get(model_id)
        if not c:
            raise HTTPException(404, "Modelo desconocido")
        return c.raw

    # ---------- archivos de evidencia ----------

    @app.post("/v1/files/missing")
    def files_missing(body: MissingIn, _: Account = Depends(current_user)):
        """De una lista de huellas sha256, cuáles faltan en el servidor (para no subir dos veces)."""
        with pool.connection() as conn:
            have = {r["sha256"] for r in conn.execute("SELECT sha256 FROM blob_object WHERE sha256 = ANY(%s)", (body.sha256,))}
        return {"missing": [x for x in body.sha256 if x not in have or not blobs.exists(x)]}

    @app.put("/v1/files/{sha256}", status_code=201)
    async def upload(sha256: str, request: Request, user: Account = Depends(current_user)):
        if not SHA_RE.match(sha256):
            raise HTTPException(400, "Identificador de archivo inválido")
        limit = s.max_file_mb * 1024 * 1024
        if int(request.headers.get("content-length") or 0) > limit:
            raise HTTPException(413, f"El archivo supera {s.max_file_mb} MB")
        data = bytearray()
        async for chunk in request.stream():
            data += chunk
            if len(data) > limit:
                raise HTTPException(413, f"El archivo supera {s.max_file_mb} MB")
        if hashlib.sha256(data).hexdigest() != sha256:
            raise HTTPException(422, "El contenido no coincide con su huella sha256")
        blobs.put(sha256, bytes(data))
        with pool.connection() as conn:
            conn.execute("INSERT INTO blob_object (sha256, bytes, mime, uploaded_by) VALUES (%s,%s,%s,%s) ON CONFLICT DO NOTHING",
                         (sha256, len(data), request.headers.get("content-type", "application/octet-stream")[:100], user.id))
        return {"sha256": sha256, "bytes": len(data)}

    @app.get("/v1/files/{sha256}")
    def download(sha256: str, user: Account = Depends(current_user)):
        with pool.connection() as conn:
            cond, args = visible(user)
            row = conn.execute(f"""SELECT f.mime FROM evidence_file f JOIN evaluation e ON e.id = f.evaluation_id
                                   WHERE f.sha256 = %s AND {cond} LIMIT 1""", (sha256, *args)).fetchone()
        data = blobs.get(sha256) if row else None
        if data is None:
            raise HTTPException(404, "Archivo no encontrado")
        return Response(data, media_type=row["mime"])

    # ---------- sincronización ----------

    @app.post("/v1/sync/push")
    def push(body: PushIn, request: Request, user: Account = Depends(current_user)):
        t = request.state.token
        if t is not None and t.kind == "device" and t.device_id != body.deviceId:
            raise HTTPException(403, "El token pertenece a otra tablet")
        if len(body.ops) > s.max_batch_ops:
            raise HTTPException(413, f"Máximo {s.max_batch_ops} operaciones por envío")
        with pool.connection() as conn:
            dev = conn.execute("SELECT status FROM device WHERE id = %s", (body.deviceId,)).fetchone()
            if dev and dev["status"] == "revoked":
                raise HTTPException(403, "Esta tablet ya no tiene acceso. Habla con el administrador.")
            conn.execute("""INSERT INTO device (id, last_sync_at, last_user_id, app_version, model) VALUES (%s, now(), %s, %s, %s)
                            ON CONFLICT (id) DO UPDATE SET last_sync_at = now(), last_user_id = excluded.last_user_id,
                            app_version = coalesce(excluded.app_version, device.app_version), model = coalesce(excluded.model, device.model)""",
                         (body.deviceId, user.id, body.appVersion, body.deviceModel))
            ops = [Op(o.opId, o.seq, o.entity, o.entityKey, o.op, o.payload, o.baseVersion) for o in body.ops]
            results = Applier(conn, user, body.deviceId, catalogs, blobs.exists).apply(ops)
            if ops:
                count = {k: sum(1 for r in results if r["status"] == k) for k in ("accepted", "rejected", "conflict")}
                audit(conn, user.id, "sync.push", "device", body.deviceId, count)
            with conn.cursor() as cur:
                for a in body.audit:
                    cur.execute("""INSERT INTO audit_log (id, at, user_id, device_id, action, entity, entity_key, detail)
                                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING""",
                                (a.id, a.at, user.id, body.deviceId, a.action, a.entity, a.entityKey, Jsonb(a.detail)))
                cur.execute("SELECT now() AS t")
                server_time = cur.fetchone()["t"].isoformat()
        return {"results": results, "auditReceived": len(body.audit), "serverTime": server_time}

    # ---------- consulta (portal web) ----------

    @app.get("/v1/me")
    def me(user: Account = Depends(current_user)):
        return {"id": user.id, "name": user.name, "email": user.email, "role": user.role,
                "mustChangePassword": user.must_change_password, "authMode": s.auth_mode}

    @app.get("/v1/models")
    def models(_: Account = Depends(current_user)):
        with pool.connection() as conn:
            used = {r["model_id"]: r["n"] for r in conn.execute("SELECT model_id, count(*) AS n FROM evaluation GROUP BY model_id")}
        return [{"id": c.id, "title": c.raw.get("title"), "source": c.raw.get("source"), "dimensions": len(c.dimensions),
                 "questions": len(c.questions), "evaluations": used.get(c.id, 0)} for c in catalogs.values()]

    @app.get("/v1/evaluations")
    def evaluations(scores: bool = False, user: Account = Depends(current_user)):
        """Evaluaciones visibles para la persona. Con scores=true incluye alcance y puntajes, para calcular resultados."""
        cond, args = visible(user)
        with pool.connection() as conn:
            rows = conn.execute(f"""SELECT e.id, e.model_id, e.company, e.site, e.evaluated_on, e.status, e.closed_at, e.updated_at,
                                    e.owner_user_id, u.name AS owner_name,
                                    (SELECT max(d.last_sync_at) FROM device d WHERE d.id = e.last_device_id) AS last_sync_at,
                                    (SELECT count(*) FROM answer a WHERE a.evaluation_id = e.id AND (a.score IS NOT NULL OR a.not_applicable)) AS answered
                                    FROM evaluation e LEFT JOIN app_user u ON u.id = e.owner_user_id
                                    WHERE {cond} ORDER BY e.evaluated_on DESC, e.updated_at DESC""", args).fetchall()
            if scores and rows:
                ids = [r["id"] for r in rows]
                sc: dict[str, list] = {i: [] for i in ids}
                an: dict[str, list] = {i: [] for i in ids}
                for r in conn.execute("SELECT evaluation_id, dimension, applies FROM dimension_scope WHERE evaluation_id = ANY(%s)", (ids,)):
                    sc[r["evaluation_id"]].append({"dimension": r["dimension"], "applies": r["applies"]})
                for r in conn.execute("SELECT evaluation_id, question_id, score, not_applicable FROM answer WHERE evaluation_id = ANY(%s)", (ids,)):
                    an[r["evaluation_id"]].append({"question_id": r["question_id"], "score": r["score"], "not_applicable": r["not_applicable"]})
                for r in rows:
                    r["scopes"], r["answers"] = sc[r["id"]], an[r["id"]]
        return rows

    @app.get("/v1/evaluations/{evaluation_id}")
    def evaluation(evaluation_id: str, user: Account = Depends(current_user)):
        cond, args = visible(user)
        with pool.connection() as conn:
            ev = conn.execute(f"""SELECT e.*, u.name AS owner_name FROM evaluation e LEFT JOIN app_user u ON u.id = e.owner_user_id
                                  WHERE e.id = %s AND {cond}""", (evaluation_id, *args)).fetchone()
            if not ev:
                raise HTTPException(404, "Evaluación no encontrada")
            q = lambda sql: conn.execute(sql, (evaluation_id,)).fetchall()  # noqa: E731
            return {
                "evaluation": ev,
                "scopes": q("SELECT dimension, applies, justification FROM dimension_scope WHERE evaluation_id = %s ORDER BY dimension"),
                "answers": q("SELECT question_id, score, not_applicable, na_justification, evidence_note, updated_at FROM answer WHERE evaluation_id = %s ORDER BY question_id"),
                "evidence": q("SELECT id, question_id, kind, mime, bytes, sha256, received_at FROM evidence_file WHERE evaluation_id = %s AND NOT withdrawn ORDER BY received_at"),
                "actions": q("SELECT id, question_id, description, impact, effort, owner, due_on, status FROM action_item WHERE evaluation_id = %s ORDER BY updated_at"),
            }

    # ---------- administración ----------

    @app.get("/v1/admin/users")
    def users(_: Account = Depends(admin_user)):
        with pool.connection() as conn:
            return conn.execute("""SELECT id, name, email, username, role, status, must_change_password, first_seen_at, last_seen_at
                                   FROM app_user ORDER BY status, name NULLS LAST""").fetchall()

    @app.post("/v1/admin/users", status_code=201)
    def invite(body: InviteIn, admin: Account = Depends(admin_user)):
        if local:
            if not body.username or not body.password:
                raise HTTPException(400, "Indica usuario y clave inicial")
            la.check_password_policy(body.password)
            uid = body.username.lower()
            with pool.connection() as conn:
                if conn.execute("SELECT 1 FROM app_user WHERE id = %s OR lower(username) = %s", (uid, uid)).fetchone():
                    raise HTTPException(409, "Ya existe una persona con ese usuario")
                if body.email and conn.execute("SELECT 1 FROM app_user WHERE lower(email) = lower(%s)", (body.email,)).fetchone():
                    raise HTTPException(409, "Ya existe una persona con ese correo")
                conn.execute("""INSERT INTO app_user (id, name, email, username, password_hash, must_change_password, role, status, invited_by)
                                VALUES (%s,%s,%s,%s,%s,true,%s,'active',%s)""",
                             (uid, body.name.strip(), body.email, uid, la.hash_password(body.password), body.role, admin.id))
                audit(conn, admin.id, "user.create", "app_user", uid, {"username": uid, "role": body.role})
            return {"id": uid}
        if not body.email:
            raise HTTPException(400, "Indica el correo")
        with pool.connection() as conn:
            if conn.execute("SELECT 1 FROM app_user WHERE lower(email) = lower(%s)", (body.email,)).fetchone():
                raise HTTPException(409, "Ya existe una persona con ese correo")
            uid = f"inv-{uuid.uuid4()}"
            conn.execute("INSERT INTO app_user (id, name, email, role, status, invited_by) VALUES (%s,%s,%s,%s,'invited',%s)",
                         (uid, body.name.strip(), body.email.strip(), body.role, admin.id))
            audit(conn, admin.id, "user.invite", "app_user", uid, {"email": body.email, "role": body.role})
        return {"id": uid}

    @app.patch("/v1/admin/users/{user_id}")
    def update_user(user_id: str, body: UserPatch, admin: Account = Depends(admin_user)):
        if user_id == admin.id and (body.status == "disabled" or (body.role and body.role != "administrador")):
            raise HTTPException(400, "No puedes quitarte a ti mismo el acceso de administrador")
        with pool.connection() as conn:
            row = conn.execute("SELECT status FROM app_user WHERE id = %s FOR UPDATE", (user_id,)).fetchone()
            if not row:
                raise HTTPException(404, "Persona no encontrada")
            if body.status == "active" and row["status"] == "invited":
                raise HTTPException(400, "La invitación se activa sola cuando la persona entra por primera vez")
            conn.execute("UPDATE app_user SET role = coalesce(%s, role), status = coalesce(%s, status) WHERE id = %s",
                         (body.role, body.status, user_id))
            if body.status == "disabled":
                revoke_tokens(conn, user_id)
            audit(conn, admin.id, "user.update", "app_user", user_id, body.model_dump(exclude_none=True))
        return {"ok": True}

    @app.get("/v1/admin/devices")
    def devices(_: Account = Depends(admin_user)):
        with pool.connection() as conn:
            return conn.execute("""SELECT d.id, d.model, d.app_version, d.status, d.first_seen_at, d.last_sync_at, d.revoked_at,
                                   d.last_user_id, u.name AS last_user_name FROM device d LEFT JOIN app_user u ON u.id = d.last_user_id
                                   ORDER BY d.last_sync_at DESC NULLS LAST""").fetchall()

    @app.post("/v1/admin/devices/{device_id}/revoke")
    def revoke(device_id: str, admin: Account = Depends(admin_user)):
        with pool.connection() as conn:
            r = conn.execute("UPDATE device SET status = 'revoked', revoked_at = now(), revoked_by = %s WHERE id = %s AND status = 'active'",
                             (admin.id, device_id))
            if r.rowcount == 0:
                raise HTTPException(404, "Tablet no encontrada o ya sin acceso")
            conn.execute("UPDATE auth_token SET revoked_at = now() WHERE device_id = %s AND revoked_at IS NULL", (device_id,))
            audit(conn, admin.id, "device.revoke", "device", device_id)
        return {"ok": True}

    @app.post("/v1/admin/users/{user_id}/password")
    def reset_password(user_id: str, body: PasswordIn, admin: Account = Depends(admin_user)):
        """Clave temporal: la persona debe cambiarla al entrar. Cierra sus sesiones abiertas en el portal."""
        require_local()
        la.check_password_policy(body.password)
        with pool.connection() as conn:
            r = conn.execute("UPDATE app_user SET password_hash = %s, must_change_password = true WHERE id = %s AND username IS NOT NULL",
                             (la.hash_password(body.password), user_id))
            if r.rowcount == 0:
                raise HTTPException(404, "Persona no encontrada")
            revoke_tokens(conn, user_id, "web")
            audit(conn, admin.id, "user.password_reset", "app_user", user_id)
        return {"ok": True}

    @app.post("/v1/admin/users/{user_id}/pairing-code", status_code=201)
    def pairing_code(user_id: str, request: Request, admin: Account = Depends(admin_user)):
        """Código de un solo uso, válido por 15 minutos, para vincular una tablet a esta persona."""
        require_local()
        code = la.new_pairing_code()
        with pool.connection() as conn:
            u = conn.execute("SELECT status FROM app_user WHERE id = %s", (user_id,)).fetchone()
            if not u:
                raise HTTPException(404, "Persona no encontrada")
            if u["status"] != "active":
                raise HTTPException(400, "La persona no tiene acceso activo")
            row = conn.execute("""INSERT INTO pairing_code (code_hash, user_id, created_by, expires_at)
                                  VALUES (%s, %s, %s, now() + make_interval(mins => %s)) RETURNING expires_at""",
                               (la.token_hash(code), user_id, admin.id, la.PAIRING_MINUTES)).fetchone()
            audit(conn, admin.id, "device.pairing_code", "app_user", user_id)
        port = request.url.port or (443 if request.url.scheme == "https" else 80)
        urls = [f"{request.url.scheme}://{ip}:{port}" for ip in la.lan_addresses()]
        return {"code": code, "expiresAt": row["expires_at"].isoformat(), "serverUrls": urls}

    @app.get("/v1/admin/audit")
    def audit_log(limit: int = 200, before: str | None = None, _: Account = Depends(admin_user)):
        limit = max(1, min(limit, 1000))
        with pool.connection() as conn:
            return conn.execute("""SELECT a.id, a.at, a.user_id, u.name AS user_name, a.device_id, a.action, a.entity, a.entity_key, a.detail
                                   FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
                                   WHERE (%s::timestamptz IS NULL OR a.at < %s::timestamptz)
                                   ORDER BY a.at DESC, a.received_at DESC LIMIT %s""", (before, before, limit)).fetchall()

    if s.tablet_dir and (s.tablet_dir / "index.html").is_file():
        # La app de captura en el navegador del mismo computador, para probarla sin tablet.
        mimetypes.add_type("application/wasm", ".wasm")  # el registro de Windows no siempre lo trae
        app.mount("/tablet", StaticFiles(directory=s.tablet_dir, html=True), name="tablet")
    if s.portal_dir and (s.portal_dir / "index.html").is_file():
        # Un solo programa en el computador: la API en /v1 y el portal en la raíz.
        app.mount("/", StaticFiles(directory=s.portal_dir, html=True), name="portal")

    return app

