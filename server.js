import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(__dirname, '../frontend');
const port = clampInt(process.env.PORT, 10000, 1, 65535);
const adminPassword = process.env.ADMIN_PASSWORD || '';
const tokenSecret = process.env.SESSION_SECRET || '';
const tokenTtlSeconds = clampInt(process.env.ADMIN_TOKEN_TTL_SECONDS, 604800, 300, 604800);
const bodyLimit = parseSize(process.env.REQUEST_BODY_LIMIT || '32kb', 32768);
const mediaBodyLimit = parseSize(process.env.MEDIA_REQUEST_BODY_LIMIT || '12mb', 12 * 1024 * 1024);
const maxMediaBytes = clampInt(process.env.MEDIA_MAX_BYTES, 8 * 1024 * 1024, 128 * 1024, 20 * 1024 * 1024);
// Demo-only credentials are backend configuration. Only their hashes are exposed to the app for offline testing.
const offlineDemoPairingCode = process.env.OFFLINE_DEMO_PAIRING_CODE || 'YAKASHA-OFFLINE-PAIR';
const offlineDemoAdminPassword = process.env.OFFLINE_DEMO_ADMIN_PASSWORD || 'YAKASHA-OFFLINE-ADMIN';
const memoryOutbox = [];
const limiterBuckets = new Map();
let pool = null;
let dbReady = false;
const linkedSessionsMemory = new Map();
const linkedMessagesMemory = new Map();
const pairingInFlight = new Map();
const WAHA_URL = String(process.env.WAHA_URL || '').replace(/\/$/, '');
const WAHA_API_KEY = process.env.WAHA_API_KEY || '';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const MAX_ACTIVE_LINKS = clampInt(process.env.MAX_ACTIVE_LINKS, 5, 1, 100);

const seedChats = [
  { id: 'maya', name: 'Maya Johnson', avatar: 'MJ', avatarClass: 'teal', time: '10:42', preview: 'I’ll send you the photos in a bit', lastSender: 'You: ', unread: 0, favorite: true, online: true, group: false },
  { id: 'family', name: 'Family Circle', avatar: 'FC', avatarClass: 'gold group', time: '10:18', preview: 'Don’t forget Sunday 😄', lastSender: 'Aunty R: ', unread: 2, favorite: false, online: false, group: true },
  { id: 'daniel', name: 'Daniel Okafor', avatar: 'DO', avatarClass: 'blue', time: '09:56', preview: 'That plan sounds good to me.', lastSender: '', unread: 0, favorite: true, online: false, group: false },
  { id: 'design', name: 'Design Team', avatar: 'DT', avatarClass: 'purple group', time: '09:31', preview: 'The latest version is in the folder', lastSender: 'Tobi: ', unread: 4, favorite: false, online: false, group: true },
  { id: 'david', name: 'David Mensah', avatar: 'DM', avatarClass: 'coral', time: 'Yesterday', preview: 'Voice message · 0:18', lastSender: '', unread: 0, favorite: false, online: true, group: false },
  { id: 'amaka', name: 'Amaka Nwosu', avatar: 'AN', avatarClass: 'rose', time: 'Yesterday', preview: 'Thank you so much 💚', lastSender: '', unread: 0, favorite: false, online: false, group: false },
  { id: 'sunday', name: 'Sunday Football ⚽', avatar: 'SF', avatarClass: 'green group', time: 'Yesterday', preview: 'Kick-off at 4pm this week', lastSender: 'Emeka: ', unread: 0, favorite: false, online: false, group: true },
  { id: 'sarah', name: 'Sarah Cole', avatar: 'SC', avatarClass: 'purple', time: 'Monday', preview: 'Are we still meeting tomorrow?', lastSender: '', unread: 0, favorite: false, online: false, group: false },
];

const mimeTypes = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.wav': 'audio/wav'
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}
function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  res.end(body);
}
function sendError(res, status, message) { sendJson(res, status, { error: message }); }
async function readJson(req, maxBytes = bodyLimit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) { const err = new Error('Request body is too large.'); err.statusCode = 413; throw err; }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const err = new Error('Invalid JSON request body.'); err.statusCode = 400; throw err; }
}
function rateLimit(req, bucket, limit, windowMs) {
  const now = Date.now();
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 90);
  const key = `${bucket}:${ip}`;
  let data = limiterBuckets.get(key);
  if (!data || data.expiresAt <= now) data = { count: 0, expiresAt: now + windowMs };
  data.count += 1; limiterBuckets.set(key, data);
  if (limiterBuckets.size > 2500) {
    for (const [k, v] of limiterBuckets) if (v.expiresAt <= now) limiterBuckets.delete(k);
  }
  return data.count <= limit;
}
function safeEqual(candidate, expected) {
  const a = Buffer.from(candidate, 'utf8'); const b = Buffer.from(expected, 'utf8');
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', tokenSecret).update(body).digest('base64url')}`;
}
function verifyToken(token) {
  if (!token || !tokenSecret) return null;
  const parts = token.split('.'); if (parts.length !== 2) return null;
  const [body, provided] = parts;
  const expected = crypto.createHmac('sha256', tokenSecret).update(body).digest();
  let actual; try { actual = Buffer.from(provided, 'base64url'); } catch { return null; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return payload.sub === 'admin' && Number.isInteger(payload.exp) && payload.exp > Math.floor(Date.now()/1000) ? payload : null;
  } catch { return null; }
}
function authorizedAdmin(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? verifyToken(match[1]) : null;
}
function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function parseSize(text, fallback) {
  const m = String(text).trim().match(/^(\d+)\s*(kb|mb|b)?$/i); if (!m) return fallback;
  const n = Number(m[1]); const u=(m[2]||'b').toLowerCase(); return n * (u==='mb'?1048576:u==='kb'?1024:1);
}
async function databaseHealth() {
  if (!pool) return 'not_configured';
  try { await pool.query({ text: 'SELECT 1', query_timeout: 1800 }); dbReady = true; return 'connected'; }
  catch { dbReady = false; return 'unavailable'; }
}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function bearerToken(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
function wahaConfigured() { return Boolean(WAHA_URL && WAHA_API_KEY); }
async function wahaRequest(method, route, data, timeoutMs = 30000) {
  if (!wahaConfigured()) throw new Error('Pairing service is not configured. Set WAHA_URL and WAHA_API_KEY on Render.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${WAHA_URL}${route}`, {
      method,
      headers: { 'X-Api-Key': WAHA_API_KEY, ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: data !== undefined ? JSON.stringify(data) : undefined,
      signal: controller.signal
    });
    const raw = await response.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { message: raw.slice(0, 500) }; }
    if (!response.ok) {
      const reason = body?.message || body?.error || `WAHA returned HTTP ${response.status}`;
      throw new Error(String(reason).slice(0, 400));
    }
    return body;
  } finally { clearTimeout(timer); }
}
function mapLinkRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionName: row.session_name ?? row.sessionName,
    tokenHash: row.auth_hash ?? row.tokenHash,
    phoneLast4: row.phone_last4 ?? row.phoneLast4 ?? '',
    status: row.status || 'STARTING',
    ownerJid: row.owner_jid ?? row.ownerJid ?? null,
    lastError: row.last_error ?? row.lastError ?? null,
    createdAt: row.created_at ?? row.createdAt ?? new Date().toISOString(),
    updatedAt: row.updated_at ?? row.updatedAt ?? new Date().toISOString()
  };
}
async function saveLinkedSession(record) {
  const normalized = mapLinkRow(record);
  linkedSessionsMemory.set(normalized.id, normalized);
  if (pool && dbReady) {
    await pool.query(`INSERT INTO yakasha_linked_sessions (id, session_name, auth_hash, phone_last4, status, owner_jid, last_error, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, owner_jid=COALESCE(EXCLUDED.owner_jid,yakasha_linked_sessions.owner_jid), last_error=EXCLUDED.last_error, updated_at=EXCLUDED.updated_at`,
    [normalized.id, normalized.sessionName, normalized.tokenHash, normalized.phoneLast4, normalized.status, normalized.ownerJid, normalized.lastError, normalized.createdAt, normalized.updatedAt]);
  }
  return normalized;
}
async function findLinkedSessionByToken(token) {
  if (!token) return null;
  const hash = sha256(token);
  if (pool && dbReady) {
    try {
      const result = await pool.query('SELECT * FROM yakasha_linked_sessions WHERE auth_hash=$1 LIMIT 1', [hash]);
      if (result.rows[0]) return mapLinkRow(result.rows[0]);
    } catch { /* allow local memory sessions while database reconnects */ }
  }
  return [...linkedSessionsMemory.values()].find((row) => row.tokenHash === hash) || null;
}
async function requireLinkedSession(req, res) {
  const link = await findLinkedSessionByToken(bearerToken(req));
  if (!link) { sendError(res, 401, 'A valid linked-account session is required.'); return null; }
  return link;
}
function getPublicBaseUrl() {
  const value = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || `http://127.0.0.1:${port}`;
  return String(value).replace(/\/$/, '');
}
function makeWebhookConfig() {
  const hook = `${getPublicBaseUrl()}/webhooks/waha?secret=${encodeURIComponent(WEBHOOK_SECRET)}`;
  return { webhooks: [{ url: hook, events: ['message.any', 'message.revoked', 'session.status'] }] };
}
function normalizePhone(value) { return String(value || '').replace(/\D/g, ''); }
function normalizedWahaStatus(session) {
  return String(session?.status || session?.state || 'UNKNOWN').toUpperCase();
}
async function refreshLinkedStatus(link) {
  let remote;
  try {
    remote = await wahaRequest('GET', `/api/sessions/${encodeURIComponent(link.sessionName)}`, undefined, 12000);
    const status = normalizedWahaStatus(remote);
    const ownerJid = remote?.me?.id || remote?.me?.jid || link.ownerJid || null;
    return await saveLinkedSession({ ...link, status, ownerJid, lastError: status === 'FAILED' ? (remote?.error || remote?.message || link.lastError) : null, updatedAt: new Date().toISOString() });
  } catch (error) {
    return await saveLinkedSession({ ...link, status: link.status || 'UNKNOWN', lastError: String(error.message || 'WAHA status unavailable').slice(0, 300), updatedAt: new Date().toISOString() });
  }
}
async function createRealPairing(phoneNumber) {
  const digits = normalizePhone(phoneNumber);
  if (!/^[1-9]\d{6,14}$/.test(digits)) throw new Error('Enter a full international phone number including country code, for example +2348012345678.');
  if (!wahaConfigured()) throw new Error('Pairing is not configured yet. Add WAHA_URL and WAHA_API_KEY in Render and redeploy.');
  if (!WEBHOOK_SECRET) throw new Error('WEBHOOK_SECRET is missing from the backend environment.');
  if (pool && dbReady) {
    const count = await pool.query(`SELECT COUNT(*)::int AS count FROM yakasha_linked_sessions WHERE status IN ('WORKING','STARTING','SCAN_QR_CODE','UNKNOWN')`);
    if (Number(count.rows[0]?.count || 0) >= MAX_ACTIVE_LINKS) throw new Error(`Yakasha is at its current linked-account limit (${MAX_ACTIVE_LINKS}). Increase MAX_ACTIVE_LINKS only after capacity testing.`);
  } else if ([...linkedSessionsMemory.values()].filter(row => ['WORKING','STARTING','SCAN_QR_CODE','UNKNOWN'].includes(row.status)).length >= MAX_ACTIVE_LINKS) {
    throw new Error(`Yakasha is at its current linked-account limit (${MAX_ACTIVE_LINKS}).`);
  }

  const id = crypto.randomUUID();
  const sessionName = `yakasha_${id.replace(/-/g, '').slice(0, 22)}`;
  const sessionToken = crypto.randomBytes(32).toString('base64url');
  let link = await saveLinkedSession({ id, sessionName, tokenHash: sha256(sessionToken), phoneLast4: digits.slice(-4), status: 'STARTING', ownerJid: null, lastError: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  try {
    await wahaRequest('POST', '/api/sessions', { name: sessionName, start: false, config: makeWebhookConfig() }, 30000);
    await wahaRequest('POST', `/api/sessions/${encodeURIComponent(sessionName)}/start`, {}, 30000);
    let remote = null;
    const began = Date.now();
    while (Date.now() - began < clampInt(process.env.PAIRING_READY_TIMEOUT_MS, 90000, 15000, 150000)) {
      remote = await wahaRequest('GET', `/api/sessions/${encodeURIComponent(sessionName)}`, undefined, 12000);
      const status = normalizedWahaStatus(remote);
      link = await saveLinkedSession({ ...link, status, ownerJid: remote?.me?.id || link.ownerJid, updatedAt: new Date().toISOString() });
      if (['SCAN_QR_CODE', 'WORKING', 'FAILED', 'PASSKEY_REQUIRED', 'PASSKEY_CONFIRMATION_REQUIRED'].includes(status)) break;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    const status = normalizedWahaStatus(remote);
    if (status === 'WORKING') return { id, token: sessionToken, status, code: null, phoneLast4: digits.slice(-4), alreadyLinked: true };
    if (status !== 'SCAN_QR_CODE') {
      const reason = status === 'FAILED' ? 'The WhatsApp session failed before a pairing code could be created.' : status.startsWith('PASSKEY') ? 'WhatsApp requires an additional passkey confirmation; this session cannot use the standard pairing-code flow.' : `The messaging engine did not become ready for a pairing code (status: ${status}).`;
      link = await saveLinkedSession({ ...link, status, lastError: reason, updatedAt: new Date().toISOString() });
      throw new Error(reason);
    }
    const codeResult = await wahaRequest('POST', `/api/${encodeURIComponent(sessionName)}/auth/request-code`, { phoneNumber: digits }, 30000);
    const code = String(codeResult?.code || codeResult?.pairingCode || '').trim();
    if (!code) throw new Error('The messaging engine returned no pairing code.');
    link = await saveLinkedSession({ ...link, status: 'SCAN_QR_CODE', updatedAt: new Date().toISOString() });
    return { id, token: sessionToken, status: 'SCAN_QR_CODE', code, phoneLast4: digits.slice(-4) };
  } catch (error) {
    // A failed first-time pairing attempt should not occupy a session slot. Best-effort cleanup only;
    // the failure status is still persisted if the WAHA engine is unreachable.
    try { await wahaRequest('DELETE', `/api/sessions/${encodeURIComponent(sessionName)}`, undefined, 12000); } catch {}
    await saveLinkedSession({ ...link, status: 'FAILED', lastError: String(error.message || 'Pairing request failed').slice(0, 300), updatedAt: new Date().toISOString() }).catch(() => {});
    throw error;
  }
}
function normalizeIncomingMessage(payload, linkId) {
  const key = payload?.id && typeof payload.id === 'object' ? payload.id : (payload?._data?.key || {});
  const fromMe = Boolean(payload?.fromMe ?? key?.fromMe ?? payload?._data?.key?.fromMe);
  const chatId = String((fromMe ? (payload?.to || key?.remote) : (payload?.from || key?.remote)) || payload?.chatId || key?.remote || '').trim();
  if (!chatId || chatId.length > 300) return null;
  const type = String(payload?.type || payload?.messageType || (payload?.hasMedia ? payload?.media?.mimetype?.split('/')[0] : '') || 'chat').slice(0, 40).toLowerCase();
  const rawBody = payload?.body ?? payload?.text ?? payload?.caption ?? payload?._data?.message?.conversation ?? payload?._data?.message?.extendedTextMessage?.text ?? '';
  const media = payload?.media || payload?._data?.media || {};
  const body = String(rawBody || (payload?.hasMedia ? `[${type || 'media'}]` : '')).slice(0, 4000);
  const providerMessageId = String((typeof payload?.id === 'string' ? payload.id : '') || key?.id || payload?._data?.key?.id || crypto.randomUUID()).slice(0, 300);
  const wahaId = providerMessageId.slice(0, 180);
  let stamp = Number(payload?.timestamp || payload?.t || Date.now());
  if (!Number.isFinite(stamp)) stamp = Date.now();
  if (stamp < 1000000000000) stamp *= 1000;
  const mediaUrl = String(media?.url || payload?.mediaUrl || '').slice(0, 2000);
  const mediaMimetype = String(media?.mimetype || payload?.mimetype || payload?.media?.mimeType || '').slice(0, 150);
  const mediaFilename = String(media?.filename || payload?.filename || '').replace(/[\r\n\0]/g, '').slice(0, 200);
  const hasMedia = Boolean(payload?.hasMedia || mediaUrl || mediaMimetype || ['image','video','audio','ptt','document','sticker'].includes(type));
  return { messageId: `${linkId}:${wahaId}`, providerMessageId, linkId, chatId, fromMe, body, senderJid: String(payload?.from || key?.participant || '').slice(0, 300), senderName: String(payload?.pushName || payload?.notifyName || payload?.sender?.pushName || '').slice(0, 100), type, timestampMs: Math.round(stamp), mediaUrl, mediaMimetype, mediaFilename, hasMedia, revoked: false };
}
async function saveLiveMessage(message) {
  const key = message.messageId;
  linkedMessagesMemory.set(key, message);
  if (pool && dbReady) {
    await pool.query(`INSERT INTO yakasha_messages (message_id, link_id, chat_id, from_me, body, sender_jid, sender_name, msg_type, timestamp_ms, revoked, provider_message_id, media_url, media_mimetype, media_filename, has_media)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (message_id) DO UPDATE SET body=EXCLUDED.body, revoked=EXCLUDED.revoked, provider_message_id=COALESCE(EXCLUDED.provider_message_id,yakasha_messages.provider_message_id), media_url=COALESCE(EXCLUDED.media_url,yakasha_messages.media_url), media_mimetype=COALESCE(EXCLUDED.media_mimetype,yakasha_messages.media_mimetype), media_filename=COALESCE(EXCLUDED.media_filename,yakasha_messages.media_filename), has_media=EXCLUDED.has_media`,
    [message.messageId, message.linkId, message.chatId, message.fromMe, message.body, message.senderJid, message.senderName, message.type, message.timestampMs, message.revoked, message.providerMessageId || null, message.mediaUrl || null, message.mediaMimetype || null, message.mediaFilename || null, Boolean(message.hasMedia)]);
  }
}
async function getLiveMessages(linkId, chatId, limit = 200) {
  if (pool && dbReady) {
    const result = await pool.query(`SELECT message_id AS "messageId", link_id AS "linkId", chat_id AS "chatId", from_me AS "fromMe", body, sender_jid AS "senderJid", sender_name AS "senderName", msg_type AS type, timestamp_ms AS "timestampMs", revoked, provider_message_id AS "providerMessageId", media_url AS "mediaUrl", media_mimetype AS "mediaMimetype", media_filename AS "mediaFilename", has_media AS "hasMedia" FROM yakasha_messages WHERE link_id=$1 AND chat_id=$2 ORDER BY timestamp_ms DESC LIMIT $3`, [linkId, chatId, limit]);
    return result.rows.reverse();
  }
  return [...linkedMessagesMemory.values()].filter(m => m.linkId === linkId && m.chatId === chatId).sort((a,b)=>a.timestampMs-b.timestampMs).slice(-limit);
}
async function getLiveChats(linkId) {
  if (pool && dbReady) {
    const result = await pool.query(`SELECT DISTINCT ON (chat_id) chat_id AS id, body, from_me AS "fromMe", sender_name AS "senderName", msg_type AS type, timestamp_ms AS "timestampMs" FROM yakasha_messages WHERE link_id=$1 AND revoked=false ORDER BY chat_id, timestamp_ms DESC`, [linkId]);
    return result.rows.sort((a,b)=>Number(b.timestampMs)-Number(a.timestampMs)).map(row => ({id:row.id,name:row.id.endsWith('@g.us') ? (row.id.split('@')[0]) : (row.id.split('@')[0]), group:row.id.endsWith('@g.us'), preview:row.body || `[${row.type}]`, lastSender:row.fromMe?'You: ':`${row.senderName ? row.senderName+': ' : ''}`, time:new Date(Number(row.timestampMs)).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}), timestampMs:Number(row.timestampMs)}));
  }
  const latest = new Map();
  for (const msg of linkedMessagesMemory.values()) if (msg.linkId === linkId && !msg.revoked && (!latest.has(msg.chatId) || latest.get(msg.chatId).timestampMs < msg.timestampMs)) latest.set(msg.chatId,msg);
  return [...latest.values()].sort((a,b)=>b.timestampMs-a.timestampMs).map(row=>({id:row.chatId,name:row.chatId.split('@')[0],group:row.chatId.endsWith('@g.us'),preview:row.body||`[${row.type}]`,lastSender:row.fromMe?'You: ':`${row.senderName ? row.senderName+': ' : ''}`,time:new Date(row.timestampMs).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}),timestampMs:row.timestampMs}));
}

async function api(req, res, url) {
  const method = req.method || 'GET'; const pathname = url.pathname;
  if (method === 'GET' && pathname === '/api/health') {
    const database = await databaseHealth(); return sendJson(res, 200, { app:'Yakasha SAP API', status:'ok', database, mode:wahaConfigured()?'linked-device':'prototype', pairingConfigured:wahaConfigured(), timestamp:new Date().toISOString() });
  }
  if (method === 'GET' && pathname === '/api/offline-demo-verifiers') {
    // This endpoint exposes hashes only. The demo values are not embedded in frontend source files.
    return sendJson(res, 200, { version: 1, pairingHash: sha256(offlineDemoPairingCode.trim()), adminHash: sha256(offlineDemoAdminPassword.trim()) });
  }

  if (method === 'GET' && pathname === '/api/config') {
    return sendJson(res, 200, { appName:'Yakasha SAP', apiVersion:'0.4.0', mode:wahaConfigured()?'linked-device':'prototype', liveMessagingEnabled:wahaConfigured(), accountLinkingEnabled:wahaConfigured(), pairingConfigured:wahaConfigured(), note:wahaConfigured()?'Linked-device pairing is enabled through the configured WAHA engine.':'Pairing needs WAHA_URL and WAHA_API_KEY configured on the backend.' });
  }
  if (method === 'GET' && pathname === '/api/chats') return sendJson(res, 200, { mode:'prototype', chats:seedChats });

  if (method === 'POST' && pathname === '/api/link/request-code') {
    if (!rateLimit(req, 'pairing-request', 3, 10 * 60 * 1000)) return sendError(res, 429, 'Too many pairing attempts from this network. Wait a few minutes and try again.');
    let body; try { body = await readJson(req); } catch (e) { return sendError(res, e.statusCode || 400, e.message); }
    const phoneNumber = normalizePhone(body.phoneNumber);
    if (!/^[1-9]\d{6,14}$/.test(phoneNumber)) return sendError(res, 400, 'Enter a full international phone number including country code.');
    if (pairingInFlight.has(phoneNumber)) return sendError(res, 409, 'A pairing request for this number is already running. Wait for it to finish.');
    const work = createRealPairing(phoneNumber);
    pairingInFlight.set(phoneNumber, work);
    try {
      const result = await work;
      return sendJson(res, 200, { ok:true, sessionId:result.id, sessionToken:result.token, status:result.status, code:result.code, phoneLast4:result.phoneLast4, alreadyLinked:Boolean(result.alreadyLinked) });
    } catch (e) {
      const message = String(e.message || 'Could not create a pairing code.').slice(0, 400);
      const code = /not configured|missing from the backend environment/i.test(message) ? 503 : /limit|too many/i.test(message) ? 429 : 502;
      return sendJson(res, code, { ok:false, error:message });
    } finally { pairingInFlight.delete(phoneNumber); }
  }

  if (method === 'GET' && pathname === '/api/link/status') {
    const link = await requireLinkedSession(req,res); if (!link) return;
    const current = await refreshLinkedStatus(link);
    return sendJson(res,200,{ sessionId:current.id, status:current.status, phoneLast4:current.phoneLast4, linked:current.status==='WORKING', lastError:current.status==='FAILED' ? current.lastError : null });
  }

  if (method === 'POST' && pathname === '/api/link/cancel') {
    const link = await requireLinkedSession(req,res); if (!link) return;
    const current = await refreshLinkedStatus(link);
    if (current.status === 'WORKING') return sendError(res,409,'This account is already linked. Use the account unlink control before removing it.');
    try { await wahaRequest('DELETE', `/api/sessions/${encodeURIComponent(current.sessionName)}`, undefined, 20000); } catch (e) { console.warn('Could not remove pending WAHA session:', String(e.message||e).slice(0,200)); }
    if (pool && dbReady) {
      await pool.query('DELETE FROM yakasha_messages WHERE link_id=$1',[current.id]).catch(()=>{});
      await pool.query('DELETE FROM yakasha_linked_sessions WHERE id=$1',[current.id]).catch(()=>{});
    }
    linkedSessionsMemory.delete(current.id);
    for (const [key,message] of linkedMessagesMemory) if(message.linkId===current.id) linkedMessagesMemory.delete(key);
    return sendJson(res,200,{cancelled:true});
  }

  if (method === 'POST' && pathname === '/api/link/reconnect') {
    const link = await requireLinkedSession(req,res); if (!link) return;
    try {
      await wahaRequest('POST', `/api/sessions/${encodeURIComponent(link.sessionName)}/start`, {}, 30000);
      const current = await saveLinkedSession({...link,status:'STARTING',lastError:null,updatedAt:new Date().toISOString()});
      return sendJson(res,202,{ accepted:true,status:current.status });
    } catch (e) { return sendError(res,502,`Could not reconnect this session: ${String(e.message||'WAHA error').slice(0,250)}`); }
  }

  if (method === 'GET' && pathname === '/api/link/chats') {
    const link = await requireLinkedSession(req,res); if (!link) return;
    const current = await refreshLinkedStatus(link);
    if (current.status !== 'WORKING') return sendJson(res,409,{error:'The linked WhatsApp session is not connected.',status:current.status});
    try { return sendJson(res,200,{chats:await getLiveChats(current.id),status:current.status}); }
    catch (e) { console.warn('Read live chats failed:',e.message); return sendError(res,503,'Chat store is temporarily unavailable.'); }
  }

  if (method === 'GET' && pathname === '/api/link/messages') {
    const link = await requireLinkedSession(req,res); if (!link) return;
    const chatId = String(url.searchParams.get('chatId') || '').trim();
    if (!chatId || chatId.length > 300) return sendError(res,400,'A valid chatId is required.');
    try {
      const messages = await getLiveMessages(link.id,chatId,200);
      // Never disclose WAHA internal media URLs or provider metadata to the browser.
      return sendJson(res,200,{messages:messages.map(m=>({messageId:m.messageId,linkId:m.linkId,chatId:m.chatId,fromMe:m.fromMe,body:m.body,senderJid:m.senderJid,senderName:m.senderName,type:m.type,timestampMs:Number(m.timestampMs),revoked:Boolean(m.revoked),hasMedia:Boolean(m.hasMedia||m.mediaUrl),mediaMimetype:m.mediaMimetype||'',mediaFilename:m.mediaFilename||''}))});
    } catch (e) { console.warn('Read live messages failed:',e.message); return sendError(res,503,'Message store is temporarily unavailable.'); }
  }

  if (method === 'POST' && pathname === '/api/link/send') {
    const link = await requireLinkedSession(req,res); if (!link) return;
    let body; try { body = await readJson(req); } catch (e) { return sendError(res,e.statusCode||400,e.message); }
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    const message = typeof body.text === 'string' ? body.text.trim() : '';
    if (!chatId || chatId.length > 300 || !message || message.length > 4000) return sendError(res,400,'A chat and message (1–4000 characters) are required.');
    if (!rateLimit(req,`linked-send-${link.id}`,60,60000)) return sendError(res,429,'Message rate limit reached. Wait a moment and retry.');
    const current = await refreshLinkedStatus(link);
    if (current.status !== 'WORKING') return sendError(res,409,'Your linked WhatsApp session is not connected yet. Reconnect and retry.');
    try {
      const result = await wahaRequest('POST','/api/sendText',{session:current.sessionName,chatId,text:message},20000);
      return sendJson(res,202,{accepted:true,delivered:Boolean(result?.id || result?.key),messageId:result?.id?.id || result?.id || null});
    } catch (e) { return sendError(res,502,`WhatsApp did not accept the message: ${String(e.message||'send failed').slice(0,250)}`); }
  }

  if (method === 'POST' && pathname === '/api/link/send-media') {
    const link = await requireLinkedSession(req,res); if (!link) return;
    if (!rateLimit(req, `linked-media-${link.id}`, 8, 60000)) return sendError(res,429,'Media send limit reached. Wait a moment and retry.');
    let body; try { body = await readJson(req, mediaBodyLimit); } catch (e) { return sendError(res,e.statusCode||400,e.message); }
    const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
    const mimetype = String(body.mimetype || '').toLowerCase().trim().slice(0,150);
    const filename = String(body.filename || 'attachment').replace(/[\r\n\0]/g,'').slice(0,200);
    const caption = typeof body.caption === 'string' ? body.caption.trim().slice(0,1000) : '';
    let data = String(body.data || '').replace(/^data:[^,]+,/, '').replace(/\s/g,'');
    if (!chatId || chatId.length > 300) return sendError(res,400,'A valid destination chat is required.');
    if (!/^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime)|audio\/[a-z0-9.+-]+(?:\s*;\s*codecs\s*=\s*\"?[a-z0-9.,+-]+\"?)?)$/i.test(mimetype)) return sendError(res,415,'Choose a supported image (JPEG/PNG/WebP), video (MP4/WebM/MOV), or audio file.');
    if (!data || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return sendError(res,400,'The media upload data is invalid.');
    const approximateBytes = Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (approximateBytes < 1 || approximateBytes > maxMediaBytes) return sendError(res,413,`Media must be smaller than ${Math.round(maxMediaBytes/1024/1024)} MB.`);
    const current = await refreshLinkedStatus(link);
    if (current.status !== 'WORKING') return sendError(res,409,'Your linked WhatsApp session is not connected. Reconnect and retry.');
    const file = { data, mimetype, filename };
    let route; let payload = { session: current.sessionName, chatId, file };
    if (mimetype.startsWith('image/')) { route = '/api/sendImage'; payload.caption = caption; }
    else if (mimetype.startsWith('video/')) { route = '/api/sendVideo'; payload.caption = caption; payload.convert = mimetype !== 'video/mp4'; }
    else { route = '/api/sendVoice'; payload.convert = !/^audio\/ogg(?:;\s*codecs=opus)?$/i.test(mimetype); if (caption) payload.caption = caption; }
    try {
      const result = await wahaRequest('POST',route,payload,60000);
      return sendJson(res,202,{accepted:true,mediaType:mimetype.split('/')[0],messageId:result?.id?.id || result?.id || result?.key?.id || null, filename});
    } catch (e) {
      return sendError(res,502,`WhatsApp did not accept this media. Check WAHA media support/format: ${String(e.message||'send failed').slice(0,220)}`);
    }
  }

  if (method === 'GET' && pathname === '/api/link/media') {
    const link = await requireLinkedSession(req,res); if (!link) return;
    const messageId = String(url.searchParams.get('messageId') || '').slice(0,400);
    const chatId = String(url.searchParams.get('chatId') || '').slice(0,300);
    if (!messageId || !chatId) return sendError(res,400,'A message ID and chat ID are required.');
    let message = linkedMessagesMemory.get(messageId) || null;
    if (pool && dbReady) {
      try {
        const row = await pool.query('SELECT message_id AS "messageId", link_id AS "linkId", chat_id AS "chatId", provider_message_id AS "providerMessageId", media_url AS "mediaUrl", media_mimetype AS "mediaMimetype", media_filename AS "mediaFilename", has_media AS "hasMedia" FROM yakasha_messages WHERE message_id=$1 AND link_id=$2 AND chat_id=$3 LIMIT 1',[messageId,link.id,chatId]);
        if (row.rows[0]) message = { ...(message||{}), ...row.rows[0] };
      } catch (e) { console.warn('Media lookup failed:',e.message); return sendError(res,503,'Media metadata is temporarily unavailable.'); }
    }
    if (!message || message.linkId !== link.id || message.chatId !== chatId || !message.hasMedia) return sendError(res,404,'Media was not found for this linked conversation.');
    let mediaUrl = message.mediaUrl || '';
    if (!mediaUrl && message.providerMessageId) {
      try {
        const remoteMessage = await wahaRequest('GET',`/api/${encodeURIComponent(link.sessionName)}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(message.providerMessageId)}?downloadMedia=true`,undefined,35000);
        mediaUrl = String(remoteMessage?.media?.url || remoteMessage?.mediaUrl || '');
        if (mediaUrl) {
          message.mediaUrl = mediaUrl;
          if (pool && dbReady) await pool.query('UPDATE yakasha_messages SET media_url=$2, media_mimetype=COALESCE(media_mimetype,$3), media_filename=COALESCE(media_filename,$4) WHERE message_id=$1',[messageId,mediaUrl,remoteMessage?.media?.mimetype||'',remoteMessage?.media?.filename||'']);
        }
      } catch (e) { return sendError(res,502,`WAHA could not retrieve this media yet: ${String(e.message||'download failed').slice(0,180)}`); }
    }
    if (!mediaUrl) return sendError(res,404,'The messaging engine has not cached this media. Enable WAHA media downloads and try again.');
    if (!wahaConfigured()) return sendError(res,503,'The media engine is not configured.');
    try {
      const target = new URL(mediaUrl, WAHA_URL);
      const wahaBase = new URL(WAHA_URL);
      if (['localhost','127.0.0.1','waha'].includes(target.hostname)) { target.host = wahaBase.host; target.protocol = wahaBase.protocol; }
      else if (target.hostname === wahaBase.hostname && target.port === wahaBase.port) { target.protocol = wahaBase.protocol; }
      // Only proxy from the configured WAHA origin. Webhook media URLs are untrusted input;
      // forwarding the API key to another port/origin would create an SSRF/credential-leak risk.
      if (!['http:','https:'].includes(target.protocol) || target.origin !== wahaBase.origin) return sendError(res,502,'The messaging engine returned an unsupported media URL.');
      const controller = new AbortController(); const timer = setTimeout(()=>controller.abort(),30000);
      try {
        const remote = await fetch(target,{headers:{'X-Api-Key':WAHA_API_KEY},signal:controller.signal});
        if (!remote.ok) return sendError(res,502,`WAHA media download failed with HTTP ${remote.status}.`);
        const len = Number(remote.headers.get('content-length')||0);
        if (len > 25*1024*1024) { controller.abort(); return sendError(res,413,'Incoming media exceeds the 25 MB preview limit.'); }
        const chunks=[]; let received=0;
        for await (const chunk of remote.body) {
          received += chunk.length;
          if (received > 25*1024*1024) { controller.abort(); return sendError(res,413,'Incoming media exceeds the 25 MB preview limit.'); }
          chunks.push(Buffer.from(chunk));
        }
        const buffer = Buffer.concat(chunks,received);
        const mime = String(message.mediaMimetype || remote.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
        const name = String(message.mediaFilename || 'yakasha-media').replace(/[\r\n\0"\\]/g,'_').slice(0,120);
        res.writeHead(200,{'Content-Type':mime,'Content-Length':buffer.length,'Content-Disposition':`inline; filename="${name}"`,'Cache-Control':'private, max-age=60','X-Content-Type-Options':'nosniff'});
        return res.end(buffer);
      } finally { clearTimeout(timer); }
    } catch (e) { return sendError(res,502,`Could not load incoming media: ${String(e.message||'download failed').slice(0,180)}`); }
  }

  if (method === 'POST' && pathname === '/webhooks/waha') {
    const supplied = String(url.searchParams.get('secret') || req.headers['x-yakasha-webhook-secret'] || '');
    if (!WEBHOOK_SECRET || !safeEqual(supplied,WEBHOOK_SECRET)) return sendError(res,401,'Invalid webhook secret.');
    let event; try { event=await readJson(req); } catch(e) { return sendError(res,e.statusCode||400,e.message); }
    const sessionName = String(event?.session || '').slice(0,100);
    let link = null;
    if (pool && dbReady && sessionName) {
      try { const result=await pool.query('SELECT * FROM yakasha_linked_sessions WHERE session_name=$1 LIMIT 1',[sessionName]); if(result.rows[0])link=mapLinkRow(result.rows[0]); } catch {}
    }
    if (!link) link=[...linkedSessionsMemory.values()].find(row=>row.sessionName===sessionName)||null;
    if (!link) return sendJson(res,202,{accepted:true,ignored:true});
    const eventName=String(event?.event||'');
    if (eventName==='session.status') {
      const status=String(event?.payload?.status || event?.payload?.payload?.status || 'UNKNOWN').toUpperCase();
      await saveLinkedSession({...link,status,ownerJid:event?.me?.id || event?.payload?.me?.id || link.ownerJid,lastError:status==='FAILED'?'WAHA session failed':null,updatedAt:new Date().toISOString()}).catch(e=>console.warn('Persist status webhook failed:',e.message));
    } else if (eventName==='message' || eventName==='message.any') {
      const normalized=normalizeIncomingMessage(event?.payload,link.id);
      if(normalized){
        try{await saveLiveMessage(normalized);}catch(e){console.warn('Persist incoming message failed:',e.message);return sendError(res,503,'Could not persist the incoming message.');}
      }
    } else if (eventName==='message.revoked') {
      const payload=event?.payload||{}; const key=payload?.id&&typeof payload.id==='object'?payload.id:{};const id=String(key?.id||payload?.id||'');
      if(id){const messageId=`${link.id}:${id}`;if(pool&&dbReady){await pool.query('UPDATE yakasha_messages SET revoked=true, body=$2 WHERE message_id=$1',[messageId,'This message was deleted']);}const prior=linkedMessagesMemory.get(messageId);if(prior)linkedMessagesMemory.set(messageId,{...prior,revoked:true,body:'This message was deleted'});}
    }
    return sendJson(res,200,{accepted:true});
  }

  if (method === 'POST' && pathname === '/api/outbox') {
    if (!rateLimit(req, 'outbox', 30, 60000)) return sendError(res, 429, 'Prototype message rate limit reached. Try again in a minute.');
    let body; try { body = await readJson(req); } catch (e) { return sendError(res, e.statusCode || 400, e.message); }
    const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
    const message = typeof body.body === 'string' ? body.body.trim() : '';
    const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 100) : '';
    if (!conversationId || conversationId.length > 100 || !message || message.length > 4000) return sendError(res, 400, 'A conversation ID and a message of 1–4000 characters are required.');
    const row = { id:crypto.randomUUID(), conversationId, body:message, clientId, createdAt:new Date().toISOString(), status:'prototype_record' };
    try {
      if (pool && dbReady) {
        await pool.query('INSERT INTO yakasha_preview_outbox (id, conversation_id, body, client_id, status, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [row.id,row.conversationId,row.body,row.clientId,row.status,row.createdAt]);
      } else {
        memoryOutbox.push(row); if (memoryOutbox.length>500) memoryOutbox.shift();
      }
    } catch (e) { console.warn('Outbox persistence unavailable:',e?.message||'unknown error'); memoryOutbox.push(row); if(memoryOutbox.length>500)memoryOutbox.shift(); }
    return sendJson(res, 202, { accepted:true, id:row.id, status:'prototype_record', delivered:false, message:'Saved to the Yakasha Prototype outbox.' });
  }

  if (method === 'POST' && pathname === '/api/admin/login') {
    if (!rateLimit(req, 'admin-login', 8, 15*60*1000)) return sendError(res, 429, 'Too many login attempts. Try again later.');
    let body; try { body = await readJson(req); } catch (e) { return sendError(res,e.statusCode||400,e.message); }
    const supplied = typeof body.password === 'string' ? body.password : '';
    if (!adminPassword || !tokenSecret) return sendError(res, 503, 'Admin access is not configured on the backend.');
    if (!safeEqual(supplied, adminPassword)) return sendError(res, 401, 'Incorrect administrator password.');
    const issuedAt = Math.floor(Date.now()/1000);
    return sendJson(res, 200, { token:signToken({sub:'admin',iat:issuedAt,exp:issuedAt+tokenTtlSeconds}), tokenType:'Bearer', expiresIn:tokenTtlSeconds });
  }

  if (method === 'GET' && (pathname === '/api/admin/status' || pathname === '/api/admin/outbox')) {
    if (!authorizedAdmin(req)) return sendError(res, 401, 'Admin authentication required. Sign in again.');
    let database = pool ? (dbReady?'connected':'unavailable') : 'not_configured';
    let rows = memoryOutbox.slice(-30).reverse(); let outboxCount = memoryOutbox.length;
    if (pool) {
      try {
        const count = await pool.query('SELECT COUNT(*)::int AS count FROM yakasha_preview_outbox'); outboxCount=Number(count.rows[0]?.count||0);
        if (pathname === '/api/admin/outbox') {
          const result = await pool.query('SELECT id, conversation_id AS "conversationId", LEFT(body, 240) AS body, status, created_at AS "createdAt" FROM yakasha_preview_outbox ORDER BY created_at DESC LIMIT 30');
          rows=result.rows;
        }
        database=await databaseHealth();
      } catch { database='unavailable'; }
    }
    if (pathname === '/api/admin/outbox') return sendJson(res,200,{mode:'prototype',records:rows.map(r=>({id:r.id,conversationId:r.conversationId,body:String(r.body).slice(0,240),status:r.status,createdAt:r.createdAt}))});
    let activeLinkedAccounts=0; try { if(pool&&dbReady){const linked=await pool.query(`SELECT COUNT(*)::int AS count FROM yakasha_linked_sessions WHERE status='WORKING'`);activeLinkedAccounts=Number(linked.rows[0]?.count||0);}else activeLinkedAccounts=[...linkedSessionsMemory.values()].filter(x=>x.status==='WORKING').length;}catch{}
    return sendJson(res,200,{appName:'Yakasha SAP',status:'authenticated',database,activeLinkedAccounts,accountLinkingEnabled:wahaConfigured(),liveMessagingEnabled:wahaConfigured(),outboxCount,mode:wahaConfigured()?'linked-device':'prototype'});
  }
  return sendError(res,404,'API route not found.');
}

function serveStatic(req, res, pathname) {
  let relative = decodeURIComponent(pathname);
  if (relative === '/') relative = '/index.html';
  if (relative === '/admin') relative = '/admin.html';
  const filePath = path.resolve(frontendDir, `.${relative}`);
  if (filePath !== frontendDir && !filePath.startsWith(frontendDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.stat(filePath,(err,stat)=>{
    if(err||!stat.isFile()){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Not found.');}
    const ext=path.extname(filePath).toLowerCase();
    const headers={'Content-Type':mimeTypes[ext]||'application/octet-stream','Content-Length':stat.size,'Cache-Control':ext==='.html'?'no-cache':'public, max-age=3600'};
    res.writeHead(200,headers);
    if(req.method==='HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req,res)=>{
  securityHeaders(res);
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/') || (url.pathname === '/webhooks/waha' && req.method === 'POST')) {
      if (url.pathname.startsWith('/api/') && req.method !== 'GET' && req.method !== 'POST') return sendError(res,405,'Method not allowed.');
      return await api(req,res,url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Method not allowed.'); }
    return serveStatic(req,res,url.pathname);
  } catch (err) {
    console.error('Request error:',err?.message||'unknown error');
    if (!res.headersSent) return sendError(res,500,'Internal server error.');
    return res.end();
  }
});

async function initDatabase() {
  if (!process.env.DATABASE_URL) { console.log('DATABASE_URL not set; using the in-memory Yakasha Prototype outbox.'); return; }
  try {
    const { Pool } = await import('pg');
    pool = new Pool({connectionString:process.env.DATABASE_URL,max:clampInt(process.env.DB_POOL_MAX,2,1,5),idleTimeoutMillis:10000,connectionTimeoutMillis:4000,ssl:process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false});
    await pool.query(`CREATE TABLE IF NOT EXISTS yakasha_preview_outbox (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL,
      client_id TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'prototype_record',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS yakasha_linked_sessions (
      id TEXT PRIMARY KEY, session_name TEXT UNIQUE NOT NULL, auth_hash TEXT NOT NULL,
      phone_last4 TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'STARTING', owner_jid TEXT,
      last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query('CREATE INDEX IF NOT EXISTS yakasha_linked_sessions_auth_hash_idx ON yakasha_linked_sessions(auth_hash)');
    await pool.query(`CREATE TABLE IF NOT EXISTS yakasha_messages (
      message_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, chat_id TEXT NOT NULL, from_me BOOLEAN NOT NULL DEFAULT FALSE,
      body TEXT NOT NULL DEFAULT '', sender_jid TEXT NOT NULL DEFAULT '', sender_name TEXT NOT NULL DEFAULT '',
      msg_type TEXT NOT NULL DEFAULT 'chat', timestamp_ms BIGINT NOT NULL DEFAULT 0, revoked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query('ALTER TABLE yakasha_messages ADD COLUMN IF NOT EXISTS provider_message_id TEXT');
    await pool.query('ALTER TABLE yakasha_messages ADD COLUMN IF NOT EXISTS media_url TEXT');
    await pool.query('ALTER TABLE yakasha_messages ADD COLUMN IF NOT EXISTS media_mimetype TEXT');
    await pool.query('ALTER TABLE yakasha_messages ADD COLUMN IF NOT EXISTS media_filename TEXT');
    await pool.query('ALTER TABLE yakasha_messages ADD COLUMN IF NOT EXISTS has_media BOOLEAN NOT NULL DEFAULT FALSE');
    await pool.query('CREATE INDEX IF NOT EXISTS yakasha_messages_link_chat_timestamp_idx ON yakasha_messages(link_id,chat_id,timestamp_ms DESC)');
    dbReady=true;console.log('PostgreSQL ready (Yakasha API, linked sessions and messages).');
  } catch(err) { dbReady=false;console.warn('PostgreSQL not ready; prototype API will use memory:',err?.message||'unknown error'); }
}
server.listen(port,'0.0.0.0',()=>{
  console.log(`Yakasha SAP lightweight API listening on port ${port}`);
  if (!adminPassword || !tokenSecret) console.warn('Admin login disabled until ADMIN_PASSWORD and SESSION_SECRET are configured.');
  void initDatabase();
});
async function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close(async()=>{try{if(pool)await pool.end();}finally{process.exit(0);}});
  setTimeout(()=>process.exit(1),10000).unref();
}
process.on('SIGTERM',()=>shutdown('SIGTERM'));
process.on('SIGINT',()=>shutdown('SIGINT'));
