# Servidor de sincronización

API FastAPI + PostgreSQL que recibe lo que cada tablet envía cuando el evaluador confirma la sincronización.

| Ruta | Para qué |
|---|---|
| `POST /v1/files/missing` | La tablet pregunta qué fotos o documentos faltan en el servidor |
| `PUT /v1/files/{sha256}` | Sube un archivo; se verifica que su contenido coincida con la huella |
| `POST /v1/sync/push` | Envía la cola de cambios en orden y la bitácora; responde aceptado, rechazado (con motivo) o conflicto por cada cambio |
| `GET /v1/evaluations`, `GET /v1/evaluations/{id}` | Consulta de las evaluaciones propias (base del portal web) |
| `GET /v1/files/{sha256}` | Descarga una evidencia de una evaluación propia |
| `GET /v1/models/{id}` | Catálogo publicado |

Reglas: cada cambio se aplica una sola vez aunque se reenvíe; solo el propietario modifica su evaluación; una evaluación cerrada es de solo lectura salvo su plan de acción; el cierre se valida otra vez en el servidor; la evidencia y la bitácora solo se agregan. Hay conflicto solo cuando otro dispositivo cambió la misma respuesta; el propietario decide en la tablet.

## Configuración

| Variable | Valor |
|---|---|
| `FS_DATABASE_URL` | Conexión a PostgreSQL |
| `FS_AUTH_MODE` | `entra` (producción) o `dev` (acepta `Bearer dev:<usuario>`; solo desarrollo) |
| `FS_ENTRA_TENANT_ID`, `FS_ENTRA_AUDIENCE` | Tenant de Vantaz y el identificador de la API registrada en Entra ID |
| `FS_BLOB_DIR` | Carpeta de evidencias (en Azure, un volumen; el adaptador de Blob Storage usa la misma interfaz en `app/storage.py`) |
| `FS_CORS_ORIGINS` | Orígenes permitidos, separados por coma (el portal web) |
| `FS_MAX_FILE_MB` | Tamaño máximo por archivo (25 por omisión) |

## Desarrollo

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
FS_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/fs_test .venv/bin/python -m pytest -q
FS_DATABASE_URL=postgresql://postgres@localhost:5432/fs FS_AUTH_MODE=dev .venv/bin/uvicorn app.main:create_app --factory --port 8000
```

El esquema se crea solo al arrancar (`app/schema.sql`).
