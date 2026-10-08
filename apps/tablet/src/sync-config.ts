// Dirección del servidor de sincronización y token de acceso.
// Mientras no esté configurado el inicio de sesión con Entra ID, el build usa un token de
// desarrollo (VITE_SYNC_TOKEN=dev:<usuario>), que el servidor solo acepta con FS_AUTH_MODE=dev.

export const SYNC_URL: string = import.meta.env.VITE_SYNC_URL ?? '';
const TOKEN: string = import.meta.env.VITE_SYNC_TOKEN ?? '';

export const syncConfigured = () => Boolean(SYNC_URL && TOKEN);
export const getToken = async () => TOKEN;

declare const __APP_VERSION__: string;

/** Versión de la app y modelo de la tablet, para que el administrador los vea en el portal. */
export function deviceInfo() {
  const m = /Android [^;]*; ([^;)]+?)(?: Build|\))/.exec(navigator.userAgent);
  return { appVersion: __APP_VERSION__, deviceModel: m?.[1]?.trim() || undefined };
}
