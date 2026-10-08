"""Aplicación de un lote de operaciones enviado por una tablet.

Reglas (sección 7 de la especificación):
- Cada operación se aplica una sola vez (op_id). Un reenvío de una operación aceptada recibe la
  misma respuesta y no cambia nada.
- Se aplican en el orden en que se hicieron en la tablet (seq). Cada una va en su propio punto de
  guardado: si una se rechaza, las demás siguen.
- Solo el propietario modifica su evaluación; una evaluación cerrada es de solo lectura (salvo su
  plan de acción).
- Conflicto: solo en respuestas, cuando otro dispositivo cambió la misma respuesta después de la
  versión sobre la que trabajó esta tablet. Cambios seguidos desde la misma tablet nunca chocan
  entre sí. El servidor no decide: devuelve su versión y el propietario elige en la tablet.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from psycopg import Connection
from psycopg.types.json import Jsonb

from .auth import User
from .catalog import SCORES, Catalog

DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class Reject(Exception):
    pass


@dataclass
class Op:
    op_id: str
    seq: int
    entity: str
    entity_key: str
    op: str
    payload: dict[str, Any]
    base_version: int | None


def _next_version(cur) -> int:
    return cur.execute("SELECT nextval('row_version_seq') AS v").fetchone()["v"]


def _text(v: Any, name: str, required: bool = False, max_len: int = 4000) -> str | None:
    if v is None or (isinstance(v, str) and not v.strip()):
        if required:
            raise Reject(f"Falta {name}")
        return None
    if not isinstance(v, str):
        raise Reject(f"{name} debe ser texto")
    if len(v) > max_len:
        raise Reject(f"{name} es demasiado largo")
    return v


def _evaluation(cur, ev_id: Any, user: User, allow_closed: bool = False):
    if not isinstance(ev_id, str):
        raise Reject("Falta la evaluación")
    row = cur.execute("SELECT * FROM evaluation WHERE id = %s FOR UPDATE", (ev_id,)).fetchone()
    if not row:
        raise Reject("La evaluación no existe en el servidor")
    if row["owner_user_id"] != user.id:
        raise Reject("Solo el evaluador propietario puede modificar esta evaluación")
    if row["status"] == "closed" and not allow_closed:
        raise Reject("La evaluación está cerrada y es de solo lectura")
    return row


class Applier:
    def __init__(self, conn: Connection, user: User, device_id: str, catalogs: dict[str, Catalog], blob_exists):
        self.conn, self.user, self.device_id, self.catalogs, self.blob_exists = conn, user, device_id, catalogs, blob_exists

    def apply(self, ops: list[Op]) -> list[dict]:
        results = []
        for op in sorted(ops, key=lambda o: o.seq):
            results.append(self._one(op))
        return results

    def _one(self, op: Op) -> dict:
        with self.conn.cursor() as cur:
            done = cur.execute("SELECT user_id, result FROM applied_op WHERE op_id = %s", (op.op_id,)).fetchone()
            if done:
                if done["user_id"] != self.user.id:
                    return {"opId": op.op_id, "status": "rejected", "reason": "Identificador de operación ya usado"}
                return done["result"]
        try:
            with self.conn.transaction():
                with self.conn.cursor() as cur:
                    handler = getattr(self, f"_{op.entity}_{op.op}", None)
                    if handler is None:
                        raise Reject(f"Operación no soportada: {op.entity}/{op.op}")
                    out = handler(cur, op)
                    if out.get("status") == "accepted":
                        cur.execute("INSERT INTO applied_op (op_id, device_id, user_id, entity, entity_key, result) VALUES (%s,%s,%s,%s,%s,%s)",
                                    (op.op_id, self.device_id, self.user.id, op.entity, op.entity_key, Jsonb(out)))
                    return out
        except Reject as r:
            return {"opId": op.op_id, "status": "rejected", "reason": str(r)}

    def _catalog(self, model_id: str) -> Catalog:
        c = self.catalogs.get(model_id)
        if not c:
            raise Reject(f"Modelo desconocido: {model_id}")
        return c

    # ---------- evaluación ----------

    def _evaluation_upsert(self, cur, op: Op) -> dict:
        p = op.payload
        ev_id = p.get("id") or op.entity_key
        if ev_id != op.entity_key:
            raise Reject("El identificador no coincide")
        company = _text(p.get("company"), "la empresa", required=True, max_len=200)
        site = _text(p.get("site"), "la faena", max_len=200)
        on = p.get("evaluatedOn")
        if not isinstance(on, str) or not DATE_RE.match(on):
            raise Reject("La fecha de evaluación no es válida")
        interviewees = p.get("interviewees") or []
        if not isinstance(interviewees, list) or not all(isinstance(x, str) for x in interviewees):
            raise Reject("La lista de entrevistados no es válida")
        v = _next_version(cur)
        exists = cur.execute("SELECT 1 FROM evaluation WHERE id = %s", (ev_id,)).fetchone()
        if not exists:
            self._catalog(p.get("modelId") or "")
            cur.execute("""INSERT INTO evaluation (id, model_id, company, site, evaluated_on, owner_user_id, interviewees, row_version, last_device_id)
                           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                        (ev_id, p["modelId"], company.strip(), site, on, self.user.id, Jsonb(interviewees), v, self.device_id))
        else:
            _evaluation(cur, ev_id, self.user)
            cur.execute("""UPDATE evaluation SET company = %s, site = %s, evaluated_on = %s, interviewees = %s,
                           row_version = %s, last_device_id = %s, updated_at = now() WHERE id = %s""",
                        (company.strip(), site, on, Jsonb(interviewees), v, self.device_id, ev_id))
        return {"opId": op.op_id, "status": "accepted", "rowVersion": v}

    def _evaluation_close(self, cur, op: Op) -> dict:
        ev = _evaluation(cur, op.entity_key, self.user, allow_closed=True)
        if ev["status"] == "closed":
            return {"opId": op.op_id, "status": "accepted", "rowVersion": ev["row_version"]}
        issues = self.closure_blocks(cur, ev)
        if issues:
            more = f" y {len(issues) - 3} más" if len(issues) > 3 else ""
            raise Reject("No se puede cerrar: " + "; ".join(issues[:3]) + more)
        v = _next_version(cur)
        cur.execute("UPDATE evaluation SET status = 'closed', closed_at = coalesce(%s::timestamptz, now()), row_version = %s, last_device_id = %s, updated_at = now() WHERE id = %s",
                    (op.payload.get("closedAt"), v, self.device_id, ev["id"]))
        return {"opId": op.op_id, "status": "accepted", "rowVersion": v}

    def closure_blocks(self, cur, ev) -> list[str]:
        """Las mismas condiciones que bloquean el cierre en la tablet (closureIssues del motor)."""
        cat = self._catalog(ev["model_id"])
        scopes = {r["dimension"]: r["applies"] for r in cur.execute("SELECT dimension, applies FROM dimension_scope WHERE evaluation_id = %s", (ev["id"],))}
        answers = {r["question_id"]: r for r in cur.execute("SELECT question_id, score, not_applicable FROM answer WHERE evaluation_id = %s", (ev["id"],))}
        out = []
        if all(scopes.get(d) is False for d in cat.dimensions):
            out.append("ninguna dimensión aplica")
        out += [f"define si {d} aplica" for d in cat.dimensions if d not in scopes]
        for q, d in cat.questions.items():
            if scopes.get(d) is False:
                continue
            a = answers.get(q)
            if not a or (not a["not_applicable"] and a["score"] is None):
                out.append(f"{q} sin responder")
        return out

    # ---------- alcance ----------

    def _dimension_scope_upsert(self, cur, op: Op) -> dict:
        p = op.payload
        ev = _evaluation(cur, p.get("evaluationId"), self.user)
        d = p.get("dimension")
        if d not in self._catalog(ev["model_id"]).dimensions:
            raise Reject(f"Dimensión desconocida: {d}")
        applies = p.get("applies")
        if not isinstance(applies, bool):
            raise Reject("Falta indicar si la dimensión aplica")
        just = _text(p.get("justification"), "la justificación")
        if not applies and not just:
            raise Reject("Para excluir una dimensión se requiere justificación")
        v = _next_version(cur)
        cur.execute("""INSERT INTO dimension_scope (evaluation_id, dimension, applies, justification, row_version) VALUES (%s,%s,%s,%s,%s)
                       ON CONFLICT (evaluation_id, dimension) DO UPDATE SET applies = excluded.applies, justification = excluded.justification,
                       row_version = excluded.row_version, updated_at = now()""", (ev["id"], d, applies, just, v))
        return {"opId": op.op_id, "status": "accepted", "rowVersion": v}

    # ---------- respuestas ----------

    def _answer_upsert(self, cur, op: Op) -> dict:
        p = op.payload
        ev = _evaluation(cur, p.get("evaluationId"), self.user)
        q = p.get("questionId")
        if q not in self._catalog(ev["model_id"]).questions:
            raise Reject(f"Pregunta desconocida: {q}")
        score = p.get("score")
        if score is not None and score not in SCORES:
            raise Reject("El puntaje debe ser 0, 25, 50, 75 o 100")
        na = bool(p.get("notApplicable"))
        na_just = _text(p.get("naJustification"), "la justificación")
        if na and (score is not None or not na_just):
            raise Reject('"No aplica" requiere justificación y no lleva puntaje')
        note = _text(p.get("evidenceNote"), "la nota de evidencia", max_len=8000)
        cur_row = cur.execute("SELECT * FROM answer WHERE evaluation_id = %s AND question_id = %s FOR UPDATE", (ev["id"], q)).fetchone()
        if cur_row and cur_row["row_version"] != op.base_version and cur_row["last_device_id"] != self.device_id:
            return {"opId": op.op_id, "status": "conflict", "server": {
                "score": cur_row["score"], "notApplicable": cur_row["not_applicable"], "naJustification": cur_row["na_justification"],
                "evidenceNote": cur_row["evidence_note"], "rowVersion": cur_row["row_version"], "updatedBy": cur_row["updated_by"],
                "updatedAt": cur_row["updated_at"].isoformat()}}
        v = _next_version(cur)
        cur.execute("""INSERT INTO answer (evaluation_id, question_id, score, not_applicable, na_justification, evidence_note, row_version, last_device_id, updated_by)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (evaluation_id, question_id) DO UPDATE SET score = excluded.score, not_applicable = excluded.not_applicable,
                       na_justification = excluded.na_justification, evidence_note = excluded.evidence_note, row_version = excluded.row_version,
                       last_device_id = excluded.last_device_id, updated_by = excluded.updated_by, updated_at = now()""",
                    (ev["id"], q, score, na, na_just if na else None, note, v, self.device_id, self.user.id))
        return {"opId": op.op_id, "status": "accepted", "rowVersion": v}

    # ---------- evidencia ----------

    def _evidence_file_upsert(self, cur, op: Op) -> dict:
        p = op.payload
        ev = _evaluation(cur, p.get("evaluationId"), self.user)
        fid = p.get("id") or op.entity_key
        if fid != op.entity_key:
            raise Reject("El identificador no coincide")
        q = p.get("questionId")
        if q is not None and q not in self._catalog(ev["model_id"]).questions:
            raise Reject(f"Pregunta desconocida: {q}")
        if p.get("kind") not in ("photo", "document", "audio_note"):
            raise Reject("Tipo de evidencia desconocido")
        sha, size = p.get("sha256"), p.get("bytes")
        blob = cur.execute("SELECT bytes FROM blob_object WHERE sha256 = %s", (sha,)).fetchone()
        if not blob or not self.blob_exists(sha):
            raise Reject("El archivo aún no se ha subido")
        if blob["bytes"] != size:
            raise Reject("El tamaño del archivo no coincide")
        prev = cur.execute("SELECT sha256, row_version FROM evidence_file WHERE id = %s", (fid,)).fetchone()
        if prev:
            if prev["sha256"] != sha:
                raise Reject("La evidencia no se modifica")
            return {"opId": op.op_id, "status": "accepted", "rowVersion": prev["row_version"]}
        v = _next_version(cur)
        cur.execute("""INSERT INTO evidence_file (id, evaluation_id, question_id, kind, mime, bytes, sha256, source, created_by, row_version)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                    (fid, ev["id"], q, p["kind"], _text(p.get("mime"), "el tipo de archivo", required=True, max_len=100), size, sha,
                     _text(p.get("source"), "la fuente", max_len=500), self.user.id, v))
        return {"opId": op.op_id, "status": "accepted", "rowVersion": v}

    # ---------- plan de acción ----------

    def _action_item_upsert(self, cur, op: Op) -> dict:
        p = op.payload
        ev = _evaluation(cur, p.get("evaluationId"), self.user, allow_closed=True)
        aid = p.get("id") or op.entity_key
        if aid != op.entity_key:
            raise Reject("El identificador no coincide")
        q = p.get("questionId")
        if q is not None and q not in self._catalog(ev["model_id"]).questions:
            raise Reject(f"Pregunta desconocida: {q}")
        for name, k in (("impacto", "impact"), ("esfuerzo", "effort")):
            x = p.get(k)
            if x is not None and not (isinstance(x, int) and 1 <= x <= 5):
                raise Reject(f"El {name} va de 1 a 5")
        status = p.get("status") or "open"
        if status not in ("open", "in_progress", "done", "cancelled"):
            raise Reject("Estado de acción desconocido")
        due = p.get("dueOn")
        if due is not None and not (isinstance(due, str) and DATE_RE.match(due)):
            raise Reject("La fecha comprometida no es válida")
        prev = cur.execute("SELECT evaluation_id FROM action_item WHERE id = %s", (aid,)).fetchone()
        if prev and prev["evaluation_id"] != ev["id"]:
            raise Reject("La acción pertenece a otra evaluación")
        v = _next_version(cur)
        cur.execute("""INSERT INTO action_item (id, evaluation_id, question_id, description, impact, effort, owner, due_on, status, row_version)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       ON CONFLICT (id) DO UPDATE SET description = excluded.description, impact = excluded.impact, effort = excluded.effort,
                       owner = excluded.owner, due_on = excluded.due_on, status = excluded.status, row_version = excluded.row_version, updated_at = now()""",
                    (aid, ev["id"], q, _text(p.get("description"), "la descripción", required=True), p.get("impact"), p.get("effort"),
                     _text(p.get("owner"), "el responsable", max_len=200), due, status, v))
        return {"opId": op.op_id, "status": "accepted", "rowVersion": v}
