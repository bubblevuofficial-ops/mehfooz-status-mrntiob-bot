/**
 * Configurable credit / branding store (replaces the old hard-coded credit).
 *
 * One small JSON file (DATA_DIR/branding.json) shared by the dashboard, the
 * command menu, and the Anti-Status messages. Edit it from the dashboard's
 * "Credits" tab — changes apply immediately (file is re-read when it changes).
 *
 *   entries    : [{ id, name, role }]  — any people/names you want listed
 *   primaryId  : which entry is THE displayed credit ("Powered by …")
 *   showCredit : master switch — false hides the credit everywhere
 *   tagline    : optional short line under the name (e.g. a team/brand)
 *
 * Text templates (Anti-Status messages) may use:
 *   {poweredBy} → "Powered by <name>." (or nothing when credit is hidden)
 *   {credit}    → just the name
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_BRANDING = () => ({
  showCredit: true,
  tagline: 'Chishti Brothers',
  primaryId: 'c-brand',
  entries: [
    { id: 'c-brand', name: 'Saif Chishti', role: 'Brand' },
    { id: 'c-dev', name: 'Mehfooz Ahmad', role: 'Developer' },
  ],
});

const MAX_ENTRIES = 20;
const clip = (v, n) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, n);

/** Validates/normalizes any input into a safe branding object. */
export function sanitizeBranding(input) {
  const base = DEFAULT_BRANDING();
  const src = input && typeof input === 'object' ? input : {};
  const seen = new Set();
  const entries = (Array.isArray(src.entries) ? src.entries : base.entries)
    .slice(0, MAX_ENTRIES)
    .map((e) => ({
      id: clip(e?.id, 40) || 'c-' + crypto.randomBytes(4).toString('hex'),
      name: clip(e?.name, 60),
      role: clip(e?.role, 60),
    }))
    .filter((e) => e.name && !seen.has(e.id) && seen.add(e.id));
  const primaryId = entries.some((e) => e.id === src.primaryId) ? src.primaryId : entries[0]?.id || '';
  return {
    showCredit: typeof src.showCredit === 'boolean' ? src.showCredit : true,
    tagline: clip(src.tagline ?? base.tagline, 80),
    primaryId,
    entries,
  };
}

const cache = new Map(); // file -> { mtimeMs, data }

function fileFor(dir) {
  return path.join(dir, 'branding.json');
}

export function getBranding(dir) {
  const file = fileFor(dir);
  try {
    const st = fs.statSync(file);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    const data = sanitizeBranding(JSON.parse(fs.readFileSync(file, 'utf8')));
    cache.set(file, { mtimeMs: st.mtimeMs, data });
    return data;
  } catch {
    return sanitizeBranding(null); // missing/corrupt file → defaults, never throws
  }
}

export function saveBranding(dir, input) {
  const data = sanitizeBranding(input);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(fileFor(dir), JSON.stringify(data, null, 2) + '\n', 'utf8');
  cache.delete(fileFor(dir));
  return data;
}

/** The displayed credit name, or '' when hidden / no entries. */
export function creditName(dir) {
  const b = getBranding(dir);
  if (!b.showCredit) return '';
  return (b.entries.find((e) => e.id === b.primaryId) || b.entries[0])?.name || '';
}

/** Fills {poweredBy} / {credit} in a message template. */
export function renderCredit(text, dir) {
  const name = creditName(dir);
  return String(text ?? '')
    .replace(/\{poweredBy\}/g, name ? `Powered by ${name}.` : '')
    .replace(/\{credit\}/g, name)
    .trimEnd();
}
