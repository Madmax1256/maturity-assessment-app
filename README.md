# maturity-assessment-app

Aplicación de evaluación de madurez organizacional con 12 dimensiones, 128 preguntas y 5 niveles de madurez. Importación desde Excel, dashboard, análisis histórico y captura offline en terreno.

## Diagnóstico de Fatiga y Somnolencia (Vantaz): MVP

App offline-first para aplicar en terreno, desde tablets Samsung con Android, el diagnóstico de madurez en gestión de fatiga y somnolencia (modelo V01: 12 dimensiones, 128 preguntas). La especificación completa está en el documento "Especificación App Diagnóstico de Fatiga y Somnolencia".

### Estado: primer incremento

| Paquete | Qué hace | Requisitos que cubre |
|---|---|---|
| `packages/model` | Tipos del catálogo y catálogo `V01` importado desde el Excel | RF-01, RN-T01 |
| `packages/engine` | Motor de cálculo puro: % por pregunta, dimensión y global, niveles, brechas, prioridad y validación de cierre | RN-01 a RN-12, RF-08, cierre |
| `packages/db` | Esquema SQLite local, guardado con cola de salida en la misma transacción, evidencia solo de agregar, resultados y conflictos de sincronización, bitácora | Sección 7 (offline y sincronización) |
| `tools/import-model.ts` | Importa el Excel y entrega un informe de validación; no escribe nada si hay errores bloqueantes | RF-01 |
| `tools/parity/make_cases.py` | Genera casos de paridad recalculando el Excel real con LibreOffice | Gate "resultados = Excel corregido" |

Pendiente para los siguientes incrementos: la app tablet (React + Ionic + Capacitor, SQLCipher), la API de sincronización (FastAPI + PostgreSQL + Blob en Azure), el portal web y el informe PDF.

### Reglas de cálculo aprobadas (Max, 2026-10-08)

- Global = promedio simple de las dimensiones que aplican; el método ponderado queda configurable.
- Nivel 5 solo con 100 % exacto.
- "No aplica" por pregunta, con justificación obligatoria; la pregunta sale del promedio.
- Con preguntas pendientes el resultado se muestra como preliminar (el Excel muestra "EVA").

### Uso

```bash
npm install
npm test                 # 68 pruebas: catálogo, motor, paridad con el Excel y base local
npm run typecheck
npm run import-model -- fixtures/Diagnostico_FS_V01.xlsx V01
python3 tools/parity/make_cases.py   # requiere openpyxl y LibreOffice
```

El motor se validó contra 26 escenarios en los que el Excel V01 se recalculó con LibreOffice: 20 completos (incluidos todo 0 % y todo 100 %, y dimensiones que no aplican) y 6 con preguntas pendientes. Los porcentajes coinciden con 9 decimales.
