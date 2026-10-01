/**
 * Lightweight tamper/integrity check for protected core files.
 *
 * How it works:
 *  - `integrity.json` (checked into the project root) stores a sha256 hash of
 *    each protected source file, plus a separate hash of just the
 *    `dependencies` object in package.json (so bumping the version/name/
 *    description doesn't trip it, but a swapped-in dependency does).
 *  - At startup, and on every poll of GET /api/integrity, `checkIntegrity()`
 *    recomputes the same hashes and compares.
 *
 * Important distinction — this only BLOCKS sensitive routes (broadcast/bulk/
 * leave/set-DP) when it has POSITIVE evidence a protected file's content
 * actually changed (a real hash mismatch). Anything short of that — the
 * manifest is missing, a file briefly couldn't be read (e.g. the process hit
 * an OS file-descriptor limit under load — very possible on constrained
 * environments like Termux/Android during a large broadcast), a corrupted
 * manifest — is surfaced as a non-blocking warning instead. Treating "we
 * couldn't verify right now" the same as "confirmed altered" caused false
 * lockouts during ordinary heavy use, which defeats the point of the check.
 *
 * result.blocking is what requireIntegrity() actually gates on.
 *
 * After a LEGITIMATE code change, regenerate the manifest with:
 *   npm run integrity:generate
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Files whose exact bytes are protected. Paths are relative to the project root.
export const PROTECTED_FILES = [
  'src/server.js',
  'src/wa-client.js',
  'src/history.js',
  'src/integrity.js',
  'src/auth.js',
  'src/moderation.js',
  'src/groupBot.js',
];

function sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256Deps(packageJsonAbsPath) {
  const pkg = JSON.parse(fs.readFileSync(packageJsonAbsPath, 'utf8'));
  const deps = pkg.dependencies || {};
  // Sort keys so unrelated formatting/order changes never cause a false mismatch.
  const sorted = Object.keys(deps)
    .sort()
    .reduce((acc, k) => ((acc[k] = deps[k]), acc), {});
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function stripBom(raw) {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * Compute the current manifest for this checkout (used both to verify and
 * to generate a fresh integrity.json). Per-file read errors are captured
 * rather than thrown, so one bad file doesn't abort the whole check.
 */
export function computeManifest(projectRoot) {
  const files = {};
  const errors = {};
  for (const rel of PROTECTED_FILES) {
    const abs = path.join(projectRoot, rel);
    try {
      files[rel] = fs.existsSync(abs) ? sha256File(abs) : null;
    } catch (e) {
      files[rel] = undefined; // could not verify — distinct from "confirmed missing" (null)
      errors[rel] = e.code || e.message;
    }
  }
  let dependenciesHash = null;
  try {
    dependenciesHash = sha256Deps(path.join(projectRoot, 'package.json'));
  } catch (e) {
    errors['package.json'] = e.code || e.message;
  }
  return { files, dependenciesHash, errors };
}

/**
 * Compare the current checkout against integrity.json.
 * @returns {{
 *   ok: boolean,            // true only when fully verified clean
 *   blocking: boolean,      // true only on a CONFIRMED content mismatch — this is what gates sensitive routes
 *   manifestFound: boolean,
 *   mismatches: string[],   // files whose hash is confirmed to differ from the baseline
 *   missing: string[],      // files confirmed absent
 *   unverifiable: string[], // files/manifest that could not be checked right now (transient)
 * }}
 */
export function checkIntegrity(projectRoot) {
  const manifestPath = path.join(projectRoot, 'integrity.json');

  if (!fs.existsSync(manifestPath)) {
    return { ok: false, blocking: false, manifestFound: false, mismatches: [], missing: [], unverifiable: [] };
  }

  let expected;
  try {
    const raw = stripBom(fs.readFileSync(manifestPath, 'utf8')).trim();
    expected = JSON.parse(raw);
  } catch (e) {
    // Can't read/parse the baseline itself — we simply can't verify anything
    // right now. Not evidence of tampering in the protected files.
    return {
      ok: false,
      blocking: false,
      manifestFound: true,
      mismatches: [],
      missing: [],
      unverifiable: ['integrity.json (' + (e.code || 'unreadable/corrupt') + ': ' + e.message + ')'],
    };
  }

  const current = computeManifest(projectRoot);
  const mismatches = [];
  const missing = [];
  const unverifiable = [];

  for (const rel of PROTECTED_FILES) {
    const exp = expected.files?.[rel];
    const cur = current.files[rel];
    if (cur === undefined) unverifiable.push(rel + ' (' + (current.errors[rel] || 'read error') + ')');
    else if (cur === null) missing.push(rel);
    else if (exp && exp !== cur) mismatches.push(rel);
  }
  if (current.dependenciesHash === null) {
    unverifiable.push('package.json (' + (current.errors['package.json'] || 'read error') + ')');
  } else if (expected.dependenciesHash && expected.dependenciesHash !== current.dependenciesHash) {
    mismatches.push('package.json (dependencies)');
  }

  const blocking = mismatches.length > 0 || missing.length > 0; // confirmed change or confirmed deletion — not a merely-unverifiable read
  const ok = blocking === false && missing.length === 0 && unverifiable.length === 0;

  return { ok, blocking, manifestFound: true, mismatches, missing, unverifiable };
}

/**
 * Express middleware factory: blocks a route only on a CONFIRMED integrity
 * violation (status.blocking === true) — never on a merely-unverifiable state,
 * since that's not evidence anything was altered.
 * @param {() => {blocking:boolean}} getStatus  a function returning the latest check result
 */
export function requireIntegrity(getStatus) {
  return (req, res, next) => {
    const status = getStatus();
    if (status.blocking) {
      return res.status(503).json({
        error:
          'Core integrity check failed — a protected file\'s content does not match its baseline. ' +
          'This action is disabled until it is resolved. See GET /api/integrity for details.',
        integrity: status,
      });
    }
    next();
  };
}
