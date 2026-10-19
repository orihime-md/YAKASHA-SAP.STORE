# Yakasha SAP + WAHA GOWS in one Render web service.
# WAHA's API stays private on localhost; only Yakasha's app/API is exposed by Render.
FROM devlikeapro/waha:gows-2026.8.2

WORKDIR /yakasha

COPY backend/package*.json ./backend/
RUN cd /yakasha/backend && npm install --omit=dev --no-audit --no-fund

COPY backend/ ./backend/
COPY frontend/ ./frontend/
COPY render-entrypoint.sh ./render-entrypoint.sh
RUN chmod +x /yakasha/render-entrypoint.sh

ENV WHATSAPP_DEFAULT_ENGINE=GOWS \
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
