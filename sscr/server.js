/**
 * Mehfooz Status Control — local web app server.
 * Credit: Mehfooz Ahmad · Saif Chishti (Chishti Brothers)
 *
 * The entire app is behind panel login (HTTP Basic Auth — see src/auth.js);
 * every route below requires it. Uploaded media is handled in memory only
 * (multer.memoryStorage()) — nothing is written to a temp folder on disk.
 *
 * Endpoints
 *   GET  /api/state                → connection state (+ QR data-URL)
 *   POST /api/pair                 → request pairing code { phone }
 *   POST /api/logout               → wipe session
 *   POST /api/reconnect            → force fresh connection
 *   GET  /api/integrity            → code-integrity status (tamper check on core files)
 *   GET  /api/groups               → list groups (with { refresh: true } to bust cache);
 *                                     each group includes announce/isSelfAdmin/broadcastable
 *   GET  /api/group/dp-img?jid=…   → proxied group DP image
 *   POST /api/group/dp             → set group DP (multipart: file, jid) [integrity-gated]
 *   POST /api/status/post          → post group status to ONE group [integrity-gated]
 *   POST /api/status/broadcast     → post ONE status to MANY groups, live progress via SSE [integrity-gated]
 *   POST /api/status/bulk          → post MANY statuses to ONE group, live progress via SSE [integrity-gated]
 *   POST /api/groups/leave         → leave MANY groups, live progress via SSE [integrity-gated]
 *   POST /api/operations/:opId/cancel → stop a running broadcast/bulk/leave between items
 *   GET  /api/events               → Server-Sent Events stream (real-time operation progress)
 *   GET  /api/history              → past operations (broadcast/bulk/leave)
 *   GET  /api/history/:id          → one operation's full per-item results
 */
import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import pino from 'pino';
import { WhatsAppClient } from './wa-client.js';
import { AccountManager } from './accounts.js';
import { HistoryStore } from './history.js';
import { checkIntegrity, requireIntegrity } from './integrity.js';
import { resolveCredentials, createCredentialStore, basicAuth } from './auth.js';
import { AntiStatusGuard } from './moderation.js';
import { GroupBot, DEV_NUMBER } from './groupBot.js';
import { getBranding, saveBranding } from './branding.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
// Some panel hosts (e.g. Katabump/Pterodactyl) inject the assigned port as
// SERVER_PORT instead of PORT — accept either, PORT still wins if both are set.
const PORT = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_DIR = path.resolve(process.env.SESSION_DIR || './session');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 314572800); // 300 MB
const MIN_DELAY_MS = 800; // floor — never allow a faster-than-this send loop, regardless of client input

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ── panel password protection ───────────────────────────────────────────────
// Applied to EVERY route below, before anything else — the dashboard is never
// reachable without it. See src/auth.js for how credentials are resolved.
const panelCreds = resolveCredentials(PROJECT_ROOT, logger);
const credStore = createCredentialStore(panelCreds);
if (panelCreds.source === 'default') {
  logger.warn(
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
    '  Panel login is using the default credentials: admin / admin.\n' +
    '  Change it from the dashboard (Settings → Change Password) as soon as\n' +
    '  you can — or set PANEL_USERNAME / PANEL_PASSWORD in .env instead.\n' +
    '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
  );
} else if (panelCreds.source === 'saved-file') {
  logger.info({ username: panelCreds.username }, 'Panel password protection is active (password was changed from the dashboard)');
} else {
  logger.info({ username: panelCreds.username }, 'Panel password protection is active (from .env)');
}

const wa = new WhatsAppClient({ sessionDir: SESSION_DIR, logger });
const history = new HistoryStore(path.join(DATA_DIR, 'history.json'));
const antiStatus = new AntiStatusGuard(wa, { configPath: path.join(DATA_DIR, 'anti-status-config.json'), logger });
antiStatus.on('detected', (d) => emit({ type: 'anti-status-detected', ...d }));
antiStatus.on('action', (result) => {
  emit({ type: 'anti-status-action', ...result });
  history.add({
    id: crypto.randomUUID(), kind: 'anti-status', startedAt: result.at, finishedAt: result.at, durationMs: 0,
    total: 1, success: (result.deleted || result.kicked || result.messaged) ? 1 : 0, failed: result.errors.length ? 1 : 0,
    unavailable: 0, cancelled: false, items: [result],
  });
});
// ── group command bot (.menu, moderation, admin commands) ───────────────────
// See src/groupBot.js for the full command list and the owner/developer-only
// permission model. DEV_NUMBER is exported from that file if you need to
// confirm what it resolved to (e.g. via a debug route or the logs below).
const groupBot = new GroupBot(wa, {
  configPath: path.join(DATA_DIR, 'group-bot-config.json'),
  warningsPath: path.join(DATA_DIR, 'group-bot-warnings.json'),
  activityLog: new HistoryStore(path.join(DATA_DIR, 'group-bot-activity.json')),
  logger,
  antiStatus, // enables the manual `.purgestatus` command
});
groupBot.start();
// Extra numbers: more WhatsApp numbers linked to the same board, each running the group bot too.
const accounts = new AccountManager({
  dataDir: DATA_DIR,
  logger,
  groupBotOpts: {
    configPath: path.join(DATA_DIR, 'group-bot-config.json'),
    warningsPath: path.join(DATA_DIR, 'group-bot-warnings.json'),
    activityLog: new HistoryStore(path.join(DATA_DIR, 'group-bot-activity.json')),
  },
});
accounts.loadAll();
logger.info({ devNumber: DEV_NUMBER }, 'Group command bot started — developer override number');

wa.start();
wa.on('pairing-code', (code) => logger.info({ code }, 'PAIRING CODE'));
wa.on('pairing-error', (err) => logger.warn({ err }, 'pairing failed'));

// ── code integrity ──────────────────────────────────────────────────────────
// Verified once at boot, and re-checked on every request to /api/integrity so
// the dashboard can show a live banner. Sensitive routes (broadcast/bulk/
// leave/set-DP) are gated by requireIntegrity() below.
let integrityStatus = checkIntegrity(PROJECT_ROOT);
if (integrityStatus.blocking) {
  logger.warn({ integrityStatus }, 'INTEGRITY CHECK FAILED (confirmed change) — sensitive operations are disabled');
} else if (!integrityStatus.ok) {
  logger.warn({ integrityStatus }, 'Integrity check could not be fully verified — sensitive operations remain enabled; will retry automatically');
} else {
  logger.info('Integrity check passed — all protected files match integrity.json');
}
function refreshIntegrity() {
  // Skip re-reading files while a broadcast/bulk/leave is actively running — that's
  // exactly when Baileys is also hammering the session directory with credential/key
  // writes, and re-reading 4 more files from disk on top of that is what can tip a
  // constrained environment (esp. Windows + real-time antivirus scanning every file
  // access) into a transient "too many open files" error. The route-level check at
  // request start already covers it; skipping the periodic poll here just avoids
  // adding unnecessary fs contention at the worst possible moment.
  if (activeOpCount > 0) return integrityStatus;
  integrityStatus = checkIntegrity(PROJECT_ROOT);
  return integrityStatus;
}

// ── SSE hub ──────────────────────────────────────────────────────────────────
// Simple pub/sub so the dashboard/activity feed gets real backend events —
// no fake progress timers anywhere in this file.
const sseClients = new Set();
const cancelledOps = new Set(); // opIds the user asked to stop — checked between loop iterations
let activeOpCount = 0; // number of broadcast/bulk/leave loops currently running
function emit(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { /* client gone, cleaned up on 'close' */ }
  }
}
wa.on('state', () => emit({ type: 'conn-state', state: wa.getState() }));

// ── app ────────────────────────────────────────────────────────────────────
const app = express();
app.use(basicAuth(credStore));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({
  storage: multer.memoryStorage(), // buffers in RAM — no per-broadcast disk I/O, and no temp files to clean up or that can be locked by antivirus
  limits: { fileSize: MAX_UPLOAD_BYTES },
});

const qrCache = new Map(); // qr string → data URL (avoid re-rendering on every poll)
async function qrDataUrl(qr) {
  if (!qr) return null;
  if (qrCache.has(qr)) return qrCache.get(qr);
  const url = await QRCode.toDataURL(qr, { width: 260, margin: 1, color: { dark: '#111b21', light: '#ffffff' } });
  qrCache.set(qr, url);
  if (qrCache.size > 5) qrCache.clear();
  return url;
}

/** Best-effort classification so the UI can tell "closed/unavailable" apart from a transient failure. */
function classifyError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (msg.includes('not-authorized') || msg.includes('forbidden') || msg.includes('item-not-found') ||
      msg.includes('not a participant') || msg.includes('404')) {
    return 'unavailable';
  }
  return 'failed';
}

/**
 * Post one item, retrying exactly once on a transient-looking failure.
 * "Unavailable" errors (not-authorized/forbidden/group gone) are never
 * retried — retrying won't fix a permission or membership problem, it'll
 * just waste a send attempt and add delay for no benefit.
 */
async function postWithRetry(mode, opts, jid, logger) {
  try {
    return mode === 'diagnostic' ? await wa.postDiagnosticStatus(opts) : await wa.postGroupStatus(opts);
  } catch (firstErr) {
    if (classifyError(firstErr) === 'unavailable') throw firstErr;
    logger.warn({ jid, err: String(firstErr?.message || firstErr) }, 'send failed, retrying once');
    await new Promise((r) => setTimeout(r, 1500));
    return mode === 'diagnostic' ? await wa.postDiagnosticStatus(opts) : await wa.postGroupStatus(opts);
  }
}

// ── code integrity status ───────────────────────────────────────────────────
app.get('/api/integrity', (req, res) => {
  res.json(refreshIntegrity());
});
const integrityGate = requireIntegrity(() => integrityStatus);

// ── SSE stream ───────────────────────────────────────────────────────────────
app.get('/api/events', (req, res) => {  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25_000);
  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
});

// ── state ──────────────────────────────────────────────────────────────────
app.get('/api/state', async (_req, res) => {
  try {
    const state = wa.getState();
    if (state.status === 'qr' && state.qr) {
      state.qr = await qrDataUrl(state.qr); // swap raw string for data URL
    } else {
      state.qr = null;
    }
    res.json(state);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ── panel account (login) settings ─────────────────────────────────────────
app.get('/api/panel/account', (_req, res) => {
  try {
    const { username, source } = credStore.get();
    res.json({ username, locked: source === 'env' });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/api/panel/change-password', (req, res) => {
  try {
    const { username, source } = credStore.get();
    if (source === 'env') {
      return res.status(400).json({ error: 'PANEL_PASSWORD is set in .env, which always takes priority — remove it from .env to change the password from here instead.' });
    }
    const newPassword = String(req.body?.newPassword || '');
    if (newPassword.length < 4) {
      return res.status(400).json({ error: 'New password must be at least 4 characters.' });
    }
    credStore.setPassword(newPassword, PROJECT_ROOT, logger);
    logger.info({ username }, 'Panel password changed from the dashboard');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/api/pair', async (req, res) => {
  // Accepts "923204854766", "+92 320 4854766", "92.3204854766" or a local "03204854766" (leading 0 → 92).
  let phone = String(req.body?.phone || '').replace(/[^\d]/g, '');
  if (/^0\d{10}$/.test(phone)) phone = '92' + phone.slice(1);
  if (!/^\d{7,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Enter a valid phone number with country code (e.g. 923001234567).' });
  }
  try {
    const result = await wa.requestPairingCode(phone);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/api/logout', async (_req, res) => {
  try {
    await wa.logout();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/api/reconnect', async (_req, res) => {
  try {
    await wa.reconnect();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ── groups ─────────────────────────────────────────────────────────────────
let groupsCache = { at: 0, data: [] };
const GROUPS_CACHE_MS = 20_000; // fast repeat loads for panels that re-fetch on navigation

app.get('/api/groups', async (req, res) => {
  try {
    const fresh = String(req.query.refresh || '') === 'true';
    if (!fresh && groupsCache.data.length && Date.now() - groupsCache.at < GROUPS_CACHE_MS) {
      return res.json({ groups: groupsCache.data, cached: true });
    }
    const groups = await wa.getGroups();
    groupsCache = { at: Date.now(), data: groups };
    res.json({ groups, cached: false });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

const dpCache = new Map(); // jid → { url, ts }
app.get('/api/group/dp-img', async (req, res) => {
  const jid = String(req.query.jid || '');
  if (!jid.endsWith('@g.us')) return res.status(400).json({ error: 'Invalid group JID' });
  try {
    const cached = dpCache.get(jid);
    let url = cached && Date.now() - cached.ts < 60_000 ? cached.url : undefined;
    if (url === undefined) {
      url = await wa.getGroupDpUrl(jid);
      dpCache.set(jid, { url, ts: Date.now() });
    }
    if (!url) return res.status(404).json({ error: 'No group DP available' });
    const remote = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!remote.ok) return res.status(502).json({ error: 'Failed to fetch group DP' });
    res.setHeader('content-type', remote.headers.get('content-type') || 'image/jpeg');
    res.setHeader('cache-control', 'public, max-age=60');
    remote.body.pipe(res);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.post('/api/group/dp', integrityGate, upload.single('file'), async (req, res) => {
  const jid = String(req.body?.jid || '');
  if (!jid.endsWith('@g.us')) {
    return res.status(400).json({ error: 'Invalid group JID' });
  }
  if (!req.file) return res.status(400).json({ error: 'No image file uploaded' });
  try {
    const mime = req.file.mimetype || 'image/jpeg';
    if (!mime.startsWith('image/')) {
      throw new Error('Group DP must be an image (JPEG/PNG).');
    }
    await wa.setGroupDp(jid, req.file.buffer);
    dpCache.delete(jid);
    res.json({ ok: true, jid });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ── post group status (single group) ────────────────────────────────────────
app.post('/api/status/post', integrityGate, upload.single('file'), async (req, res) => {
  const jid = String(req.body?.jid || '');
  const caption = String(req.body?.caption || '').trim();
  const statusText = String(req.body?.text || req.body?.statusText || '').trim();
  const mode = String(req.body?.mode || 'group'); // 'group' (real) | 'diagnostic'
  const backgroundColor = req.body?.backgroundColor ? String(req.body.backgroundColor).trim() : undefined;
  const font = req.body?.font ? Number(req.body.font) : undefined;

  if (!jid.endsWith('@g.us')) return res.status(400).json({ error: 'Invalid group JID' });

  let mediaType = null;
  let mime = '';
  let mediaBuffer = null;

  if (req.file) {
    mime = req.file.mimetype || '';
    mediaType = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : null;
    if (!mediaType) {
      return res.status(400).json({ error: 'Unsupported media type — please upload an image or a video.' });
    }
    mediaBuffer = req.file.buffer;
  } else if (statusText || caption) {
    mediaType = 'text';
  } else {
    return res.status(400).json({ error: 'Please enter a text status or upload an image/video file.' });
  }

  try {
    const opts = { jid, mediaBuffer, mediaType, mimetype: mime, caption, text: statusText || caption, backgroundColor, font };
    const result = mode === 'diagnostic' ? await wa.postDiagnosticStatus(opts) : await wa.postGroupStatus(opts);
    logger.info({ jid, mode, mediaType, caption: caption || null, text: statusText || null }, 'status posted');
    res.json({ ok: true, mode, mediaType, ...result });
  } catch (err) {
    logger.error({ err }, 'post status failed');
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ── broadcast: post ONE status to MANY groups, live progress over SSE ───────
app.post('/api/status/broadcast', integrityGate, upload.single('file'), async (req, res) => {
  const jidsRaw = String(req.body?.jids || '');
  const jidList = jidsRaw.split(',').map((j) => j.trim()).filter((j) => j.endsWith('@g.us'));
  const namesRaw = req.body?.names ? String(req.body.names) : ''; // "jid|name,jid|name" — for readable activity-feed labels
  const nameMap = new Map(namesRaw.split(',').filter(Boolean).map((pair) => {
    const [j, ...rest] = pair.split('|');
    return [j, rest.join('|') || j];
  }));
  const caption = String(req.body?.caption || '').trim();
  const statusText = String(req.body?.text || req.body?.statusText || '').trim();
  const mode = String(req.body?.mode || 'group');
  const delayMs = Math.max(MIN_DELAY_MS, Number(req.body?.delayMs || 2000));
  const backgroundColor = req.body?.backgroundColor ? String(req.body.backgroundColor).trim() : undefined;
  const font = req.body?.font ? Number(req.body.font) : undefined;

  if (jidList.length === 0) return res.status(400).json({ error: 'No groups selected.' });

  let mediaType = null;
  let mime = '';
  let mediaBuffer = null;

  if (req.file) {
    mime = req.file.mimetype || '';
    mediaType = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : null;
    if (!mediaType) {
      return res.status(400).json({ error: 'Unsupported media type — please upload an image or a video.' });
    }
    mediaBuffer = req.file.buffer;
  } else if (statusText || caption) {
    mediaType = 'text';
  } else {
    return res.status(400).json({ error: 'Please enter a text status or upload an image/video file.' });
  }

  const opId = crypto.randomUUID();
  const startedAt = Date.now();
  const results = [];
  emit({ type: 'op-start', opId, kind: 'broadcast', total: jidList.length, mode });
  activeOpCount++;
  try {

  for (let i = 0; i < jidList.length; i++) {
    if (cancelledOps.has(opId)) {
      results.push({ index: i + 1, jid: jidList[i], name: nameMap.get(jidList[i]) || jidList[i], ok: false, status: 'cancelled' });
      emit({ type: 'op-item', opId, kind: 'broadcast', index: i + 1, total: jidList.length, jid: jidList[i], name: nameMap.get(jidList[i]) || jidList[i], status: 'cancelled' });
      continue;
    }
    const jid = jidList[i];
    const name = nameMap.get(jid) || jid;
    emit({ type: 'op-item', opId, kind: 'broadcast', index: i + 1, total: jidList.length, jid, name, status: 'processing' });
    try {
      const opts = { jid, mediaBuffer, mediaType, mimetype: mime, caption, text: statusText || caption, backgroundColor, font };
      const resObj = await postWithRetry(mode, opts, jid, logger);
      results.push({ index: i + 1, jid, name, ok: true, messageId: resObj.messageId });
      emit({ type: 'op-item', opId, kind: 'broadcast', index: i + 1, total: jidList.length, jid, name, status: 'ok', messageId: resObj.messageId });
      logger.info({ jid, mode, index: i + 1, total: jidList.length }, 'broadcast status item posted');
    } catch (err) {
      const status = classifyError(err);
      results.push({ index: i + 1, jid, name, ok: false, status, error: String(err?.message || err) });
      emit({ type: 'op-item', opId, kind: 'broadcast', index: i + 1, total: jidList.length, jid, name, status, error: String(err?.message || err) });
      logger.error({ err, jid }, 'broadcast status item failed');
    }
    if (i < jidList.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  const wasCancelled = cancelledOps.has(opId);
  cancelledOps.delete(opId);
  const successCount = results.filter((r) => r.ok).length;
  const unavailableCount = results.filter((r) => !r.ok && r.status === 'unavailable').length;
  const cancelledCount = results.filter((r) => !r.ok && r.status === 'cancelled').length;
  const failedCount = results.length - successCount - unavailableCount - cancelledCount;
  const durationMs = Date.now() - startedAt;

  const entry = history.add({
    id: opId, kind: 'broadcast', mode, startedAt, finishedAt: Date.now(), durationMs, cancelled: wasCancelled,
    total: results.length, success: successCount, failed: failedCount, unavailable: unavailableCount,
    items: results,
  });
  emit({ type: 'op-done', opId, kind: 'broadcast', total: results.length, success: successCount, failed: failedCount, unavailable: unavailableCount, cancelled: wasCancelled, durationMs });

  res.json({ ok: true, opId, total: results.length, success: successCount, failed: failedCount, unavailable: unavailableCount, cancelled: wasCancelled, results, historyId: entry.id });

  } finally {
    activeOpCount--;
  }
});

// ── bulk: post MANY statuses to ONE group, live progress over SSE ──────────
app.post('/api/status/bulk', integrityGate, upload.array('files', 20), async (req, res) => {
  const jid = String(req.body?.jid || '');
  const mode = String(req.body?.mode || 'group');
  const delayMs = Math.max(MIN_DELAY_MS, Number(req.body?.delayMs || 2000));
  const backgroundColor = req.body?.backgroundColor ? String(req.body.backgroundColor).trim() : undefined;
  const font = req.body?.font ? Number(req.body.font) : undefined;
  const rawTextList = req.body?.textList ? String(req.body.textList) : '';

  if (!jid.endsWith('@g.us')) return res.status(400).json({ error: 'Invalid group JID' });

  const opId = crypto.randomUUID();
  const startedAt = Date.now();
  const results = [];
  const files = req.files || [];
  const totalItems = files.length > 0 ? files.length : rawTextList.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).length;
  emit({ type: 'op-start', opId, kind: 'bulk', total: totalItems, mode });
  activeOpCount++;
  try {

  if (files.length > 0) {
    for (let i = 0; i < files.length; i++) {
      if (cancelledOps.has(opId)) {
        results.push({ index: i + 1, filename: files[i].originalname, ok: false, status: 'cancelled' });
        emit({ type: 'op-item', opId, kind: 'bulk', index: i + 1, total: files.length, jid, name: files[i].originalname, status: 'cancelled' });
        continue;
      }
      const file = files[i];
      const mime = file.mimetype || '';
      const mediaType = mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : null;
      emit({ type: 'op-item', opId, kind: 'bulk', index: i + 1, total: files.length, jid, name: file.originalname, status: 'processing' });
      if (!mediaType) {
        results.push({ index: i + 1, filename: file.originalname, ok: false, status: 'failed', error: 'Unsupported file type' });
        emit({ type: 'op-item', opId, kind: 'bulk', index: i + 1, total: files.length, jid, name: file.originalname, status: 'failed', error: 'Unsupported file type' });
        continue;
      }
      try {
        const opts = { jid, mediaBuffer: file.buffer, mediaType, mimetype: mime, caption: '' };
        const resObj = await postWithRetry(mode, opts, jid, logger);
        results.push({ index: i + 1, filename: file.originalname, ok: true, messageId: resObj.messageId });
        emit({ type: 'op-item', opId, kind: 'bulk', index: i + 1, total: files.length, jid, name: file.originalname, status: 'ok', messageId: resObj.messageId });
      } catch (err) {
        const status = classifyError(err);
        results.push({ index: i + 1, filename: file.originalname, ok: false, status, error: String(err?.message || err) });
        emit({ type: 'op-item', opId, kind: 'bulk', index: i + 1, total: files.length, jid, name: file.originalname, status, error: String(err?.message || err) });
      }
      if (i < files.length - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  } else if (rawTextList.trim()) {
    const lines = rawTextList.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return res.status(400).json({ error: 'No text status lines provided.' });
    for (let i = 0; i < lines.length; i++) {
      if (cancelledOps.has(opId)) {
        results.push({ index: i + 1, text: lines[i], ok: false, status: 'cancelled' });
        emit({ type: 'op-item', opId, kind: 'bulk', index: i + 1, total: lines.length, jid, name: lines[i].slice(0, 40), status: 'cancelled' });
        continue;
      }
      const text = lines[i];
      emit({ type: 'op-item', opId, kind: 'bulk', index: i + 1, total: lines.length, jid, name: text.slice(0, 40), status: 'processing' });
      try {
        const opts = { jid, mediaType: 'text', text, backgroundColor, font };
        const resObj = await postWithRetry(mode, opts, jid, logger);
        results.push({ index: i + 1, text, ok: true, messageId: resObj.messageId });
        emit({ type: 'op-item', opId, kind: 'bulk', index: i + 1, total: lines.length, jid, name: text.slice(0, 40), status: 'ok', messageId: resObj.messageId });
      } catch (err) {
        const status = classifyError(err);
        results.push({ index: i + 1, text, ok: false, status, error: String(err?.message || err) });
        emit({ type: 'op-item', opId, kind: 'bulk', index: i + 1, total: lines.length, jid, name: text.slice(0, 40), status, error: String(err?.message || err) });
      }
      if (i < lines.length - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  } else {
    return res.status(400).json({ error: 'Please select multiple media files or enter multiple text status lines.' });
  }

  const successCount = results.filter((r) => r.ok).length;
  const unavailableCount = results.filter((r) => !r.ok && r.status === 'unavailable').length;
  const cancelledCount = results.filter((r) => !r.ok && r.status === 'cancelled').length;
  const failedCount = results.length - successCount - unavailableCount - cancelledCount;
  const durationMs = Date.now() - startedAt;
  const wasCancelled = cancelledOps.has(opId);
  cancelledOps.delete(opId);

  const entry = history.add({
    id: opId, kind: 'bulk', mode, startedAt, finishedAt: Date.now(), durationMs, cancelled: wasCancelled,
    total: results.length, success: successCount, failed: failedCount, unavailable: unavailableCount,
    items: results,
  });
  emit({ type: 'op-done', opId, kind: 'bulk', total: results.length, success: successCount, failed: failedCount, unavailable: unavailableCount, cancelled: wasCancelled, durationMs });

  res.json({ ok: true, opId, total: results.length, success: successCount, failed: failedCount, unavailable: unavailableCount, cancelled: wasCancelled, results, historyId: entry.id });

  } finally {
    activeOpCount--;
  }
});

// ── leave MANY groups, live progress over SSE ────────────────────────────────
app.post('/api/groups/leave', integrityGate, async (req, res) => {
  const jidsRaw = String(req.body?.jids || (Array.isArray(req.body?.jidsArr) ? req.body.jidsArr.join(',') : ''));
  const jidList = jidsRaw.split(',').map((j) => j.trim()).filter((j) => j.endsWith('@g.us'));
  const namesRaw = req.body?.names ? String(req.body.names) : '';
  const nameMap = new Map(namesRaw.split(',').filter(Boolean).map((pair) => {
    const [j, ...rest] = pair.split('|');
    return [j, rest.join('|') || j];
  }));
  const delayMs = Math.max(MIN_DELAY_MS, Number(req.body?.delayMs || 900));

  if (jidList.length === 0) return res.status(400).json({ error: 'No groups selected.' });

  const opId = crypto.randomUUID();
  const startedAt = Date.now();
  const results = [];
  emit({ type: 'op-start', opId, kind: 'leave', total: jidList.length });
  activeOpCount++;
  try {

  for (let i = 0; i < jidList.length; i++) {
    if (cancelledOps.has(opId)) {
      results.push({ index: i + 1, jid: jidList[i], name: nameMap.get(jidList[i]) || jidList[i], ok: false, status: 'cancelled' });
      emit({ type: 'op-item', opId, kind: 'leave', index: i + 1, total: jidList.length, jid: jidList[i], name: nameMap.get(jidList[i]) || jidList[i], status: 'cancelled' });
      continue;
    }
    const jid = jidList[i];
    const name = nameMap.get(jid) || jid;
    emit({ type: 'op-item', opId, kind: 'leave', index: i + 1, total: jidList.length, jid, name, status: 'processing' });
    try {
      try {
        await wa.leaveGroup(jid);
      } catch (firstErr) {
        if (classifyError(firstErr) === 'unavailable') throw firstErr;
        await new Promise((r) => setTimeout(r, 1500));
        await wa.leaveGroup(jid);
      }
      results.push({ index: i + 1, jid, name, ok: true });
      emit({ type: 'op-item', opId, kind: 'leave', index: i + 1, total: jidList.length, jid, name, status: 'ok' });
    } catch (err) {
      const status = classifyError(err);
      results.push({ index: i + 1, jid, name, ok: false, status, error: String(err?.message || err) });
      emit({ type: 'op-item', opId, kind: 'leave', index: i + 1, total: jidList.length, jid, name, status, error: String(err?.message || err) });
    }
    if (i < jidList.length - 1) await new Promise((r) => setTimeout(r, delayMs));
  }

  groupsCache = { at: 0, data: [] }; // force a fresh group list next time — membership changed
  const successCount = results.filter((r) => r.ok).length;
  const unavailableCount = results.filter((r) => !r.ok && r.status === 'unavailable').length;
  const cancelledCount = results.filter((r) => !r.ok && r.status === 'cancelled').length;
  const failedCount = results.length - successCount - unavailableCount - cancelledCount;
  const durationMs = Date.now() - startedAt;
  const wasCancelled = cancelledOps.has(opId);
  cancelledOps.delete(opId);

  const entry = history.add({
    id: opId, kind: 'leave', startedAt, finishedAt: Date.now(), durationMs, cancelled: wasCancelled,
    total: results.length, success: successCount, failed: failedCount, unavailable: unavailableCount,
    items: results,
  });
  emit({ type: 'op-done', opId, kind: 'leave', total: results.length, success: successCount, failed: failedCount, unavailable: unavailableCount, cancelled: wasCancelled, durationMs });

  res.json({ ok: true, opId, total: results.length, success: successCount, failed: failedCount, unavailable: unavailableCount, cancelled: wasCancelled, results, historyId: entry.id });

  } finally {
    activeOpCount--;
  }
});

// ── cancel a running broadcast/bulk/leave operation ─────────────────────────
app.post('/api/operations/:opId/cancel', (req, res) => {
  cancelledOps.add(req.params.opId);
  res.json({ ok: true });
});

// ── history ───────────────────────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  const limit = Math.min(200, Number(req.query.limit || 50));
  const entries = history.list(limit).map((e) => ({ ...e, items: undefined })); // list view: no per-item payload
  res.json({ entries });
});

app.get('/api/history/:id', (req, res) => {
  const entry = history.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  res.json({ entry });
});

// ── Anti-Status Guard config ────────────────────────────────────────────────
// Shared with the standalone command (scripts/anti-status-guard.mjs) via the
// same config file — reloaded from disk on every GET so either side's edits
// show up. Changing config is gated the same as other consequential actions
// (broadcast/leave/DP), since it governs an automated kick+delete+message action.
app.get('/api/anti-status/config', (req, res) => {
  try {
    res.json(antiStatus.reloadConfig());
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});
app.post('/api/anti-status/config', integrityGate, (req, res) => {
  try {
    const { enabled, deleteEnabled, kickEnabled, kickMessage, cooldownMs, warnLimit, warnMessage, manualEnabled, manualRemoveUser } = req.body || {};
    const patch = {};
    if (typeof enabled === 'boolean') patch.enabled = enabled;
    if (typeof deleteEnabled === 'boolean') patch.deleteEnabled = deleteEnabled;
    if (typeof kickEnabled === 'boolean') patch.kickEnabled = kickEnabled;
    if (typeof manualEnabled === 'boolean') patch.manualEnabled = manualEnabled;
    if (typeof manualRemoveUser === 'boolean') patch.manualRemoveUser = manualRemoveUser;
    if (typeof kickMessage === 'string') patch.kickMessage = kickMessage.slice(0, 1000);
    if (typeof cooldownMs === 'number' && cooldownMs >= 1000) patch.cooldownMs = cooldownMs;
    // Status-mention guard: same 3-strike-by-default warning count used for
    // someone posting a personal status that mentions/tags the group.
    if (typeof warnLimit === 'number' && warnLimit >= 1) patch.warnLimit = Math.floor(warnLimit);
    if (typeof warnMessage === 'string') patch.warnMessage = warnMessage.slice(0, 1000);
    res.json(antiStatus.saveConfig(patch));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});
app.post('/api/anti-status/group', integrityGate, (req, res) => {
  try {
    const { jid, enabled } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'jid is required' });
    res.json(antiStatus.setGroupEnabled(jid, !!enabled));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Bulk: switch the Anti-Status guard on/off for MANY groups in one click.
//   { all: true, enabled }        → every group this account is currently ADMIN in (the only place it can act)
//   { jids: [...], enabled }      → exactly the groups you ticked
app.post('/api/anti-status/bulk', integrityGate, async (req, res) => {
  try {
    const { all, jids, enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (true/false) is required' });
    let targets;
    if (all) targets = (await wa.getGroups()).filter((g) => g.isSelfAdmin).map((g) => g.jid);
    else if (Array.isArray(jids)) targets = jids;
    else return res.status(400).json({ error: 'send { all: true } or { jids: [...] }' });
    const cfg = antiStatus.setGroupsEnabled(targets, enabled);
    res.json({ ...cfg, changed: targets.length });
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ── Anti-Status manual control ──────────────────────────────────────────────
// Recent detected status broadcasts + a manual delete (optionally removing the
// sender). Independent of the automatic behavior above.
app.get('/api/anti-status/detected', (req, res) => {
  res.json({ entries: antiStatus.getDetected(req.query.jid || undefined) });
});
app.post('/api/anti-status/manual-delete', integrityGate, async (req, res) => {
  try {
    const { id, jid, removeUser } = req.body || {};
    if (!id && !jid) return res.status(400).json({ error: 'id or jid is required' });
    res.json(await antiStatus.manualDelete({ id, jid, removeUser: typeof removeUser === 'boolean' ? removeUser : undefined }));
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});

// ── Credits / branding (fully configurable — see src/branding.js) ───────────
app.get('/api/branding', (_req, res) => res.json(getBranding(DATA_DIR)));
app.post('/api/branding', integrityGate, (req, res) => {
  try {
    res.json(saveBranding(DATA_DIR, req.body || {}));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ── diagnostic: why isn't this account showing as admin in group X? ────────
// Not gated by integrityGate — it's read-only. Returns raw identifiers with
// no matching logic applied, so a JID-format mismatch can be seen directly.
app.get('/api/debug/group-admin', async (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: 'jid query param is required' });
  try {
    const result = await wa.debugGroupIdentity(jid);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ── Group Command Bot settings (.menu commands — see src/groupBot.js) ──────
// Lets the dashboard show/change every per-group toggle (Antilink, Antispam,
// Welcome, …) without needing to type `.command on|off` in WhatsApp itself.
// Reloaded from disk on every GET so a change made from chat shows up here
// too, and vice versa. Gated the same as Anti-Status config, since it
// governs automated delete/kick/message actions in your groups.
app.get('/api/group-bot/config', (req, res) => {
  try {
    res.json(groupBot.reloadConfig());
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});
app.post('/api/group-bot/mode', integrityGate, (req, res) => {
  try {
    const { mode } = req.body || {};
    res.json(groupBot.setMode(mode));
  } catch (err) {
    res.status(400).json({ error: String(err?.message || err) });
  }
});
app.get('/api/group-bot/settings', (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: 'jid query param is required' });
  try {
    res.json(groupBot.getGroupSettings(jid));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});
app.post('/api/group-bot/settings', integrityGate, (req, res) => {
  try {
    const { jid, patch } = req.body || {};
    if (!jid) return res.status(400).json({ error: 'jid is required' });
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch object is required' });
    res.json(groupBot.saveGroupSettings(jid, patch));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Bulk group settings: ONE patch (e.g. { antilink: true, antisticker: true, fileAccess: { enabled: true } }) applied to
// many groups at once — { jids: [...] } for the ticked groups, or { all: true } for every group you are in.
app.post('/api/group-bot/bulk', integrityGate, async (req, res) => {
  try {
    const { jids, all, patch } = req.body || {};
    if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch object is required' });
    let targets = jids;
    if (all) {
      const main = await wa.getGroups().catch(() => []);
      const extra = await accounts.allExtraGroups();
      targets = [...new Set([...main, ...extra].map((g) => g.jid))];
    }
    if (!Array.isArray(targets) || !targets.length) return res.status(400).json({ error: 'no groups selected' });
    res.json(groupBot.saveGroupSettingsBulk(targets, patch));
  } catch (err) {
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// ── extra numbers (multi-number) ─────────────────────────────────────────────
async function accountView(a) {
  const st = a.wa.getState();
  return { id: a.id, label: a.label, status: st.status, me: st.me, qr: await qrDataUrl(st.qr), pairingCode: st.pairingCode, pairingError: st.pairingError };
}
app.get('/api/accounts', async (_req, res) => {
  try { res.json({ accounts: await Promise.all([...accounts.accounts.values()].map(accountView)) }); }
  catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});
app.post('/api/accounts', async (req, res) => {
  try {
    const id = accounts.add(req.body?.label);
    let phone = String(req.body?.phone || '').replace(/[^\d]/g, '');
    if (/^0\d{10}$/.test(phone)) phone = '92' + phone.slice(1);
    if (phone) {
      if (!/^\d{7,15}$/.test(phone)) return res.status(400).json({ error: 'Invalid phone number (use country code, e.g. 923001234567).' });
      accounts.get(id).wa.requestPairingCode(phone).catch((err) => logger.warn({ err: String(err?.message || err) }, 'extra pairing failed'));
    }
    res.json({ id });
  } catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});
app.post('/api/accounts/:id/pair', async (req, res) => {
  try {
    let phone = String(req.body?.phone || '').replace(/[^\d]/g, '');
    if (/^0\d{10}$/.test(phone)) phone = '92' + phone.slice(1);
    if (!/^\d{7,15}$/.test(phone)) return res.status(400).json({ error: 'Invalid phone number (use country code, e.g. 923001234567).' });
    accounts.get(req.params.id).wa.requestPairingCode(phone).catch((err) => logger.warn({ err: String(err?.message || err) }, 'extra pairing failed'));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});
app.post('/api/accounts/:id/reconnect', async (req, res) => {
  try { await accounts.get(req.params.id).wa.reconnect(); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});
app.delete('/api/accounts/:id', async (req, res) => {
  try { await accounts.remove(req.params.id); res.json({ ok: true }); }
  catch (err) { res.status(500).json({ error: String(err?.message || err) }); }
});

// ── JSON-only 404 + error handling ──────────────────────────────────────────
// Placed after every route above. Without this, an unmatched path or an
// uncaught throw inside a route falls through to Express's own default
// handler, which renders an HTML page (a literal "<!DOCTYPE html>…" stack
// trace) — the frontend then tries res.json() on that HTML and fails with
// "Unexpected token '<' … is not valid JSON". These two handlers make sure
// every single response from this API, error or not, is JSON.
app.use((req, res) => {
  res.status(404).json({ error: `No such API route: ${req.method} ${req.path}` });
});
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error({ err }, 'unhandled error in route handler');
  if (res.headersSent) return;
  res.status(500).json({ error: String(err?.message || err) });
});

app.listen(PORT, HOST, () => {
  logger.info(`Mehfooz Status Control → http://${HOST}:${PORT}`);
  logger.info(`Session dir: ${SESSION_DIR}`);
});
