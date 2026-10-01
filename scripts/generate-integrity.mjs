#!/usr/bin/env node
/**
 * Regenerates integrity.json from the current contents of the protected
 * files. Run this after any legitimate edit to src/server.js, src/wa-client.js,
 * src/history.js, src/integrity.js, or package.json's dependencies.
 *
 *   npm run integrity:generate
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeManifest, PROTECTED_FILES } from '../src/integrity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const manifest = computeManifest(projectRoot);
const out = { generatedAt: new Date().toISOString(), ...manifest };

fs.writeFileSync(path.join(projectRoot, 'integrity.json'), JSON.stringify(out, null, 2) + '\n');

console.log('integrity.json written:');
for (const rel of PROTECTED_FILES) {
  console.log('  ' + rel + '  ' + (manifest.files[rel] ? manifest.files[rel].slice(0, 12) + '…' : 'MISSING'));
}
console.log('  package.json deps  ' + manifest.dependenciesHash.slice(0, 12) + '…');
