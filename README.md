# maturity-assessment-app

Aplicación de evaluación de madurez organizacional con 12 dimensiones, 128 preguntas y 5 niveles de madurez. Importación desde Excel, dashboard, análisis histórico y captura offline en terreno.

## Diagnóstico de Fatiga y Somnolencia (Vantaz): MVP

App offline-first para aplicar en terreno, desde tablets Samsung con Android, el diagnóstico de madurez en gestión de fatiga y somnolencia (modelo V01: 12 dimensiones, 128 preguntas). La especificación completa está en el documento "Especificación App Diagnóstico de Fatiga y Somnolencia".

### Estado: incrementos 1 a 5

| Paquete | Qué hace | Requisitos que cubre |
|---|---|---|
| `packages/model` | Tipos del catálogo y catálogo `V01` importado desde el Excel | RF-01, RN-T01 |
| `packages/engine` | Motor de cálculo puro: % por pregunta, dimensión y global, niveles, brechas, prioridad y validación de cierre | RN-01 a RN-12, RF-08, cierre |
| `packages/db` | Esquema SQLite local, guardado con cola de salida en la misma transacción, evidencia solo de agregar, resultados y conflictos de sincronización, bitácora | Sección 7 (offline y sincronización) |
| `tools/import-model.ts` | Importa el Excel y entrega un informe de validación; no escribe nada si hay errores bloqueantes | RF-01 |
| `tools/parity/make_cases.py` | Genera casos de paridad recalculando el Excel real con LibreOffice | Gate "resultados = Excel corregido" |
| `server` | Servidor de sincronización (FastAPI + PostgreSQL): recibe archivos y cambios confirmados desde la tablet, valida propietario, catálogo y cierre, detecta conflictos; ver `server/README.md` | Sección 7 |
| Modo local (`FS_AUTH_MODE=local`) | Sin Entra ID: usuario y clave en el portal, tablets vinculadas con un código de un solo uso, portal publicado por el mismo servidor y respaldos automáticos; ver `server/README.md` | Decisión de Max, 2026-10-08 |
| `apps/portal` | Portal web (navegador): panel, evaluaciones con resultados, respuestas, evidencia y plan; usuarios e invitaciones, tablets, modelo y bitácora para el administrador | Secciones 6 y 8 |
| `packages/ui` | Estilos de marca Vantaz y componentes de resultados compartidos por la tablet y el portal | Sección 8 |
| `apps/tablet` | App de terreno (React + Vite, empaquetada con Capacitor para Android): evaluaciones, antecedentes y alcance, captura con No aplica y evidencia, resultados, plan de acción y cola de sincronización | RF-02 a RF-09, sección 7 |

Pendiente para los siguientes incrementos: instalador para el computador del administrador, el informe PDF y la exportación a Excel. Entra ID y Azure quedan como opción futura (el servidor ya valida tokens de Entra).

### App de tablet: cómo guarda los datos

- La base local es SQLite compilado a WebAssembly (sql.js) y usa el mismo código de `packages/db` que las pruebas.
- Después de cada cambio se guarda una copia completa de la base cifrada con AES-GCM de 256 bits en el almacenamiento del dispositivo. La llave se genera en la tablet y no es exportable. Las fotos y documentos de evidencia se cifran igual, cada uno por separado.
- Funciona sin conexión: la fuente Open Sans y todos los recursos van dentro de la app.
- Nada se envía solo. La pantalla Sincronizar muestra cada cambio en cola y envía solo cuando el evaluador confirma. Primero sube los archivos que falten, luego los cambios en orden y al final la bitácora. Si otro dispositivo cambió una respuesta, el evaluador elige cuál queda; si el servidor rechaza un cambio, se muestra el motivo y se puede reintentar.
- El servidor se configura en el build con `VITE_SYNC_URL`; mientras no esté Entra ID se usa `VITE_SYNC_TOKEN=dev:<usuario>`, que el servidor acepta solo en modo de desarrollo.

Diferencias con la especificación, aprobadas por Max (2026-10-08): se usa React sin Ionic (los estilos vienen del prototipo aprobado) y sql.js con AES-GCM en lugar de SQLCipher, porque así el mismo código de base corre en la tablet, en el navegador y en CI.

### Reglas de cálculo aprobadas (Max, 2026-10-08)

- Global = promedio simple de las dimensiones que aplican; el método ponderado queda configurable.
- Nivel 5 solo con 100 % exacto.
- "No aplica" por pregunta, con justificación obligatoria; la pregunta sale del promedio.
- Con preguntas pendientes el resultado se muestra como preliminar (el Excel muestra "EVA").

### Uso

```bash
npm install
npm test                 # 79 pruebas: catálogo, motor, paridad con el Excel, base local y sincronización
npm run typecheck
npm run dev:tablet       # app de tablet en el navegador (http://localhost:5173)
npm run build:tablet     # build para Android en apps/tablet/dist
npm run dev:portal       # portal web (http://localhost:5174); VITE_API_URL apunta al servidor
node apps/tablet/e2e/smoke.cjs   # prueba de humo sobre el build servido con `npm run preview -w apps/tablet`
npm run import-model -- fixtures/Diagnostico_FS_V01.xlsx V01
python3 tools/parity/make_cases.py   # requiere openpyxl y LibreOffice
```

El motor se validó contra 26 escenarios en los que el Excel V01 se recalculó con LibreOffice: 20 completos (incluidos todo 0 % y todo 100 %, y dimensiones que no aplican) y 6 con preguntas pendientes. Los porcentajes coinciden con 9 decimales.

Para generar el APK: `cd apps/tablet && npx cap add android` (una vez), luego `npm run android:sync` y compilar en Android Studio.
