"""API de sincronización y consulta. Ejecutar desde server/: uvicorn app.main:create_app --factory"""

from __future__ import annotations

import hashlib
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


class PushIn(BaseModel):
    deviceId: str = Field(min_length=1, max_length=64)
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

    app = FastAPI(title="Diagnóstico F&S: sincronización", version="0.3.0", lifespan=lifespan)
    if s.cors_origins:
        app.add_middleware(CORSMiddleware, allow_origins=s.cors_origins, allow_methods=["GET", "POST", "PUT"],
                           allow_headers=["authorization", "content-type"])
    app.state.pool, app.state.blobs = pool, blobs

    def current_user(request: Request) -> User:
        u = auth(request)
        with pool.connection() as conn:
            conn.execute("""INSERT INTO app_user (id, name, email) VALUES (%s,%s,%s)
                            ON CONFLICT (id) DO UPDATE SET last_seen_at = now(), name = coalesce(excluded.name, app_user.name),
                            email = coalesce(excluded.email, app_user.email)""", (u.id, u.name, u.email))
        return u

    @app.get("/health")
    def health():
        with pool.connection() as conn:
            conn.execute("SELECT 1")
        return {"ok": True, "models": sorted(catalogs)}

    @app.get("/v1/models/{model_id}")
    def model(model_id: str, _: User = Depends(current_user)):
        c = catalogs.get(model_id)
        if not c:
            raise HTTPException(404, "Modelo desconocido")
        return c.raw

    # ---------- archivos de evidencia ----------

    @app.post("/v1/files/missing")
    def files_missing(body: MissingIn, _: User = Depends(current_user)):
        """De una lista de huellas sha256, cuáles faltan en el servidor (para no subir dos veces)."""
        with pool.connection() as conn:
            have = {r["sha256"] for r in conn.execute("SELECT sha256 FROM blob_object WHERE sha256 = ANY(%s)", (body.sha256,))}
        return {"missing": [x for x in body.sha256 if x not in have or not blobs.exists(x)]}

    @app.put("/v1/files/{sha256}", status_code=201)
    async def upload(sha256: str, request: Request, user: User = Depends(current_user)):
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
    def download(sha256: str, user: User = Depends(current_user)):
        with pool.connection() as conn:
            row = conn.execute("""SELECT f.mime FROM evidence_file f JOIN evaluation e ON e.id = f.evaluation_id
                                  WHERE f.sha256 = %s AND e.owner_user_id = %s LIMIT 1""", (sha256, user.id)).fetchone()
        data = blobs.get(sha256) if row else None
        if data is None:
            raise HTTPException(404, "Archivo no encontrado")
        return Response(data, media_type=row["mime"])

    # ---------- sincronización ----------

    @app.post("/v1/sync/push")
    def push(body: PushIn, user: User = Depends(current_user)):
        if len(body.ops) > s.max_batch_ops:
            raise HTTPException(413, f"Máximo {s.max_batch_ops} operaciones por envío")
        with pool.connection() as conn:
            conn.execute("""INSERT INTO device (id, last_sync_at, last_user_id) VALUES (%s, now(), %s)
                            ON CONFLICT (id) DO UPDATE SET last_sync_at = now(), last_user_id = excluded.last_user_id""", (body.deviceId, user.id))
            ops = [Op(o.opId, o.seq, o.entity, o.entityKey, o.op, o.payload, o.baseVersion) for o in body.ops]
            results = Applier(conn, user, body.deviceId, catalogs, blobs.exists).apply(ops)
            with conn.cursor() as cur:
                for a in body.audit:
                    cur.execute("""INSERT INTO audit_log (id, at, user_id, device_id, action, entity, entity_key, detail)
                                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT (id) DO NOTHING""",
                                (a.id, a.at, user.id, body.deviceId, a.action, a.entity, a.entityKey, Jsonb(a.detail)))
                cur.execute("SELECT now() AS t")
                server_time = cur.fetchone()["t"].isoformat()
        return {"results": results, "auditReceived": len(body.audit), "serverTime": server_time}

    # ---------- consulta (portal web) ----------

    @app.get("/v1/evaluations")
    def evaluations(user: User = Depends(current_user)):
        with pool.connection() as conn:
            return conn.execute("""SELECT e.id, e.model_id, e.company, e.site, e.evaluated_on, e.status, e.closed_at, e.updated_at,
                                   (SELECT count(*) FROM answer a WHERE a.evaluation_id = e.id AND (a.score IS NOT NULL OR a.not_applicable)) AS answered
                                   FROM evaluation e WHERE e.owner_user_id = %s ORDER BY e.updated_at DESC""", (user.id,)).fetchall()

    @app.get("/v1/evaluations/{evaluation_id}")
    def evaluation(evaluation_id: str, user: User = Depends(current_user)):
        with pool.connection() as conn:
            ev = conn.execute("SELECT * FROM evaluation WHERE id = %s AND owner_user_id = %s", (evaluation_id, user.id)).fetchone()
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

    return app

