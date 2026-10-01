/**
 * Anti-Status Guard — watches groups you enable for other members posting a
 * WhatsApp Group Status, and reacts: delete-for-everyone, remove the sender,
 * post your configured message.
 *
 * Scope, enforced in code, not just by convention:
 *   - Only in groups explicitly enabled in the config (never on by default).
 *   - Only when this account is a VERIFIED admin in that group right now
 *     (checked fresh via checkAdminStatus() before every action — never
 *     from a cached/stale group list).
 *   - Only on messages actually flagged as a group-status post — ordinary
 *     chat messages, media, everything else is never touched or deleted.
 *   - Never acts on another admin's post.
 *   - A per-group cooldown prevents rapid repeated actions from one burst
 *     of events.
 *
 * Honesty about limits (see README "Anti-Status Guard" section for more):
 *   - "Delete" is WhatsApp's real admin delete-for-everyone — it removes the
 *     message from the group going forward. It can't un-deliver something
 *     already seen/saved/screenshotted before the delete runs.
 *   - Detecting another member's INCOMING group-status post depends on how
 *     this fork surfaces it on receive, which could not be verified against
 *     a live connection while building this. The detection below checks the
 *     same wrapper this app uses when SENDING, plus a defensive fallback —
 *     confirm it actually fires against your own account before relying on
 *     it, and check the logs for "anti-status" entries to see what it saw.
 *
 * Config is a small JSON file (default: data/anti-status-config.json),
 * shared between the web panel and the standalone command
 * (scripts/anti-status-guard.mjs) — editing it from either place, or from
 * the dashboard's Anti-Status tab, affects both.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { renderCredit } from './branding.js';

export const DEFAULT_CONFIG = {
  enabled: false,
  groups: {}, // { [jid]: true }
  deleteEnabled: true,
  kickEnabled: true,
  // {user} is replaced with an @-mention of the responsible member.
  kickMessage: '{user} has been removed for posting a status in this group, as this is not permitted here.\n\n{poweredBy}',
  cooldownMs: 4000,
  // If true, a kick is skipped when the delete attempt could not even get a
  // server accept (ok:false) — an unconfirmed-but-accepted delete still
  // allows the kick, since "accepted" is the most this client can ever know.
  kickOnlyIfDeleteAccepted: false,

  // ── Status-mention guard ──────────────────────────────────────────────
  // Separate from the real-group-status pipeline above. Covers a member
  // posting their own personal status and mentioning/tagging this group as
  // one of the recipients (WhatsApp's "share status with" audience picker),
  // so the status shows up inside the group. Same delete-it behavior, but
  // instead of an immediate kick this gets its own 3-strike warning count
  // per member per group before the member is removed. Everything else
  // (master switch, delete toggle, cooldown, admin-only enforcement) is
  // shared with the pipeline above and is not duplicated here.
  // ── Manual control ────────────────────────────────────────────────────
  // Used by the `.purgestatus` command and the dashboard's "Detected statuses"
  // list. Separate from (and never changes) the automatic behavior above.
  manualEnabled: true,
  manualRemoveUser: false, // false = delete the status only · true = also remove the sender
  warnLimit: 3,
  // {user} → @-mention, {count} → this violation's number, {limit} → warnLimit.
  warnMessage: '{user} ⚠️ Warning {count}/{limit}: your status was removed because it mentioned/tagged this group, which is not permitted here.\n\n{poweredBy}',
};

const MAX_PROCESSED_IDS = 500;
const MAX_DETECTED = 50;

export class AntiStatusGuard extends EventEmitter {
  constructor(wa, { configPath, logger }) {
    super();
    this.wa = wa;
    this.configPath = configPath;
    // Warning counts live in their own file, next to the config, so they
    // survive restarts and are shared the same way the config is (dashboard
    // + standalone command both read/write through this same path).
    this.warningsPath = path.join(path.dirname(configPath), 'anti-status-warnings.json');
    this.logger = logger;
    this.config = this._loadConfig();
    this._warnings = this._loadWarnings(); // { "jid|senderJid": count }
    this._lastActionAt = new Map(); // jid -> timestamp, per-group cooldown (burst throttle)
    this._lastMentionActionAt = new Map(); // "jid|senderJid" -> timestamp, same idea for the mention guard
    // Separate from the cooldown: a bounded set of "jid|id" already fully
    // handled, so the exact same status message is never processed twice —
    // e.g. on a reconnect replay of messages.upsert, or two listeners racing.
    this._processedIds = new Set();
    this._detected = []; // recent detected status broadcasts (newest first) — feeds manual delete
    this._onMessages = this._onMessages.bind(this);
    this.wa.on('messages', this._onMessages);
  }

  _loadWarnings() {
    try {
      if (fs.existsSync(this.warningsPath)) {
        return JSON.parse(fs.readFileSync(this.warningsPath, 'utf8')) || {};
      }
    } catch (e) {
      this.logger?.warn({ err: e }, 'anti-status: could not read warnings store, starting fresh');
    }
    return {};
  }

  _saveWarnings() {
    try {
      fs.mkdirSync(path.dirname(this.warningsPath), { recursive: true });
      fs.writeFileSync(this.warningsPath, JSON.stringify(this._warnings, null, 2) + '\n');
    } catch (e) {
      this.logger?.warn({ err: e }, 'anti-status: could not persist warnings store');
    }
  }

  _warnKey(jid, senderJid) {
    return jid + '|' + senderJid;
  }

  /** Current strike count for a member in a group (0 if none on record). */
  getWarningCount(jid, senderJid) {
    return this._warnings[this._warnKey(jid, senderJid)] || 0;
  }

  _bumpWarningCount(jid, senderJid) {
    const key = this._warnKey(jid, senderJid);
    const next = (this._warnings[key] || 0) + 1;
    this._warnings[key] = next;
    this._saveWarnings();
    return next;
  }

  _resetWarningCount(jid, senderJid) {
    const key = this._warnKey(jid, senderJid);
    if (key in this._warnings) {
      delete this._warnings[key];
      this._saveWarnings();
    }
  }

  _loadConfig() {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        // Older saved configs carry the previously hard-coded credit line — swap it for the configurable token.
        for (const k of ['kickMessage', 'warnMessage']) {
          if (typeof raw[k] === 'string') raw[k] = raw[k].replace(/\n*Powered by Saif Chishti\.\s*$/, '\n\n{poweredBy}');
        }
        return { ...DEFAULT_CONFIG, ...raw, groups: { ...(raw.groups || {}) } };
      }
    } catch (e) {
      this.logger?.warn({ err: e }, 'anti-status: could not read config, using defaults');
    }
    return { ...DEFAULT_CONFIG, groups: {} };
  }

  /** Re-read the config file from disk — call this if another process (the
   *  standalone command, or the dashboard) may have changed it since. */
  reloadConfig() {
    this.config = this._loadConfig();
    return this.config;
  }

  saveConfig(patch) {
    // `patch.groups`, when given, is the COMPLETE new group map. (It used to be merged into the old map, which made
    // switching a group OFF a silent no-op — the removed key was merged straight back in.)
    this.config = { ...this.config, ...patch, groups: patch.groups ? { ...patch.groups } : { ...this.config.groups } };
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n');
    return this.config;
  }

  setGroupEnabled(jid, enabled) {
    const groups = { ...this.config.groups };
    if (enabled) groups[jid] = true; else delete groups[jid];
    return this.saveConfig({ groups });
  }

  /** Turn the guard on/off for MANY groups with one write (dashboard "enable for all my admin groups"). */
  setGroupsEnabled(jids, enabled) {
    const groups = { ...this.config.groups };
    for (const jid of jids) {
      if (typeof jid !== 'string' || !jid.endsWith('@g.us')) continue;
      if (enabled) groups[jid] = true; else delete groups[jid];
    }
    return this.saveConfig({ groups });
  }

  _credit(text) {
    return renderCredit(text, path.dirname(this.configPath));
  }

  // ── Manual control ──────────────────────────────────────────────────────
  _recordDetections(messages) {
    try {
      for (const msg of messages || []) {
        const jid = msg?.key?.remoteJid;
        if (!jid || !jid.endsWith('@g.us') || msg.key?.fromMe || !msg.key?.id) continue;
        const type = this._isGroupStatusMessage(msg) ? 'group-status'
          : this._isStatusMentionNotificationInGroup(msg, jid) ? 'mention' : null;
        if (!type) continue;
        const senderJid = msg.key.participant || msg.participant;
        if (!senderJid || this._detected.some((d) => d.msgId === msg.key.id && d.jid === jid)) continue;
        const entry = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          jid, senderJid, msgId: msg.key.id, type, at: Date.now(), done: false,
          key: msg.key, quotedKey: type === 'mention' ? this._extractQuotedStatusKey(msg) : null,
        };
        this._detected.unshift(entry);
        this._detected.length = Math.min(this._detected.length, MAX_DETECTED);
        this.emit('detected', this._publicDetected(entry));
      }
    } catch (err) {
      this.logger?.warn({ err }, 'anti-status: could not record detection');
    }
  }

  _publicDetected(d) {
    const { key, quotedKey, ...rest } = d; // eslint-disable-line no-unused-vars
    return rest;
  }

  /** Recent detected status broadcasts (newest first), optionally for one group. */
  getDetected(jid) {
    return this._detected.filter((d) => !jid || d.jid === jid).map((d) => this._publicDetected(d));
  }

  /**
   * Manually delete a detected status broadcast (by id, or the newest pending
   * one in `jid`). removeUser: true/false, or undefined → dashboard default.
   * Same verified-admin rule and same hardened delete as the automatic path.
   */
  async manualDelete({ jid, id, msgId, removeUser } = {}) {
    this.reloadConfig();
    if (this.config.manualEnabled === false) throw new Error('Manual status control is turned off in the dashboard.');
    const entry = this._detected.find((d) =>
      (id ? d.id === id : msgId ? d.msgId === msgId && (!jid || d.jid === jid) : d.jid === jid && !d.done));
    if (!entry) throw new Error('No detected status broadcast found' + (jid && !id ? ' in this group' : '') + '.');
    const remove = typeof removeUser === 'boolean' ? removeUser : !!this.config.manualRemoveUser;

    const status = await this.wa.checkAdminStatus(entry.jid, entry.senderJid);
    if (!status.selfIsAdmin) throw new Error('This account is not an admin in that group.');

    const result = {
      type: 'manual', jid: entry.jid, groupName: status.groupName, senderJid: entry.senderJid, msgId: entry.msgId, at: Date.now(),
      detected: true, deleted: false, deleteMethod: null, deleteAttempts: [], kicked: false, messaged: false, errors: [],
    };
    const del = await this.wa.deleteMessageForEveryone(entry.jid, entry.key);
    result.deleted = del.ok; result.deleteMethod = del.method; result.deleteAttempts = del.attempts;
    if (!del.ok) result.errors.push('delete: ' + (del.error || 'unknown failure'));
    if (entry.quotedKey) {
      const d2 = await this.wa.deleteMessageForEveryone('status@broadcast', entry.quotedKey);
      result.deleted = result.deleted || d2.ok;
      if (!d2.ok) result.errors.push('delete (quoted original): ' + (d2.error || 'unknown failure'));
    }
    if (remove) {
      if (status.targetIsAdmin) result.errors.push('kick: skipped — sender is a group admin');
      else {
        try { await this.wa.removeParticipant(entry.jid, entry.senderJid); result.kicked = true; }
        catch (err) { result.errors.push('kick: ' + String(err?.message || err)); }
      }
    }
    entry.done = true;
    this.logger?.info(result, 'anti-status: manual action taken');
    this.emit('action', result);
    return result;
  }

  async _onMessages(messages) {
    this._recordDetections(messages); // additive: manual control works even when auto is off
    if (!this.config.enabled) return;
    for (const msg of messages) {
      try {
        const jid = msg?.key?.remoteJid;
        if (jid === 'status@broadcast') {
          // A personal status that included this account in its audience.
          // NOTE: this only ever proves the account was IN the audience —
          // never which specific group (if any) was actually mentioned. A
          // live test confirmed this fired a warning in an unrelated group
          // the sender is also a member of, alongside the group actually
          // mentioned. So this path no longer warns/kicks per group (that
          // would be punishing the wrong group half the time) — it only
          // makes a best-effort attempt to wipe the status itself, silently.
          // The real, per-group-accurate signal is the in-group card below.
          await this._handleMentionStatusSilentDeleteOnly(msg);
        } else if (jid && jid.endsWith('@g.us')) {
          if (this._isGroupStatusMessage(msg)) {
            // Real Group Status — untouched original pipeline, immediate kick.
            await this._handleOne(msg);
          } else if (this._isStatusMentionNotificationInGroup(msg, jid)) {
            // The other visible symptom of "mentioned/tagged this group in a
            // status": WhatsApp also drops a status-mention card directly
            // into the group chat itself, separate from the copy the
            // audience receives on the Updates tab. This is the one signal
            // that's actually specific to THIS group, so it's now the only
            // path that warns/kicks. Deleted straight out of the group chat
            // where it landed — a real group message, so a real admin
            // delete-for-everyone should actually take effect on it.
            await this._handleGroupMentionNotification(msg, jid);
          } else if (this.config.groups?.[jid]) {
            // Didn't match any known shape, but this IS a watched/admin
            // group — log a compact fingerprint (not the full raw message)
            // so an unrecognized status-mention card's real shape can be
            // spotted from the logs without wading through connection noise.
            this._logUnmatchedGroupMessage(msg, jid);
          }
        }
      } catch (err) {
        this.logger?.error({ err }, 'anti-status: handler error for one message');
      }
    }
  }

  /**
   * Compact fingerprint of a message this guard didn't recognize, logged
   * only for messages arriving in a watched/admin group. Deliberately small
   * (keys and short flags, not the full message body) so it can be found
   * and read directly from a console screenshot/copy instead of getting
   * lost in a huge JSON blob.
   */
  _logUnmatchedGroupMessage(msg, jid) {
    try {
      const m = msg?.message || {};
      const contentKeys = Object.keys(m);
      const contextKeysByContent = {};
      for (const k of contentKeys) {
        const ctx = m[k]?.contextInfo;
        if (ctx) contextKeysByContent[k] = Object.keys(ctx);
      }
      const textPreview = (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        ''
      ).slice(0, 60);
      this.logger?.info({
        jid,
        msgId: msg.key?.id,
        fromMe: !!msg.key?.fromMe,
        stubType: msg.messageStubType ?? null,
        stubParams: msg.messageStubParameters ?? null,
        contentKeys,
        contextKeysByContent,
        textPreview,
      }, 'anti-status: unmatched message fingerprint in watched group');
    } catch (err) {
      this.logger?.warn({ err }, 'anti-status: failed to fingerprint unmatched message');
    }
  }

  /**
   * If the status-mention card carries the original status as a quoted
   * message (contextInfo.stanzaId + contextInfo.participant, the normal WA
   * "replying to X" shape), this recovers that as a deletable key on
   * status@broadcast — the actual status, as opposed to the card itself.
   * Important because the card WhatsApp renders in the group ("@ This group
   * was mentioned") looks, from the evidence so far, like a client-side
   * notification wrapping a quote of the real status rather than a plain
   * revokable message in its own right — deleting the card's own key alone
   * was confirmed NOT enough to make it disappear for other members. Trying
   * both keys (card + quoted original) maximizes the chance one of them is
   * the one WhatsApp will actually honor.
   */
  _extractQuotedStatusKey(msg) {
    const m = msg?.message;
    if (!m) return null;
    for (const key of Object.keys(m)) {
      const ctx = m[key]?.contextInfo;
      if (ctx?.stanzaId && ctx?.participant) {
        return { id: ctx.stanzaId, remoteJid: 'status@broadcast', participant: ctx.participant, fromMe: false };
      }
    }
    return null;
  }

  /**
   * Candidate detector for the "status-mention" card WhatsApp drops into a
   * group's own chat when a member tags/mentions that group while posting a
   * personal status — as opposed to the real Group Status feature above,
   * and separate from the status@broadcast copy handled in
   * _handleMentionStatus. The exact wire shape for this notification is not
   * documented and could not be verified against a live connection while
   * building this (same honesty caveat as _isGroupStatusMessage above) —
   * this checks every plausible field name a fork might use for it. Confirm
   * against your own logs ("anti-status" entries) before relying on it, and
   * widen this list if your account's notification arrives shaped
   * differently than these guesses.
   */
  _isStatusMentionNotificationInGroup(msg, jid) {
    const m = msg?.message;
    if (!m) return false;
    if (m.statusMentionMessage || m.groupStatusMentionMessage || m.groupMentionedMessage) return true;
    const stub = msg?.messageStubType;
    if (stub && /status.*mention|mention.*status/i.test(String(stub))) return true;
    if (msg?.messageStubParameters?.some?.((p) => /status.*mention|mention.*status/i.test(String(p)))) return true;
    for (const key of Object.keys(m)) {
      const ctx = m[key]?.contextInfo;
      if (!ctx) continue;
      if (ctx.isStatusMention || ctx.statusMentionMessage || ctx.mentionedGroupJid) return true;
      // The plain @-mention mechanism, but pointed at a GROUP jid instead of
      // a person — plausible given the WA UI just renders "This group was
      // mentioned" instead of a name for that case. Only counts when it's
      // THIS group being mentioned (not some other jid unrelated to here).
      if (Array.isArray(ctx.mentionedJid) && ctx.mentionedJid.includes(jid)) return true;
    }
    return false;
  }

  /**
   * Recognizes a group-status post regardless of which fork the SENDER used
   * to create it. This matters because our one WhatsApp connection receives
   * whatever shape WhatsApp's server delivers — we never talk to the
   * sender's library directly — and different forks (see README's fork
   * research table) wrap the same real feature differently on the wire:
   *   - groupStatusMessageV2  → this project's own fork, and the two other
   *     forks confirmed to implement the real mechanism correctly
   *   - groupStatusMessage (no "V2")     → the older v1 wrapper some forks use
   *   - contextInfo.isGroupStatus         → some forks surface it as a flag on
   *     the inner message instead of a distinct wrapper type
   *   - stanza-level is_group_status meta → not visible on the parsed message
   *     object in every fork; the raw meta attribute is checked if present
   *   - status@broadcast + statusJidList limited to this group's members →
   *     what a fork with NO real group-status support (like @yemo-dev/yebail,
   *     per the README table) produces when asked for one. It is not a true
   *     group status, but it is the visible symptom a member of this group
   *     would see, so it is still flagged for review here.
   */
  _isGroupStatusMessage(msg) {
    const m = msg?.message;
    if (!m) return false;
    if (m.groupStatusMessageV2 || m.groupStatusMessage) return true;
    if (msg?.messageStubParameters?.some?.((p) => String(p).includes('is_group_status'))) return true;
    for (const key of Object.keys(m)) {
      if (m[key]?.contextInfo?.isGroupStatus) return true;
    }
    return false;
  }

  /**
   * Catches the "fake" group status: a personal status sent to
   * status@broadcast with this group's own member list as the audience —
   * the fallback behavior of forks with no real group-status support. This
   * arrives on a completely different event (status updates, not group
   * messages) so it's checked separately from _isGroupStatusMessage/_handleOne.
   * Not wired to an event source here since Baileys does not expose another
   * account's status list to us at all (status privacy) — this account can
   * only ever detect it via a member reporting it or, if this account is
   * itself in the audience, via a still-undocumented status event. Left as
   * an explicit, honest gap rather than a fabricated detection path.
   */

  async _handleOne(msg) {
    if (msg.key?.fromMe) return; // never act on our own sends
    const jid = msg.key?.remoteJid;
    if (!jid || !jid.endsWith('@g.us')) return; // groups only
    if (!this.config.groups?.[jid]) return; // not enabled for this group
    if (!this._isGroupStatusMessage(msg)) return; // only group-status posts

    const senderJid = msg.key?.participant || msg.participant;
    if (!senderJid) return;
    const msgId = msg.key?.id;
    if (!msgId) return;

    // Duplicate-event protection: this exact status message is only ever
    // acted on once, regardless of how many times the event fires.
    const dedupeKey = jid + '|' + msgId;
    if (this._processedIds.has(dedupeKey)) return;

    const now = Date.now();
    const last = this._lastActionAt.get(jid) || 0;
    if (now - last < (this.config.cooldownMs ?? 4000)) return;

    // Marked processed up front (not after success) so a slow/erroring run
    // can't leave the door open for the same message to be picked up again
    // by a second concurrent event before this one finishes.
    this._processedIds.add(dedupeKey);
    if (this._processedIds.size > MAX_PROCESSED_IDS) {
      const oldest = this._processedIds.values().next().value;
      this._processedIds.delete(oldest);
    }

    let status;
    try {
      status = await this.wa.checkAdminStatus(jid, senderJid);
    } catch (err) {
      this.logger?.warn({ err, jid }, 'anti-status: could not verify admin status, skipping this event');
      return;
    }
    if (!status.selfIsAdmin) {
      this.logger?.warn({ jid, groupName: status.groupName }, 'anti-status: enabled here but this account is not currently an admin — disable it for this group or re-check your admin status');
      return;
    }
    if (status.targetIsAdmin) return; // never moderate admins

    this._lastActionAt.set(jid, now);

    // Full pipeline, in the required order: detect (done above) → delete →
    // verify → warn/mention → kick. Each stage's honest outcome is recorded
    // even when it fails, so the dashboard/log never claims success it
    // didn't get.
    const result = {
      jid, groupName: status.groupName, senderJid, msgId, at: now,
      detected: true,
      deleted: false, deleteMethod: null, deleteAttempts: [],
      kicked: false, messaged: false, errors: [],
    };

    // Step 1: delete first, so other members stop being able to view it.
    if (this.config.deleteEnabled) {
      try {
        const del = await this.wa.deleteMessageForEveryone(jid, msg.key);
        result.deleted = del.ok;
        result.deleteMethod = del.method;
        result.deleteAttempts = del.attempts; // per-variant detail for the dashboard/log
        if (!del.ok) {
          result.errors.push('delete: ' + (del.error || 'unknown failure'));
        } else {
          // "ok" only means a server accepted a revoke stanza without
          // rejecting it — see deleteMessageForEveryone's own comment on why
          // that is NOT the same as "confirmed gone from other members'
          // phones". Nothing client-side can confirm that, on any fork.
          result.errors.push('delete: server accepted at least one variant (' + del.method + ') — cannot confirm it removed the visible entry for other members');
        }
      } catch (err) {
        // Should be unreachable (deleteMessageForEveryone catches internally),
        // kept as a last-resort guard so one bad message can't crash the guard.
        result.errors.push('delete: ' + String(err?.message || err));
      }
    }

    // Step 2 (required before kick): mention the responsible member and
    // explain why the action was taken.
    if (this.config.kickMessage) {
      try {
        const text = this.config.kickMessage.includes('{user}')
          ? this.config.kickMessage.replace(/\{user\}/g, '@' + senderJid.split('@')[0])
          : this.config.kickMessage;
        await this.wa.sock.sendMessage(jid, { text: this._credit(text), mentions: [senderJid] });
        result.messaged = true;
      } catch (err) {
        result.errors.push('message: ' + String(err?.message || err));
      }
    }

    // Step 3: kick only after the delete step has been attempted (never
    // before — enforced by code order, not just convention). Still runs even
    // if delete failed/unconfirmed, unless the operator explicitly opted
    // into requiring a server-accepted delete first.
    const deleteBlocksKick = this.config.kickOnlyIfDeleteAccepted && this.config.deleteEnabled && !result.deleted;
    if (this.config.kickEnabled && !deleteBlocksKick) {
      try {
        await this.wa.removeParticipant(jid, senderJid);
        result.kicked = true;
      } catch (err) {
        result.errors.push('kick: ' + String(err?.message || err));
      }
    } else if (this.config.kickEnabled && deleteBlocksKick) {
      result.errors.push('kick: skipped — kickOnlyIfDeleteAccepted is on and delete was not accepted');
    }

    this.logger?.info(result, 'anti-status: action taken');
    this.emit('action', result);
  }

  /**
   * Handles a personal status that reached this account via
   * status@broadcast — the shape produced whenever this account happens to
   * be in that status's audience. Confirmed by a live test to NOT be a
   * reliable per-group signal: it fired in an unrelated group the sender is
   * also a member of, alongside the group actually mentioned, because this
   * account being in the audience says nothing about which group (if any)
   * was the one actually tagged. So this no longer warns or kicks anywhere
   * — it only makes a best-effort, silent attempt to wipe the status
   * itself (never attributed to, or announced in, any specific group).
   * Warning/kicking now happens exclusively via
   * _handleGroupMentionNotification, which is tied to one specific group.
   */
  async _handleMentionStatusSilentDeleteOnly(msg) {
    if (msg.key?.fromMe) return; // never act on our own sends
    if (!this.config.deleteEnabled) return;
    const msgId = msg.key?.id;
    if (!msgId) return;

    const dedupeKey = 'mention-silent|' + msgId;
    if (this._processedIds.has(dedupeKey)) return;
    this._processedIds.add(dedupeKey);
    if (this._processedIds.size > MAX_PROCESSED_IDS) {
      const oldest = this._processedIds.values().next().value;
      this._processedIds.delete(oldest);
    }

    try {
      const del = await this.wa.deleteMessageForEveryone('status@broadcast', msg.key);
      this.logger?.info({ msgId, ok: del.ok, method: del.method }, 'anti-status: silent status delete attempted (no warn/kick — audience membership alone does not identify a group)');
    } catch (err) {
      this.logger?.warn({ err, msgId }, 'anti-status: silent status delete failed');
    }
  }

  /**
   * Handles the status-mention notification card when it arrives directly
   * in a group's own chat (see _isStatusMentionNotificationInGroup). Unlike
   * _handleMentionStatus this already knows exactly which group it landed
   * in, so only that one group is checked/enforced — and the delete is
   * addressed to the group itself, since that's where the message lives.
   */
  async _handleGroupMentionNotification(msg, jid) {
    if (msg.key?.fromMe) return;
    if (!this.config.groups?.[jid]) return; // not enabled for this group
    const senderJid = msg.key?.participant || msg.participant;
    if (!senderJid) return;
    const msgId = msg.key?.id;
    if (!msgId) return;

    const dedupeKey = 'group-mention|' + jid + '|' + msgId;
    if (this._processedIds.has(dedupeKey)) return;
    this._processedIds.add(dedupeKey);
    if (this._processedIds.size > MAX_PROCESSED_IDS) {
      const oldest = this._processedIds.values().next().value;
      this._processedIds.delete(oldest);
    }

    // Logged unconditionally (not just on failure) so the exact shape of
    // this notification is on record from the first time it's ever seen —
    // needed to tune _isStatusMentionNotificationInGroup/
    // _extractQuotedStatusKey against how this account's fork actually
    // delivers it, without having to reproduce the mention again.
    this.logger?.info({ jid, senderJid, msgId, raw: msg }, 'anti-status: status-mention card seen in group — raw shape for tuning');

    try {
      await this._enforceMentionViolation(jid, senderJid, msg, jid);
    } catch (err) {
      this.logger?.error({ err, jid }, 'anti-status: mention-guard handler error (group notification)');
    }
  }

  async _enforceMentionViolation(jid, senderJid, msg, deleteTarget) {
    let status;
    try {
      status = await this.wa.checkAdminStatus(jid, senderJid);
    } catch (err) {
      this.logger?.warn({ err, jid }, 'anti-status: could not verify admin/membership status, skipping this group for this event');
      return;
    }
    if (!status.selfIsAdmin) return; // can't act where this account isn't admin
    if (!status.targetIsMember) return; // sender isn't in this particular group — not relevant here
    if (status.targetIsAdmin) return; // never moderate admins

    const cooldownKey = jid + '|' + senderJid;
    const now = Date.now();
    const last = this._lastMentionActionAt.get(cooldownKey) || 0;
    if (now - last < (this.config.cooldownMs ?? 4000)) return;
    this._lastMentionActionAt.set(cooldownKey, now);

    const result = {
      type: 'mention', jid, groupName: status.groupName, senderJid, msgId: msg.key?.id, at: now,
      detected: true,
      deleted: false, deleteMethod: null, deleteAttempts: [],
      warned: false, warnCount: 0, warnLimit: this.config.warnLimit ?? 3,
      kicked: false, messaged: false, errors: [],
    };

    // Step 1: delete the status/notification itself, so it's gone from the
    // group — for everyone, not just hidden from this account — before any
    // warning is sent. deleteTarget is 'status@broadcast' for the copy that
    // reached this account as part of the status's own audience, or the
    // group's own jid when it's the mention-notification card that landed
    // directly in the group chat; the same hardened multi-variant delete
    // (see deleteMessageForEveryone) is used either way.
    //
    // For the in-group card specifically, its own key alone was confirmed
    // (live, by the operator) NOT to make it disappear for other members —
    // consistent with it being a client-rendered notification quoting the
    // real status rather than a plain revokable message. So when a quoted
    // original key can be recovered (see _extractQuotedStatusKey), that key
    // is ALSO deleted on status@broadcast, in addition to the card's own
    // key — maximizing the chance one of the two is the one WhatsApp honors.
    if (this.config.deleteEnabled) {
      try {
        const del = await this.wa.deleteMessageForEveryone(deleteTarget, msg.key);
        result.deleted = del.ok;
        result.deleteMethod = del.method;
        result.deleteAttempts = del.attempts;
        if (!del.ok) result.errors.push('delete: ' + (del.error || 'unknown failure'));
      } catch (err) {
        result.errors.push('delete: ' + String(err?.message || err));
      }

      const quotedKey = this._extractQuotedStatusKey(msg);
      if (quotedKey) {
        try {
          const del2 = await this.wa.deleteMessageForEveryone('status@broadcast', quotedKey);
          result.deleted = result.deleted || del2.ok;
          result.deleteAttempts = [...result.deleteAttempts, ...del2.attempts.map((a) => ({ ...a, method: 'quoted-original:' + a.method }))];
          if (!del2.ok) result.errors.push('delete (quoted original): ' + (del2.error || 'unknown failure'));
          else result.deleteMethod = result.deleteMethod || ('quoted-original:' + del2.method);
        } catch (err) {
          result.errors.push('delete (quoted original): ' + String(err?.message || err));
        }
      }
    }

    // Step 2: bump this member's strike count for this group.
    const count = this._bumpWarningCount(jid, senderJid);
    const limit = this.config.warnLimit ?? 3;
    result.warnCount = count;

    if (count < limit) {
      // Strikes 1..limit-1: warn in the group, no kick.
      if (this.config.warnMessage) {
        try {
          const text = this.config.warnMessage
            .replace(/\{user\}/g, '@' + senderJid.split('@')[0])
            .replace(/\{count\}/g, String(count))
            .replace(/\{limit\}/g, String(limit));
          await this.wa.sock.sendMessage(jid, { text: this._credit(text), mentions: [senderJid] });
          result.warned = true;
          result.messaged = true;
        } catch (err) {
          result.errors.push('warn-message: ' + String(err?.message || err));
        }
      }
    } else {
      // Final strike: same message + kick as the real-group-status path,
      // then the count resets so a future violation starts back at 1.
      if (this.config.kickMessage) {
        try {
          const text = this.config.kickMessage.includes('{user}')
            ? this.config.kickMessage.replace(/\{user\}/g, '@' + senderJid.split('@')[0])
            : this.config.kickMessage;
          await this.wa.sock.sendMessage(jid, { text: this._credit(text), mentions: [senderJid] });
          result.messaged = true;
        } catch (err) {
          result.errors.push('message: ' + String(err?.message || err));
        }
      }
      const deleteBlocksKick = this.config.kickOnlyIfDeleteAccepted && this.config.deleteEnabled && !result.deleted;
      if (this.config.kickEnabled && !deleteBlocksKick) {
        try {
          await this.wa.removeParticipant(jid, senderJid);
          result.kicked = true;
        } catch (err) {
          result.errors.push('kick: ' + String(err?.message || err));
        }
      } else if (this.config.kickEnabled && deleteBlocksKick) {
        result.errors.push('kick: skipped — kickOnlyIfDeleteAccepted is on and delete was not accepted');
      }
      this._resetWarningCount(jid, senderJid);
    }

    this.logger?.info(result, 'anti-status: mention-guard action taken');
    this.emit('action', result);
  }

  stop() {
    this.wa.off('messages', this._onMessages);
  }
}
