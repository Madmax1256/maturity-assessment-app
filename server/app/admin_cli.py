"""Tareas de consola del modo local. Ejecutar desde server/:

    python -m app.admin_cli crear-admin --usuario max --nombre "Max Gajardo"
    python -m app.admin_cli respaldo --carpeta D:/Respaldos/FS
    python -m app.admin_cli restaurar --carpeta D:/Respaldos/FS [--archivo fs-20261008-120000.dump]
    python -m app.admin_cli hay-admin        # sale con 0 si ya existe un administrador con clave

crear-admin crea (o restablece) una cuenta de administrador con usuario y clave. La clave se pide por
teclado y no queda en el historial. Es la forma de entrar la primera vez: después, el administrador
crea al resto de las personas desde el portal.
respaldo copia la base y la evidencia a la carpeta; restaurar las devuelve sobre una base vacía.
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import sys
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from . import backup
from . import local_auth as la
from .config import Settings


def create_admin(database_url: str, username: str, name: str, password: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9._-]{3,40}", username):
        raise ValueError("El usuario debe tener entre 3 y 40 letras, números, punto, guion o guion bajo")
    if len(password) < la.MIN_PASSWORD:
        raise ValueError(f"La clave debe tener al menos {la.MIN_PASSWORD} caracteres")
    uid = username.lower()
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        conn.execute((Path(__file__).parent / "schema.sql").read_text(encoding="utf-8"))
        existing = conn.execute("SELECT id FROM app_user WHERE id = %s OR lower(username) = %s", (uid, uid)).fetchone()
        if existing:
            uid = existing["id"]
            conn.execute("""UPDATE app_user SET username = %s, password_hash = %s, must_change_password = false, role = 'administrador',
                            status = 'active', name = coalesce(name, %s) WHERE id = %s""", (uid, la.hash_password(password), name, uid))
            conn.execute("UPDATE auth_token SET revoked_at = now() WHERE user_id = %s AND kind = 'web' AND revoked_at IS NULL", (uid,))
            action = "user.admin_reset_console"
        else:
            conn.execute("""INSERT INTO app_user (id, name, username, password_hash, role, status)
                            VALUES (%s, %s, %s, %s, 'administrador', 'active')""", (uid, name, uid, la.hash_password(password)))
            action = "user.admin_created_console"
        conn.execute("INSERT INTO audit_log (id, at, user_id, action, entity, entity_key, detail) VALUES (%s, now(), %s, %s, 'app_user', %s, %s)",
                     (f"srv-{uuid.uuid4()}", uid, action, uid, Jsonb(None)))
    return uid


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m app.admin_cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("crear-admin", help="Crea o restablece una cuenta de administrador")
    c.add_argument("--usuario", required=True)
    c.add_argument("--nombre", default=None)
    b = sub.add_parser("respaldo", help="Respalda la base y la evidencia en una carpeta")
    b.add_argument("--carpeta", default=None, help="Por omisión, FS_BACKUP_DIR")
    r = sub.add_parser("restaurar", help="Restaura un respaldo sobre una base vacía")
    r.add_argument("--carpeta", required=True)
    r.add_argument("--archivo", default=None, help="Respaldo de la base a usar; por omisión, el más reciente")
    sub.add_parser("hay-admin", help="Sale con 0 si ya existe un administrador activo con clave")
    a = p.parse_args(argv)
    s = Settings()
    if a.cmd == "hay-admin":
        with psycopg.connect(s.database_url) as conn:
            conn.execute((Path(__file__).parent / "schema.sql").read_text(encoding="utf-8"))
            n = conn.execute("""SELECT count(*) FROM app_user WHERE role = 'administrador' AND status = 'active'
                                AND password_hash IS NOT NULL""").fetchone()[0]
        return 0 if n else 1
    if a.cmd == "respaldo":
        dest = Path(a.carpeta) if a.carpeta else s.backup_dir
        if not dest:
            print("Indica --carpeta o define FS_BACKUP_DIR.", file=sys.stderr)
            return 1
        res = backup.run_backup(s.database_url, s.blob_dir, dest, s.backup_keep, s.pg_bin)
        print(f"Respaldo listo: {res['file']} ({res['bytes'] // 1024} KB), {res['blobsCopied']} archivos de evidencia nuevos.")
        return 0
    if a.cmd == "restaurar":
        folder = Path(a.carpeta)
        dumps = sorted((folder / "db").glob("fs-*.dump"))
        dump = folder / "db" / a.archivo if a.archivo else (dumps[-1] if dumps else None)
        if not dump or not dump.is_file():
            print("No se encontró el respaldo de la base en esa carpeta.", file=sys.stderr)
            return 1
        with psycopg.connect(s.database_url) as conn:
            if conn.execute("SELECT to_regclass('public.evaluation')").fetchone()[0]:
                print("La base de destino no está vacía. Restaura sobre una base nueva.", file=sys.stderr)
                return 1
        backup.restore(s.database_url, dump, folder / "blobs", s.blob_dir, s.pg_bin)
        print(f"Restaurado desde {dump.name}.")
        return 0
    if a.cmd == "crear-admin":
        # El instalador pasa la clave en FS_ADMIN_PASSWORD, para que no quede en la línea de comandos.
        pw = os.environ.pop("FS_ADMIN_PASSWORD", None)
        if pw is None:
            pw = getpass.getpass("Clave (mínimo 10 caracteres): ")
            if pw != getpass.getpass("Repite la clave: "):
                print("Las claves no coinciden.", file=sys.stderr)
                return 1
        try:
            uid = create_admin(s.database_url, a.usuario, a.nombre or a.usuario, pw)
        except ValueError as e:
            print(e, file=sys.stderr)
            return 1
        print(f"Listo. Entra al portal con el usuario {uid}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
