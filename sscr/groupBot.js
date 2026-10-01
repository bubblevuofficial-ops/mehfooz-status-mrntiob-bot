/**
 * Group Command Bot — turns incoming WhatsApp group messages into a full
 * moderation/admin command set, driven by `.` commands (e.g. `.menu`,
 * `.antilink on`, `.kick @user`).
 *
 * ── Who can control it (read this first) ───────────────────────────────────
 * This is intentionally NOT admin-controlled. WhatsApp group-admin status is
 * granted by whoever runs the group and can change at any time, so this bot
 * never trusts it for anything more than "should auto-moderation leave this
 * person's messages alone" (see EXEMPT below). Every command that changes a
 * setting or takes an action (kick, promote, mute, antilink on/off, …) is
 * gated to exactly two identities, in EVERY bot mode (public or private):
 *
 *   1. OWNER  — the WhatsApp account this bot is connected to/running as
 *               (this is a self-bot: the number logged into the session).
 *   2. DEV    — one hardcoded developer number (see DEV_NUMBER below).
 *
 * No one else can change a setting or run an action command, no matter what
 * they say, even if they are a WhatsApp group admin, and even if they ask
 * repeatedly. This is enforced in code (_isAuthorized below), not just by
 * convention. The only exception is a short list of read-only info commands
 * (menu/admins/groupinfo/activity/warnings) which ordinary members MAY use
 * when the bot's mode is "public" — see PUBLIC_INFO_COMMANDS. Everything
 * else always requires OWNER or DEV, in both modes.
 *
 * "Auto-moderation" (deleting a link when Antilink is on, etc.) is not a
 * command from anyone — it's the bot enforcing settings OWNER/DEV already
 * turned on, against ordinary members. Current group admins and the
 * owner/dev are exempt from it (see EXEMPT below), the same way in most
 * moderation bots — admins can post normally without tripping the filters
 * they configured for everyone else.
 *
 * ── Known limitations (documented honestly, matches the rest of this repo)──
 * - Mute/Unmute: WhatsApp has no per-member mute. "Mute" here means the bot
 *   auto-deletes that member's future messages in this group until unmuted —
 *   a soft mute, not a protocol-level restriction.
 * - Antibot / Antinsfw: there is no reliable bot-detection or image-content
 *   classification available offline. Antibot only catches participants
 *   whose JID matches known non-human suffixes this fork exposes (rare in
 *   practice). Antinsfw is a wired-up but inert hook — classifyImageNSFW()
 *   always returns false until you plug in a real image-moderation model or
 *   API; see the comment on that function.
 * - Approve (auto-approve join requests) and Anticall (auto-reject calls)
 *   depend on the Baileys fork exposing groupRequestParticipantsList /
 *   sock.rejectCall — this was not verified against a live connection while
 *   building this (no network access in the build environment). Both fail
 *   silently and log at debug level if unsupported, instead of crashing.
 * - Kicking/muting relies on reconstructing a phone-number JID
 *   (`digits@s.whatsapp.net`). Accounts WhatsApp has switched to its @lid
 *   privacy system may not match this and could fail to kick — same
 *   limitation already documented in wa-client.js's checkAdminStatus.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getBranding, renderCredit } from './branding.js';
import { CourseFiles, isReadCommand, STORE_NAME, clampBatchSize, DEFAULT_BATCH_SIZE, MIN_BATCH_SIZE, MAX_BATCH_SIZE } from './courseFiles.js';

// ── Owner / developer access ────────────────────────────────────────────────
// DEV_NUMBER is hardcoded so it always has full control of this bot, in every
// mode, and can't be edited away just by someone tampering with a running
// deployment's .env file. If you ever need to change it, edit
// HARDCODED_DEV_NUMBER below — everything else in this file reads from the
// exported DEV_NUMBER constant.
//
// Assumption made while building this: you gave the number as
// "03204854766" with no country code. That 03xx prefix is Pakistani mobile
// numbering, so it was converted to international format by dropping the
// leading 0 and prefixing +92: 923204854766. If that's wrong, fix the digits
// below (country code + number, digits only, no "+", no spaces, no leading 0).
const HARDCODED_DEV_NUMBER = '923204854766';
// An optional DEV_NUMBER in .env overrides the hardcoded value at runtime if
// you ever want to change it without editing code — but the hardcoded value
// above is always the fallback, so the bot never loses its developer override
// just because an .env file was deleted or edited.
export const DEV_NUMBER = String(process.env.DEV_NUMBER || HARDCODED_DEV_NUMBER).replace(/\D/g, '');

// WhatsApp's newer @lid privacy system can show a group member under an
// opaque pseudonymous ID instead of their real phone number, with NO
// reverse mapping exposed by this fork's groupMetadata() (confirmed from
// your own server log on 2026-09-27: the participant record for the
// developer number's account only carried the @lid form, nothing else to
// resolve DEV_NUMBER against). Pre-seeding the exact @lid captured from
// that log means the developer number is recognized immediately, without
// waiting for the more general fix below.
const HARDCODED_DEV_LIDS = ['274401887043599'];

/**
 * Extra developer/owner identities registered at runtime via `.setdev`
 * (reply to that person's message) — the durable fix for the @lid problem:
 * instead of guessing a phone<->lid mapping that this fork doesn't expose,
 * OWNER captures whatever raw identifier the account actually messages
 * with and the bot remembers it exactly, going forward, no matter which
 * form (phone JID or @lid) it is. Persisted in the same config file as
 * everything else, under state.devIds.
 */

const PREFIX = '.';

// Read-only commands ordinary members may use while the bot is in "public"
// mode. In "private" mode (the default), even these require OWNER/DEV.
const PUBLIC_INFO_COMMANDS = new Set(['menu', 'help', 'ping', 'admins', 'groupinfo', 'ginfo', 'activity', 'warnings']);
// Commands a plain GROUP ADMIN may run (everything else is developer / board-number only).
const ADMIN_ALLOWED_COMMANDS = new Set(['kick', 'lock', 'unlock', 'mute', 'unmute', 'open', 'close', 'groupopen', 'groupclose']);

// Small built-in list for Antibadword. Deliberately short/generic — extend it
// yourself below, or (better) use Antispecificword's per-group custom list
// from the .antispecificword command instead of editing this.
const DEFAULT_BAD_WORDS = ['madarchod', 'behenchod', 'bhosdike', 'chutiya', 'randi', 'fuck', 'bitch', 'asshole'];

const LINK_RE = /(https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(com|net|org|io|me|xyz|info|co|in|pk|link|club|shop|live|tv|gg|app)\b/i;
const CHANNEL_RE = /whatsapp\.com\/channel\/|chat\.whatsapp\.com\/[a-z0-9]{20,}/i;

const DEFAULT_BADWORD_MESSAGE = '⚠️ {user}, please keep the language respectful in *{group}*.\nBarah-e-meharbani ba-akhlaq zaban istemal karein.\n\n_Powered by Saif Chishti_';

const DEFAULT_GROUP_SETTINGS = () => ({
  antilink: false,
  antisticker: false,
  antispam: { enabled: false, limit: 3, windowSec: 15 }, // N identical messages in a row within windowSec
  antibadword: false,
  antispecificword: { enabled: false, words: [] },
  autophoto: false,
  autovideo: false,
  antimention: { enabled: false, limit: 5 },
  antiflood: { enabled: false, limit: 8, windowSec: 10 }, // N messages of any kind within windowSec
  antibot: false,
  antiforward: false,
  antimedia: false,
  antinsfw: false,
  welcome: { enabled: false, message: 'Welcome {user} to {group}! 🎉' },
  goodbye: { enabled: false, message: '{user} has left {group}. Goodbye! 👋' },
  approve: false,
  autokick: { enabled: false, bannedNumbers: [] },
  antidelete: false,
  antivoice: false,
  antichannel: false,
  warnLimit: 3,
  mutedMembers: [], // bare phone numbers, soft-muted in this group
  // Course files (see src/courseFiles.js) — per group, only active after `.fileon` in that group.
  fileAccess: { enabled: false, batchSize: DEFAULT_BATCH_SIZE },
  // Delivery card (`.filecard on|off`, `.filecardlink on|off`): after files are sent, post the group DP + a thank-you that
  // mentions the member, names the group and (optionally) includes the invite link. Separate switch, per group.
  fileCard: { enabled: false, showLink: false },
  // Custom bad-word list + reply, per group (`.addbadword`, `.delbadword`, `.badwordmsg`, or the dashboard).
  badword: { enabled: false, words: [], message: DEFAULT_BADWORD_MESSAGE },
  // What Antilink / Antibadword / bad-word filter do to a violating message (dashboard: Moderation section).
  modActions: { delete: true, warn: true, kick: true },
});

const DEFAULT_STATE = () => ({
  mode: 'private', // 'public' | 'private' — see PUBLIC_INFO_COMMANDS. OWNER/DEV are never affected by this.
  anticall: { enabled: false }, // global — calls aren't scoped to a group
  devIds: [], // extra developer/owner identities registered via `.setdev` — see notes above HARDCODED_DEV_LIDS
  groups: {},
});

function loadJson(filePath, makeDefault) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      const fresh = makeDefault();
      fs.writeFileSync(filePath, JSON.stringify(fresh, null, 2), 'utf8');
      return fresh;
    }
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return makeDefault();
    return JSON.parse(raw);
  } catch {
    return makeDefault();
  }
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/** Bare digits from a jid ("923001234567@s.whatsapp.net" -> "923001234567"). */
function bareNumber(jid) {
  if (!jid) return null;
  return String(jid).split('@')[0].split(':')[0];
}

function getContextInfo(msg) {
  const m = msg.message || {};
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.stickerMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    m.audioMessage?.contextInfo ||
    null
  );
}

/** Id of a tapped button/list row (quick-reply, legacy buttons, template, list) or ''. */
function extractButtonId(msg) {
  const m = msg.message || {};
  const native = m.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (native) {
    try { return String(JSON.parse(native).id || ''); } catch { /* fall through */ }
  }
  return String(m.buttonsResponseMessage?.selectedButtonId || m.templateButtonReplyMessage?.selectedId || m.listResponseMessage?.singleSelectReply?.selectedRowId || '');
}

function extractText(msg) {
  const m = msg.message || {};
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  );
}

function getMessageKind(msg) {
  const m = msg.message || {};
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.stickerMessage) return 'sticker';
  if (m.audioMessage) return m.audioMessage.ptt ? 'ptt' : 'audio';
  if (m.documentMessage) return 'document';
  if (m.protocolMessage) return 'protocol';
  if (m.conversation || m.extendedTextMessage) return 'text';
  return 'other';
}

function isForwarded(msg) {
  const ctx = getContextInfo(msg);
  return !!(ctx?.isForwarded || (ctx?.forwardingScore || 0) > 0);
}

function resolveTargetJid(msg, argText) {
  const ctx = getContextInfo(msg);
  if (ctx?.mentionedJid?.[0]) return ctx.mentionedJid[0];
  if (ctx?.participant) return ctx.participant;
  const digits = String(argText || '').replace(/[^0-9]/g, '');
  if (digits.length >= 8) return `${digits}@s.whatsapp.net`;
  return null;
}

function containsBadWord(text, words) {
  if (!text || !words?.length) return false;
  const lower = text.toLowerCase();
  return words.some((w) => w && lower.includes(String(w).toLowerCase()));
}

/** Whole-word (unicode-aware) match, so "ass" doesn't fire on "class". Phrases are matched as-is. */
function containsWholeWord(text, words) {
  if (!text || !words?.length) return false;
  const lower = text.toLowerCase();
  return words.some((w) => {
    const word = String(w || '').trim().toLowerCase();
    if (!word) return false;
    const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^\\p{L}\\p{N}])' + esc + '($|[^\\p{L}\\p{N}])', 'u').test(lower);
  });
}

function renderTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`));
}

/**
 * Stub extension point for Antinsfw. There is no offline/local NSFW image
 * classifier bundled here, and this project has no external ML API wired up.
 * This always returns false (never blocks anything) until you replace the
 * body with a real call to an image-moderation model or API of your choice
 * (pass it `imageBuffer`, return true if it should be treated as NSFW).
 * Leaving Antinsfw "on" right now enables the hook but changes no behavior.
 */
async function classifyImageNSFW(_imageBuffer) {
  return false;
}

export class GroupBot {
  /**
   * @param {import('./wa-client.js').WhatsAppClient} wa
   * @param {object} opts
   * @param {string} opts.configPath
   * @param {string} opts.warningsPath
   * @param {import('./history.js').HistoryStore} opts.activityLog
   * @param {import('pino').Logger} opts.logger
   */
  constructor(wa, { configPath, warningsPath, activityLog, logger, antiStatus }) {
    this.wa = wa;
    this.antiStatus = antiStatus || null; // optional: enables `.purgestatus` (manual status removal)
    this.configPath = configPath;
    this.dataDir = path.dirname(configPath);
    this.courseFiles = new CourseFiles(wa, { logger, credit: () => renderCredit('{poweredBy}', this.dataDir) }); // GITHUB_TOKEN (optional) is read from the environment
    this._badwordCooldown = new Map(); // "group|number" -> last reply timestamp
    this.warningsPath = warningsPath;
    this.activityLog = activityLog;
    this.logger = logger;

    this._floodTracker = new Map(); // "group|number" -> number[] timestamps
    this._spamTracker = new Map(); // "group|number" -> { lastText, streak }
    this._deletedCache = new Map(); // "group|id" -> { senderJid, text, kind, at }
    this._warnedOnceUnsupported = new Set(); // dedupe debug logs for unsupported features
    this._startedAt = Date.now();

    this._onMessages = this._onMessages.bind(this);
    this._onParticipantsUpdate = this._onParticipantsUpdate.bind(this);
    this._onCalls = this._onCalls.bind(this);
  }

  start() {
    this.wa.on('messages', this._onMessages);
    this.wa.on('group-participants-update', this._onParticipantsUpdate);
    this.wa.on('call', this._onCalls);
    // Polls for pending join requests every 20s in groups with Approve on.
    // Polling (not an event) because join-request events are not reliably
    // exposed across forks — see class-level doc comment.
    this._approveTimer = setInterval(() => this._pollApprovals().catch(() => {}), 20_000);
  }

  stop() {
    this.wa.off('messages', this._onMessages);
    this.wa.off('group-participants-update', this._onParticipantsUpdate);
    this.wa.off('call', this._onCalls);
    clearInterval(this._approveTimer);
  }

  // ── state I/O ──────────────────────────────────────────────────────────
  _loadState() {
    return loadJson(this.configPath, DEFAULT_STATE);
  }
  _saveState(state) {
    saveJson(this.configPath, state);
  }
  _getGroupSettings(state, jid) {
    if (!state.groups[jid]) state.groups[jid] = DEFAULT_GROUP_SETTINGS();
    // Groups saved before newer features existed: fill in the missing keys (existing values are never touched).
    const defaults = DEFAULT_GROUP_SETTINGS();
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in state.groups[jid])) state.groups[jid][k] = v;
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const [k2, v2] of Object.entries(v)) if (!(k2 in state.groups[jid][k])) state.groups[jid][k][k2] = v2;
      }
    }
    return state.groups[jid];
  }
  _loadWarnings() {
    return loadJson(this.warningsPath, () => ({}));
  }
  _saveWarnings(w) {
    saveJson(this.warningsPath, w);
  }

  _log(groupJid, entry) {
    try {
      this.activityLog.add({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'group-bot',
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        total: 1,
        success: entry.ok !== false ? 1 : 0,
        failed: entry.ok === false ? 1 : 0,
        unavailable: 0,
        cancelled: false,
        items: [{ groupJid, ...entry }],
      });
    } catch (err) {
      this.logger?.error({ err }, 'group-bot: failed to write activity log');
    }
  }

  /** Is this bare number / raw jid one of: DEV_NUMBER, a pre-seeded @lid, or a `.setdev`-registered id? */
  _isDevId(senderBareNum, senderJid, state) {
    if (senderBareNum && senderBareNum === DEV_NUMBER) return true;
    if (senderBareNum && HARDCODED_DEV_LIDS.includes(senderBareNum)) return true;
    const registered = state?.devIds || [];
    if (registered.some((id) => id === senderJid || bareNumber(id) === senderBareNum)) return true;
    return false;
  }

  /**
   * Authorization is checked FOUR ways, any one of which is enough:
   *   1. `fromMe` — WhatsApp's own flag for "this session sent it". Checked
   *      first and sufficient alone, so the owner's own commands never
   *      depend on number-matching at all.
   *   2. _isDevId() — bare-digits match against DEV_NUMBER, a pre-seeded
   *      @lid, or a `.setdev`-registered id (see notes above the state
   *      default and HARDCODED_DEV_LIDS).
   *   3. wa.isSelfIdentifier(jid) — matches phone-JID vs. @lid forms for
   *      the OWNER's own identity.
   *   4. Resolve every identifier WhatsApp's group participant list has on
   *      record for this sender (via wa.getParticipantIdentifiers) and
   *      run _isDevId against each of them too — covers a fork that DOES
   *      expose a phone<->lid pairing on the participant record even when
   *      the message itself arrived under the other form.
   * Every denial is logged (server logs + .activity) with the raw
   * identifiers involved, specifically so a real developer-number mismatch
   * can be diagnosed from the logs instead of guessed at.
   */
  async _isAuthorized({ fromMe, senderJid, senderBareNum, groupJid, state }) {
    if (fromMe) return true;
    if (this._isDevId(senderBareNum, senderJid, state)) return true;
    if (this.wa.isSelfIdentifier(senderJid)) return true;
    if (groupJid) {
      try {
        const ids = await this._resolveParticipantIdentifiers(groupJid, senderJid);
        if (ids.some((id) => this._isDevId(bareNumber(id), id, state))) return true;
      } catch {
        /* fall through to unauthorized */
      }
    }
    return false;
  }

  /** getParticipantIdentifiers() result, cached briefly per (group, sender) — group membership/identifiers don't change every second, and this runs on every command from an unrecognized number. */
  async _resolveParticipantIdentifiers(groupJid, senderJid) {
    const key = `${groupJid}|${senderJid}`;
    const cached = this._idCache?.get(key);
    if (cached && Date.now() - cached.at < 30_000) return cached.ids;
    const ids = await this.wa.getParticipantIdentifiers(groupJid, senderJid);
    if (!this._idCache) this._idCache = new Map();
    this._idCache.set(key, { ids, at: Date.now() });
    return ids;
  }

  async _safeSendText(jid, text, mentions = []) {
    try {
      await this.wa.sendText(jid, text, mentions);
    } catch (err) {
      this.logger?.error({ err, jid }, 'group-bot: sendText failed');
    }
  }

  async _groupName(jid) {
    try {
      const meta = await this.wa.getGroupMetadata(jid);
      return meta.subject || jid;
    } catch {
      return jid;
    }
  }

  // ── warnings (shared by manual .warn and every auto-moderation trigger) ──
  _warnKey(groupJid, bareNum) {
    return `${groupJid}|${bareNum}`;
  }

  /** @returns {{count:number, limit:number}} */
  _addWarning(groupJid, bareNum, limit) {
    const w = this._loadWarnings();
    const key = this._warnKey(groupJid, bareNum);
    w[key] = (w[key] || 0) + 1;
    this._saveWarnings(w);
    return { count: w[key], limit };
  }

  _resetWarning(groupJid, bareNum) {
    const w = this._loadWarnings();
    delete w[this._warnKey(groupJid, bareNum)];
    this._saveWarnings(w);
  }

  _getWarningCount(groupJid, bareNum) {
    const w = this._loadWarnings();
    return w[this._warnKey(groupJid, bareNum)] || 0;
  }

  // ── message pipeline ──────────────────────────────────────────────────
  async _onMessages(messages) {
    for (const msg of messages) {
      try {
        await this._handleMessage(msg);
      } catch (err) {
        this.logger?.error({ err }, 'group-bot: message handling failed');
      }
    }
  }

  async _handleMessage(msg) {
    if (!msg?.message || !msg?.key?.remoteJid) return;
    const groupJid = msg.key.remoteJid;
    const isGroup = groupJid.endsWith('@g.us');

    // Duplicate guard: the same WhatsApp message id is only ever processed once (reconnect/history replays,
    // two listeners firing, etc. used to make the bot answer the same request twice).
    if (msg.key.id) {
      if (!this._seenIds) this._seenIds = new Set();
      const sid = `${groupJid}|${msg.key.id}`;
      if (this._seenIds.has(sid)) return;
      this._seenIds.add(sid);
      if (this._seenIds.size > 3000) this._seenIds.delete(this._seenIds.values().next().value);
    }

    // Antidelete: a delete shows up as a NEW message whose content is a
    // protocolMessage of type REVOKE, referencing the original message's key.
    const proto = msg.message.protocolMessage;
    if (proto?.type === 'REVOKE' || proto?.type === 0) {
      if (isGroup) await this._handleRevoke(groupJid, proto);
      return;
    }

    const selfBareNum = bareNumber(this.wa.getSelfJid());
    const senderJid = msg.key.fromMe ? this.wa.getSelfJid() : msg.key.participant || msg.key.remoteJid;
    const senderBareNum = bareNumber(senderJid);
    let text = extractText(msg).trim();

    // A tapped course-files button behaves exactly like the member typing that request themselves.
    let viaButton = false;
    if (isGroup && !msg.key.fromMe) {
      const btnText = CourseFiles.buttonToText(extractButtonId(msg));
      if (btnText) {
        text = btnText;
        viaButton = true;
        const menuId = msg.message?.interactiveResponseMessage?.contextInfo?.stanzaId
          || msg.message?.buttonsResponseMessage?.contextInfo?.stanzaId
          || msg.message?.templateButtonReplyMessage?.contextInfo?.stanzaId
          || msg.message?.listResponseMessage?.contextInfo?.stanzaId;
        this.courseFiles.vanishMenu(groupJid, menuId).catch(() => {}); // not awaited: files start at the same moment
      }
    }

    // Cache every group message briefly, for Antidelete to reconstruct from.
    if (isGroup && !msg.key.fromMe) {
      this._cacheForAntidelete(groupJid, msg.key.id, {
        senderJid,
        text: text || `[${getMessageKind(msg)}]`,
        at: Date.now(),
      });
    }

    // Owner/dev course-file admin: .stats / .files / .folders / .mids … and .upload (+ the files sent while an upload is open).
    // Cheap pre-check first, so the (slower) authorization lookup only runs when it can matter.
    if ((text && CourseFiles.isAdminText(text)) || (getMessageKind(msg) === 'document' && this.courseFiles.hasOpenUpload(groupJid, senderBareNum))) {
      const st = this._loadState();
      const isAdmin = await this._isAuthorized({ fromMe: !!msg.key.fromMe, senderJid, senderBareNum, groupJid: isGroup ? groupJid : null, state: st });
      if (isAdmin) {
        const done = await this.courseFiles
          .handleAdmin({ groupJid, senderBare: senderBareNum, senderJid, text, msg, isAdmin })
          .catch((err) => { this.logger?.error({ err }, 'group-bot: course files admin failed'); return false; });
        if (done) return;
      }
    }

    // Course files — picture reader: reply to a picture with `.read` (or caption a picture with it) and the bot
    // scans it for subject codes, then sends the files batch by batch (`more` for the next batch).
    if (isGroup && !msg.key.fromMe && text && isReadCommand(text)) {
      const groupSettings = this._getGroupSettings(this._loadState(), groupJid);
      const fileSettings = groupSettings.fileAccess;
      if (fileSettings?.enabled) {
        const consumed = await this.courseFiles
          .handleRead({ groupJid, senderBare: senderBareNum, senderJid, msg, batchSize: fileSettings.batchSize, card: groupSettings.fileCard, log: (e) => this._log(groupJid, e) })
          .catch((err) => { this.logger?.error({ err }, 'group-bot: course files .read failed'); return false; });
        if (consumed) return;
      }
    }

    // Course files: any member may type a course code (with or without ".") in a group where `.fileon` was
    // used — independent of public/private mode. Checked before command routing so ".cs101" / ".more" work
    // for everyone, but only a real folder / the sender's own open menu is ever consumed.
    if (isGroup && text && (viaButton || getMessageKind(msg) === 'text')) {
      const groupSettings = this._getGroupSettings(this._loadState(), groupJid);
      const fileSettings = groupSettings.fileAccess;
      if (fileSettings?.enabled) {
        const consumed = await this.courseFiles
          .handle({ groupJid, senderBare: senderBareNum, senderJid, text, msg, batchSize: fileSettings.batchSize, card: groupSettings.fileCard, log: (e) => this._log(groupJid, e) })
          .catch((err) => { this.logger?.error({ err }, 'group-bot: course files handler failed'); return false; });
        if (consumed) return;
      }
    }

    if (text.startsWith(PREFIX)) {
      await this._handleCommand({ msg, groupJid, isGroup, senderJid, senderBareNum, selfBareNum, fromMe: !!msg.key.fromMe, text });
      return;
    }

    if (!isGroup) return; // auto-moderation only applies inside groups
    await this._autoModerate({ msg, groupJid, senderJid, senderBareNum, selfBareNum });
  }

  _cacheForAntidelete(groupJid, id, data) {
    const key = `${groupJid}|${id}`;
    this._deletedCache.set(key, data);
    if (this._deletedCache.size > 1000) {
      const oldest = this._deletedCache.keys().next().value;
      this._deletedCache.delete(oldest);
    }
  }

  async _handleRevoke(groupJid, proto) {
    const state = this._loadState();
    const settings = this._getGroupSettings(state, groupJid);
    if (!settings.antidelete) return;
    const originalId = proto.key?.id;
    if (!originalId) return;
    const cached = this._deletedCache.get(`${groupJid}|${originalId}`);
    if (!cached) return; // never seen it, or it was our own outgoing message
    const senderNum = bareNumber(cached.senderJid);
    await this._safeSendText(
      groupJid,
      `🗑️ *Antidelete*: @${senderNum} deleted a message:\n\n${cached.text}`,
      [cached.senderJid]
    );
    this._log(groupJid, { type: 'antidelete', sender: senderNum });
  }

  // ── auto-moderation (runs on ordinary messages, never on commands) ──────
  async _autoModerate({ msg, groupJid, senderJid, senderBareNum, selfBareNum }) {
    const state = this._loadState();
    const settings = this._getGroupSettings(state, groupJid);

    // Soft-muted members: delete everything from them, no other checks needed.
    if (settings.mutedMembers.includes(senderBareNum)) {
      await this.wa.deleteMessageForEveryone(groupJid, msg.key).catch(() => {});
      return;
    }

    // OWNER/DEV and current group admins are exempt from every auto-filter
    // below — they configured these filters for everyone else, not themselves.
    if (this._isDevId(senderBareNum, senderJid, state) || senderBareNum === selfBareNum || this.wa.isSelfIdentifier(senderJid)) return;
    let isAdmin = false;
    try {
      const status = await this.wa.checkAdminStatus(groupJid, senderJid);
      isAdmin = status.targetIsAdmin;
    } catch {
      /* if we can't verify, fall through and still apply filters */
    }
    if (isAdmin) return;

    const kind = getMessageKind(msg);
    const text = extractText(msg);
    const ctx = getContextInfo(msg);

    const violate = (reason) => this._violate({ msg, groupJid, senderJid, senderBareNum, settings, reason });

    if (settings.badword?.enabled && containsWholeWord(text, settings.badword.words)) {
      const act = { delete: true, warn: true, kick: true, ...(settings.modActions || {}) };
      if (act.delete) await this.wa.deleteMessageForEveryone(groupJid, msg.key).catch(() => {});
      const cdKey = `${groupJid}|${senderBareNum}`;
      if (Date.now() - (this._badwordCooldown.get(cdKey) || 0) > 10_000) {
        this._badwordCooldown.set(cdKey, Date.now());
        let count = 0;
        let limit = settings.warnLimit || 3;
        let kicked = false;
        if (act.warn) {
          ({ count, limit } = this._addWarning(groupJid, senderBareNum, limit));
          if (act.kick && count >= limit) {
            kicked = await this.wa.removeParticipant(groupJid, senderJid).then(() => true).catch(() => false);
            if (kicked) this._resetWarning(groupJid, senderBareNum);
          }
        }
        const groupName = await this._groupName(groupJid);
        const out = renderTemplate(settings.badword.message || DEFAULT_BADWORD_MESSAGE, { user: `@${senderBareNum}`, group: groupName, count: String(count), limit: String(limit) });
        await this._safeSendText(groupJid, out, [senderJid]);
        if (kicked) await this._safeSendText(groupJid, `🚫 @${senderBareNum} removed — reached ${limit} warnings.`, [senderJid]);
        this._log(groupJid, { type: 'badword', sender: senderBareNum, warnCount: count, kicked, deleted: !!act.delete });
      }
      return;
    }
    if (settings.antichannel && CHANNEL_RE.test(text)) return void (await violate('Antichannel: channel link is not allowed here'));
    if (settings.antilink && LINK_RE.test(text)) return void (await violate('Antilink: links are not allowed here'));
    if (settings.antisticker && kind === 'sticker') return void (await violate('Antisticker: stickers are not allowed here'));
    if (settings.antimedia && ['image', 'video', 'sticker', 'audio', 'ptt', 'document'].includes(kind))
      return void (await violate('Antimedia: media is not allowed here'));
    if (settings.autophoto && kind === 'image') return void (await violate('Autophoto: photos are not allowed here'));
    if (settings.autovideo && kind === 'video') return void (await violate('Autovideo: videos are not allowed here'));
    if (settings.antivoice && kind === 'ptt') return void (await violate('Antivoice: voice notes are not allowed here'));
    if (settings.antiforward && isForwarded(msg)) return void (await violate('Antiforward: forwarded messages are not allowed here'));
    if (settings.antibadword && containsBadWord(text, DEFAULT_BAD_WORDS)) return void (await violate('Antibadword: watch your language'));
    if (settings.antispecificword?.enabled && containsBadWord(text, settings.antispecificword.words))
      return void (await violate('Antispecificword: that word is not allowed here'));
    if (settings.antimention?.enabled) {
      const n = ctx?.mentionedJid?.length || 0;
      if (n > settings.antimention.limit) return void (await violate(`Antimention: tagged too many members at once (${n})`));
    }
    if (kind === 'image' && settings.antinsfw) {
      // Hook only — see classifyImageNSFW() doc comment above. Buffer is not
      // downloaded here (no media-download pipeline wired to this handler);
      // this is left as a clearly-marked stub, not a working filter.
      const flagged = await classifyImageNSFW(null);
      if (flagged) return void (await violate('Antinsfw: image flagged as inappropriate'));
    }

    // Antispam: same text repeated back-to-back by the same sender.
    if (settings.antispam?.enabled && text) {
      const key = `${groupJid}|${senderBareNum}`;
      const prev = this._spamTracker.get(key);
      const now = Date.now();
      if (prev && prev.lastText === text && now - prev.at <= settings.antispam.windowSec * 1000) {
        prev.streak += 1;
        prev.at = now;
        if (prev.streak >= settings.antispam.limit) {
          prev.streak = 0;
          return void (await violate('Antispam: repeated message spam'));
        }
      } else {
        this._spamTracker.set(key, { lastText: text, streak: 1, at: now });
      }
    }

    // Antiflood: too many messages (any content) in a short window.
    if (settings.antiflood?.enabled) {
      const key = `${groupJid}|${senderBareNum}`;
      const now = Date.now();
      const windowMs = settings.antiflood.windowSec * 1000;
      const arr = (this._floodTracker.get(key) || []).filter((t) => now - t <= windowMs);
      arr.push(now);
      this._floodTracker.set(key, arr);
      if (arr.length > settings.antiflood.limit) {
        this._floodTracker.set(key, []);
        return void (await violate('Antiflood: sending messages too fast'));
      }
    }
  }

  async _violate({ msg, groupJid, senderJid, senderBareNum, settings, reason }) {
    const act = { delete: true, warn: true, kick: true, ...(settings.modActions || {}) };
    if (act.delete) await this.wa.deleteMessageForEveryone(groupJid, msg.key).catch(() => {});
    let count = 0;
    let limit = settings.warnLimit || 3;
    let kicked = false;
    if (act.warn) {
      ({ count, limit } = this._addWarning(groupJid, senderBareNum, limit));
      if (act.kick && count >= limit) {
        kicked = await this.wa.removeParticipant(groupJid, senderJid).then(() => true).catch(() => false);
        if (kicked) this._resetWarning(groupJid, senderBareNum);
      }
    }
    this._log(groupJid, { type: 'auto-moderation', reason, sender: senderBareNum, warnCount: count, kicked, deleted: !!act.delete });
    if (kicked) {
      await this._safeSendText(groupJid, `🚫 @${senderBareNum} removed — reached ${limit} warnings.\nLast reason: ${reason}`, [senderJid]);
    } else if (act.warn) {
      await this._safeSendText(groupJid, `⚠️ @${senderBareNum} — ${reason}\nWarning ${count}/${limit}.`, [senderJid]);
    }
  }

  // ── group-membership events (Welcome/Goodbye/Autokick) ──────────────────
  /** Newer Baileys versions send participants as objects ({id, phoneNumber, lid, admin}) instead of plain JID strings. */
  _normParticipant(p) {
    if (!p) return null;
    if (typeof p === 'string') return { jid: p, bare: bareNumber(p) };
    const jid = p.id || p.jid || p.lid || p.phoneNumber;
    const phone = p.phoneNumber || (String(p.id || '').endsWith('@s.whatsapp.net') ? p.id : null) || (String(p.jid || '').endsWith('@s.whatsapp.net') ? p.jid : null);
    if (!jid) return null;
    return { jid, bare: bareNumber(phone || jid) };
  }

  async _onParticipantsUpdate({ id: groupJid, participants, action }) {
    if (!groupJid?.endsWith('@g.us') || !participants?.length) return;
    const state = this._loadState();
    const settings = this._getGroupSettings(state, groupJid);

    if (action === 'add') {
      for (const raw of participants) {
        const np = this._normParticipant(raw);
        if (!np) continue;
        const { jid: p, bare } = np;
        if (settings.autokick?.enabled && settings.autokick.bannedNumbers.includes(bare)) {
          const ok = await this.wa.removeParticipant(groupJid, p).then(() => true).catch(() => false);
          this._log(groupJid, { type: 'autokick', target: bare, ok });
          continue; // don't also welcome someone we just kicked
        }
        if (settings.welcome?.enabled) {
          // Send IMMEDIATELY, mentioning the new member — never let a slow group-name lookup delay or block it.
          const groupName = await Promise.race([this._groupName(groupJid), new Promise((r) => setTimeout(() => r('the group'), 2500))]).catch(() => 'the group');
          const text = renderTemplate(settings.welcome.message, { user: `@${bare}`, group: groupName });
          await this._safeSendText(groupJid, text, [p]);
          this._log(groupJid, { type: 'welcome', target: bare, ok: true });
        }
      }
    } else if (action === 'remove' && settings.goodbye?.enabled) {
      const groupName = await this._groupName(groupJid);
      for (const raw of participants) {
        const np = this._normParticipant(raw);
        if (!np) continue;
        const text = renderTemplate(settings.goodbye.message, { user: `@${np.bare}`, group: groupName });
        await this._safeSendText(groupJid, text, [np.jid]);
      }
    }
  }

  async _pollApprovals() {
    const state = this._loadState();
    for (const [groupJid, settings] of Object.entries(state.groups)) {
      if (!settings.approve) continue;
      try {
        const reqs = await this.wa.getJoinRequests(groupJid);
        for (const r of reqs) {
          const jid = r.jid || r.id;
          if (!jid) continue;
          await this.wa.approveJoinRequest(groupJid, jid).catch(() => {});
        }
      } catch (err) {
        if (!this._warnedOnceUnsupported.has('approve')) {
          this._warnedOnceUnsupported.add('approve');
          this.logger?.debug({ err }, 'group-bot: Approve is on but join-request polling is unsupported here');
        }
      }
    }
  }

  async _onCalls(calls) {
    const state = this._loadState();
    if (!state.anticall?.enabled) return;
    for (const call of calls || []) {
      if (call.status && call.status !== 'offer') continue;
      const ok = await this.wa.rejectCall(call.id, call.from).catch(() => false);
      if (!ok && !this._warnedOnceUnsupported.has('anticall')) {
        this._warnedOnceUnsupported.add('anticall');
        this.logger?.debug('group-bot: Anticall is on but this session/fork cannot programmatically reject calls');
      }
    }
  }

  // ── commands ──────────────────────────────────────────────────────────
  async _handleCommand({ msg, groupJid, isGroup, senderJid, senderBareNum, selfBareNum, fromMe, text }) {
    const [cmdRaw, ...rest] = text.slice(PREFIX.length).trim().split(/\s+/);
    const cmd = (cmdRaw || '').toLowerCase();
    const argText = rest.join(' ').trim();
    if (!cmd) return;

    const state = this._loadState();
    const isAuth = await this._isAuthorized({ fromMe, senderJid, senderBareNum, groupJid: isGroup ? groupJid : null, state });
    // STRICT permission model:
    //  - DEVELOPER number + the number this board is linked to (fromMe) → every command, always.
    //  - GROUP ADMINS → ONLY the moderation commands in ADMIN_ALLOWED_COMMANDS (kick/lock/unlock/mute/unmute/open/close).
    //  - everyone else → ignored completely (course-file `.read` / codes are handled earlier, before this point).
    let isAdminOnlyCmd = false;
    if (!isAuth && isGroup && ADMIN_ALLOWED_COMMANDS.has(cmd)) {
      const st = await this.wa.checkAdminStatus(groupJid, senderJid).catch(() => null);
      if (st?.targetIsAdmin) {
        isAdminOnlyCmd = true;
        // A plain admin must never be able to kick the developer, the bot's own number or another admin.
        if (cmd === 'kick') {
          const t = resolveTargetJid(msg, argText);
          const tBare = bareNumber(t);
          const tSt = t ? await this.wa.checkAdminStatus(groupJid, t).catch(() => null) : null;
          if (!t || this._isDevId(tBare, t, state) || this.wa.isSelfIdentifier(t) || tSt?.targetIsAdmin) {
            return this._safeSendText(groupJid, '⛔ You can only remove normal members.');
          }
        }
      }
    }

    if (!isAuth && !isAdminOnlyCmd) {
      this.logger?.info({ cmd, senderJid, senderBareNum, devNumber: DEV_NUMBER }, 'group-bot: command ignored — sender is not developer / board number / (admin for allowed commands)');
      this._log(groupJid, { type: 'denied-command', cmd, sender: senderBareNum, ok: false });
      return;
    }

    const reply = (t, mentions) => this._safeSendText(groupJid, t, mentions);
    const groupOnly = () => reply('This command only works inside a group.');

    try {
      switch (cmd) {
        case 'menu':
        case 'help':
          return await reply(this._menuText(state));

        case 'ping': {
          const uptime = this._formatDuration(Date.now() - this._startedAt);
          return reply(`🏓 *Pong!* Bot is online.\nUptime: ${uptime}`);
        }

        case 'mode': {
          const v = argText.toLowerCase();
          if (!['public', 'private'].includes(v)) return reply(`Usage: ${PREFIX}mode public|private\nCurrent: ${state.mode}`);
          state.mode = v;
          this._saveState(state);
          return reply(`✅ Bot mode set to *${v}*. (OWNER/DEV can always command the bot in either mode.)`);
        }

        case 'setdev': {
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: reply to that person's message with ${PREFIX}setdev (or mention them: ${PREFIX}setdev @user)`);
          if (!state.devIds.includes(target)) state.devIds.push(target);
          this._saveState(state);
          return reply(`✅ Registered ${bareNumber(target)} as a developer/owner identity — their commands will always be obeyed from now on, in any mode, no matter which JID form WhatsApp shows them under.`);
        }

        case 'removedev': {
          const v = argText.trim().toLowerCase();
          if (v === 'all') {
            state.devIds = [];
            this._saveState(state);
            return reply('✅ Cleared every `.setdev`-registered identity. (DEV_NUMBER itself is unaffected — edit HARDCODED_DEV_NUMBER in src/groupBot.js for that.)');
          }
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: reply to that person's message with ${PREFIX}removedev, or ${PREFIX}removedev all`);
          state.devIds = state.devIds.filter((id) => id !== target);
          this._saveState(state);
          return reply(`✅ Removed ${bareNumber(target)} from the registered developer/owner list.`);
        }

        case 'devlist': {
          return reply(
            `👑 *Developer/owner identities*\nHardcoded number: +${DEV_NUMBER}\nPre-seeded @lid: ${HARDCODED_DEV_LIDS.join(', ') || '(none)'}\n${PREFIX}setdev-registered: ${state.devIds.map(bareNumber).join(', ') || '(none)'}`
          );
        }

        // ── group info / read-only ──────────────────────────────────────
        case 'admins': {
          if (!isGroup) return groupOnly();
          const meta = await this.wa.getGroupMetadata(groupJid);
          const admins = (meta.participants || []).filter((p) => p.admin === 'admin' || p.admin === 'superadmin');
          const lines = admins.map((a) => `• @${bareNumber(a.id)}${a.admin === 'superadmin' ? ' (owner)' : ''}`);
          return reply(`👮 *Group Admins* (${admins.length})\n${lines.join('\n') || 'none found'}`, admins.map((a) => a.id));
        }

        case 'groupinfo':
        case 'ginfo': {
          if (!isGroup) return groupOnly();
          const meta = await this.wa.getGroupMetadata(groupJid);
          const adminCount = (meta.participants || []).filter((p) => p.admin).length;
          return reply(
            `📋 *Group Info*\n` +
              `Name: ${meta.subject || '(unnamed)'}\n` +
              `Members: ${meta.participants?.length ?? 0}\n` +
              `Admins: ${adminCount}\n` +
              `Announce-only: ${meta.announce ? 'yes' : 'no'}\n` +
              `Locked info: ${meta.restrict ? 'yes' : 'no'}\n` +
              `Description: ${meta.desc || '(none)'}`
          );
        }

        case 'activity': {
          if (!isGroup) return groupOnly();
          const entries = (this.activityLog.list(50) || []).filter((e) => e.items?.[0]?.groupJid === groupJid).slice(0, 10);
          if (!entries.length) return reply('📭 No recent activity logged for this group yet.');
          const lines = entries.map((e) => {
            const it = e.items[0];
            return `• [${new Date(e.startedAt).toLocaleString()}] ${it.type}${it.reason ? ' — ' + it.reason : ''}${it.sender ? ' (@' + it.sender + ')' : ''}`;
          });
          return reply(`🕘 *Recent Activity*\n${lines.join('\n')}`);
        }

        case 'warnings': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}warnings @user`);
          const count = this._getWarningCount(groupJid, bareNumber(target));
          return reply(`⚠️ @${bareNumber(target)} has ${count} warning(s) in this group.`, [target]);
        }

        // ── moderation actions ───────────────────────────────────────────
        case 'warn': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}warn @user [reason]`);
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const { count, limit } = this._addWarning(groupJid, bareNumber(target), settingsForGroup.warnLimit || 3);
          this._log(groupJid, { type: 'manual-warn', target: bareNumber(target), reason: argText || null });
          if (count >= limit) {
            const ok = await this.wa.removeParticipant(groupJid, target).then(() => true).catch(() => false);
            if (ok) this._resetWarning(groupJid, bareNumber(target));
            return reply(`🚫 @${bareNumber(target)} reached ${limit} warnings and was removed.`, [target]);
          }
          return reply(`⚠️ @${bareNumber(target)} warned (${count}/${limit}).${argText ? '\nReason: ' + argText : ''}`, [target]);
        }

        case 'resetwarn': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}resetwarn @user`);
          this._resetWarning(groupJid, bareNumber(target));
          return reply(`✅ Warnings cleared for @${bareNumber(target)}.`, [target]);
        }

        case 'kick': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}kick @user`);
          const ok = await this.wa.removeParticipant(groupJid, target).then(() => true).catch((e) => { this.logger?.error({ e }, 'kick failed'); return false; });
          this._log(groupJid, { type: 'kick', target: bareNumber(target), ok });
          return reply(ok ? `👢 Removed @${bareNumber(target)}.` : `❌ Could not remove @${bareNumber(target)} (need admin rights here).`, [target]);
        }

        case 'add': {
          if (!isGroup) return groupOnly();
          const digits = argText.replace(/[^0-9]/g, '');
          if (digits.length < 8) return reply(`Usage: ${PREFIX}add <full phone number with country code>`);
          const target = `${digits}@s.whatsapp.net`;
          const ok = await this.wa.addParticipant(groupJid, target).then(() => true).catch(() => false);
          this._log(groupJid, { type: 'add', target: digits, ok });
          return reply(ok ? `✅ Invited/added +${digits}.` : `❌ Could not add +${digits} (blocked privacy setting, or need admin rights).`);
        }

        case 'promote': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}promote @user`);
          const ok = await this.wa.promoteParticipant(groupJid, target).then(() => true).catch(() => false);
          this._log(groupJid, { type: 'promote', target: bareNumber(target), ok });
          return reply(ok ? `⬆️ @${bareNumber(target)} is now an admin.` : `❌ Could not promote @${bareNumber(target)}.`, [target]);
        }

        case 'demote': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}demote @user`);
          const ok = await this.wa.demoteParticipant(groupJid, target).then(() => true).catch(() => false);
          this._log(groupJid, { type: 'demote', target: bareNumber(target), ok });
          return reply(ok ? `⬇️ @${bareNumber(target)} is no longer an admin.` : `❌ Could not demote @${bareNumber(target)}.`, [target]);
        }

        case 'mute': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}mute @user  (soft-mute — bot deletes their messages here)`);
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const bare = bareNumber(target);
          if (!settingsForGroup.mutedMembers.includes(bare)) settingsForGroup.mutedMembers.push(bare);
          this._saveState(state);
          return reply(`🔇 @${bare} is muted in this group (their messages will be auto-deleted).`, [target]);
        }

        case 'unmute': {
          if (!isGroup) return groupOnly();
          const target = resolveTargetJid(msg, argText);
          if (!target) return reply(`Usage: ${PREFIX}unmute @user`);
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const bare = bareNumber(target);
          settingsForGroup.mutedMembers = settingsForGroup.mutedMembers.filter((n) => n !== bare);
          this._saveState(state);
          return reply(`🔊 @${bare} is unmuted.`, [target]);
        }

        case 'tagall':
        case 'everyone': {
          if (!isGroup) return groupOnly();
          const meta = await this.wa.getGroupMetadata(groupJid);
          const ids = (meta.participants || []).map((p) => p.id);
          const header = argText || '📣 Tagging everyone';
          const lines = ids.map((id) => `@${bareNumber(id)}`).join('\n');
          return reply(`${header}\n\n${lines}`, ids);
        }

        // ── group settings ────────────────────────────────────────────
        case 'grouplink':
        case 'link': {
          if (!isGroup) return groupOnly();
          const url = await this.wa.getGroupInviteLink(groupJid).catch(() => null);
          return reply(url ? `🔗 ${url}` : '❌ Could not fetch invite link (need admin rights here).');
        }

        case 'revokelink': {
          if (!isGroup) return groupOnly();
          const url = await this.wa.revokeGroupInviteLink(groupJid).catch(() => null);
          this._log(groupJid, { type: 'revokelink', ok: !!url });
          return reply(url ? `🔄 New invite link: ${url}` : '❌ Could not revoke invite link.');
        }

        case 'groupopen':
        case 'open': {
          if (!isGroup) return groupOnly();
          const ok = await this.wa.setGroupAnnounceOnly(groupJid, false).then(() => true).catch(() => false);
          return reply(ok ? '🔓 Group opened — all members can send messages.' : '❌ Could not change this (need admin rights here).');
        }

        case 'groupclose':
        case 'close': {
          if (!isGroup) return groupOnly();
          const ok = await this.wa.setGroupAnnounceOnly(groupJid, true).then(() => true).catch(() => false);
          return reply(ok ? '🔒 Group closed — only admins can send messages.' : '❌ Could not change this (need admin rights here).');
        }

        case 'lock':
        case 'unlock': {
          if (!isGroup) return groupOnly();
          const target = argText.toLowerCase();
          if (!['info', 'chat'].includes(target)) return reply(`Usage: ${PREFIX}${cmd} info|chat`);
          if (target === 'chat') {
            const ok = await this.wa.setGroupAnnounceOnly(groupJid, cmd === 'lock').then(() => true).catch(() => false);
            return reply(ok ? `✅ Chat ${cmd === 'lock' ? 'locked (admins only)' : 'unlocked'}.` : '❌ Could not change this.');
          }
          const ok = await this.wa.setGroupInfoLocked(groupJid, cmd === 'lock').then(() => true).catch(() => false);
          return reply(ok ? `✅ Group info edit ${cmd === 'lock' ? 'locked to admins' : 'unlocked'}.` : '❌ Could not change this.');
        }

        // ── simple on/off toggles ────────────────────────────────────────
        case 'antilink':
        case 'antisticker':
        case 'autophoto':
        case 'autovideo':
        case 'antibot':
        case 'antiforward':
        case 'antimedia':
        case 'antinsfw':
        case 'antidelete':
        case 'antivoice':
        case 'antichannel':
        case 'approve': {
          if (!isGroup) return groupOnly();
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) return reply(`Usage: ${PREFIX}${cmd} on|off`);
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          settingsForGroup[cmd] = v === 'on';
          this._saveState(state);
          return reply(`✅ *${cmd}* turned ${v.toUpperCase()} for this group.`);
        }

        case 'antibadword': {
          if (!isGroup) return groupOnly();
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) return reply(`Usage: ${PREFIX}antibadword on|off`);
          this._getGroupSettings(state, groupJid).antibadword = v === 'on';
          this._saveState(state);
          return reply(`✅ Antibadword turned ${v.toUpperCase()}.`);
        }

        case 'anticall': {
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) return reply(`Usage: ${PREFIX}anticall on|off  (this is a global setting, not per-group — calls aren't tied to one group)`);
          state.anticall = { enabled: v === 'on' };
          this._saveState(state);
          return reply(`✅ Anticall turned ${v.toUpperCase()} (applies to the whole account).`);
        }

        case 'antispecificword': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, ...wordParts] = argText.split(/\s+/);
          const word = wordParts.join(' ');
          if (sub === 'on' || sub === 'off') {
            settingsForGroup.antispecificword.enabled = sub === 'on';
            this._saveState(state);
            return reply(`✅ Antispecificword turned ${sub.toUpperCase()}.`);
          }
          if (sub === 'add' && word) {
            settingsForGroup.antispecificword.words.push(word.toLowerCase());
            this._saveState(state);
            return reply(`✅ Added "${word}" to the blocked-word list.`);
          }
          if (sub === 'remove' && word) {
            settingsForGroup.antispecificword.words = settingsForGroup.antispecificword.words.filter((w) => w !== word.toLowerCase());
            this._saveState(state);
            return reply(`✅ Removed "${word}" from the blocked-word list.`);
          }
          if (sub === 'list') {
            return reply(`📝 Blocked words: ${settingsForGroup.antispecificword.words.join(', ') || '(none)'}`);
          }
          return reply(`Usage: ${PREFIX}antispecificword on|off|add <word>|remove <word>|list`);
        }

        case 'antispam': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, limitArg] = argText.split(/\s+/);
          if (sub === 'off') { settingsForGroup.antispam.enabled = false; this._saveState(state); return reply('✅ Antispam turned OFF.'); }
          if (sub === 'on') {
            settingsForGroup.antispam.enabled = true;
            if (limitArg && Number(limitArg) > 0) settingsForGroup.antispam.limit = Number(limitArg);
            this._saveState(state);
            return reply(`✅ Antispam turned ON (limit: ${settingsForGroup.antispam.limit} repeats).`);
          }
          return reply(`Usage: ${PREFIX}antispam on [repeat-limit]|off`);
        }

        case 'antiflood': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, limitArg, windowArg] = argText.split(/\s+/);
          if (sub === 'off') { settingsForGroup.antiflood.enabled = false; this._saveState(state); return reply('✅ Antiflood turned OFF.'); }
          if (sub === 'on') {
            settingsForGroup.antiflood.enabled = true;
            if (limitArg && Number(limitArg) > 0) settingsForGroup.antiflood.limit = Number(limitArg);
            if (windowArg && Number(windowArg) > 0) settingsForGroup.antiflood.windowSec = Number(windowArg);
            this._saveState(state);
            return reply(`✅ Antiflood turned ON (limit: ${settingsForGroup.antiflood.limit} msgs / ${settingsForGroup.antiflood.windowSec}s).`);
          }
          return reply(`Usage: ${PREFIX}antiflood on [limit] [windowSec]|off`);
        }

        case 'antimention': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, limitArg] = argText.split(/\s+/);
          if (sub === 'off') { settingsForGroup.antimention.enabled = false; this._saveState(state); return reply('✅ Antimention turned OFF.'); }
          if (sub === 'on') {
            settingsForGroup.antimention.enabled = true;
            if (limitArg && Number(limitArg) > 0) settingsForGroup.antimention.limit = Number(limitArg);
            this._saveState(state);
            return reply(`✅ Antimention turned ON (limit: ${settingsForGroup.antimention.limit} mentions/message).`);
          }
          return reply(`Usage: ${PREFIX}antimention on [limit]|off`);
        }

        case 'welcome':
        case 'goodbye': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, ...msgParts] = argText.split(/\s+/);
          if (sub === 'on' || sub === 'off') {
            settingsForGroup[cmd].enabled = sub === 'on';
            this._saveState(state);
            return reply(`✅ ${cmd[0].toUpperCase() + cmd.slice(1)} turned ${sub.toUpperCase()}.`);
          }
          if (sub === 'set' && msgParts.length) {
            settingsForGroup[cmd].message = msgParts.join(' ');
            this._saveState(state);
            return reply(`✅ ${cmd} message updated. Use {user} and {group} as placeholders.`);
          }
          return reply(`Usage: ${PREFIX}${cmd} on|off|set <message with {user}/{group}>`);
        }

        case 'autokick': {
          if (!isGroup) return groupOnly();
          const settingsForGroup = this._getGroupSettings(state, groupJid);
          const [sub, numArg] = argText.split(/\s+/);
          const digits = (numArg || '').replace(/[^0-9]/g, '');
          if (sub === 'on' || sub === 'off') {
            settingsForGroup.autokick.enabled = sub === 'on';
            this._saveState(state);
            return reply(`✅ Autokick turned ${sub.toUpperCase()}.`);
          }
          if (sub === 'ban' && digits) {
            if (!settingsForGroup.autokick.bannedNumbers.includes(digits)) settingsForGroup.autokick.bannedNumbers.push(digits);
            this._saveState(state);
            return reply(`✅ +${digits} will be auto-removed if they join.`);
          }
          if (sub === 'unban' && digits) {
            settingsForGroup.autokick.bannedNumbers = settingsForGroup.autokick.bannedNumbers.filter((n) => n !== digits);
            this._saveState(state);
            return reply(`✅ +${digits} removed from the autokick list.`);
          }
          if (sub === 'list') {
            return reply(`🚷 Autokick list: ${settingsForGroup.autokick.bannedNumbers.map((n) => '+' + n).join(', ') || '(empty)'}`);
          }
          return reply(`Usage: ${PREFIX}autokick on|off|ban <number>|unban <number>|list`);
        }

        // ── status control ──────────────────────────────────────────────
        case 'purgestatus': {
          // Removes a detected status broadcast in this group with a live, single-message progress animation.
          //   .purgestatus          → uses the dashboard default (delete only / also remove user)
          //   .purgestatus kick     → delete + remove the sender      .purgestatus nokick → delete only
          // Reply to the status card to target that exact one; otherwise the newest detected one.
          if (!isGroup) return groupOnly();
          if (!this.antiStatus) return reply('❌ Status control is not available in this process.');
          const flag = argText.toLowerCase();
          const removeUser = flag === 'kick' ? true : (flag === 'nokick' || flag === 'only') ? false : undefined;
          const quotedId = getContextInfo(msg)?.stanzaId;
          const pending = this.antiStatus.getDetected(groupJid).find((d) => (quotedId ? d.msgId === quotedId : !d.done));
          if (!pending) return reply('❌ No detected status broadcast found in this group.');
          // Not awaited: the animation runs ~13s and must not block message handling everywhere else.
          this._purgeStatusAnimated({ groupJid, pending, quotedId, removeUser }).catch((err) => {
            this.logger?.error({ err }, 'group-bot: purgestatus failed');
            this._safeSendText(groupJid, `❌ *Status removal failed*\n${err?.message || err}`);
          });
          return;
        }

        // ── quick delete ────────────────────────────────────────────────
        case 'del':
        case 'delete': {
          // Reply to any message with .del → it is removed for everyone (the bot must be a group admin
          // for other members' messages). The .del command message itself is removed too.
          if (!isGroup) return groupOnly();
          const ctx = getContextInfo(msg);
          if (!ctx?.stanzaId) return reply(`Usage: reply to the message you want removed with ${PREFIX}del`);
          const targetKey = { id: ctx.stanzaId, remoteJid: groupJid, fromMe: ctx.participant ? bareNumber(ctx.participant) === selfBareNum : false, participant: ctx.participant };
          const r = targetKey.fromMe ? { ok: await this.wa.deleteOwnMessage(groupJid, targetKey) } : await this.wa.deleteMessageForEveryone(groupJid, targetKey);
          if (msg.key.fromMe) await this.wa.deleteOwnMessage(groupJid, msg.key);
          else await this.wa.deleteMessageForEveryone(groupJid, msg.key).catch(() => {});
          this._log(groupJid, { type: 'del', target: bareNumber(ctx.participant), ok: !!r.ok });
          if (!r.ok) return reply('❌ Could not delete that message (is the bot a group admin?).');
          return;
        }

        // ── course files (per group) ────────────────────────────────────
        case 'fileon':
        case 'fileoff': {
          if (!isGroup) return groupOnly();
          const groupSettings = this._getGroupSettings(state, groupJid);
          const fa = groupSettings.fileAccess;
          const credit = renderCredit('{poweredBy}', this.dataDir);
          const tail = credit ? `\n\n_${credit}_` : '';
          if (cmd === 'fileoff') {
            fa.enabled = false;
            this._saveState(state);
            return reply(`⛔ *${STORE_NAME.toUpperCase()} — DISCONNECTED*\nThe file system is now OFF for this group. Course codes are ignored here.${tail}`);
          }
          if (fa.enabled) return reply(`✅ *File System is already ACTIVE* in this group.\nMembers can type a course code such as *cs101*.${tail}`);
          fa.enabled = true; // live immediately (survives a restart) — the animation below is the "connecting" show
          this._saveState(state);
          // Not awaited on purpose: a 12-second animation must never freeze message handling for every other group.
          this._runFilesConnectAnimation(groupJid, clampBatchSize(fa.batchSize)).catch((err) => this.logger?.error({ err }, 'group-bot: files connect animation failed'));
          return;
        }

        case 'filestatus': {
          if (!isGroup) return groupOnly();
          const gs = this._getGroupSettings(state, groupJid);
          const fa = gs.fileAccess;
          return reply([
            `📚 *${STORE_NAME}* — ${fa.enabled ? '🟢 ON' : '⚪ OFF'}`,
            `📦 Files per request: ${clampBatchSize(fa.batchSize)} (change with ${PREFIX}settrigger <${MIN_BATCH_SIZE}-${MAX_BATCH_SIZE}>)`,
          ].join('\n'));
        }

        // Delivery card: after the files, post the group DP + a thank-you that mentions the member. Per group.
        case 'filecard':
        case 'filecardlink': {
          if (!isGroup) return groupOnly();
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) {
            return reply(cmd === 'filecard'
              ? `Usage: ${PREFIX}filecard on|off\nAfter files are delivered, posts the group DP with a message that mentions the member and names this group.`
              : `Usage: ${PREFIX}filecardlink on|off\nAdds this group's invite link to the delivery card (needs ${PREFIX}filecard on).`);
          }
          const fc = this._getGroupSettings(state, groupJid).fileCard;
          if (cmd === 'filecard') fc.enabled = v === 'on'; else fc.showLink = v === 'on';
          this._saveState(state);
          return reply(`✅ *${cmd === 'filecard' ? 'Delivery card' : 'Group link on delivery card'}* turned ${v.toUpperCase()} for this group.`);
        }

        case 'settrigger': {
          if (!isGroup) return groupOnly();
          const n = Number(argText);
          if (!Number.isInteger(n) || n < MIN_BATCH_SIZE || n > MAX_BATCH_SIZE) {
            return reply(`Usage: ${PREFIX}settrigger <${MIN_BATCH_SIZE}-${MAX_BATCH_SIZE}>\nHow many files are sent each time a member picks an option or types ${PREFIX}more in this group.`);
          }
          this._getGroupSettings(state, groupJid).fileAccess.batchSize = n;
          this._saveState(state);
          return reply(`✅ Batch size set to *${n}* file${n === 1 ? '' : 's'} per request in this group.`);
        }

        // ── bad words (per group) ───────────────────────────────────────
        case 'addbadword': {
          if (!isGroup) return groupOnly();
          const words = argText.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
          if (!words.length) return reply(`Usage: ${PREFIX}addbadword <word>  (separate several with commas)`);
          const bw = this._getGroupSettings(state, groupJid).badword;
          for (const w of words) if (!bw.words.includes(w)) bw.words.push(w);
          bw.enabled = true;
          this._saveState(state);
          return reply(`✅ Added ${words.length} word${words.length === 1 ? '' : 's'} to this group's bad-word list (${bw.words.length} total). Bad-word reply is ON.`);
        }

        case 'delbadword': {
          if (!isGroup) return groupOnly();
          const words = argText.split(',').map((w) => w.trim().toLowerCase()).filter(Boolean);
          if (!words.length) return reply(`Usage: ${PREFIX}delbadword <word>  (separate several with commas)`);
          const bw = this._getGroupSettings(state, groupJid).badword;
          const before = bw.words.length;
          bw.words = bw.words.filter((w) => !words.includes(w));
          this._saveState(state);
          return reply(before === bw.words.length ? '❓ None of those words were in the list.' : `✅ Removed ${before - bw.words.length} word(s). ${bw.words.length} left.`);
        }

        case 'badwordlist': {
          if (!isGroup) return groupOnly();
          const bw = this._getGroupSettings(state, groupJid).badword;
          return reply(`🚫 *Bad words* (${bw.enabled ? 'ON' : 'OFF'}, ${bw.words.length}):\n${bw.words.join(', ') || '(none)'}`);
        }

        case 'badword': {
          if (!isGroup) return groupOnly();
          const v = argText.toLowerCase();
          if (!['on', 'off'].includes(v)) return reply(`Usage: ${PREFIX}badword on|off`);
          this._getGroupSettings(state, groupJid).badword.enabled = v === 'on';
          this._saveState(state);
          return reply(`✅ Bad-word reply turned ${v.toUpperCase()} for this group.`);
        }

        case 'badwordmsg': {
          if (!isGroup) return groupOnly();
          const bw = this._getGroupSettings(state, groupJid).badword;
          if (!argText) return reply(`Usage: ${PREFIX}badwordmsg <message>  — placeholders: {user} {group}\nCurrent:\n${bw.message}`);
          bw.message = argText.slice(0, 60000);
          this._saveState(state);
          return reply('✅ Bad-word reply message updated for this group.');
        }

        default:
          return reply(`❓ Unknown command "${cmd}". Send *${PREFIX}menu* to see everything available.`);
      }
    } catch (err) {
      this.logger?.error({ err, cmd }, 'group-bot: command handler threw');
      return reply('❌ Something went wrong running that command. Check the server logs.');
    }
  }

  /**
   * Animated status removal: ONE message is sent, then edited through a
   * loading → detecting → deleting → done sequence (~7 seconds; the text grows
   * and shrinks between frames). The real delete starts immediately in the
   * background and its true result is shown in the last frame. If this
   * WhatsApp fork can't edit messages, the animation is skipped and only the
   * final result is sent.
   */
  /**
   * Sends frames[0], then edits that ONE message through the rest (each frame is shown for its `wait` ms).
   * Guarantees the whole show lasts at least `minMs`. Falls back silently (still waiting) when edits aren't supported.
   * @returns the message key (or null when it can't be edited any more)
   */
  async _playFrames(groupJid, frames, { mentions = [], minMs = 0 } = {}) {
    const t0 = Date.now();
    const sent = await this.wa.sendText(groupJid, frames[0].t, mentions).catch(() => null);
    let key = sent?.key || null;
    for (let i = 0; i < frames.length; i++) {
      await new Promise((res) => setTimeout(res, frames[i].wait));
      if (i + 1 < frames.length && key) {
        const ok = await this.wa.editText(groupJid, key, frames[i + 1].t, mentions);
        if (!ok) key = null;
      }
    }
    const left = minMs - (Date.now() - t0);
    if (left > 0) await new Promise((res) => setTimeout(res, left));
    return key;
  }

  /** ~12.5 s "connecting to the store" show, played once when `.fileon` is switched on. */
  async _runFilesConnectAnimation(groupJid, batchSize) {
    const S = STORE_NAME;
    const bar = (pct) => '▰'.repeat(Math.round(pct / 10)) + '▱'.repeat(10 - Math.round(pct / 10));
    const head = `🔌 *${S.toUpperCase()}*`;
    const f = (pct, title, ...lines) => `${head}\n${bar(pct)} ${pct}%\n*${title}*${lines.length ? '\n' + lines.map((l) => `• ${l}`).join('\n') : ''}`;
    const frames = [
      { t: `⏳ *Starting File System…*`, wait: 1000 },
      { t: f(8, 'Initializing secure channel', 'Preparing encrypted session', 'Allocating file-system resources'), wait: 1300 },
      { t: f(20, `Connecting to ${S}`, `Locating the ${S} servers`, 'Establishing a secure link'), wait: 1500 },
      { t: f(34, 'Authenticating access', 'Verifying bot credentials', 'Granting read access to the archive'), wait: 1300 },
      { t: f(48, 'Linking the file system', `This group is being connected to ${S}`, 'Registering access permissions'), wait: 1400 },
      { t: f(62, 'Fetching the file index', 'Reading course directories', 'Indexing handouts, midterms, finals & quizzes'), wait: 1500 },
      { t: f(76, 'Synchronizing data', 'Building the delivery pipeline', 'Warming up the high-speed cache'), wait: 1300 },
      { t: f(88, 'Verifying file integrity', 'Running validation checks', 'Testing delivery speed'), wait: 1300 },
      { t: f(96, 'Finalizing connection', 'Applying group settings', 'Almost ready…'), wait: 1200 },
    ];
    const key = await this._playFrames(groupJid, frames, { minMs: 12000 });
    const credit = renderCredit('{poweredBy}', this.dataDir);
    const final = [
      `✅ *${S.toUpperCase()} — CONNECTED*`,
      '━━━━━━━━━━━━━━━━━━',
      '🟢 File System: *ACTIVE*',
      `📂 Source: *${S}*`,
      '⚡ Delivery: instant, parallel',
      `📦 Files per request: *${batchSize}*`,
      '',
      '*How to get files*',
      '• Type a course code — e.g. *cs101*',
      '• Or pick a type — *cs101 mid* · *cs101 final* · *cs101 quiz*',
      ...(credit ? ['', `_${credit}_`] : []),
    ].join('\n');
    if (key && (await this.wa.editText(groupJid, key, final))) return;
    await this._safeSendText(groupJid, final);
  }

  async _purgeStatusAnimated({ groupJid, pending, quotedId, removeUser }) {
    const t0 = Date.now();
    const who = `@${bareNumber(pending.senderJid)}`;
    const mentions = [pending.senderJid];
    const bar = (pct) => '▰'.repeat(Math.round(pct / 10)) + '▱'.repeat(10 - Math.round(pct / 10));
    const f = (pct, title, ...lines) => `${title}\n${bar(pct)} ${pct}%${lines.length ? '\n' + lines.map((l) => `• ${l}`).join('\n') : ''}`;
    // 10 frames, ≈12.5 s in total — the delete request runs in parallel the whole time.
    const frames = [
      { t: '⏳ *Initializing…*', wait: 900 },
      { t: f(8, '⚙️ *STATUS CONTROL ENGINE*', 'Establishing a secure session'), wait: 1200 },
      { t: f(18, '🔐 *Verifying Access*', 'Checking admin privileges', 'Validating permissions in this group'), wait: 1200 },
      { t: f(30, '🔍 *Detecting Status Broadcast*', 'Scanning recent group activity', 'Locating the status message', 'Matching sender identity'), wait: 1300 },
      { t: f(45, '✅ *Status Detected*', `Posted by: ${who}`, `Type: ${pending.type === 'mention' ? 'Status mention' : 'Group status'}`, 'Action: removal queued'), wait: 1200 },
      { t: f(58, '🧾 *Preparing Removal Request*', 'Building the delete payload', 'Signing the request'), wait: 1200 },
      { t: f(68, '📡 *Contacting WhatsApp Servers*', 'Sending the delete request', 'Waiting for acknowledgement'), wait: 1300 },
      { t: f(78, '🗑️ *Status is being deleted…*', 'Removing it for every member', 'Processing is still running'), wait: 1200 },
      { t: f(88, '🔄 *Synchronizing*', 'Confirming removal across devices', 'Updating the activity log'), wait: 1200 },
      { t: f(96, '🧹 *Finalizing…*', 'Cleaning up temporary data', 'Almost done'), wait: 1300 },
    ];

    const job = this.antiStatus
      .manualDelete({ jid: groupJid, id: pending.id, removeUser })
      .then((r) => ({ r }), (e) => ({ e }));
    let key = await this._playFrames(groupJid, frames, { mentions, minMs: 12000 });

    const out = await job;
    let final;
    if (out.e) {
      final = `❌ *Status removal failed*\n${out.e.message}`;
      this._log(groupJid, { type: 'purgestatus', target: bareNumber(pending.senderJid), ok: false });
    } else {
      const r = out.r;
      const lines = [r.deleted ? '✅ *STATUS REMOVED*' : '⚠️ *Delete sent — not confirmed by WhatsApp*', '━━━━━━━━━━━━━━━━━━', `👤 Posted by: ${who}`, r.deleted ? '🗑️ Status deleted successfully' : '🗑️ The server did not confirm the deletion', `⏱️ Completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`];
      if (r.kicked) lines.push(`🚪 ${who} removed from the group`);
      const extra = r.errors.filter((e) => e.startsWith('kick'));
      if (extra.length) lines.push(`⚠️ ${extra.join('; ')}`);
      const credit = renderCredit('{poweredBy}', this.dataDir);
      if (credit) lines.push('', `_${credit}_`);
      final = lines.join('\n');
      this._log(groupJid, { type: 'purgestatus', target: bareNumber(r.senderJid), ok: r.deleted, kicked: r.kicked });
    }
    if (key && (await this.wa.editText(groupJid, key, final, mentions))) return;
    await this._safeSendText(groupJid, final, mentions);
  }

  // ── dashboard API surface ─────────────────────────────────────────────
  // Used by src/server.js's /api/group-bot/* routes so every toggle this
  // class understands can also be read/changed from the web panel, not just
  // via chat commands. Always reads fresh from disk so either side's edits
  // (dashboard, or a `.command` typed in WhatsApp) show up immediately on
  // the other.
  reloadConfig() {
    return this._loadState();
  }

  getGroupSettings(jid) {
    const state = this._loadState();
    return this._getGroupSettings(state, jid);
  }

  /** Applies a (dashboard) patch onto ONE group's settings object in place — sanitizes the nested file/badword blocks. */
  _applyPatch(settings, patch) {
    const clean = { ...(patch || {}) };
    if (clean.fileAccess && typeof clean.fileAccess === 'object') {
      const fa = {};
      if (typeof clean.fileAccess.enabled === 'boolean') fa.enabled = clean.fileAccess.enabled;
      if (clean.fileAccess.batchSize != null) fa.batchSize = clampBatchSize(clean.fileAccess.batchSize);
      clean.fileAccess = fa;
    }
    if (clean.fileCard && typeof clean.fileCard === 'object') {
      const fc = {};
      if (typeof clean.fileCard.enabled === 'boolean') fc.enabled = clean.fileCard.enabled;
      if (typeof clean.fileCard.showLink === 'boolean') fc.showLink = clean.fileCard.showLink;
      clean.fileCard = fc;
    }
    if (clean.badword && typeof clean.badword === 'object') {
      const bw = {};
      if (typeof clean.badword.enabled === 'boolean') bw.enabled = clean.badword.enabled;
      if (Array.isArray(clean.badword.words)) bw.words = [...new Set(clean.badword.words.map((w) => String(w).trim().toLowerCase()).filter(Boolean))].slice(0, 500);
      if (typeof clean.badword.message === 'string') bw.message = clean.badword.message.slice(0, 60000);
      clean.badword = bw;
    }
    for (const [key, value] of Object.entries(clean)) {
      if (!(key in settings)) continue; // ignore unknown keys rather than letting the dashboard inject arbitrary fields
      if (value && typeof value === 'object' && !Array.isArray(value) && typeof settings[key] === 'object' && !Array.isArray(settings[key])) {
        settings[key] = { ...settings[key], ...value };
      } else {
        settings[key] = value;
      }
    }
    return settings;
  }

  /** Shallow-merges `patch` into one group's settings (nested objects like antispam are merged one level deep) and persists. */
  saveGroupSettings(jid, patch) {
    const state = this._loadState();
    const settings = this._applyPatch(this._getGroupSettings(state, jid), patch);
    this._saveState(state);
    return settings;
  }

  /** Same patch applied to MANY groups with a single read + single write (used by the dashboard's Bulk Settings). */
  saveGroupSettingsBulk(jids, patch) {
    const list = [...new Set((Array.isArray(jids) ? jids : []).filter((j) => typeof j === 'string' && j.endsWith('@g.us')))].slice(0, 20000);
    const state = this._loadState();
    for (const jid of list) this._applyPatch(this._getGroupSettings(state, jid), patch);
    this._saveState(state);
    return { updated: list.length };
  }

  setMode(mode) {
    if (!['public', 'private'].includes(mode)) throw new Error('mode must be "public" or "private"');
    const state = this._loadState();
    state.mode = mode;
    this._saveState(state);
    return state;
  }

  _formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h ${m}m ${sec}s`;
  }

  _menuText(state) {
    // Bold sans-serif unicode "font" for A–Z / a–z / 0–9; anything else passes through untouched.
    const bold = (t) =>
      [...String(t)].map((ch) => {
        const c = ch.codePointAt(0);
        if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5d4 + c - 65);
        if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ee + c - 97);
        if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ec + c - 48);
        return ch;
      }).join('');
    const section = (icon, title, items) =>
      [`╭─「 ${icon} ${bold(title)} 」`, ...items.map((c) => `│ ➤ \`${PREFIX}${c}\``), '╰──────────────'].join('\n');

    const sections = [
      ['🛡️', 'PROTECTION', ['antilink', 'antisticker', 'antispam', 'antibadword', 'antispecificword', 'autophoto', 'autovideo', 'antimention', 'antiflood', 'antibot', 'antiforward', 'antimedia', 'antinsfw', 'antidelete', 'anticall', 'antivoice', 'antichannel']],
      ['👥', 'MEMBERSHIP', ['welcome', 'goodbye', 'approve', 'autokick']],
      ['⚠️', 'WARNINGS & MODERATION', ['warn', 'warnings', 'resetwarn', 'kick', 'add', 'promote', 'demote', 'mute', 'unmute', 'tagall']],
      ['🚫', 'STATUS CONTROL', ['purgestatus', 'del']],
      ['📚', 'COURSE FILES', ['fileon', 'fileoff', 'filestatus', 'settrigger', 'stats', 'files', 'folders', 'handouts', 'mids', 'finals', 'quizzes', 'upload', 'done']],
      ['🤬', 'BAD WORDS', ['addbadword', 'delbadword', 'badwordlist', 'badword', 'badwordmsg']],
      ['🏷️', 'GROUP', ['admins', 'groupinfo', 'grouplink', 'revokelink', 'groupopen', 'groupclose', 'lock', 'unlock', 'activity']],
      ['⚙️', 'BOT', ['mode', 'ping', 'menu', 'setdev', 'removedev', 'devlist']],
    ];
    const totalCommands = sections.reduce((n, [, , items]) => n + items.length, 0);

    // Credit shown here is fully configurable from the dashboard's Credits tab.
    const b = getBranding(this.dataDir);
    const primary = b.entries.find((e) => e.id === b.primaryId) || b.entries[0];
    const title = b.showCredit && primary ? bold(primary.name.toUpperCase()) : bold('COMMAND MENU');

    const head = [
      `╔═══════════════════╗`,
      `   ✦ ${title} ✦`,
      ...(b.showCredit && b.tagline ? [`   _${b.tagline}_`] : []),
      `╚═══════════════════╝`,
      '',
      `◈ ${bold('Mode')}      ➜ ${state.mode}`,
      `◈ ${bold('Prefix')}    ➜ ${PREFIX}`,
      `◈ ${bold('Runtime')}   ➜ ${this._formatDuration(Date.now() - this._startedAt)}`,
      `◈ ${bold('Commands')}  ➜ ${totalCommands}`,
      '',
      '_Every command below only works for the bot owner and the developer number — everyone else, including group admins, is ignored, in both public and private mode._',
    ].join('\n');

    const body = sections.map(([icon, t, items]) => section(icon, t, items)).join('\n\n');

    const foot = [];
    if (b.showCredit && b.entries.length) {
      foot.push(`╭─「 ✨ ${bold('CREDITS')} 」`);
      for (const e of b.entries) foot.push(`│ ${e.id === primary?.id ? '★' : '◦'} ${e.name}${e.role ? ` — ${e.role}` : ''}`);
      foot.push('╰──────────────');
      if (primary) foot.push('', `✦ ${bold('Powered by')} ${primary.name} ✦`);
    }
    const tip = '📚 _Course files: in groups where .fileon is active, members just type a course code like cs101 (or cs101 mid / final / quiz) — no prefix needed. Owner: .stats [cs101] shows folders + file counts, .upload cs101 as a reply to a file (or as its caption) saves it into that GitHub folder._';
    return [head, '', body, '', tip, ...(foot.length ? ['', foot.join('\n')] : [])].join('\n');
  }
}
