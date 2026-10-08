// A qué servidor sincroniza la tablet y con qué token.
// Modo local: la tablet se vincula una vez con un código que entrega el administrador en el portal;
// la dirección y el token quedan en la base cifrada (tabla device_link).
// Para pruebas y CI también se puede fijar en el build: VITE_SYNC_URL y VITE_SYNC_TOKEN=dev:<usuario>,
// que el servidor solo acepta con FS_AUTH_MODE=dev.

import { getLink, type Driver } from '@fs/db';

const BUILD_URL: string = import.meta.env.VITE_SYNC_URL ?? '';
const BUILD_TOKEN: string = import.meta.env.VITE_SYNC_TOKEN ?? '';

export interface SyncTarget { url: string; token: string; linked: boolean }

export function syncTarget(db: Driver): SyncTarget | null {
  const l = getLink(db);
  if (l) return { url: l.server_url, token: l.token, linked: true };
  return BUILD_URL && BUILD_TOKEN ? { url: BUILD_URL, token: BUILD_TOKEN, linked: false } : null;
}

/** Acepta "192.168.1.20:8000" o una dirección completa; sin puerto se usa el 8000 del servidor local. */
export function normalizeServerUrl(raw: string): string | null {
  let s = raw.trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.port && u.protocol === 'http:' && !raw.includes(':80')) u.port = '8000';
    return u.origin;
  } catch {
    return null;
  }
}

export interface PairResult { token: string; user: { id: string; name: string | null; role: string } }

export async function pairWithServer(url: string, code: string, deviceId: string): Promise<PairResult> {
  let r: Response;
  try {
    r = await fetch(`${url}/v1/auth/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceId, ...deviceInfo() }),
    });
  } catch {
    throw new Error('No se pudo conectar con el servidor. Revisa la dirección y que la tablet esté en la misma red Wi‑Fi que el computador.');
  }
  if (!r.ok) {
    let detail = '';
    try { detail = String(((await r.json()) as { detail?: unknown }).detail ?? ''); } catch { /* sin cuerpo */ }
    throw new Error(detail || `El servidor respondió ${r.status}`);
  }
  return (await r.json()) as PairResult;
}

declare const __APP_VERSION__: string;

/** Versión de la app y modelo de la tablet, para que el administrador los vea en el portal. */
export function deviceInfo() {
  const m = /Android [^;]*; ([^;)]+?)(?: Build|\))/.exec(navigator.userAgent);
  return { appVersion: __APP_VERSION__, deviceModel: m?.[1]?.trim() || undefined };
}
