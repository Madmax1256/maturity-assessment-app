"""Quién entra y qué puede ver.

Roles (sección 6 de la especificación): administrador (usuarios, tablets, modelo), supervisor (ve
todas las evaluaciones) y evaluador (crea y ve las suyas). Nadie edita respuestas desde el portal.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from fastapi import HTTPException
from psycopg import Connection
from psycopg.types.json import Jsonb

from .auth import User
from .config import Settings

ROLES = ("administrador", "supervisor", "evaluador")


@dataclass(frozen=True)
class Account:
    id: str
    name: str | None
    email: str | None
    role: str
    must_change_password: bool = False

    @property
    def sees_all(self) -> bool:
        return self.role in ("administrador", "supervisor")

    @property
    def is_admin(self) -> bool:
        return self.role == "administrador"


def resolve_account(conn: Connection, u: User, s: Settings) -> Account:
    """Vincula el token con una persona registrada. Sin invitación no hay acceso."""
    row = conn.execute("SELECT * FROM app_user WHERE id = %s", (u.id,)).fetchone()
    if row is None and s.auth_mode == "local":
        raise HTTPException(403, "Tu cuenta no tiene acceso a la aplicación.")
    if row is None and u.email:
        invited = conn.execute("SELECT * FROM app_user WHERE lower(email) = lower(%s) AND status = 'invited'", (u.email,)).fetchone()
        if invited:
            # Primera entrada de una persona invitada: la invitación pasa a ser su cuenta.
            conn.execute("UPDATE app_user SET id = %s, status = 'active', name = coalesce(name, %s), last_seen_at = now() WHERE id = %s",
                         (u.id, u.name, invited["id"]))
            audit(conn, u.id, "user.first_login", "app_user", u.id, {"email": u.email})
            row = conn.execute("SELECT * FROM app_user WHERE id = %s", (u.id,)).fetchone()
    if row is None:
        keys = {u.id.lower(), (u.email or "").lower()}
        role = "administrador" if keys & set(s.bootstrap_admins) else s.auto_enroll_role
        if role not in ROLES:
            raise HTTPException(403, "Tu cuenta no tiene acceso a la aplicación. Pide una invitación al administrador.")
        conn.execute("INSERT INTO app_user (id, name, email, role, status) VALUES (%s,%s,%s,%s,'active') ON CONFLICT (id) DO NOTHING",
                     (u.id, u.name, u.email, role))
        audit(conn, u.id, "user.enrolled", "app_user", u.id, {"role": role})
        row = conn.execute("SELECT * FROM app_user WHERE id = %s", (u.id,)).fetchone()
    if row["status"] == "disabled":
        raise HTTPException(403, "Tu acceso a la aplicación fue retirado.")
    conn.execute("UPDATE app_user SET last_seen_at = now(), name = coalesce(name, %s), email = coalesce(email, %s) WHERE id = %s",
                 (u.name, u.email, u.id))
    return Account(id=row["id"], name=row["name"] or u.name, email=row["email"] or u.email, role=row["role"],
                   must_change_password=bool(row.get("must_change_password")))


def audit(conn: Connection, user_id: str, action: str, entity: str | None, key: str | None, detail: object = None) -> None:
    conn.execute("INSERT INTO audit_log (id, at, user_id, action, entity, entity_key, detail) VALUES (%s, now(), %s, %s, %s, %s, %s)",
                 (f"srv-{uuid.uuid4()}", user_id, action, entity, key, Jsonb(detail)))
