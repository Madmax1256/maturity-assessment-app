"""Almacén de archivos de evidencia, direccionado por sha256.

MVP: carpeta local (o un volumen montado). En Azure se reemplaza por Blob Storage con la misma
interfaz; el resto del servidor no cambia.
"""

from pathlib import Path
import os
import tempfile
from typing import Protocol


class BlobStore(Protocol):
    def put(self, sha256: str, data: bytes) -> None: ...
    def get(self, sha256: str) -> bytes | None: ...
    def exists(self, sha256: str) -> bool: ...


class LocalBlobStore:
    def __init__(self, root: Path):
        self.root = root
        root.mkdir(parents=True, exist_ok=True)

    def _path(self, sha: str) -> Path:
        return self.root / sha[:2] / sha

    def put(self, sha256: str, data: bytes) -> None:
        p = self._path(sha256)
        if p.exists():
            return
        p.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=p.parent)
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, p)

    def get(self, sha256: str) -> bytes | None:
        p = self._path(sha256)
        return p.read_bytes() if p.exists() else None

    def exists(self, sha256: str) -> bool:
        return self._path(sha256).exists()
