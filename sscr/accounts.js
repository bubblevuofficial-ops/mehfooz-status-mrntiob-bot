/**
 * Extra WhatsApp numbers ("multi-number") for the same board.
 *
 * The main number (session/) keeps working exactly as before. Every extra number added here gets its OWN
 * WhatsApp session + its OWN GroupBot, so the welcome / moderation / course-file features run in every group
 * of every linked number. Settings are shared (same group-bot-config.json), so a group configured once works
 * no matter which of your numbers is in it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WhatsAppClient } from './wa-client.js';
import { GroupBot } from './groupBot.js';

export class AccountManager {
  constructor({ dataDir, logger, groupBotOpts }) {
    this.dataDir = dataDir;
    this.logger = logger;
    this.groupBotOpts = groupBotOpts; // { configPath, warningsPath, activityLog }
    this.file = path.join(dataDir, 'accounts.json');
    this.accounts = new Map(); // id -> { id, label, wa, bot }
  }

  _readList() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
  }
  _writeList() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const list = [...this.accounts.values()].map((a) => ({ id: a.id, label: a.label }));
    fs.writeFileSync(this.file, JSON.stringify(list, null, 2), 'utf8');
  }

  _spawn(id, label) {
    const sessionDir = path.join(this.dataDir, 'accounts', id, 'session');
    const wa = new WhatsAppClient({ sessionDir, logger: this.logger.child ? this.logger.child({ account: id }) : this.logger });
    const bot = new GroupBot(wa, { ...this.groupBotOpts, logger: this.logger });
    bot.start();
    wa.start().catch((err) => this.logger.error({ err, id }, 'extra account failed to start'));
    this.accounts.set(id, { id, label, wa, bot });
    return this.accounts.get(id);
  }

  /** Re-start every saved extra number at boot. */
  loadAll() {
    for (const a of this._readList()) {
      try { this._spawn(a.id, a.label); } catch (err) { this.logger.error({ err, id: a.id }, 'could not restore extra account'); }
    }
  }

  add(label) {
    const id = crypto.randomBytes(4).toString('hex');
    this._spawn(id, String(label || '').trim().slice(0, 40) || `Number ${this.accounts.size + 2}`);
    this._writeList();
    return id;
  }

  get(id) {
    const a = this.accounts.get(id);
    if (!a) throw new Error('No such number');
    return a;
  }

  async remove(id) {
    const a = this.get(id);
    try { await a.wa.logout(); } catch { /* already logged out */ }
    try { a.bot.stop(); } catch { /* noop */ }
    this.accounts.delete(id);
    this._writeList();
    fs.rmSync(path.join(this.dataDir, 'accounts', id), { recursive: true, force: true });
  }

  /** All groups from every CONNECTED extra number (jid → group), for "apply to all groups". */
  async allExtraGroups() {
    const out = [];
    for (const a of this.accounts.values()) {
      if (a.wa.connectionStatus !== 'open') continue;
      try { out.push(...(await a.wa.getGroups())); } catch { /* skip */ }
    }
    return out;
  }
}
