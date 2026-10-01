/**
 * Entry point for panel-style hosts (Katabump / Pterodactyl, etc.) that expect
 * a root-level `index.js` to start the app. It does nothing but load the real
 * server — no logic lives here, so nothing about the app's behaviour changes.
 */
import './src/server.js';
