/**
 * Minimal history store — append-only JSON file, capped at MAX_ENTRIES.
 * Deliberately simple: no database, no external deps. Good enough for a
 * single-user local tool; swap for SQLite later if you need more.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_ENTRIES = 200;

export class HistoryStore {
  /** @param {string} filePath */
  constructor(filePath) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, '[]', 'utf8');
    }
  }

  _readAll() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /** Newest first. */
  list(limit = MAX_ENTRIES) {
    return this._readAll().slice(0, limit);
  }

  get(id) {
    return this._readAll().find((e) => e.id === id) || null;
  }

  /**
   * @param {object} entry {id, kind, startedAt, finishedAt, durationMs, total, success, failed, unavailable, mode, items}
   */
  add(entry) {
    const all = this._readAll();
    all.unshift(entry);
    const trimmed = all.slice(0, MAX_ENTRIES);
    fs.writeFileSync(this.filePath, JSON.stringify(trimmed, null, 0), 'utf8');
    return entry;
  }
}
