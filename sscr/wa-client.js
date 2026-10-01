/**
 * WhatsApp client wrapper for the Group Status tool.
 *
 * Engine: @itsliaaa/baileys (a maintained Baileys fork, v0.3.18-final, Jun 2026)
 * — the only actively maintained fork family that implements the REAL WhatsApp
 * Group Status mechanism:
 *
 *   message = {
 *     groupStatusMessageV2: {
 *       message: { imageMessage | videoMessage | ... }
 *     }
 *   }
 *
 * wrapped content is relayed to the GROUP JID itself (not status@broadcast),
 * with `contextInfo.isGroupStatus = true` and a stanza-level
 * `<meta is_group_status="true"/>` attribute.
 *
 * The plain `status@broadcast` + `statusJidList` path is intentionally NOT used
 * for the primary feature (it produces an audience-limited PERSONAL status,
 * not a group status). It is exposed only as an explicitly labelled
 * "diagnostic" mode to help isolate server-side rejection of group statuses.
 */
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  jidNormalizedUser,
} from '@itsliaaa/baileys';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const RECONNECT_DELAYS = [5_000, 10_000, 20_000, 30_000];

/**
 * Bare-JID compare: strips the ":device" resource suffix WhatsApp appends
 * (e.g. "1234@s.whatsapp.net:12" -> "1234@s.whatsapp.net"). Works for
 * ordinary phone JIDs (@s.whatsapp.net / @c.us) AND @lid identifiers —
 * jidNormalizedUser() is built for the former and can mangle or reject the
 * latter, which is exactly why admin-matching using ONLY jidNormalizedUser
 * silently fails for accounts WhatsApp has switched to its newer "LID"
 * (Linked ID) privacy system, where a group can list participants under an
 * opaque @lid identifier instead of their real phone-number JID.
 */
function bareJid(jid) {
  if (!jid) return null;
  const at = jid.indexOf('@');
  if (at < 0) return jid;
  const user = jid.slice(0, at).split(':')[0];
  const server = jid.slice(at);
  return user + server;
}

/**
 * Is `candidateJid` the same participant as one of `selfJids`? Compares
 * every self-identifier against the candidate — both as-is and normalized —
 * so it matches regardless of whether either side is a phone JID
 * (@s.whatsapp.net/@c.us) or an @lid identifier, and regardless of which
 * one this account's own socket vs. this specific group happens to expose.
 */
function jidMatchesAny(candidateJid, selfJids) {
  if (!candidateJid) return false;
  const candidates = [candidateJid, bareJid(candidateJid)];
  try { candidates.push(jidNormalizedUser(candidateJid)); } catch { /* not a phone JID — fine, @lid etc. */ }
  for (const self of selfJids) {
    if (!self) continue;
    const selfForms = [self, bareJid(self)];
    try { selfForms.push(jidNormalizedUser(self)); } catch { /* noop */ }
    if (candidates.some((c) => selfForms.includes(c))) return true;
  }
  return false;
}

/** Every identifier this account's own socket exposes for itself — phone JID and, if present, LID. */
function selfIdentifiers(sock) {
  return [sock?.user?.id, sock?.user?.lid].filter(Boolean);
}

/** Every identifier a single group participant record exposes — different Baileys/fork versions populate different fields. */
function participantIdentifiers(p) {
  return [p?.id, p?.jid, p?.lid].filter(Boolean);
}

export class WhatsAppClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.sessionDir  where creds are persisted
   * @param {import('pino').Logger} opts.logger
   * @param {string} [opts.browserName]
   */
  constructor({ sessionDir, logger, browserName = 'Chrome' }) {
    super();
    this.sessionDir = sessionDir;
    this.logger = logger;
    this.browserName = browserName;
    this.sock = null;
    this.saveCreds = null;
    this.qr = null;
    this.connectionStatus = 'connecting'; // connecting|qr|pairing|open|close|loggedOut
    this.lastDisconnectReason = null;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pendingPairingPhone = null;
    this.starting = false;
    this.generation = 0; // incremented per socket; stale sockets' events are ignored
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  /** Current human-readable state for the UI */
  getState() {
    return {
      status: this.connectionStatus,
      qr: this.qr,
      registered: this.sock?.authState?.creds?.registered === true,
      me: this.sock?.user
        ? { id: this.sock.user.id, name: this.sock.user.name || this.sock.user.verifiedName || null }
        : null,
      lastDisconnectReason: this.lastDisconnectReason,
      reconnectAttempt: this.reconnectAttempt,
      pairingCode: this.pairingCode || null,
      pairingError: this.pairingError || null,
      sessionDir: this.sessionDir,
    };
  }

  _setStatus(status) {
    this.connectionStatus = status;
    this.logger.info({ status }, 'connection status');
    this.emit('state');
  }

  /**
   * Start (or restart) the WhatsApp connection. Safe to call repeatedly.
   */
  async start() {
    if (this.starting) return;
    if (this.sock) {
      // If a socket exists and is in a useful state, don't clobber it.
      if (['open', 'qr', 'pairing'].includes(this.connectionStatus)) return;
      // stale socket (e.g. after a 'close'): tear it down before rebuilding
      try {
        this.sock.end(undefined);
      } catch {
        /* noop */
      }
      this.sock = null;
    }
    this.starting = true;
    try {
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionDir);
      this.saveCreds = saveCreds;

      const sock = makeWASocket({
        auth: state,
        logger: this.logger,
        browser: Browsers.appropriate(this.browserName),
        printQRInTerminal: false,
        syncFullHistory: false,
        markOnlineOnConnect: true,
        connectTimeoutMs: 30_000,
        keepAliveIntervalMs: 30_000,
        generateHighQualityLinkPreview: false,
        getMessage: async () => undefined,
      });
      this.generation += 1;
      const gen = this.generation;
      this.sock = sock;

      sock.ev.on('creds.update', () => {
        if (gen !== this.generation) return; // stale socket
        try {
          saveCreds();
        } catch (err) {
          this.logger.error({ err }, 'failed to save creds');
        }
      });

      sock.ev.on('messages.upsert', (upsert) => {
        if (gen !== this.generation) return; // stale socket
        try {
          this.emit('messages', upsert.messages || []);
        } catch (err) {
          this.logger.error({ err }, 'messages.upsert handler failed');
        }
      });

      // Group membership changes (join/leave/promote/demote) — used by the
      // group-bot's Welcome/Goodbye/Autokick features. Event shape:
      // { id: groupJid, participants: string[], action: 'add'|'remove'|'promote'|'demote' }
      sock.ev.on('group-participants.update', (event) => {
        if (gen !== this.generation) return; // stale socket
        try {
          this.emit('group-participants-update', event);
        } catch (err) {
          this.logger.error({ err }, 'group-participants.update handler failed');
        }
      });

      // Incoming calls — used by the group-bot's Anticall feature. Support
      // for programmatically rejecting a call varies by fork (see
      // rejectCall() below); the event itself is standard.
      sock.ev.on('call', (calls) => {
        if (gen !== this.generation) return; // stale socket
        try {
          this.emit('call', calls || []);
        } catch (err) {
          this.logger.error({ err }, 'call handler failed');
        }
      });

      // Needed to confirm a delete-for-everyone actually reached the server
      // (as opposed to just not throwing on send) — see deleteMessageForEveryone.
      sock.ev.on('messages.update', (updates) => {
        if (gen !== this.generation) return; // stale socket
        try {
          this.emit('messages-update', updates || []);
        } catch (err) {
          this.logger.error({ err }, 'messages.update handler failed');
        }
      });

      sock.ev.on('connection.update', (update) => {
        if (gen !== this.generation) return; // stale socket
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
          // While a pairing-code request is pending for this socket, ignore
          // the QR entirely — showing it would flip the UI back to "scan QR"
          // mid-pairing even though the code is still on its way.
          if (!this.pendingPairingPhone) {
            this.qr = qr;
            this._setStatus('qr');
          }
        }
        if (connection === 'open') {
          this.qr = null;
          this.pendingPairingPhone = null;
          this.reconnectAttempt = 0;
          this._setStatus('open');
        } else if (connection === 'close') {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          this.lastDisconnectReason = statusCode ?? null;
          const loggedOut = statusCode === DisconnectReason.loggedOut;
          this.qr = null;
          this._setStatus(loggedOut ? 'loggedOut' : 'close');
          if (!loggedOut) {
            this._scheduleReconnect();
          }
        }
      });

      // Pairing code: the socket needs its websocket handshake open before
      // requestPairingCode() can send its stanza, so a single fixed delay is
      // fragile — slow networks miss the window and the request silently
      // never lands. Retry with backoff instead of one fire-and-forget shot.
      if (this.pendingPairingPhone && !state.creds.registered) {
        this._setStatus('pairing');
        this._requestPairingCodeWithRetry(sock, gen, this.pendingPairingPhone);
      }
    } finally {
      this.starting = false;
    }
  }

  /**
   * Requests a pairing code, retrying with backoff if the socket isn't
   * ready to send it yet (common on the first attempt right after connect).
   * Stops retrying once the socket is stale, a new pairing/QR flow has
   * superseded it, or attempts are exhausted.
   */
  async _requestPairingCodeWithRetry(sock, gen, phone, attempt = 0) {
    const MAX_ATTEMPTS = 5;
    const DELAY_MS = [1200, 2000, 3000, 4000, 5000];
    await new Promise((resolve) => setTimeout(resolve, DELAY_MS[Math.min(attempt, DELAY_MS.length - 1)]));
    if (gen !== this.generation || this.pendingPairingPhone !== phone) return; // superseded
    try {
      const code = await sock.requestPairingCode(phone);
      if (gen !== this.generation || this.pendingPairingPhone !== phone) return;
      this.pairingCode = code;
      this.pairingError = null;
      this.emit('pairing-code', code);
      this.emit('state'); // push the code to the dashboard right away (SSE conn-state)
    } catch (err) {
      if (gen !== this.generation || this.pendingPairingPhone !== phone) return;
      if (attempt + 1 < MAX_ATTEMPTS) {
        this.logger.warn({ err: String(err?.message || err), attempt }, 'pairing code request failed, retrying');
        return this._requestPairingCodeWithRetry(sock, gen, phone, attempt + 1);
      }
      this.logger.error({ err }, 'pairing code request failed after retries');
      this.pairingError = String(err?.message || err);
      this.emit('pairing-error', String(err?.message || err));
      this.emit('state');
    }
  }

  _scheduleReconnect() {
    // A manual reconnect (or a newer socket) may already be healthy — don't race it.
    if (['open', 'qr', 'pairing'].includes(this.connectionStatus)) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt += 1;
    this.logger.info({ delay, attempt: this.reconnectAttempt }, 'scheduling reconnect');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.logger.info('reconnecting…');
      this.start();
    }, delay);
    this.emit('reconnect-in', delay);
  }

  /** Ask the server for a 8-digit pairing code for the given phone number. */
  async requestPairingCode(phone) {
    if (this.sock?.authState?.creds?.registered) {
      throw new Error('Account is already registered/paired — no pairing code needed.');
    }
    // A socket that has already emitted a QR committed its handshake to
    // QR-based linking — requesting a pairing code on it afterwards either
    // throws or returns a code WhatsApp never accepts. The fix is to tear
    // that socket down and open a fresh one with the phone queued, which
    // reuses the same delayed-request path start() already uses for a
    // pairing-code-first connection.
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        /* noop */
      }
      this.sock = null;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempt = 0;
    this.qr = null;
    this.pairingCode = null;
    this.pairingError = null;
    this.connectionStatus = 'connecting';
    this.pendingPairingPhone = phone;
    await this.start();
    return { queued: true };
  }

  /** Manually re-start the connection (e.g. after a logout) to get a fresh QR. */
  async reconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {
        /* noop */
      }
      this.sock = null;
    }
    this.reconnectAttempt = 0;
    this.connectionStatus = 'connecting';
    this.qr = null;
    this.emit('state');
    await this.start();
  }

  /** Wipe the session so the next start shows a fresh QR. */
  async logout() {    if (this.sock) {
      try {
        await this.sock.logout();
      } catch (err) {
        this.logger.warn({ err }, 'logout() error (continuing)');
      }
      try {
        this.sock.end(undefined);
      } catch {
        /* noop */
      }
      this.sock = null;
    }
    clearTimeout(this.reconnectTimer);
    this.qr = null;
    this.connectionStatus = 'loggedOut';
    this.emit('state');
    // Remove persisted creds so a fresh QR is generated on next start.
    if (fs.existsSync(this.sessionDir)) {
      for (const file of fs.readdirSync(this.sessionDir)) {
        fs.rmSync(path.join(this.sessionDir, file), { force: true });
      }
    }
  }

  _assertOpen() {
    if (!this.sock || this.connectionStatus !== 'open') {
      throw new Error('WhatsApp is not connected (status: ' + this.connectionStatus + ').');
    }
  }

  /**
   * Fetch every group the account participates in, with permission detection:
   *  - `announce: true`  → "announcement" group — only admins can send messages
   *  - `isSelfAdmin`     → whether THIS account is an admin in that group
   *  - `broadcastable`   → derived: can this account actually post a status?
   *    (announce === false, i.e. open group) OR (announce === true AND isSelfAdmin)
   * @returns {Promise<Array<{jid:string,name:string,participants:number,announce:boolean,isSelfAdmin:boolean,broadcastable:boolean}>>}
   */
  async getGroups() {
    this._assertOpen();
    const all = await this.sock.groupFetchAllParticipating();
    const selfJids = selfIdentifiers(this.sock);
    if (this.logger?.level === 'debug') {
      this.logger.debug({ selfJids }, 'getGroups: self identifiers for admin matching');
    }
    return Object.values(all)
      .map((g) => {
        const announce = !!g.announce;
        const participants = g.participants || [];
        const me = participants.find((p) => jidMatchesAny(p.id, selfJids) || participantIdentifiers(p).some((id) => jidMatchesAny(id, selfJids)));
        const isSelfAdmin = !!me && (me.admin === 'admin' || me.admin === 'superadmin');
        if (this.logger?.level === 'debug' && !me) {
          this.logger.debug({ group: g.subject, participantIds: participants.map((p) => participantIdentifiers(p)) }, 'getGroups: self not found among participants for this group');
        }
        const broadcastable = !announce || isSelfAdmin;
        return {
          jid: g.id,
          name: g.subject || '(unnamed group)',
          participants: participants.length,
          announce,
          isSelfAdmin,
          broadcastable,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Group profile-picture URL (may be null if the group has no DP). */
  async getGroupDpUrl(jid) {
    this._assertOpen();
    try {
      return await this.sock.profilePictureUrl(jid, 'image');
    } catch {
      return null;
    }
  }

  /**
   * Set the group DP. Requires admin rights in the group.
   * @param {string} jid group jid
   * @param {Buffer} imageBuffer jpeg/png buffer
   */
  async setGroupDp(jid, imageBuffer) {
    this._assertOpen();
    await this.sock.updateProfilePicture(jid, imageBuffer);
  }

  /**
   * Leave a group. Requires the account to currently be a participant.
   * @param {string} jid group jid
   */
  async leaveGroup(jid) {
    this._assertOpen();
    await this.sock.groupLeave(jid);
  }

  /**
   * Restrict a group to admin-only sending ("announcement" group) or lift
   * that restriction. This is the one fully-reliable PREVENTIVE control —
   * once set, non-admins can't send anything at all (including a group
   * status), enforced by WhatsApp itself, not by watching-and-reacting.
   */
  async setGroupAnnounceOnly(jid, restrict) {
    this._assertOpen();
    await this.sock.groupSettingUpdate(jid, restrict ? 'announcement' : 'not_announcement');
  }

  /**
   * Admin delete-for-everyone, hardened for reliability.
   *
   * Honesty about verification: there is no reliable client-side signal that
   * a delete actually removed something from other members' phones — a send
   * that doesn't throw only means the server accepted the stanza, not that
   * it did anything visible. This was confirmed by live testing: the
   * 'standard' variant below reports success every time while the group
   * status keeps showing up for other members. Because of that, an earlier
   * version of this method returned as soon as one variant didn't throw —
   * which meant it never even attempted the other variants. That bug is
   * fixed: every variant is now attempted and reported, and "ok" only means
   * "the server didn't reject it", never "it's actually gone".
   *
   * Variants, in order:
   *  - standard: plain revoke to the group JID. Known to "succeed" (no
   *    throw) without removing the visible Updates-tab entry — kept mainly
   *    so its outcome is logged for comparison, not because it's expected
   *    to work.
   *  - group-status-revoke: the same revoke with the groupStatus flag
   *    re-asserted, for forks that branch on it during deletion.
   *  - status-broadcast-revoke: addresses the revoke to status@broadcast
   *    instead of the group JID — how real personal Stories are deleted.
   *    A "Group Status" renders in the Updates tab like a Story, which
   *    WhatsApp may track in that separate system rather than as a group
   *    chat message, regardless of which JID it was originally sent to.
   *    This is the variant most likely to actually affect what other
   *    members see, if any of them can.
   *
   * @returns {Promise<{ok:boolean, method:string|null, attempts:Array<{method:string, ok:boolean, error:string|null}>, error:string|null}>}
   *   ok      — true if AT LEAST ONE variant was accepted by the server
   *   method  — the LAST variant that was accepted (status-broadcast-revoke
   *             wins this slot if it succeeds, since it's tried last and is
   *             the most likely to matter)
   *   attempts — every variant's individual outcome, for the dashboard/log
   *   error   — set only if every variant failed
   */
  async deleteMessageForEveryone(jid, key) {
    this._assertOpen();
    if (!key?.id || !jid) {
      return { ok: false, method: null, attempts: [], error: 'missing message key/jid' };
    }
    // Admin delete-for-everyone of ANOTHER member's message requires the key
    // to carry that member's jid as `participant` with fromMe left false —
    // using the exact key we received off the wire already satisfies this,
    // but a manually-constructed key (e.g. in tests) can easily drop this
    // field, so we make sure it's present rather than trusting the caller.
    const fullKey = { ...key, remoteJid: jid, fromMe: !!key.fromMe };

    const isTransient = (err) => {
      const msg = String(err?.message || err || '').toLowerCase();
      return /timed?\s*out|timeout|network|econn|rate.?limit|temporar|unavailable|socket/.test(msg);
    };

    const variants = [
      { name: 'standard', content: { delete: fullKey } },
      { name: 'group-status-revoke', content: { delete: fullKey, groupStatus: true } },
      { name: 'status-broadcast-revoke', content: { delete: { ...fullKey, remoteJid: 'status@broadcast' } } },
    ];

    const attempts = [];
    let lastOkMethod = null;

    for (const variant of variants) {
      if (typeof this.sock?.sendMessage !== 'function') {
        attempts.push({ method: variant.name, ok: false, error: 'connected socket has no sendMessage capability' });
        continue;
      }
      // Deletes go to status@broadcast for this variant, not the group jid.
      const targetJid = variant.content.delete.remoteJid;
      let attempt = 0;
      let variantOk = false;
      let variantError = null;
      while (attempt < 2) { // initial try + one retry, transient errors only
        attempt += 1;
        try {
          await this.sock.sendMessage(targetJid, variant.content);
          variantOk = true;
          lastOkMethod = variant.name;
          break;
        } catch (err) {
          variantError = String(err?.message || err);
          if (attempt < 2 && isTransient(err)) {
            this.logger?.warn({ err, jid, id: fullKey.id, method: variant.name }, 'anti-status: transient delete error, retrying once');
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          break;
        }
      }
      attempts.push({ method: variant.name, ok: variantOk, error: variantOk ? null : variantError });
      this.logger?.info({ jid, id: fullKey.id, method: variant.name, ok: variantOk, error: variantError }, 'anti-status: delete variant attempted');
    }

    const anyOk = attempts.some((a) => a.ok);
    return {
      ok: anyOk,
      method: lastOkMethod,
      attempts,
      error: anyOk ? null : (attempts[attempts.length - 1]?.error || 'all delete variants failed'),
    };
  }

  /** Remove one participant from a group. Requires this account to be an admin there. */
  async removeParticipant(jid, participantJid) {
    this._assertOpen();
    return this.sock.groupParticipantsUpdate(jid, [participantJid], 'remove');
  }

  /** Add one participant to a group by phone-number JID. Requires this account to be an admin there. */
  async addParticipant(jid, participantJid) {
    this._assertOpen();
    return this.sock.groupParticipantsUpdate(jid, [participantJid], 'add');
  }

  /** Promote a participant to group admin. Requires this account to be an admin there. */
  async promoteParticipant(jid, participantJid) {
    this._assertOpen();
    return this.sock.groupParticipantsUpdate(jid, [participantJid], 'promote');
  }

  /** Demote a participant from group admin. Requires this account to be an admin there. */
  async demoteParticipant(jid, participantJid) {
    this._assertOpen();
    return this.sock.groupParticipantsUpdate(jid, [participantJid], 'demote');
  }

  /** This account's own jid, exactly as the socket reports it (may be a phone JID or, on newer sessions, an @lid). */
  getSelfJid() {
    return this.sock?.user?.id || null;
  }

  /**
   * Every identifier (id/jid/lid) WhatsApp's own participant record uses for
   * whichever member `participantJid` refers to in this group — not just the
   * one form it happened to arrive as. Needed because a message's
   * `key.participant` can show up as an opaque @lid pseudo-id in a group even
   * for an account whose real, dialable number you already know (e.g. the
   * hardcoded developer number) — matching bare digits against @lid then
   * always fails. Resolving through the group's participant list (which
   * usually carries both forms on the same record) finds the phone-number
   * form to match against instead. Falls back to `[participantJid]` (no
   * resolution possible) rather than throwing.
   */
  async getParticipantIdentifiers(jid, participantJid) {
    this._assertOpen();
    try {
      const metadata = await this.sock.groupMetadata(jid);
      for (const p of metadata.participants || []) {
        const ids = participantIdentifiers(p);
        if (ids.some((id) => jidMatchesAny(id, [participantJid]))) return ids;
      }
    } catch {
      /* fall through */
    }
    return [participantJid];
  }

  /** Every identifier (phone JID + @lid, where present) this account is currently known by. */
  getSelfIdentifiers() {
    return selfIdentifiers(this.sock);
  }

  /**
   * Robust "is this jid me?" check — matches a phone-number JID against an
   * @lid identifier and vice versa (same logic checkAdminStatus/getGroups
   * use), so the owner is still recognized even in a group where this
   * account's own participant record uses a different identifier form than
   * `sock.user.id` does. Used as a fallback by the group-bot's command
   * authorization on top of the primary `fromMe` check.
   */
  isSelfIdentifier(jid) {
    if (!jid || !this.sock) return false;
    return jidMatchesAny(jid, selfIdentifiers(this.sock));
  }

  /** Full raw group metadata: subject, description, owner, and every participant with their admin flag. */
  async getGroupMetadata(jid) {
    this._assertOpen();
    return this.sock.groupMetadata(jid);
  }

  /** Current group invite link (fetches the invite code and builds the full chat.whatsapp.com URL). */
  async getGroupInviteLink(jid) {
    this._assertOpen();
    const code = await this.sock.groupInviteCode(jid);
    return `https://chat.whatsapp.com/${code}`;
  }

  /** Revoke the current invite link and return the newly issued one. Requires admin rights. */
  async revokeGroupInviteLink(jid) {
    this._assertOpen();
    const code = await this.sock.groupRevokeInvite(jid);
    return `https://chat.whatsapp.com/${code}`;
  }

  /** Lock ('locked') or unlock ('unlocked') editing of the group's name/description/icon to admins only. */
  async setGroupInfoLocked(jid, locked) {
    this._assertOpen();
    await this.sock.groupSettingUpdate(jid, locked ? 'locked' : 'unlocked');
  }

  /**
   * Pending join requests for a group with membership-approval turned on in
   * WhatsApp itself. Not every fork/session exposes this — throws a clear
   * error instead of a cryptic one if it's unsupported.
   */
  async getJoinRequests(jid) {
    this._assertOpen();
    try {
      return (await this.sock.groupRequestParticipantsList(jid)) || [];
    } catch (e) {
      throw new Error('This session/fork does not support listing join requests: ' + (e?.message || e));
    }
  }

  async approveJoinRequest(jid, participantJid) {
    this._assertOpen();
    return this.sock.groupRequestParticipantsUpdate(jid, [participantJid], 'approve');
  }

  async rejectJoinRequest(jid, participantJid) {
    this._assertOpen();
    return this.sock.groupRequestParticipantsUpdate(jid, [participantJid], 'reject');
  }

  /** Send a plain text message, optionally @-mentioning the given jids (they must also appear as @digits in the text to render as a mention). */
  async sendText(jid, text, mentions = []) {
    this._assertOpen();
    return this.sock.sendMessage(jid, { text, mentions: mentions.length ? mentions : undefined });
  }

  /**
   * Edit a message this account sent earlier (used for the animated
   * status-purge progress message). Returns true/false, never throws — the
   * caller falls back to plain messages when a fork can't edit.
   */
  async editText(jid, key, text, mentions = []) {
    try {
      this._assertOpen();
      await this.sock.sendMessage(jid, { text, edit: key, mentions: mentions.length ? mentions : undefined });
      return true;
    } catch (err) {
      this.logger?.debug({ err: String(err?.message || err) }, 'editText failed');
      return false;
    }
  }

  /**
   * Interactive quick-reply buttons (itsliaaa/baileys `interactiveButtons`). If the fork/WhatsApp
   * rejects them, falls back to a plain text message so the member can still type the option.
   * buttons = [{ id, text }]. Returns the sent message (or null).
   */
  async sendButtons(jid, { text, footer, buttons = [], mentions = [] } = {}) {
    this._assertOpen();
    try {
      return await this.sock.sendMessage(jid, {
        text,
        footer: footer || undefined,
        mentions: mentions.length ? mentions : undefined,
        interactiveButtons: buttons.map((b) => ({
          name: 'quick_reply',
          buttonParamsJson: JSON.stringify({ display_text: b.text, id: b.id }),
        })),
      });
    } catch (err) {
      this.logger?.debug({ err: String(err?.message || err) }, 'sendButtons failed — using plain text');
      return this.sock.sendMessage(jid, { text, mentions: mentions.length ? mentions : undefined });
    }
  }

  /** Delete one of THIS account's own messages for everyone. Never throws. */
  async deleteOwnMessage(jid, key) {
    try {
      this._assertOpen();
      await this.sock.sendMessage(jid, { delete: { ...key, remoteJid: jid, fromMe: true } });
      return true;
    } catch (err) {
      this.logger?.debug({ err: String(err?.message || err) }, 'deleteOwnMessage failed');
      return false;
    }
  }

  /** Send a file as a WhatsApp document message. */
  async sendDocument(jid, { buffer, fileName, mimetype = 'application/pdf', caption, quoted } = {}) {
    this._assertOpen();
    return this.sock.sendMessage(
      jid,
      { document: buffer, mimetype, fileName, caption: caption || undefined },
      quoted ? { quoted } : undefined
    );
  }

  /** Send an image (by URL or buffer) with an optional caption that can @-mention members. */
  async sendImage(jid, { url, buffer, caption, mentions = [], quoted } = {}) {
    this._assertOpen();
    return this.sock.sendMessage(
      jid,
      { image: buffer || { url }, caption: caption || undefined, mentions: mentions.length ? mentions : undefined },
      quoted ? { quoted } : undefined
    );
  }

  /**
   * Best-effort call rejection for the Anticall feature. Whether a fork
   * exposes a way to programmatically reject a call at all varies — this
   * never throws; it returns false when unsupported so the caller can log
   * it once instead of crashing the call handler on every incoming call.
   */
  async rejectCall(callId, callFrom) {
    this._assertOpen();
    if (typeof this.sock.rejectCall !== 'function') return false;
    try {
      await this.sock.rejectCall(callId, callFrom);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fresh (non-cached) admin check for one participant in one group — used
   * right before a moderation action so a stale group-list snapshot can
   * never cause an action to be taken (or skipped) on outdated information.
   * @returns {Promise<{ selfIsAdmin: boolean, targetIsAdmin: boolean, targetIsMember: boolean, groupName: string }>}
   */
  async checkAdminStatus(jid, targetJid) {
    this._assertOpen();
    const metadata = await this.sock.groupMetadata(jid);
    const selfJids = selfIdentifiers(this.sock);
    const participants = metadata.participants || [];
    let selfIsAdmin = false;
    let targetIsAdmin = false;
    let targetIsMember = false;
    for (const p of participants) {
      const ids = participantIdentifiers(p);
      const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
      if (ids.some((id) => jidMatchesAny(id, selfJids))) selfIsAdmin = isAdmin;
      if (targetJid && ids.some((id) => jidMatchesAny(id, [targetJid]))) {
        targetIsMember = true; // distinct from targetIsAdmin: true even when the match isn't an admin
        targetIsAdmin = isAdmin;
      }
    }
    if (this.logger?.level === 'debug') {
      this.logger.debug({ jid, selfJids, selfIsAdmin, targetJid, targetIsAdmin, targetIsMember, participantIds: participants.map((p) => participantIdentifiers(p)) }, 'checkAdminStatus result');
    }
    return { selfIsAdmin, targetIsAdmin, targetIsMember, groupName: metadata.subject || jid };
  }

  /**
   * Raw diagnostic dump for one group: every identifier this account's own
   * socket exposes for itself, and every participant's raw id/jid/lid/admin
   * fields exactly as the library returns them — no matching logic applied.
   * Exists purely so a mismatch (e.g. self shown under a JID format the
   * group's participant list doesn't use) can be diagnosed precisely instead
   * of guessed at. Safe to expose: it's this account's own data, already
   * behind the panel login.
   */
  async debugGroupIdentity(jid) {
    this._assertOpen();
    const metadata = await this.sock.groupMetadata(jid);
    return {
      groupName: metadata.subject || jid,
      self: { id: this.sock.user?.id || null, lid: this.sock.user?.lid || null },
      participants: (metadata.participants || []).map((p) => ({ id: p.id || null, jid: p.jid || null, lid: p.lid || null, admin: p.admin ?? null })),
    };
  }

  /**
   * POST A REAL GROUP STATUS.
   *
   * Primary mechanism — the REAL WhatsApp Group Status:
   *   { groupStatusMessageV2: { message: { imageMessage|videoMessage|extendedTextMessage } } }
   * relayed to the group JID with contextInfo.isGroupStatus + <meta is_group_status="true"/>.
   *
   * @param {object} opts
   * @param {string} opts.jid group jid
   * @param {string} [opts.mediaPath] path to image/video file on disk
   * @param {'image'|'video'|'text'} opts.mediaType
   * @param {string} [opts.mimetype]
   * @param {string} [opts.caption]
   * @param {string} [opts.text]
   * @param {string} [opts.backgroundColor] hex color string e.g. '#008069'
   * @param {number} [opts.font]
   * @returns {Promise<{messageId:string}>}
   */
  async postGroupStatus({ jid, mediaBuffer, mediaPath, mediaType, mimetype, caption, text, backgroundColor, font }) {
    this._assertOpen();
    let content;
    const hasMedia = mediaBuffer || mediaPath;
    if (mediaType === 'text' || (!hasMedia && text)) {
      content = {
        text: text || caption,
        backgroundColor: backgroundColor || undefined,
        font: font ? Number(font) : undefined,
      };
    } else if (mediaType === 'video') {
      content = { video: mediaBuffer || { url: mediaPath }, caption: caption || undefined, mimetype };
    } else {
      content = { image: mediaBuffer || { url: mediaPath }, caption: caption || undefined, mimetype };
    }

    const msg = await this.sock.sendMessage(jid, {
      ...content,
      groupStatus: true, // → groupStatusMessageV2 wrapper (+ isGroupStatus + is_group_status meta)
    });
    return { messageId: msg?.key?.id || null, jid };
  }

  /**
   * DIAGNOSTIC ONLY — NOT the group-status mechanism.
   *
   * Posts a plain PERSONAL status restricted to the members of the group
   * (status@broadcast + statusJidList).
   */
  async postDiagnosticStatus({ jid, mediaBuffer, mediaPath, mediaType, mimetype, caption, text, backgroundColor, font }) {
    this._assertOpen();
    const metadata = await this.sock.groupMetadata(jid);
    const members = (metadata.participants || []).map((p) => p.id);
    let content;
    const hasMedia = mediaBuffer || mediaPath;
    if (mediaType === 'text' || (!hasMedia && text)) {
      content = {
        text: text || caption,
        backgroundColor: backgroundColor || undefined,
        font: font ? Number(font) : undefined,
      };
    } else if (mediaType === 'video') {
      content = { video: mediaBuffer || { url: mediaPath }, caption: caption || undefined, mimetype };
    } else {
      content = { image: mediaBuffer || { url: mediaPath }, caption: caption || undefined, mimetype };
    }

    const msg = await this.sock.sendMessage('status@broadcast', content, {
      broadcast: true,
      statusJidList: members,
    });
    return { messageId: msg?.key?.id || null, jid, audience: members.length };
  }
}
