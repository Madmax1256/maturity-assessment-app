"""Respaldo del modo local: base de datos (pg_dump) y archivos de evidencia.

Cada respaldo deja en la carpeta elegida:
    db/fs-AAAAMMDD-HHMMSS.dump   copia completa de la base (formato de pg_restore)
    blobs/<sha256>               archivos de evidencia; como el nombre es su huella, solo se copian los nuevos
Se conservan los últimos `keep` respaldos de la base. Los archivos de evidencia nunca se borran del
respaldo, porque la evidencia es de solo agregar.

Con FS_BACKUP_DIR definido, el servidor hace un respaldo al iniciar (si el último tiene más de 20
horas) y luego uno cada 24 horas.
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import threading
from datetime import datetime
from pathlib import Path

log = logging.getLogger("fs.backup")
STAMP = "%Y%m%d-%H%M%S"


def _pg_tool(name: str, pg_bin: str | None) -> str:
    exe = name + (".exe" if os.name == "nt" else "")
    if pg_bin:
        return str(Path(pg_bin) / exe)
    found = shutil.which(exe)
    if not found:
        raise RuntimeError(f"No se encontró {exe}. Indica la carpeta de PostgreSQL en FS_PG_BIN.")
    return found


def last_backup(dest: Path) -> datetime | None:
    dumps = sorted((dest / "db").glob("fs-*.dump")) if (dest / "db").is_dir() else []
    if not dumps:
        return None
    return datetime.strptime(dumps[-1].stem[3:], STAMP)


def run_backup(database_url: str, blob_dir: Path, dest: Path, keep: int = 30, pg_bin: str | None = None) -> dict:
    (dest / "db").mkdir(parents=True, exist_ok=True)
    (dest / "blobs").mkdir(parents=True, exist_ok=True)
    out = dest / "db" / f"fs-{datetime.now().strftime(STAMP)}.dump"
    tmp = out.with_suffix(".partial")
    subprocess.run([_pg_tool("pg_dump", pg_bin), "--format=custom", "--no-owner", f"--file={tmp}", f"--dbname={database_url}"],
                   check=True, capture_output=True, text=True)
    tmp.replace(out)  # un respaldo a medias nunca queda con el nombre final
    copied = 0
    if blob_dir.is_dir():
        for f in blob_dir.rglob("*"):
            if f.is_file() and not (dest / "blobs" / f.name).exists():
                part = dest / "blobs" / (f.name + ".partial")
                shutil.copy2(f, part)
                part.replace(dest / "blobs" / f.name)
                copied += 1
    dumps = sorted((dest / "db").glob("fs-*.dump"))
    for old in dumps[:-keep] if keep > 0 else []:
        old.unlink()
    return {"file": str(out), "bytes": out.stat().st_size, "blobsCopied": copied, "kept": min(len(dumps), keep)}


def restore(database_url: str, dump: Path, backup_blobs: Path, blob_dir: Path, pg_bin: str | None = None) -> None:
    """Restaura sobre una base vacía (créala antes). No mezcla con datos existentes."""
    subprocess.run([_pg_tool("pg_restore", pg_bin), "--no-owner", "--exit-on-error", f"--dbname={database_url}", str(dump)],
                   check=True, capture_output=True, text=True)
    blob_dir.mkdir(parents=True, exist_ok=True)
    for f in backup_blobs.glob("*"):
        if f.is_file() and not f.name.endswith(".partial"):
            target = blob_dir / f.name[:2] / f.name
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                shutil.copy2(f, target)


def start_scheduler(database_url: str, blob_dir: Path, dest: Path, keep: int, pg_bin: str | None) -> threading.Event:
    stop = threading.Event()

    def loop() -> None:
        while not stop.is_set():
            last = last_backup(dest)
            if last is None or (datetime.now() - last).total_seconds() > 20 * 3600:
                try:
                    r = run_backup(database_url, blob_dir, dest, keep, pg_bin)
                    log.info("Respaldo listo: %s", r["file"])
                except Exception:  # noqa: BLE001 - un respaldo fallido no debe botar el servidor
                    log.exception("No se pudo hacer el respaldo en %s", dest)
            stop.wait(3600)

    threading.Thread(target=loop, name="fs-backup", daemon=True).start()
    return stop

