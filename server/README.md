# Servidor de sincronización

API FastAPI + PostgreSQL que recibe lo que cada tablet envía cuando el evaluador confirma la sincronización.

| Ruta | Para qué |
|---|---|
| `POST /v1/files/missing` | La tablet pregunta qué fotos o documentos faltan en el servidor |
| `PUT /v1/files/{sha256}` | Sube un archivo; se verifica que su contenido coincida con la huella |
| `POST /v1/sync/push` | Envía la cola de cambios en orden y la bitácora; responde aceptado, rechazado (con motivo) o conflicto por cada cambio |
| `GET /v1/me` | Persona que entró y su rol |
| `GET /v1/evaluations[?scores=true]`, `GET /v1/evaluations/{id}` | Evaluaciones visibles: el evaluador ve las suyas; supervisor y administrador, todas |
| `GET /v1/files/{sha256}` | Descarga una evidencia de una evaluación visible |
| `GET /v1/models`, `GET /v1/models/{id}` | Versiones del modelo y catálogo publicado |
| `GET/POST /v1/admin/users`, `PATCH /v1/admin/users/{id}` | Personas, invitaciones, rol y acceso (solo administrador) |
| `GET /v1/admin/devices`, `POST /v1/admin/devices/{id}/revoke` | Tablets y quitar acceso a una tablet (solo administrador) |
| `GET /v1/admin/audit` | Bitácora del servidor y de las tablets (solo administrador) |

Acceso: solo entra quien fue invitado desde el portal (la invitación se activa la primera vez que la persona entra con ese correo) o quien está en `FS_BOOTSTRAP_ADMINS`. Una persona sin acceso o una tablet con acceso quitado no puede sincronizar.

Reglas: cada cambio se aplica una sola vez aunque se reenvíe; solo el propietario modifica su evaluación; una evaluación cerrada es de solo lectura salvo su plan de acción; el cierre se valida otra vez en el servidor; la evidencia y la bitácora solo se agregan. Hay conflicto solo cuando otro dispositivo cambió la misma respuesta; el propietario decide en la tablet.

## Configuración

| Variable | Valor |
|---|---|
| `FS_DATABASE_URL` | Conexión a PostgreSQL |
| `FS_AUTH_MODE` | `local` (usuario y clave en este servidor; ver "Modo local"), `entra` (cuentas Microsoft de la empresa) o `dev` (acepta `Bearer dev:<usuario>`; solo desarrollo) |
| `FS_ENTRA_TENANT_ID`, `FS_ENTRA_AUDIENCE` | Tenant de Vantaz y el identificador de la API registrada en Entra ID |
| `FS_BLOB_DIR` | Carpeta de evidencias (en Azure, un volumen; el adaptador de Blob Storage usa la misma interfaz en `app/storage.py`) |
| `FS_CORS_ORIGINS` | Orígenes permitidos, separados por coma (el portal web) |
| `FS_BOOTSTRAP_ADMINS` | Correos (o ids) que entran como administradores sin invitación; para el primer acceso |
| `FS_AUTO_ENROLL_ROLE` | Opcional. Si se define (por ejemplo `evaluador`), cualquier cuenta válida entra con ese rol sin invitación |
| `FS_MAX_FILE_MB` | Tamaño máximo por archivo (25 por omisión) |
| `FS_PORTAL_DIR` | Carpeta del portal compilado (`apps/portal/dist`). Si se define, el servidor lo publica en `/` |
| `FS_BACKUP_DIR` | Modo local: carpeta de respaldos automáticos (uno al iniciar si el último tiene más de 20 horas, y uno cada 24 horas) |
| `FS_BACKUP_KEEP` | Respaldos de la base que se conservan (30 por omisión) |
| `FS_PG_BIN` | Carpeta `bin` de PostgreSQL, si `pg_dump` no está en el PATH |

## Modo local

Para usar la app sin Entra ID ni Azure: el servidor y el portal corren en un computador de la
oficina y las tablets sincronizan por la red Wi‑Fi.

- Cada persona entra al portal con usuario y clave. El administrador la crea con una clave inicial
  y la persona debe cambiarla al entrar. Tras 5 intentos fallidos el usuario queda bloqueado 5
  minutos. Las sesiones del portal duran 12 horas. Solo se guardan hashes (scrypt para claves,
  SHA-256 para tokens y códigos).
- Cada tablet se vincula una vez con un código de un solo uso que el administrador genera en
  Usuarios y accesos (vence en 15 minutos). La tablet guarda su token en la base cifrada y solo
  sirve para esa tablet. Quitar acceso a la tablet o a la persona lo invalida.
- La conexión con las tablets es http dentro de la red local; conviene una red Wi‑Fi con clave y
  sin invitados.

```bash
cd server
export FS_DATABASE_URL=postgresql://postgres@localhost:5432/fs FS_AUTH_MODE=local
python -m app.admin_cli crear-admin --usuario max --nombre "Max Gajardo"     # primera vez
FS_PORTAL_DIR=../apps/portal/dist FS_BACKUP_DIR=~/Respaldos/FS \
  python -m uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
python -m app.admin_cli respaldo --carpeta ~/Respaldos/FS                    # respaldo manual
python -m app.admin_cli restaurar --carpeta ~/Respaldos/FS                   # sobre una base vacía
```

El portal queda en `http://<ip-del-computador>:8000/`. Al generar un código, el portal muestra la
dirección que hay que escribir en la tablet.

## Desarrollo

```bash
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
FS_TEST_DATABASE_URL=postgresql://postgres@localhost:5432/fs_test .venv/bin/python -m pytest -q
FS_DATABASE_URL=postgresql://postgres@localhost:5432/fs FS_AUTH_MODE=dev .venv/bin/uvicorn app.main:create_app --factory --port 8000
```

El esquema se crea solo al arrancar (`app/schema.sql`).
