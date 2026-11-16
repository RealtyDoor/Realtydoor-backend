/**
 * Prints what every Clerk instance must look like (src/config/clerkManifest.js) as a checklist to apply in the dashboard and tick.
 *   node scripts/printClerkChecklist.js            # the full list
 *   node scripts/printClerkChecklist.js --risks    # only the points that still need proof
 * Clerk's dashboard cannot be edited from code, so this is the single written spec; a test keeps it in step with the code.
 */
const m = require('../src/config/clerkManifest');

const onlyRisks = process.argv.includes('--risks');
console.log(`Clerk checklist for "${m.application.name}" (${m.application.type}). Plan: ${m.application.plan}.\n`);
let area = '';
for (const s of m.settings.filter((x) => !onlyRisks || x.risk)) {
  if (s.area !== area) { area = s.area; console.log(`\n${area}`); }
  console.log(`  [ ] ${s.setting}: ${s.value}   (${s.source})`);
  if (s.note) console.log(`        ${s.note}`);
  if (s.risk) console.log(`        RISK: ${s.risk}`);
}
if (!onlyRisks) {
  console.log('\nRedirect paths (the website reads these from its environment):');
  for (const [k, v] of Object.entries(m.paths)) console.log(`  ${k}=${v}`);
  console.log(`\nOur signup sends these fields to Clerk: ${m.createUserFields.join(', ')}.`);
  console.log(`Roles mirrored in public metadata: ${m.roles.join(', ')} (the database is the authority).`);
}
