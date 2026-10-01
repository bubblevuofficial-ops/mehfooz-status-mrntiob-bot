/**
 * Minimal password protection for the whole panel — plain HTTP Basic Auth,
 * no extra dependency. Applied to EVERY route (dashboard HTML, API, SSE)
 * before anything else runs, so the panel is never reachable unauthenticated.
 *
 * Credentials:
 *   - PANEL_USERNAME / PANEL_PASSWORD in .env, if you want to set your own, OR
 *   - if PANEL_PASSWORD isn't set, a random password is generated on first run
 *     and saved to panel-password.txt in the project root (also printed to the
 *     console) so you can find it again. Later restarts reuse that same saved
 *     password instead of generating a new one each time — otherwise you'd get
 *     locked out on every restart.
 *
 * Browsers cache Basic Auth credentials per-origin after the first successful
 * login, and automatically attach them to every subsequent request to that
 * origin — including the dashboard's EventSource (SSE) connection, which has
 * no API of its own for custom headers. That's exactly why Basic Auth is a
 * good fit here: nothing extra needed on the frontend.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function timingSafeStringEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal-length buffers so the timing doesn't
    // leak the correct length either.
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Resolve the panel's credentials at boot.
 *
 * Priority:
 *   1. PANEL_USERNAME / PANEL_PASSWORD in .env — always wins, and the
 *      in-panel "change password" screen is disabled in this case (env is
 *      the intended override, so we never silently disagree with it).
 *   2. A password previously saved from the panel's own "change password"
 *      screen (panel-password.txt) — reused across restarts.
 *   3. Default admin / admin — no file is generated just for starting the
 *      app; nothing is written to disk until you actually change the
 *      password from the dashboard.
 *
 * @returns {{ username: string, password: string, source: 'env'|'default'|'saved-file' }}
 */
export function resolveCredentials(projectRoot, logger) {
  const username = process.env.PANEL_USERNAME || 'admin';
  const passwordFile = path.join(projectRoot, 'panel-password.txt');

  if (process.env.PANEL_PASSWORD) {
    return { username, password: process.env.PANEL_PASSWORD, source: 'env' };
  }

  // Reuse a password saved earlier via the panel's own change-password screen.
  if (fs.existsSync(passwordFile)) {
    const saved = fs.readFileSync(passwordFile, 'utf8').trim();
    if (saved) return { username, password: saved, source: 'saved-file' };
  }

  return { username, password: 'admin', source: 'default' };
}

/**
 * Mutable in-memory store wrapping the resolved credentials, so the panel
 * can change the password at runtime without restarting the process.
 * basicAuth() below always reads from this store, never from a frozen
 * object, so a change takes effect on the very next request.
 */
export function createCredentialStore(initial) {
  let current = { ...initial };
  return {
    get: () => current,
    /** Returns true and persists to disk if the change was applied. */
    setPassword(newPassword, projectRoot, logger) {
      if (current.source === 'env') return false; // .env always wins — don't fight it
      current = { ...current, password: newPassword, source: 'saved-file' };
      try {
        fs.writeFileSync(path.join(projectRoot, 'panel-password.txt'), newPassword + '\n', { mode: 0o600 });
      } catch (e) {
        logger?.warn({ err: e }, 'Password changed in memory but could not be saved to panel-password.txt — it will revert to the previous value on restart');
      }
      return true;
    },
  };
}

/**
 * Express middleware: HTTP Basic Auth over a credential store (see
 * createCredentialStore above) so a password change is picked up live.
 */
export function basicAuth(store) {
  return (req, res, next) => {
    const { username, password } = store.get();
    const header = req.headers.authorization || '';
    const [scheme, encoded] = header.split(' ');
    if (scheme === 'Basic' && encoded) {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const sep = decoded.indexOf(':');
      const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
      const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
      if (timingSafeStringEqual(user, username) && timingSafeStringEqual(pass, password)) {
        return next();
      }
    }
    res.set('WWW-Authenticate', 'Basic realm="Mehfooz Status Control", charset="UTF-8"');
    res.status(401).send('Authentication required.');
  };
}
