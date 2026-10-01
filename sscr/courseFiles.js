/**
 * Course Files — "Chishti Stock" delivery engine.
 *
 * NEW FLOW (v2.1) — no numbered menus, nothing to learn:
 *
 *   cs101            → every file of the course, streamed out in a fixed order
 *                      (Handouts → Midterms → Finals → Quizzes), non-stop.
 *   cs101 mid        → only Midterm papers          (aliases: midterm, mids)
 *   cs101 final      → only Finalterm papers        (aliases: finals, finalterm)
 *   cs101 handouts   → only Handouts & Books        (aliases: handout, book, books, notes)
 *   cs101 quiz       → only Quizzes & Short Notes   (aliases: quizzes, short, assignments)
 *   more / cs101 more→ the next burst, when a course has more files than the group's batch size
 *
 * Speed: the moment a course is recognised, every download starts in parallel
 * (up to DOWNLOAD_CONCURRENCY at once) while the first file is already being
 * sent, so WhatsApp never waits for a download. Downloaded files are kept in a
 * small in-memory cache, so the 2nd member asking for the same course gets
 * files instantly. Nothing is sent for a folder that does not exist — normal
 * chat is never touched.
 *
 * Optional "delivery card" (per group, `.filecard on|off`, `.filecardlink on|off`):
 * after the files are out, the bot posts the group's DP with a caption that
 * mentions the member, names the group and (optionally) shares the invite link.
 *
 * The file store is presented to members as "Chishti Stock" (STORE_NAME).
 * Optional env var GITHUB_TOKEN raises the store's 60 requests/hour limit.
 */
import axios from 'axios';

export const GITHUB_OWNER = 'bubblevuofficial-ops';
export const GITHUB_REPO = 'data';
export const GITHUB_BRANCH = 'main';
export const STORE_NAME = 'Chishti Stock';
export const COURSE_CODE_RE = /^[a-z]{2,5}\d{2,5}[a-z0-9]*$/;
export const DEFAULT_BATCH_SIZE = 10;
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 50;
export const POWERED_BY = 'Powered by Saif Chishti';
export const SUPPORT_NUMBER = (process.env.DEV_NUMBER || '923204854766').replace(/\D/g, ''); // shown when a file is not in stock
const KEYCAPS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];

const LIST_TTL_MS = 5 * 60_000; // cache a folder listing (saves the 60/hr unauthenticated API quota)
const MISS_TTL_MS = 2 * 60_000; // cache "folder does not exist" too
const SESSION_TTL_MS = 2 * 60 * 60_000; // an unfinished course expires after 2 hours
const DOWNLOAD_CONCURRENCY = 10;
const DUP_WINDOW_MS = 10_000; // same member + same request inside this window = duplicate, ignored
const MENU_TTL_MS = 10 * 60_000;
const SEND_GAP_MS = 25; // just enough to keep WhatsApp ordering stable
const CACHE_MAX_BYTES = 200 * 1024 * 1024;
const CACHE_MAX_FILE_BYTES = 30 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;
const TRUSTED_HOSTS = new Set(['api.github.com', 'raw.githubusercontent.com']);

/** Categories in delivery order. `aliases` are what a member may type after the course code. */
export const CATEGORIES = [
  { key: 'handouts', icon: '📘', label: 'Handouts & Books', aliases: ['handout', 'handouts', 'book', 'books', 'notes', 'lectures', 'lecture'] },
  { key: 'mid', icon: '📝', label: 'Midterm Papers', aliases: ['mid', 'mids', 'midterm', 'midterms'] },
  { key: 'final', icon: '🎓', label: 'Finalterm Papers', aliases: ['final', 'finals', 'finalterm', 'finalterms'] },
  { key: 'quiz', icon: '⚡', label: 'Quizzes & Short Notes', aliases: ['quiz', 'quizzes', 'short', 'assignment', 'assignments'] },
];

export function clampBatchSize(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_BATCH_SIZE;
  return Math.min(MAX_BATCH_SIZE, Math.max(MIN_BATCH_SIZE, v));
}

/** "  .CS101 " → "cs101" if it looks like a course code, else null. */
export function parseCourseCode(text) {
  const t = String(text || '').trim().toLowerCase().replace(/^\./, '');
  return COURSE_CODE_RE.test(t) ? t : null;
}

/**
 * "cs101" | ".cs101 mid" | "cs101 more" | "more" → { code, filter, more } or null.
 * A second word is only accepted when it is a known filter — so an ordinary sentence that
 * happens to start with something code-shaped is ignored (and never hits the store).
 */
export function parseRequest(text) {
  const parts = String(text || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 2) return null;
  const first = parts[0].replace(/^\./, '');
  if (parts.length === 1 && first === 'more') return { code: null, filter: null, more: true };
  const code = COURSE_CODE_RE.test(first) ? first : null;
  if (!code) return null;
  if (parts.length === 1) return { code, filter: null, more: false };
  const word = parts[1].replace(/^\./, '');
  if (word === 'more') return { code, filter: null, more: true };
  if (word === 'all') return { code, filter: null, more: false };
  if (/^\d{1,2}$/.test(word)) return { code, filter: null, more: false, pick: Number(word) };
  const cat = CATEGORIES.find((c) => c.aliases.includes(word) || c.key === word);
  return cat ? { code, filter: cat.key, more: false } : null;
}

/** Which category one file belongs to. */
export function categoryOf(file) {
  const name = String(file?.name || '').toLowerCase();
  // "pdf" is matched on the name without its extension — nearly every file ends in .pdf.
  const base = name.replace(/\.[a-z0-9]{1,5}$/, '');
  if (name.includes('handout') || name.includes('book') || base.includes('pdf')) return 'handouts';
  if (name.includes('mid')) return 'mid';
  if (name.includes('final')) return 'final';
  return 'quiz';
}

/** Files split per category (each list naturally sorted by name). */
export function groupFiles(files) {
  const groups = { handouts: [], mid: [], final: [], quiz: [] };
  for (const f of files) groups[categoryOf(f)].push(f);
  for (const k of Object.keys(groups)) groups[k].sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
  return groups;
}

/** File name = last URL segment, no query string, percent-decoding undone. */
export function fileNameFromUrl(url) {
  const last = String(url || '').split('?')[0].split('#')[0].split('/').filter(Boolean).pop() || 'file.pdf';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

const MIME = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  txt: 'text/plain',
  zip: 'application/zip',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};
export function mimeFor(fileName) {
  const ext = String(fileName).toLowerCase().split('.').pop();
  return MIME[ext] || 'application/pdf'; // PDF is the default, as specified
}

/** ".read" / "read" / "!read" / ".scan" — the command that reads a picture. */
export function isReadCommand(text) {
  return /^[.!]?\s*(read|scan)\s*$/i.test(String(text || '').trim());
}

/**
 * Pulls every subject code out of OCR text: "CS504", "cs-504", "CS 504", "MTH101" → ["cs504", "mth101"].
 * In the digit part the usual OCR slips are repaired (O→0, I/l→1). Order of appearance is kept, duplicates dropped.
 */
export function extractCourseCodes(text) {
  const out = [];
  const re = /(?<![a-z0-9])([a-z]{2,4})[\s\-_]?([0-9oil]{3,4})(?![a-z0-9])/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const digits = m[2].replace(/[oO]/g, '0').replace(/[iIlL]/g, '1');
    if (!/^\d{3,4}$/.test(digits)) continue;
    const code = `${m[1]}${digits}`.toLowerCase();
    if (COURSE_CODE_RE.test(code) && !out.includes(code)) out.push(code);
  }
  return out;
}

const ADMIN_CMDS = new Set(['stats', 'stat', 'files', 'total', 'count', 'repo', 'folders', 'folder', 'upload', 'done',
  ...CATEGORIES.flatMap((c) => [c.key, ...c.aliases])]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export class CourseFiles {
  /**
   * @param {import('./wa-client.js').WhatsAppClient} wa
   * @param {{logger?: any, http?: any, token?: string, credit?: () => string}} [opts]
   *   `http` = axios instance (tests inject a fake); `credit` returns the "Powered by …" line ('' hides it).
   */
  constructor(wa, { logger, http = axios, token = process.env.GITHUB_TOKEN, credit } = {}) {
    this.wa = wa;
    this.logger = logger;
    this.http = http;
    this.token = (token || '').trim();
    this.credit = credit || (() => POWERED_BY);
    this.sessions = new Map(); // "chat|sender" -> { code, filter, files, index, touchedAt, busy }
    this._listCache = new Map(); // code -> { at, files|null }
    this._fileCache = new Map(); // download_url -> { at, buffer }
    this._fileCacheBytes = 0;
    this._inflight = new Map(); // download_url -> Promise<{buffer,fileName}|null>
    this._recent = new Map(); // "chat|sender|request" -> timestamp (duplicate guard)
    this._menus = new Map(); // menu message id -> { groupJid, code, options, key, at }
    this._pending = new Map(); // "chat|sender" -> that member's latest open menu
  }

  _creditLine() {
    const c = String(this.credit() || '').trim();
    return c ? `_${c.replace(/\.$/, '')}_` : '';
  }

  /** Group name, auto-detected (cached 10 min). Falls back to the store name. */
  async _groupName(groupJid) {
    const hit = this._names?.get(groupJid);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.name;
    let name = STORE_NAME;
    try {
      const meta = await this.wa.getGroupMetadata(groupJid);
      if (meta?.subject) name = meta.subject;
    } catch { /* keep fallback */ }
    if (!this._names) this._names = new Map();
    this._names.set(groupJid, { at: Date.now(), name });
    return name;
  }

  _sessionKey(chatId, senderBare) {
    return `${chatId}|${senderBare}`;
  }

  _getSession(chatId, senderBare) {
    const key = this._sessionKey(chatId, senderBare);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (Date.now() - s.touchedAt > SESSION_TTL_MS) {
      this.sessions.delete(key);
      return null;
    }
    return s;
  }

  _deleteSession(chatId, senderBare) {
    this.sessions.delete(this._sessionKey(chatId, senderBare));
  }

  _headers(url) {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'mehfooz-course-files' };
    if (this.token) {
      // Only ever sent to the store's own hosts.
      try {
        if (TRUSTED_HOSTS.has(new URL(url).hostname)) headers.Authorization = `token ${this.token}`;
      } catch { /* not a URL — no token */ }
    }
    return headers;
  }

  /** Folder listing (files only) or null when the folder doesn't exist / can't be read. */
  async _listFolder(code) {
    const hit = this._listCache.get(code);
    if (hit && Date.now() - hit.at < (hit.files ? LIST_TTL_MS : MISS_TTL_MS)) return hit.files;

    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(code)}`;
    let files = null;
    try {
      const res = await this.http.get(url, { params: { ref: GITHUB_BRANCH }, headers: this._headers(url), timeout: 20_000 });
      if (Array.isArray(res.data) && res.data.length) {
        files = res.data.filter((f) => f && f.type === 'file' && f.download_url && !String(f.name).startsWith('.'));
        if (!files.length) files = null;
      }
    } catch (err) {
      const status = err?.response?.status;
      if (status === 403 || status === 429) {
        this.logger?.warn({ code, status }, 'course-files: store rate limit hit — set GITHUB_TOKEN to raise it');
        return undefined; // don't cache: the limit will lift (undefined = "could not check", null = "not in stock")
      }
      if (status !== 404) {
        this.logger?.warn({ code, err: String(err?.message || err) }, 'course-files: store listing failed');
        return undefined; // network hiccup — stay silent, don't claim the course is missing
      }
    }
    this._listCache.set(code, { at: Date.now(), files });
    return files;
  }

  // ── download layer: cache + in-flight de-duplication + one retry ───────────
  _cacheGet(url) {
    const hit = this._fileCache.get(url);
    if (!hit) return null;
    if (Date.now() - hit.at > CACHE_TTL_MS) {
      this._fileCache.delete(url);
      this._fileCacheBytes -= hit.buffer.length;
      return null;
    }
    return hit.buffer;
  }

  _cachePut(url, buffer) {
    if (buffer.length > CACHE_MAX_FILE_BYTES) return;
    this._fileCache.set(url, { at: Date.now(), buffer });
    this._fileCacheBytes += buffer.length;
    for (const [k, v] of this._fileCache) { // Map keeps insertion order → oldest first
      if (this._fileCacheBytes <= CACHE_MAX_BYTES) break;
      this._fileCache.delete(k);
      this._fileCacheBytes -= v.buffer.length;
    }
  }

  _fetchOne(f) {
    const cached = this._cacheGet(f.download_url);
    if (cached) return Promise.resolve({ buffer: cached, fileName: fileNameFromUrl(f.download_url) || f.name });
    if (this._inflight.has(f.download_url)) return this._inflight.get(f.download_url);
    const p = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await this.http.get(f.download_url, {
            responseType: 'arraybuffer',
            headers: this._headers(f.download_url),
            timeout: 90_000,
            maxContentLength: 100 * 1024 * 1024,
            maxBodyLength: 100 * 1024 * 1024,
          });
          const buffer = Buffer.from(res.data);
          this._cachePut(f.download_url, buffer);
          return { buffer, fileName: fileNameFromUrl(f.download_url) || f.name };
        } catch (err) {
          if (attempt === 1) this.logger?.warn({ file: f.name, err: String(err?.message || err) }, 'course-files: download failed — skipping');
        }
      }
      return null;
    })().finally(() => this._inflight.delete(f.download_url));
    this._inflight.set(f.download_url, p);
    return p;
  }

  /** Starts every download right away with limited concurrency; returns one promise per file, in order. */
  _startDownloads(batch) {
    let next = 0;
    const resolvers = [];
    const results = batch.map((_, i) => new Promise((resolve) => { resolvers[i] = resolve; }));
    const worker = async () => {
      while (next < batch.length) {
        const i = next++;
        resolvers[i](await this._fetchOne(batch[i]));
      }
    };
    for (let w = 0; w < Math.min(DOWNLOAD_CONCURRENCY, batch.length); w++) worker();
    return results;
  }

  /** "2" | "#2" | "option 2" | ".2" → 2, else null. */
  static parsePick(text) {
    const m = /^[.#]?\s*(?:option|opt|no|number)?\s*\.?\s*(\d{1,2})\s*$/i.exec(String(text || '').trim());
    return m ? Number(m[1]) : null;
  }

  /** The menu a numeric reply refers to: the one it was written as a reply to, else the sender's own latest menu. */
  _findMenu(groupJid, senderBare, msg) {
    const now = Date.now();
    const ctx = msg?.message?.extendedTextMessage?.contextInfo;
    const quoted = ctx?.stanzaId && this._menus.get(ctx.stanzaId);
    if (quoted && quoted.groupJid === groupJid && now - quoted.at < MENU_TTL_MS) return quoted;
    const own = this._pending.get(this._sessionKey(groupJid, senderBare));
    return own && now - own.at < MENU_TTL_MS ? own : null;
  }

  /**
   * Entry point from the group bot for ONE group message (feature already
   * known to be enabled for that group). Returns true when the message was
   * consumed (so the caller must not process it further).
   * `card` = { enabled, showLink } — the optional delivery card for this group.
   */
  async handle({ groupJid, senderBare, senderJid, text, msg, batchSize, card, log }) {
    let req = parseRequest(text);

    // A number ("2") answers the menu the bot showed — but only when such a menu is open, so normal chat is never touched.
    if (!req) {
      const pick = CourseFiles.parsePick(text);
      if (pick === null) return false;
      const menu = this._findMenu(groupJid, senderBare, msg);
      const opt = menu?.options[pick - 1];
      if (!opt) return false;
      req = { code: menu.code, filter: opt.filter, more: false };
    }

    // "more" continues THIS member's own unfinished course — nobody else's.
    if (req.more) {
      const s = this._getSession(groupJid, senderBare);
      if (s && (!req.code || s.code === req.code)) {
        await this._run({ groupJid, senderBare, senderJid, msg, session: s, batchSize, card, log });
        return true;
      }
      if (!req.code) return false; // bare "more" with nothing open → ordinary chat, stay silent
      // "cs101 more" with no open cs101 session → just start cs101 from the top
    }

    const code = req.code;
    const dupKey = `${groupJid}|${senderBare}|${code}|${req.filter || ''}`;
    const nowTs = Date.now();
    if (nowTs - (this._recent.get(dupKey) || 0) < DUP_WINDOW_MS) return true; // same request twice → answer once
    const files = await this._listFolder(code);
    if (files === undefined) return false; // store unreachable / rate-limited → stay silent
    if (files === null) {
      // Not in stock: tell the member who to contact (once per window per member/course).
      this._recent.set(dupKey, nowTs);
      await this.wa.sendText(groupJid, this._notFoundBox({ senderBare, code, groupName: await this._groupName(groupJid) }), [senderJid]).catch(() => {});
      return true;
    }
    this._recent.set(dupKey, nowTs);
    if (this._recent.size > 500) for (const [k, t] of this._recent) if (nowTs - t > DUP_WINDOW_MS) this._recent.delete(k);

    const groups = groupFiles(files);
    const filled = CATEGORIES.filter((c) => groups[c.key].length);

    // No category chosen and the course has several kinds of files → show the menu box and wait for a number.
    // A category that has no files → show the menu again with a friendly note instead of guessing.
    if (req.pick) {
      const opts = [...filled.map((c) => c.key), null]; // last option = everything
      if (req.pick > opts.length) {
        await this._sendMenu({ groupJid, senderBare, senderJid, code, groups, filled, missedLabel: null });
        return true;
      }
      req = { ...req, filter: opts[req.pick - 1] };
    }
    const missed = !!req.filter && !groups[req.filter].length;
    if ((!req.filter && !req.pick && filled.length > 1) || (missed && filled.length)) {
      await this._sendMenu({ groupJid, senderBare, senderJid, code, groups, filled, missedLabel: missed ? CATEGORIES.find((c) => c.key === req.filter).label : null });
      return true;
    }

    let ordered = [];
    const filter = req.filter && groups[req.filter].length ? req.filter : null;
    if (filter) ordered = groups[filter];
    else for (const c of CATEGORIES) ordered.push(...groups[c.key]);

    const session = { code, subject: code.toUpperCase(), filter, files: ordered, index: 0, touchedAt: Date.now(), busy: false };
    this.sessions.set(this._sessionKey(groupJid, senderBare), session);
    await this._run({ groupJid, senderBare, senderJid, msg, session, batchSize, card, log, first: true });
    return true;
  }

  // ══════════════════════════ OWNER / ADMIN COMMANDS ══════════════════════════
  //   .stats [cs101]   → folders + total files + handouts / mids / finals / quizzes
  //   .files | .total  → total files          .folders → number (and names) of folders
  //   .handouts | .mids | .finals | .quizzes [cs101] → count for that type
  //   .upload cs101    → create folder cs101 on GitHub; every file you send next goes inside it
  //   .upload stop     → end the upload mode   (also: .done)
  // Needs a GitHub token with WRITE access (env GITHUB_WRITE_TOKEN or GITHUB_TOKEN) for .upload.

  /** One API call for the whole repo (git tree). Cached 2 min. */
  async _repoStats() {
    if (this._statsCache && Date.now() - this._statsCache.at < 2 * 60_000) return this._statsCache.data;
    const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}`;
    const res = await this.http.get(url, { params: { recursive: 1 }, headers: this._headers(url), timeout: 30_000 });
    const folders = new Map(); // folder -> { total, handouts, mid, final, quiz }
    for (const n of res.data?.tree || []) {
      const parts = String(n.path).split('/');
      if (n.type === 'tree' && parts.length === 1 && !parts[0].startsWith('.')) {
        if (!folders.has(parts[0])) folders.set(parts[0], { total: 0, handouts: 0, mid: 0, final: 0, quiz: 0 });
      }
      if (n.type === 'blob' && parts.length >= 2 && !parts[0].startsWith('.') && !parts[parts.length - 1].startsWith('.')) {
        const f = folders.get(parts[0]) || { total: 0, handouts: 0, mid: 0, final: 0, quiz: 0 };
        f.total += 1;
        f[categoryOf({ name: parts[parts.length - 1] })] += 1;
        folders.set(parts[0], f);
      }
    }
    const data = { folders };
    this._statsCache = { at: Date.now(), data };
    return data;
  }

  static _docOf(msg) {
    const unwrap = (m) => m?.documentMessage || m?.documentWithCaptionMessage?.message?.documentMessage || null;
    const m = msg?.message;
    const own = unwrap(m);
    if (own) return { doc: own, holder: msg, own: true };
    const q = m?.extendedTextMessage?.contextInfo?.quotedMessage;
    const quoted = unwrap(q);
    if (quoted) return { doc: quoted, holder: { key: msg.key, message: q }, own: false };
    return null;
  }

  async _downloadDoc(holder) {
    if (typeof this.wa.downloadMedia === 'function') return this.wa.downloadMedia(holder);
    const { downloadMediaMessage } = await import('@itsliaaa/baileys');
    return downloadMediaMessage(holder, 'buffer', {});
  }

  /**
   * Create/overwrite `path` on GitHub. With { keepBoth: true } an existing file is NEVER replaced:
   * the new one is saved as "name (2).ext", "name (3).ext" … and the final path is returned.
   */
  async _ghPut(path, buffer, message, { keepBoth = false } = {}) {
    const tok = (process.env.GITHUB_WRITE_TOKEN || this.token || '').trim();
    if (!tok) throw new Error('no GitHub token — set GITHUB_WRITE_TOKEN');
    const urlOf = (p) => `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${p.split('/').map(encodeURIComponent).join('/')}`;
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'mehfooz-course-files', Authorization: `token ${tok}` };
    const lookup = async (p) => {
      try {
        const r = await this.http.get(urlOf(p), { params: { ref: GITHUB_BRANCH }, headers, timeout: 20_000 });
        return r.data?.sha || true;
      } catch (e) { if (e?.response?.status !== 404) throw e; return null; }
    };
    let sha = await lookup(path);
    if (keepBoth && sha) {
      const slash = path.lastIndexOf('/');
      const dir = path.slice(0, slash + 1);
      const base = path.slice(slash + 1);
      const dot = base.lastIndexOf('.');
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : '';
      for (let n = 2; sha && n < 500; n += 1) {
        path = `${dir}${stem} (${n})${ext}`;
        sha = await lookup(path);
      }
      message = `Add ${path}`;
    }
    if (sha === true) sha = undefined;
    this._lastPutReplaced = !!sha;
    const url = urlOf(path);
    await this.http.put(url, { message, content: Buffer.from(buffer).toString('base64'), branch: GITHUB_BRANCH, ...(sha ? { sha } : {}) },
      { headers, timeout: 120_000, maxBodyLength: Infinity, maxContentLength: Infinity });
    this._statsCache = null;
    return path;
  }

  async _uploadDoc({ groupJid, senderJid, msg, folder, info, groupName, session }) {
    const name = String(info.doc.fileName || `file-${Date.now()}.pdf`).replace(/[\\/]/g, '_').trim();
    try {
      const buffer = await this._downloadDoc(info.holder);
      const saved = await this._ghPut(`${folder}/${name}`, buffer, `Add ${folder}/${name}`, { keepBoth: false }); // same name again → old file is replaced by the new one
      const savedName = saved.slice(folder.length + 1);
      this._listCache.clear(); // uploaded files must show up in the very next search
      this._fileCache.clear();
      this._fileCacheBytes = 0;
      this._statsCache = null;
      session.count += 1;
      await this.wa.sendText(groupJid, `✅ Uploaded → ${folder}/${savedName}`, [senderJid]).catch(() => {});
    } catch (err) {
      this.logger?.warn({ err: String(err?.message || err), name }, 'course-files: upload failed');
      await this.wa.sendText(groupJid, `❌ Upload failed: ${name}\n${String(err?.response?.data?.message || err?.message || err).slice(0, 120)}`, [senderJid]).catch(() => {});
    }
  }

  /**
   * Call this for EVERY message from the owner/admin BEFORE handle() (documents included — text may be empty).
   * Returns true when the message was an admin command / an upload (then skip everything else).
   */
  async handleAdmin({ groupJid, senderBare, senderJid, text, msg, isAdmin }) {
    if (!isAdmin) return false;
    const info = CourseFiles._docOf(msg);
    const caption = info?.own ? (info.doc.caption || msg?.message?.documentWithCaptionMessage?.message?.documentMessage?.caption || '') : '';
    const t = String(text || caption || '').trim();
    const isDot = t.startsWith('.');
    const parts = t.toLowerCase().replace(/^\./, '').split(/\s+/).filter(Boolean);
    const cmd = isDot ? parts[0] || '' : '';
    const arg = parts[1] || '';
    const key = this._sessionKey(groupJid, senderBare);
    this._uploads ||= new Map();
    const groupName = await this._groupName(groupJid);
    const credit = this._creditLine();
    const send = (lines) => this.wa.sendText(groupJid, [...lines, ...(credit ? [credit] : [])].join('\n'), [senderJid]).catch(() => {});

    // ── upload: `.upload cs101` as a REPLY to a file (or as the file's caption) → saved straight into folder cs101 ──
    if (cmd === 'upload') {
      const folder = arg.replace(/[^a-z0-9_-]/g, '');
      if (!folder || !info) {
        await send([`📚 *${groupName}*`, !folder ? 'Use: reply to a file with *.upload cs101*' : 'Reply to a file with *.upload ' + folder + '*']);
        return true;
      }
      await this._uploadDoc({ groupJid, senderJid, msg, folder, info, groupName, session: { count: 0 } });
      return true;
    }

    // ── counting commands ──
    const cat = CATEGORIES.find((c) => c.aliases.includes(cmd) || c.key === cmd);
    const isStats = ['stats', 'stat', 'files', 'total', 'count', 'repo'].includes(cmd);
    const isFolders = ['folders', 'folder'].includes(cmd);
    if (!isDot || !(cat || isStats || isFolders)) return false;

    let data;
    try { data = await this._repoStats(); } catch (err) {
      await send([`❌ Could not read the repository: ${String(err?.response?.status || err?.message || err).slice(0, 80)}`]);
      return true;
    }
    const code = COURSE_CODE_RE.test(arg) ? arg : null;
    const rows = code ? [...data.folders].filter(([k]) => k === code) : [...data.folders];
    if (code && !rows.length) {
      await send([`📚 *${groupName}*`, `*${code.toUpperCase()}* folder not found.`]);
      return true;
    }
    const sum = (k) => rows.reduce((n, [, f]) => n + f[k], 0);
    const lines = [`📚 *${groupName}*`];
    if (isFolders) {
      const names = [...data.folders.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      lines.push(`📁 Folders: *${names.length}*`, names.map((n) => n.toUpperCase()).join(', '));
    } else if (cat) {
      lines.push(`${cat.icon} ${cat.label}: *${sum(cat.key)}*${code ? ` in ${code.toUpperCase()}` : ` (in ${rows.filter(([, f]) => f[cat.key]).length} folders)`}`);
    } else {
      lines.push(code ? `📊 *${code.toUpperCase()}*` : '📊 *Repository*');
      if (!code) lines.push(`📁 Folders: *${rows.length}*`);
      lines.push(`📦 Total files: *${sum('total')}*`);
      for (const c of CATEGORIES) lines.push(`${c.icon} ${c.label}: *${sum(c.key)}*`);
    }
    await send(lines);
    return true;
  }

  /** Text that could be an admin command (cheap pre-check, no auth work). */
  static isAdminText(text) {
    const w = String(text || '').trim().toLowerCase().split(/\s+/)[0] || '';
    return ADMIN_CMDS.has(w.replace(/^\./, '')) && w.startsWith('.');
  }

  /** Does this member have an open `.upload` folder in this chat? */
  hasOpenUpload(groupJid, senderBare) {
    const u = this._uploads?.get(this._sessionKey(groupJid, senderBare));
    return !!u && Date.now() - u.at < 30 * 60_000;
  }

  _supportLine() {
    return `📞 Need something we don't have? Contact *Saif*: wa.me/${SUPPORT_NUMBER}`;
  }

  _notFoundBox({ senderBare, code, groupName }) {
    return [
      `📚 *${groupName}*`,
      `@${senderBare} sorry, *${code.toUpperCase()}* is not in stock right now 😔`,
      this._supportLine(),
      ...(this._creditLine() ? [this._creditLine()] : []),
    ].join('\n');
  }

  /** ONE nicely designed message listing every option as a number. The member replies with the number. */
  async _sendMenu({ groupJid, senderBare, senderJid, code, groups, filled, missedLabel }) {
    const subject = code.toUpperCase();
    const total = filled.reduce((n, c) => n + groups[c.key].length, 0);
    const options = filled.map((c) => ({ filter: c.key, c, n: groups[c.key].length }));
    options.push({ filter: null, c: { icon: '🗂️', label: 'Everything (all of the above)' }, n: total });
    const credit = this._creditLine();
    const groupName = await this._groupName(groupJid);
    const lines = [`📚 *${groupName}*`];
    if (missedLabel) lines.push(`@${senderBare} no *${missedLabel}* for *${subject}* yet 😔 — we have:`);
    else lines.push(`@${senderBare} *${subject}* — ${plural(total, 'file')}:`);
    options.forEach((o, i) => lines.push(`${KEYCAPS[i] || `${i + 1}.`} ${o.c.icon} ${o.c.label} (${o.n})`));
    lines.push(`👉 Send *${code} 2* or just *2* · or type *${code} mid* / *${code} final*`);
    if (credit) lines.push(credit);
    const sent = await this.wa.sendText(groupJid, lines.join('\n'), [senderJid]).catch(() => null);
    const menu = { groupJid, code, options, key: sent?.key, at: Date.now() };
    this._pending.set(this._sessionKey(groupJid, senderBare), menu);
    if (sent?.key?.id) this._menus.set(sent.key.id, menu);
    for (const [k, m] of this._menus) if (Date.now() - m.at > MENU_TTL_MS) this._menus.delete(k);
    for (const [k, m] of this._pending) if (Date.now() - m.at > MENU_TTL_MS) this._pending.delete(k);
  }

  // Kept for compatibility with older callers (buttons are no longer sent).
  static buttonToText() { return null; }
  async vanishMenu() {}

  // ══════════════════════════ IMAGE READER (.read) ══════════════════════════
  //   Reply to a picture (a course-selection screenshot, a datesheet …) with `.read`:
  //   the bot scans it, lists every subject code it can see, checks the store, and then
  //   sends the files step by step — one batch at a time, `more` gives the next batch.

  /** The picture a message points at: the replied-to image, or the message's own image. */
  _pictureOf(msg, groupJid) {
    const m = msg?.message || {};
    const ctx = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;
    const img = quoted?.imageMessage
      || quoted?.viewOnceMessage?.message?.imageMessage
      || quoted?.documentWithCaptionMessage?.message?.imageMessage;
    if (img) {
      return { key: { remoteJid: groupJid, id: ctx.stanzaId, participant: ctx.participant, fromMe: false }, message: { imageMessage: img } };
    }
    if (m.imageMessage) return msg; // ".read" typed as the caption of the picture itself
    return null;
  }

  async _downloadPicture(pic) {
    const { downloadMediaMessage } = await import('@itsliaaa/baileys');
    return downloadMediaMessage(
      pic, 'buffer', {},
      { logger: this.logger, reuploadRequest: this.wa.sock?.updateMediaMessage?.bind(this.wa.sock) },
    );
  }

  /**
   * Picture → text. Uses Claude vision when ANTHROPIC_API_KEY is set (best on screenshots),
   * otherwise free offline OCR (tesseract.js, installed with `npm install`).
   */
  async _ocr(buffer) {
    const key = (process.env.ANTHROPIC_API_KEY || '').trim();
    if (key) {
      try {
        const res = await this.http.post('https://api.anthropic.com/v1/messages', {
          model: process.env.ANTHROPIC_VISION_MODEL || 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          messages: [{ role: 'user', content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: Buffer.from(buffer).toString('base64') } },
            { type: 'text', text: 'List every university subject/course code visible in this image (like CS101, MTH302, ENG201), in order of appearance, separated by spaces. Output only the codes.' },
          ] }],
        }, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 45_000 });
        const text = (res.data?.content || []).map((c) => c.text || '').join(' ');
        if (text.trim()) return text;
      } catch (err) {
        this.logger?.warn({ err: String(err?.message || err) }, 'course-files: vision read failed — falling back to OCR');
      }
    }
    const { createWorker } = await import('tesseract.js');
    if (!this._ocrWorker) this._ocrWorker = createWorker('eng');
    const worker = await this._ocrWorker;
    const { data } = await worker.recognize(Buffer.from(buffer));
    return data?.text || '';
  }

  /**
   * `.read` handler. Returns true when the message was consumed.
   */
  async handleRead({ groupJid, senderBare, senderJid, msg, batchSize, card, log }) {
    const pic = this._pictureOf(msg, groupJid);
    const credit = this._creditLine();
    const who = `@${senderBare}`;
    if (!pic) {
      await this.wa.sendText(groupJid, `${who} 🖼️ Reply to a picture with *.read* and I'll find the subjects in it and send their files.${credit ? `\n${credit}` : ''}`, [senderJid]).catch(() => {});
      return true;
    }
    const dupKey = `${groupJid}|${senderBare}|read|${pic.key?.id || ''}`;
    if (Date.now() - (this._recent.get(dupKey) || 0) < DUP_WINDOW_MS) return true;
    this._recent.set(dupKey, Date.now());

    const existing = this._getSession(groupJid, senderBare);
    if (existing?.busy) return true;

    await this.wa.sendText(groupJid, [`🖼️ *Image received!*`, ``, `🔍 Scanning complete image…`, `📚 Looking for all subject codes…`, `⏳ Please wait…`].join('\n'), [senderJid]).catch(() => {});

    let codes = [];
    try {
      codes = extractCourseCodes(await this._ocr(await this._downloadPicture(pic)));
    } catch (err) {
      this.logger?.warn({ err: String(err?.message || err) }, 'course-files: reading the picture failed');
      await this.wa.sendText(groupJid, `${who} ⚠️ Could not read that picture. Please send a clearer screenshot.`, [senderJid]).catch(() => {});
      return true;
    }
    if (!codes.length) {
      await this.wa.sendText(groupJid, `${who} 😔 No subject codes found in that picture. Try a clearer / cropped screenshot, or type the code (e.g. *cs101*).`, [senderJid]).catch(() => {});
      return true;
    }

    // Check every code in the store (in parallel; listings are cached).
    const listings = await Promise.all(codes.map((c) => this._listFolder(c)));
    const found = [];
    const missing = [];
    codes.forEach((c, i) => {
      if (Array.isArray(listings[i])) found.push({ code: c, files: listings[i] });
      else if (listings[i] === null) missing.push(c);
    });

    const lines = [`📚 *Subjects:* ${codes.map((c) => c.toUpperCase()).join(' | ')}`];
    if (found.length) lines.push(`✅ In stock: ${found.map((f) => `${f.code.toUpperCase()} (${f.files.length})`).join(' | ')}`);
    if (missing.length) lines.push(`❌ Not in stock: ${missing.map((c) => c.toUpperCase()).join(' | ')}`);
    if (!found.length) lines.push(this._supportLine());
    await this.wa.sendText(groupJid, lines.join('\n'), [senderJid]).catch(() => {});
    if (!found.length) return true;

    // One queue for the whole picture: subject by subject, each in the usual order (Handouts → Mids → Finals → Quizzes).
    const queue = [];
    for (const { code, files } of found) {
      const groups = groupFiles(files);
      for (const c of CATEGORIES) for (const f of groups[c.key]) queue.push({ ...f, _course: code.toUpperCase() });
    }
    const session = {
      code: found.length === 1 ? found[0].code : null,
      subject: found.map((f) => f.code.toUpperCase()).join(' + '),
      scope: `Picture · ${plural(found.length, 'subject')}`,
      filter: null, files: queue, index: 0, touchedAt: Date.now(), busy: false,
    };
    this.sessions.set(this._sessionKey(groupJid, senderBare), session);
    await this._run({ groupJid, senderBare, senderJid, msg, session, batchSize, card, log, first: true });
    return true;
  }

  async _run({ groupJid, senderBare, senderJid, msg, session, batchSize, card, log, first = false }) {
    if (session.busy) return; // a burst is already going out for this member
    session.busy = true;
    session.touchedAt = Date.now();
    const started = Date.now();
    const credit = this._creditLine();
    const who = `@${senderBare}`;
    try {
      const size = clampBatchSize(batchSize);
      const batch = session.files.slice(session.index, session.index + size);
      if (!batch.length) {
        await this.wa.sendText(groupJid, `${who} No more files left for *${session.subject}*.${credit ? `\n\n${credit}` : ''}`, [senderJid]);
        this._deleteSession(groupJid, senderBare);
        return;
      }

      // 1) every download starts NOW, in parallel — before anything else is sent
      const downloads = this._startDownloads(batch);

      // 2) ONE short message (never edited); the first file follows immediately
      const scope = session.scope || (session.filter ? CATEGORIES.find((c) => c.key === session.filter).label : 'Complete course');
      const groupName = await this._groupName(groupJid);
      this.wa
        .sendText(groupJid, `📚 *${groupName}* · *${session.subject}* · ${scope}\n⚡ Sending ${plural(batch.length, 'file')} to ${who}…`, [senderJid])
        .catch(() => null);

      let delivered = 0;
      for (let i = 0; i < batch.length; i++) {
        const got = await downloads[i];
        if (got) {
          try {
            await this.wa.sendDocument(groupJid, { buffer: got.buffer, fileName: got.fileName, mimetype: mimeFor(got.fileName), quoted: first && i === 0 ? msg : undefined });
            delivered += 1;
          } catch (err) {
            this.logger?.warn({ err: String(err?.message || err), file: got.fileName }, 'course-files: sending a file failed');
          }
        }
        downloads[i] = null; // let the buffer go once it is sent (the cache keeps small ones)
        if (i < batch.length - 1) await sleep(SEND_GAP_MS);
      }

      session.index += batch.length;
      const remaining = session.files.length - session.index;
      const done = [`✅ *${session.subject}* — ${delivered} of ${batch.length} sent to ${who}`];
      if (remaining > 0) {
        const left = new Map();
        for (const f of session.files.slice(session.index)) if (f._course) left.set(f._course, (left.get(f._course) || 0) + 1);
        const detail = left.size > 1 ? ` (${[...left].map(([c, n]) => `${c}: ${n}`).join(', ')})` : '';
        done.push(`📥 ${remaining} more left${detail} — type *more* to get the next ${Math.min(size, remaining)}`);
      }
      if (remaining <= 0) this._deleteSession(groupJid, senderBare);
      if (delivered < batch.length) done.push(`⚠️ ${batch.length - delivered} could not be sent. ${this._supportLine()}`);
      if (credit) done.push(credit);
      await this.wa.sendText(groupJid, done.join('\n'), [senderJid]).catch(() => {});

      log?.({ type: 'course-files-batch', course: session.subject, sender: senderBare, delivered, skipped: batch.length - delivered, ms: Date.now() - started });

    } finally {
      session.busy = false;
    }
  }
}
