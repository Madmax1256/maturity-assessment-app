/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dirección del servidor (server/). */
  readonly VITE_API_URL?: string;
  /** "dev" muestra una entrada con usuario de desarrollo; "entra" usará Microsoft Entra ID. */
  readonly VITE_AUTH_MODE?: string;
}
