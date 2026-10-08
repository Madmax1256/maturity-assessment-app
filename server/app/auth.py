"""Identidad del usuario a partir del token. Producción: Microsoft Entra ID (OIDC, RS256)."""

from dataclasses import dataclass

import jwt
from fastapi import HTTPException, Request

from .config import Settings


@dataclass(frozen=True)
class User:
    id: str
    name: str | None = None
    email: str | None = None
    roles: tuple[str, ...] = ()


class Authenticator:
    def __init__(self, s: Settings):
        self.s = s
        self._jwks: jwt.PyJWKClient | None = None
        if s.auth_mode == "entra":
            if not (s.entra_tenant_id and s.entra_audience):
                raise RuntimeError("FS_AUTH_MODE=entra requiere FS_ENTRA_TENANT_ID y FS_ENTRA_AUDIENCE")
            self._jwks = jwt.PyJWKClient(f"https://login.microsoftonline.com/{s.entra_tenant_id}/discovery/v2.0/keys", cache_keys=True)
        elif s.auth_mode != "dev":
            raise RuntimeError(f"FS_AUTH_MODE desconocido: {s.auth_mode}")

    def __call__(self, request: Request) -> User:
        h = request.headers.get("authorization", "")
        if not h.lower().startswith("bearer "):
            raise HTTPException(401, "Falta el token de acceso")
        token = h[7:].strip()
        if self.s.auth_mode == "dev":
            if not token.startswith("dev:") or len(token) < 5:
                raise HTTPException(401, "Token de desarrollo inválido")
            return User(id=token[4:], name=token[4:], email=token[4:])
        assert self._jwks is not None
        try:
            key = self._jwks.get_signing_key_from_jwt(token).key
            c = jwt.decode(token, key, algorithms=["RS256"], audience=self.s.entra_audience,
                           issuer=f"https://login.microsoftonline.com/{self.s.entra_tenant_id}/v2.0",
                           options={"require": ["exp", "iat", "oid"]})
        except jwt.PyJWTError as e:
            raise HTTPException(401, "Token inválido o vencido") from e
        return User(id=c["oid"], name=c.get("name"), email=c.get("preferred_username"), roles=tuple(c.get("roles", [])))
