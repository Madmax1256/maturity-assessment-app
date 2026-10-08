"""Catálogos publicados (el mismo JSON que usa la tablet, importado del Excel)."""

import json
from dataclasses import dataclass
from pathlib import Path

SCORES = {0, 25, 50, 75, 100}


@dataclass(frozen=True)
class Catalog:
    id: str
    raw: dict
    dimensions: tuple[str, ...]
    questions: dict[str, str]  # question_id -> dimensión


def load_catalogs(d: Path) -> dict[str, Catalog]:
    out: dict[str, Catalog] = {}
    for f in sorted(d.glob("*.json")):
        raw = json.loads(f.read_text(encoding="utf-8"))
        out[raw["id"]] = Catalog(
            id=raw["id"], raw=raw,
            dimensions=tuple(x["code"] for x in raw["dimensions"]),
            questions={q["id"]: q["dimension"] for q in raw["questions"]},
        )
    if not out:
        raise RuntimeError(f"No hay catálogos en {d}")
    return out
