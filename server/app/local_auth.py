"""Modo local (FS_AUTH_MODE=local): cuentas con usuario y clave guardadas en este servidor.

Pensado para correr en el computador del administrador, sin depender de Entra ID. El portal entra
con usuario y clave y recibe una sesión de 12 horas; cada tablet se vincula una vez con un código de
un solo uso y recibe un token propio, que deja de servir cuando se revoca la tablet o se quita el
acceso a la persona. En la base solo se guarda el hash de claves, tokens y códigos.
"""

from __future__ import annotations

import base64
import socket
import hashlib
import hmac
import secrets
import threading
import time
from dataclasses import dataclass

from fastapi import HTTPException
from psycopg import Connection

WEB_SESSION_HOURS = 12
PAIRING_MINUTES = 15
MIN_PASSWORD = 10
MAX_FAILS = 5
LOCK_SECONDS = 300
# Sin letras ni números que se confundan al dictarlos (0/O, 1/I/L).
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"

_SCRYPT = {"n": 2**14, "r": 8, "p": 1, "dklen": 32}


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, **_SCRYPT)
    return "scrypt$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(dk).decode()


def verify_password(password: str, stored: str | None) -> bool:
    if not stored or not stored.startswith("scrypt$"):
        # Igual se calcula un hash para no revelar por el tiempo de respuesta si el usuario existe.
        hashlib.scrypt(password.encode(), salt=b"0" * 16, **_SCRYPT)
        return False
    _, salt, dk = stored.split("$")
    got = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt), **_SCRYPT)
    return hmac.compare_digest(got, base64.b64decode(dk))


def check_password_policy(password: str) -> None:
    if len(password) < MIN_PASSWORD:
        raise HTTPException(400, f"La clave debe tener al menos {MIN_PASSWORD} caracteres")


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return "fs_" + secrets.token_urlsafe(32)


def new_pairing_code() -> str:
    raw = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    return f"{raw[:4]}-{raw[4:]}"


def normalize_code(code: str) -> str:
    c = "".join(ch for ch in code.upper() if ch.isalnum())
    return f"{c[:4]}-{c[4:]}"


@dataclass(frozen=True)
class TokenInfo:
    user_id: str
    kind: str
    device_id: str | None


def lookup_token(conn: Connection, token: str) -> TokenInfo:
    row = conn.execute("""SELECT t.user_id, t.kind, t.device_id, t.revoked_at, (t.expires_at IS NOT NULL AND t.expires_at <= now()) AS expired
                          FROM auth_token t WHERE t.token_hash = %s""", (token_hash(token),)).fetchone()
    if row is None or row["expired"]:
        raise HTTPException(401, "Sesión vencida o inválida. Vuelve a entrar.")
    if row["revoked_at"] is not None:
        if row["kind"] == "device":
            raise HTTPException(403, "Esta tablet fue desvinculada. Pide un código nuevo al administrador.")
        raise HTTPException(401, "Sesión vencida o inválida. Vuelve a entrar.")
    conn.execute("UPDATE auth_token SET last_used_at = now() WHERE token_hash = %s", (token_hash(token),))
    return TokenInfo(row["user_id"], row["kind"], row["device_id"])


class LoginThrottle:
    """Tras varios intentos fallidos, bloquea ese usuario unos minutos (en memoria del proceso)."""

    def __init__(self) -> None:
        self._fails: dict[str, tuple[int, float]] = {}
        self._lock = threading.Lock()

    def check(self, username: str) -> None:
        with self._lock:
            n, until = self._fails.get(username, (0, 0.0))
            if n >= MAX_FAILS and until > time.monotonic():
                raise HTTPException(429, "Demasiados intentos fallidos. Espera unos minutos e intenta de nuevo.")

    def fail(self, username: str) -> None:
        with self._lock:
            n, _ = self._fails.get(username, (0, 0.0))
            self._fails[username] = (n + 1, time.monotonic() + LOCK_SECONDS)

    def reset(self) -> None:
        with self._lock:
            self._fails.clear()

    def ok(self, username: str) -> None:
        with self._lock:
            self._fails.pop(username, None)


def lan_addresses() -> list[str]:
    """Direcciones IPv4 de este computador en la red local, para que las tablets lo encuentren."""
    found: list[str] = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sk:
            sk.connect(("10.255.255.255", 1))  # no envía nada; solo elige la interfaz de salida
            found.append(sk.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            found.append(str(info[4][0]))
    except OSError:
        pass
    return [ip for ip in dict.fromkeys(found) if not ip.startswith("127.")]
