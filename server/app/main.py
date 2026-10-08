"""API de sincronización y consulta. Ejecutar desde server/: uvicorn app.main:create_app --factory"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
import re
from contextlib import asynccontextmanager
from typing import Any, Literal

from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from psycopg_pool import ConnectionPool
from pydantic import BaseModel, Field

from .access import Account, audit, resolve_account
from .auth import Authenticator
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
    name: str = Field(min_length=1, max_length=200)
    email: str = Field(pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$", max_length=200)
    role: Literal["administrador", "supervisor", "evaluador"]


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
        yield
        pool.close()

    app = FastAPI(title="Diagnóstico F&S: sincronización", version="0.4.0", lifespan=lifespan)
    if s.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_methods=["GET", "POST", "PUT", "PATCH"],
                           allow_headers=["authorization", "content-type"])
    app.state.pool, app.state.blobs = pool, blobs

    def current_user(request: Request) -> Account:
        u = auth(request)
        with pool.connection() as conn:
            return resolve_account(conn, u, s)

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
    def push(body: PushIn, user: Account = Depends(current_user)):
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
        return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}

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
            return conn.execute("SELECT id, name, email, role, status, first_seen_at, last_seen_at FROM app_user ORDER BY status, name NULLS LAST").fetchall()

    @app.post("/v1/admin/users", status_code=201)
    def invite(body: InviteIn, admin: Account = Depends(admin_user)):
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
            audit(conn, admin.id, "device.revoke", "device", device_id)
        return {"ok": True}

    @app.get("/v1/admin/audit")
    def audit_log(limit: int = 200, before: str | None = None, _: Account = Depends(admin_user)):
        limit = max(1, min(limit, 1000))
        with pool.connection() as conn:
            return conn.execute("""SELECT a.id, a.at, a.user_id, u.name AS user_name, a.device_id, a.action, a.entity, a.entity_key, a.detail
                                   FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
                                   WHERE (%s::timestamptz IS NULL OR a.at < %s::timestamptz)
                                   ORDER BY a.at DESC, a.received_at DESC LIMIT %s""", (before, before, limit)).fetchall()

    return app

