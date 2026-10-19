# Yakasha SAP + WAHA GOWS in one Render web service.
# Supports a flat repository by creating compatibility backend/frontend paths.
FROM devlikeapro/waha:gows-2026.8.2

WORKDIR /yakasha
COPY . /yakasha/source/

RUN set -eux; \
    mkdir -p /yakasha/backend /yakasha/frontend; \
    cp -a /yakasha/source/. /yakasha/backend/; \
    cp -a /yakasha/source/. /yakasha/frontend/; \
    if [ -f /yakasha/backend/package.json ]; then \
      cd /yakasha/backend && npm install --omit=dev --no-audit --no-fund; \
    else \
      echo "ERROR: No root-level package.json found; cannot install backend dependencies."; \
      exit 1; \
    fi; \
    if [ ! -f /yakasha/source/render-entrypoint.sh ]; then \
      echo "ERROR: render-entrypoint.sh is missing from the repository root."; \
      exit 1; \
    fi; \
    cp /yakasha/source/render-entrypoint.sh /yakasha/render-entrypoint.sh; \
    chmod +x /yakasha/render-entrypoint.sh

ENV NODE_ENV=production \
    WHATSAPP_DEFAULT_ENGINE=GOWS \
    WHATSAPP_API_PORT=3000 \
    WHATSAPP_API_HOSTNAME=127.0.0.1 \
    WAHA_LOCAL_STORE_BASE_DIR=/app/.sessions \
    WHATSAPP_FILES_FOLDER=/app/.media \
    WHATSAPP_FILES_LIFETIME=0 \
    WAHA_PRINT_QR=false \
    WAHA_WORKER_RESTART_SESSIONS=true \
    WAHA_DASHBOARD_ENABLED=false \
    WHATSAPP_SWAGGER_ENABLED=false

EXPOSE 10000
CMD ["/yakasha/render-entrypoint.sh"]
