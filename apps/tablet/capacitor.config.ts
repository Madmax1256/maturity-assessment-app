import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'cl.vantaz.fsdiagnostico',
  appName: 'Diagnóstico F&S',
  webDir: 'dist',
  // Modo local: el servidor corre en un computador de la red Wi‑Fi y responde por http en el
  // puerto 8000. La app se sirve desde https://localhost, así que hay que permitir esas llamadas.
  server: { cleartext: true },
  android: { allowMixedContent: true },
};

export default config;
