"""Respaldo y restauración del modo local."""

import shutil
import time

import psycopg
import pytest

from app import backup
from app.admin_cli import main as cli
from tests.conftest import DB_URL, Tablet

pytestmark = pytest.mark.skipif(not shutil.which("pg_dump"), reason="requiere pg_dump")
RESTORE_URL = DB_URL.rsplit("/", 1)[0] + "/fs_restore_test"


def test_backup_and_restore_round_trip(client, app, tmp_path, monkeypatch):
    ana = Tablet(client, "ana")
    ev, c = ana.new_eval(company="Minera Respaldo")
    ana.push(c, ana.answer(ev, "D01-Q01", 75))
    blob_dir = app.state.blobs.root
    (blob_dir / "ab").mkdir(parents=True, exist_ok=True)
    (blob_dir / "ab" / ("ab" + "0" * 62)).write_bytes(b"foto")
    dest = tmp_path / "respaldos"

    r1 = backup.run_backup(DB_URL, blob_dir, dest, keep=2)
    assert r1["blobsCopied"] >= 1 and (dest / "blobs" / ("ab" + "0" * 62)).read_bytes() == b"foto"
    time.sleep(1.1)
    assert backup.run_backup(DB_URL, blob_dir, dest, keep=2)["blobsCopied"] == 0  # solo copia lo nuevo
    time.sleep(1.1)
    backup.run_backup(DB_URL, blob_dir, dest, keep=2)
    assert len(list((dest / "db").glob("fs-*.dump"))) == 2 and backup.last_backup(dest) is not None

    with psycopg.connect(DB_URL.rsplit("/", 1)[0] + "/postgres", autocommit=True) as conn:
        conn.execute("DROP DATABASE IF EXISTS fs_restore_test")
        conn.execute("CREATE DATABASE fs_restore_test")
    restored_blobs = tmp_path / "blobs2"
    monkeypatch.setenv("FS_DATABASE_URL", RESTORE_URL)
    monkeypatch.setenv("FS_BLOB_DIR", str(restored_blobs))
    assert cli(["restaurar", "--carpeta", str(dest)]) == 0
    with psycopg.connect(RESTORE_URL) as conn:
        assert conn.execute("SELECT company FROM evaluation").fetchone()[0] == "Minera Respaldo"
        assert conn.execute("SELECT score FROM answer").fetchone()[0] == 75
    assert (restored_blobs / "ab" / ("ab" + "0" * 62)).read_bytes() == b"foto"
    # No restaura encima de una base con datos.
    assert cli(["restaurar", "--carpeta", str(dest)]) == 1
