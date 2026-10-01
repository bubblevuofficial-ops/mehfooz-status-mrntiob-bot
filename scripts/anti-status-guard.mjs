#!/usr/bin/env node
/**
 * Anti-Status Guard — standalone command.
 *
 * Runs the same moderation logic as the dashboard's Anti-Status tab
 * (src/moderation.js), but as its own lightweight process with no web UI —
 * for running in the background (pm2, a systemd service, a plain
 * `node scripts/anti-status-guard.mjs &`) without the full panel open.
 *
 * It shares two things with the main panel, so either can configure it:
 *   - the same session directory (SESSION_DIR) — so it logs in as the same
 *     WhatsApp account, once already linked
 *   - the same config file (DATA_DIR/anti-status-config.json) — so groups
 *     you enable from the dashboard's Anti-Status tab apply here too, and
 *     vice versa
 *
 * ⚠️  IMPORTANT: run this OR the main panel (`npm start`) against a given
 * session directory — never both AT THE SAME TIME. WhatsApp/Baileys only
 * supports one active connection per linked session; two processes racing
 * to write the same session files will conflict and disconnect each other.
 * If you want moderation running standalone, either:
 *   (a) don't run `npm start` while this is running, or
 *   (b) link a second device (a separate SESSION_DIR) just for this script,
 *       independent of the main panel.
 *
 * First-time login: this script has no web page to show a QR code on, so
 * the practical path is: `npm start` once, link via QR or pairing code in
 * the browser, stop the panel, then run this script — it reuses the same
 * ./session automatically. If you'd rather link directly from here instead,
 * it will prompt you for a phone number and print a pairing code to the
 * terminal when no session exists yet.
 *
 * Usage:
 *   node scripts/anti-status-guard.mjs
 *   npm run anti-status
 */
import path from 'node:path';
import readline from 'node:readline';
import fs from 'node:fs';
import dotenv from 'dotenv';
import pino from 'pino';
import { WhatsAppClient } from '../src/wa-client.js';
import { AntiStatusGuard } from '../src/moderation.js';

dotenv.config();

const SESSION_DIR = path.resolve(process.env.SESSION_DIR || './session');
const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const CONFIG_PATH = path.join(DATA_DIR, 'anti-status-config.json');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});

function askPhone() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('No existing session found. Enter your WhatsApp number (international format, digits only, e.g. 923001234567): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const hasExistingSession = fs.existsSync(SESSION_DIR) && fs.readdirSync(SESSION_DIR).length > 0;

  const wa = new WhatsAppClient({ sessionDir: SESSION_DIR, logger });
  const guard = new AntiStatusGuard(wa, { configPath: CONFIG_PATH, logger });

  guard.on('action', (result) => {
    logger.info(result, '🛡️  anti-status action taken');
  });

  wa.on('pairing-code', (code) => {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('  Pairing code: ' + code);
    logger.info('  Enter this in WhatsApp → Linked Devices → Link a Device → Link with phone number');
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
  wa.on('pairing-error', (err) => logger.warn({ err }, 'pairing failed'));
  wa.on('state', () => {
    if (wa.connectionStatus === 'open') {
      const cfg = guard.reloadConfig();
      const groupCount = Object.keys(cfg.groups || {}).length;
      logger.info(
        { enabled: cfg.enabled, groupsEnabled: groupCount },
        cfg.enabled
          ? `Connected. Watching ${groupCount} group(s) for Anti-Status violations.`
          : 'Connected, but Anti-Status is currently OFF in config — enable it from the dashboard\'s Anti-Status tab, or edit ' + CONFIG_PATH + ' directly ({"enabled": true, ...}).'
      );
    } else if (wa.connectionStatus === 'qr') {
      logger.info('QR code ready — this standalone command has no page to show it on. Either run `npm start` once to link via the browser, then come back here, or wait for a pairing-code prompt instead.');
    }
  });

  if (!hasExistingSession) {
    const phone = await askPhone();
    if (phone) {
      await wa.requestPairingCode(phone).catch((err) => logger.error({ err }, 'failed to request pairing code'));
    }
  }

  logger.info('Anti-Status Guard (standalone) starting — session: ' + SESSION_DIR + ' · config: ' + CONFIG_PATH);
  await wa.start();

  const shutdown = () => {
    logger.info('Shutting down Anti-Status Guard...');
    guard.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
