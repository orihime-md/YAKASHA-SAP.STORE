# Yakasha SAP — all-in-one WAHA linked-device prototype V8

A lightweight mobile-first web app and Node.js backend with a Render Blueprint. The frontend is plain HTML/CSS/JavaScript; the backend uses Node's built-in HTTP server plus a small PostgreSQL pool.

## Project folders

- `frontend/` — responsive WhatsApp-inspired UI, initial phone-number pairing screen, local/offline demo screen, chats, group/community prototype pages, attachment composer, and admin panel entry.
- `backend/` — WAHA pairing and session-status integration, authenticated text/media sending, incoming webhook handling, linked-message persistence, protected media proxy, and admin API.
- `Dockerfile` and `render-entrypoint.sh` — run WAHA GOWS and Yakasha’s Node backend in one Render web service, following the same all-in-one deployment pattern as the Orihime MD reference.
- `render.yaml` — provisions the Docker web service and PostgreSQL automatically, generates WAHA/API webhook/session secrets, and asks you to choose the real admin password.

## Real account pairing

1. Open Yakasha SAP over HTTPS.
2. Enter the complete phone number for an account you own or are authorized to link.
3. The backend requests a real pairing code from the configured WAHA service.
4. On the original phone, open WhatsApp → Settings → Linked devices → Link a device → Link with phone number instead; enter the code shown in Yakasha SAP.
5. The frontend checks the session status until WAHA reports `WORKING`.
6. Incoming message webhooks must be able to reach `https://YOUR-YAKASHA-SERVICE/webhooks/waha?secret=...`. Once linked, chat/message polling reads messages for that account and text/image/audio/video send requests go through the same WAHA session.

## Incoming and outgoing media

- Outgoing media uses WAHA's `POST /api/sendImage`, `POST /api/sendVideo`, and `POST /api/sendVoice` APIs with base64 data. The lightweight Yakasha API accepts media up to 8 MB by default and forwards the media payload directly; it does not transcode media itself.
- Incoming webhook metadata stores the media type, MIME type, file name, provider message ID, and media URL. The browser requests actual media through `/api/link/media` using its linked-session token; WAHA's private API key and internal media URL are not passed to the browser.
- For incoming attachments, configure WAHA media downloads using `WAHA_EVENTS_DOWNLOAD_MEDIA=true` for webhook events and `WAHA_API_DOWNLOAD_MEDIA=true` for API retrieval (these are the current granular settings; `WHATSAPP_DOWNLOAD_MEDIA` is deprecated). Ensure WAHA media URLs are reachable from the Yakasha backend and do not use a mimetype filter that excludes all media. If webhook media URLs are missing, Yakasha attempts a `downloadMedia=true` message lookup. WAHA media cache lifetime/storage determine how long old attachments can be fetched. See the [WAHA configuration guide](https://waha.devlike.pro/docs/how-to/config/) and [receive-message guide](https://waha.devlike.pro/docs/how-to/receive-messages/).
- Images supported by this UI/API are JPEG, PNG, and WebP. Videos are MP4, WebM or MOV; non-MP4 conversion may depend on the WAHA engine/tier. Audio is sent through WAHA's voice endpoint and non-Opus formats may require WAHA conversion support. If WAHA rejects a particular codec or format, convert the file on-device before sending or use a compatible format. WAHA's supported media endpoints/formats vary by installed engine/tier; see its current messaging docs: https://github.com/devlikeapro/waha-docs/blob/main/content/docs/how-to/send-messages/index.md.
- Incoming media retrieval is capped at 25 MB per response; adjust only after considering memory limits. Large media and conversions should not be handled on Render Free.

## Offline demo credentials

Offline demo access is only for **local prototype testing**. The literal demo values live in backend configuration and this README, not in the HTML/CSS/JavaScript frontend sources. The server sends only SHA-256 verifier hashes to the browser while it is online; the browser caches those hashes locally to enable testing after it loses connection.

- **Offline demo pairing code:** `YAKASHA-OFFLINE-PAIR`
- **Offline demo admin password:** `YAKASHA-OFFLINE-ADMIN`

Important limitations:

1. Open the HTTPS app once while the backend is reachable so the browser can cache the app shell and verifier hashes. The service worker caches the UI files, not API results or linked messages.
2. After the backend becomes unreachable, requesting a pairing code offers an **Offline prototype mode** screen. Enter the demo pairing code from this section. It opens local sample chats; it does not pair a real WhatsApp account or deliver messages.
3. The offline demo admin password opens a browser-only status mock. If the backend is reachable, both demo credentials are disabled and the real backend pairing/admin authentication path is used.
4. Offline verifier hashes in browser storage are only a prototype gate, not production-grade authentication. Don't use demo credentials for security or real administrator access. The real `ADMIN_PASSWORD` and `SESSION_SECRET` remain server-side.
5. Small attachments (up to 1.2 MB) can be saved locally in offline demo mode for UI testing. Real media delivery requires the WAHA connection. For a real linked account, the app can queue text messages while disconnected and retry them when connectivity returns. Small media files up to 1 MB can be queued locally; larger attachments require reconnecting first. The app caches the most recently loaded linked chat list and message history for offline reading, subject to browser storage limits.

## Data-off / airplane-mode behavior

A browser running on a phone with all internet access completely disabled cannot instantly receive network messages or transmit a newly composed message. Yakasha can show previously cached linked chats/messages and queue text or small media locally for retry after connectivity returns. Anything composed only on the offline phone must reach the server after the phone reconnects; a local queue is not immediate delivery.

The behavior you described for Orihime MD is different: when its **server-side linked WhatsApp session** remains connected to the internet, the backend can receive messages and send configured/automated responses even if your personal phone is offline or in airplane mode. Yakasha’s linked session can still receive messages on the server, and sent/received messages can be stored for the app to sync later. Yakasha does not import Orihime’s bot commands or automatic reply logic, so it will not automatically respond to inbound messages unless that feature is added separately. The WAHA host and session must remain online. Turning mobile data off is fine if the phone has Wi-Fi; with no network connection at all, the app UI cannot live-send or live-receive.

## Render setup — all-in-one (no separate WAHA host)

1. Download and extract this ZIP. Upload the **contents** of the extracted folder to a new GitHub repository, keeping `render.yaml`, `Dockerfile`, `render-entrypoint.sh`, `backend/`, and `frontend/` at the repository root level.
2. In Render, select **New → Blueprint**, connect the GitHub repository, and apply the Blueprint.
3. Render creates the Yakasha Docker web service and PostgreSQL database. It automatically generates `WAHA_API_KEY`, `WEBHOOK_SECRET`, and `SESSION_SECRET`. Choose your own strong `ADMIN_PASSWORD` when prompted (or add it under the service’s Environment page if Render asks after creation).
4. You do **not** need to provide `WAHA_URL` or `WAHA_API_KEY`: WAHA GOWS is launched inside the same container and the backend uses `http://127.0.0.1:3000`. The generated API key is used by both processes.
5. Wait for deployment. Open `https://YOUR-SERVICE.onrender.com/api/health`. For live pairing, expect `status: "ok"`, `database: "connected"`, `mode: "linked-device"`, `pairingConfigured: true`. If the service fails to start, inspect Render logs for WAHA readiness or Docker build errors.
6. Open the main service URL for Yakasha SAP. The real admin page is `/admin`; sign in with the `ADMIN_PASSWORD` you chose.
7. Start pairing only with a WhatsApp account you own or are authorized to link. Verify actual code delivery and incoming/outgoing messages on a live account; successful deployment alone does not guarantee all WAHA features work with every engine release.

### Environment variables

Render supplies `PORT` and `RENDER_EXTERNAL_URL`. The Blueprint generates `WAHA_API_KEY`, `WEBHOOK_SECRET`, and `SESSION_SECRET`, and wires `DATABASE_URL` plus `WHATSAPP_SESSIONS_POSTGRESQL_URL` to the created PostgreSQL database. You choose `ADMIN_PASSWORD`. `WAHA_URL` is set to the internal localhost address because the WAHA engine is in the same Docker container. No external WAHA service is required for this bundled mode.

### Free-plan limitations

This Blueprint uses a Render Free web service and Free PostgreSQL database. Free web services may sleep when idle, and free PostgreSQL databases have a limited lifetime. WAHA GOWS plus Yakasha also share the web service’s available memory, so the Blueprint sets `MAX_ACTIVE_LINKS=1` as a conservative starting point. A Render Free service has no persistent disk; WAHA linked-device credentials stored on the container filesystem may be lost after a redeploy or restart, potentially requiring re-pairing. This is a testing/hobby setup, not a guarantee of permanent 24/7 WhatsApp connectivity. Plan for persistent storage and paid resources before relying on it for important messages.

## Current boundaries

This V8 keeps the existing prototype/UI and adds an all-in-one WAHA GOWS Docker deployment path. The backend integration adds outgoing image/audio/video forwarding, incoming media metadata and an authenticated proxy, and offline demo entry. The integration is wired to WAHA and passed an end-to-end mock-API smoke test for pairing, text send, incoming image metadata/media proxy, and outgoing image/video/audio endpoint routing. The all-in-one container startup and real integration still need a deployment test against the exact running WAHA engine/API version and a real account before claiming live delivery and every codec work end-to-end. It does not import full pre-existing chat history, and live group/community administration, calls, status updates, and cross-account community synchronization remain unfinished prototype behavior.

Only link accounts you own or have permission to use. Don't share pairing codes, linked-session tokens, WAHA API keys, or the real admin password.

## Local checks

```sh
node --check backend/server.js
node --check frontend/app.js
node --check frontend/pairing.js
node --check frontend/sw.js
```
