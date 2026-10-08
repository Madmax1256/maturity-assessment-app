// Cliente del servidor. El token sale del inicio de sesión: en modo local, la sesión que entrega
// el servidor con usuario y clave; en desarrollo, "dev:<usuario>"; con Entra ID, el token de la
// cuenta Microsoft. Sin VITE_API_URL el portal usa el mismo servidor que lo publica.

export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
export type AuthMode = 'local' | 'dev' | 'entra';

/** El servidor dice cómo se entra; VITE_AUTH_MODE solo sirve si no responde. */
export async function loadAuthMode(): Promise<AuthMode> {
  try {
    const r = await fetch(`${API_URL}/v1/auth/config`);
    if (r.ok) return ((await r.json()) as { mode: AuthMode }).mode;
  } catch { /* sin servidor: se usa la configuración del build */ }
  return (import.meta.env.VITE_AUTH_MODE as AuthMode | undefined) ?? 'dev';
}

const KEY = 'fs-portal-token';
let token: string | null = (() => { try { return sessionStorage.getItem(KEY); } catch { return null; } })();

export function setToken(t: string | null) {
  token = t;
  try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch { /* sin almacenamiento */ }
}
export const hasToken = () => Boolean(token);

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Se avisa cuando el servidor rechaza la sesión (vencida o cerrada), para volver a la entrada. */
export const SESSION_EXPIRED = 'fs-session-expired';

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token ?? ''}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    throw new ApiError(0, 'No se pudo conectar con el servidor.');
  }
  if (!r.ok) {
    let detail = '';
    try {
      const body = (await r.json()) as { detail?: unknown };
      detail = typeof body.detail === 'string' ? body.detail : '';
    } catch { /* sin cuerpo */ }
    if (r.status === 401 && token) dispatchEvent(new CustomEvent(SESSION_EXPIRED, { detail }));
    throw new ApiError(r.status, detail || `El servidor respondió ${r.status}`);
  }
  return (await r.json()) as T;
}

/** Descarga un archivo de evidencia con el token y devuelve una URL local para mostrarlo. */
export async function fileUrl(sha256: string): Promise<string> {
  const r = await fetch(`${API_URL}/v1/files/${sha256}`, { headers: { authorization: `Bearer ${token ?? ''}` } });
  if (!r.ok) throw new ApiError(r.status, 'No se pudo abrir el archivo');
  return URL.createObjectURL(await r.blob());
}

// ---------- tipos de las respuestas ----------

export type Role = 'administrador' | 'supervisor' | 'evaluador';
export interface Me { id: string; name: string | null; email: string | null; role: Role; mustChangePassword?: boolean; authMode?: AuthMode }

export interface ScoreRow { question_id: string; score: number | null; not_applicable: boolean }
export interface EvaluationRow {
  id: string; model_id: string; company: string; site: string | null; evaluated_on: string; status: 'draft' | 'closed';
  closed_at: string | null; updated_at: string; owner_user_id: string; owner_name: string | null; last_sync_at: string | null; answered: number;
  scopes?: { dimension: string; applies: boolean }[]; answers?: ScoreRow[];
}
export interface EvaluationDetail {
  evaluation: EvaluationRow & { interviewees: string[] };
  scopes: { dimension: string; applies: boolean; justification: string | null }[];
  answers: (ScoreRow & { na_justification: string | null; evidence_note: string | null; updated_at: string })[];
  evidence: { id: string; question_id: string | null; kind: string; mime: string; bytes: number; sha256: string; received_at: string }[];
  actions: { id: string; question_id: string | null; description: string; impact: number | null; effort: number | null; owner: string | null; due_on: string | null; status: string }[];
}
export interface UserRow { id: string; name: string | null; email: string | null; username?: string | null; must_change_password?: boolean; role: Role; status: 'active' | 'invited' | 'disabled'; first_seen_at: string; last_seen_at: string }
export interface DeviceRow { id: string; model: string | null; app_version: string | null; status: 'active' | 'revoked'; first_seen_at: string; last_sync_at: string | null; revoked_at: string | null; last_user_id: string | null; last_user_name: string | null }
export interface AuditRow { id: string; at: string; user_id: string; user_name: string | null; device_id: string | null; action: string; entity: string | null; entity_key: string | null; detail: unknown }
export interface ModelRow { id: string; title: string | null; source: { file: string; importedAt: string; sha256: string } | null; dimensions: number; questions: number; evaluations: number }
