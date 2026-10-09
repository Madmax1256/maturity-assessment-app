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
    # "entra" valida tokens de Microsoft Entra ID; "local" usa usuario y clave guardados en este servidor;
    # "dev" acepta "Bearer dev:<usuario>" y solo sirve para desarrollo y pruebas.
    auth_mode: str = field(default_factory=lambda: os.environ.get("FS_AUTH_MODE", "entra"))
    entra_tenant_id: str = field(default_factory=lambda: os.environ.get("FS_ENTRA_TENANT_ID", ""))
    entra_audience: str = field(default_factory=lambda: os.environ.get("FS_ENTRA_AUDIENCE", ""))
    blob_dir: Path = field(default_factory=lambda: Path(os.environ.get("FS_BLOB_DIR", str(ROOT / "server" / "var" / "blobs"))))
    catalog_dir: Path = field(default_factory=lambda: Path(os.environ.get("FS_CATALOG_DIR", str(ROOT / "packages" / "model" / "catalog"))))
    cors_origins: list[str] = field(default_factory=lambda: _list(os.environ.get("FS_CORS_ORIGINS")))
    max_file_mb: int = field(default_factory=lambda: int(os.environ.get("FS_MAX_FILE_MB", "25")))
    # Correos (o ids) que entran como administradores aunque nadie los haya invitado: el primer acceso.
    bootstrap_admins: list[str] = field(default_factory=lambda: [x.lower() for x in _list(os.environ.get("FS_BOOTSTRAP_ADMINS"))])
    # Si se define (por ejemplo "evaluador"), una cuenta del tenant sin invitación entra con ese rol.
    # Vacío por omisión: solo entran personas invitadas desde el portal.
    auto_enroll_role: str = field(default_factory=lambda: os.environ.get("FS_AUTO_ENROLL_ROLE", ""))
    # Carpeta con el portal compilado (apps/portal/dist). Si existe, el servidor lo publica en "/".
    portal_dir: Path | None = field(default_factory=lambda: Path(p) if (p := os.environ.get("FS_PORTAL_DIR")) else None)
    tablet_dir: Path | None = field(default_factory=lambda: Path(p) if (p := os.environ.get("FS_TABLET_DIR")) else None)
    # Modo local: carpeta de respaldos automáticos (vacío = sin respaldo automático), cuántos
    # respaldos de la base conservar y, si pg_dump no está en el PATH, la carpeta bin de PostgreSQL.
    backup_dir: Path | None = field(default_factory=lambda: Path(p) if (p := os.environ.get("FS_BACKUP_DIR")) else None)
    backup_keep: int = field(default_factory=lambda: int(os.environ.get("FS_BACKUP_KEEP", "30")))
    pg_bin: str | None = field(default_factory=lambda: os.environ.get("FS_PG_BIN") or None)
    max_batch_ops: int = 500
