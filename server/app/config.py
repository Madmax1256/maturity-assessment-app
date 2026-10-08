"""Configuración por variables de entorno. En Azure se cargan desde App Service / Key Vault."""

from dataclasses import dataclass, field
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def _list(v: str | None) -> list[str]:
    return [x.strip() for x in (v or "").split(",") if x.strip()]


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default_factory=lambda: os.environ.get("FS_DATABASE_URL", "postgresql://postgres@localhost:5432/fs"))
    # "entra" valida tokens de Microsoft Entra ID; "dev" acepta "Bearer dev:<usuario>" y solo sirve para desarrollo y pruebas.
    auth_mode: str = field(default_factory=lambda: os.environ.get("FS_AUTH_MODE", "entra"))
    entra_tenant_id: str = field(default_factory=lambda: os.environ.get("FS_ENTRA_TENANT_ID", ""))
    entra_audience: str = field(default_factory=lambda: os.environ.get("FS_ENTRA_AUDIENCE", ""))
    blob_dir: Path = field(default_factory=lambda: Path(os.environ.get("FS_BLOB_DIR", str(ROOT / "server" / "var" / "blobs"))))
    catalog_dir: Path = field(default_factory=lambda: Path(os.environ.get("FS_CATALOG_DIR", str(ROOT / "packages" / "model" / "catalog"))))
    cors_origins: list[str] = field(default_factory=lambda: _list(os.environ.get("FS_CORS_ORIGINS")))
    max_file_mb: int = field(default_factory=lambda: int(os.environ.get("FS_MAX_FILE_MB", "25")))
    max_batch_ops: int = 500
