# Imagen del servidor de sincronización (Azure App Service o Container Apps).
# Construir desde la raíz del repositorio: docker build -f server/Dockerfile -t fs-sync .
FROM python:3.13-slim
WORKDIR /srv
COPY server/requirements.txt server/requirements.txt
RUN pip install --no-cache-dir -r server/requirements.txt
COPY server/app server/app
COPY packages/model/catalog packages/model/catalog
ENV FS_CATALOG_DIR=/srv/packages/model/catalog FS_BLOB_DIR=/data/blobs
WORKDIR /srv/server
EXPOSE 8000
USER nobody
CMD ["uvicorn", "app.main:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
