"""Arma el zip del instalador para Windows: python3 deploy/windows/empaquetar.py [carpeta_salida]

Requiere el portal compilado sin VITE_API_URL (npm run build:portal), para que use el mismo
servidor que lo publica. Los scripts de PowerShell se guardan en UTF-8 con BOM y fin de línea
CRLF, que es lo que Windows PowerShell 5.1 necesita para leer bien los acentos.
"""

import json
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent


def windows_text(src: Path, bom: bool) -> bytes:
    text = src.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\n", "\r\n")
    return (b"\xef\xbb\xbf" if bom else b"") + text.encode("utf-8")


def main() -> int:
    out_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "dist"
    portal = ROOT / "apps" / "portal" / "dist"
    if not (portal / "index.html").is_file():
        print("Falta el portal compilado: npm run build:portal", file=sys.stderr)
        return 1
    if any("http://localhost:" in p.read_text(encoding="utf-8", errors="ignore") for p in portal.rglob("*.js")):
        print("El portal parece compilado con otra dirección de servidor; compílalo sin VITE_API_URL.", file=sys.stderr)
        return 1
    version = json.loads((ROOT / "apps" / "tablet" / "package.json").read_text())["version"]
    name = f"fs-diagnostico-windows-{version}"
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{name}.zip"

    files: dict[str, bytes] = {}
    for f in ("instalar.ps1", "iniciar.ps1", "detener.ps1", "respaldar.ps1"):
        files[f] = windows_text(HERE / f, bom=True)
    files["LEEME.txt"] = windows_text(HERE / "LEEME.txt", bom=True)
    files["INSTALAR.cmd"] = windows_text(HERE / "INSTALAR.cmd", bom=False)
    for p in sorted((ROOT / "server" / "app").glob("*")):
        if p.suffix in (".py", ".sql"):
            files[f"app/server/app/{p.name}"] = p.read_bytes()
    files["app/server/requirements.txt"] = (ROOT / "server" / "requirements.txt").read_bytes()
    for p in sorted((ROOT / "packages" / "model" / "catalog").glob("*.json")):
        files[f"app/packages/model/catalog/{p.name}"] = p.read_bytes()
    for p in sorted(portal.rglob("*")):
        if p.is_file():
            files[f"app/portal/{p.relative_to(portal).as_posix()}"] = p.read_bytes()

    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for rel, data in files.items():
            z.writestr(f"{name}/{rel}", data)
    print(f"{target} ({target.stat().st_size // 1024} KB, {len(files)} archivos)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
