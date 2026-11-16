/**
 * Writes .env.example and the settings table of the release runbook from the one list of settings (src/config/productionSpec.js).
 *   node scripts/genConfigDocs.js          # writes both
 *   node scripts/genConfigDocs.js --check  # writes nothing; exit 1 if either file differs from what the spec says (used by a test)
 * The runbook is in the other repository (../../admin-nextjs); when it is not there, only .env.example is handled.
 */
const fs = require('fs');
const path = require('path');
const { renderEnvExample, renderRunbookTable, replaceBlock } = require('../src/config/renderConfigDocs');

const CHECK = process.argv.includes('--check');
const envFile = path.join(__dirname, '..', '.env.example');
const runbook = path.join(__dirname, '../../../admin-nextjs/docs/production-release-runbook.md');

let stale = 0;
function handle(file, next, label) {
  const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (now === next) { console.log(`ok       ${label}`); return; }
  if (CHECK) { stale += 1; console.log(`DIFFERS  ${label}`); return; }
  fs.writeFileSync(file, next);
  console.log(`written  ${label}`);
}

handle(envFile, renderEnvExample() + '\n', '.env.example');
if (fs.existsSync(runbook)) {
  const md = fs.readFileSync(runbook, 'utf8');
  const next = replaceBlock(md, renderRunbookTable());
  if (next === null) { console.log('skipped  runbook (no spec:begin / spec:end markers)'); } else handle(runbook, next, 'production-release-runbook.md');
} else console.log('skipped  runbook (other repository not found)');

if (CHECK && stale) { console.error('Run `node scripts/genConfigDocs.js` and commit the result.'); process.exitCode = 1; }
