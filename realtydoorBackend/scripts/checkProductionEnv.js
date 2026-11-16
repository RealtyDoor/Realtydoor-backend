/**
 * Checks a real environment against the one list of settings (src/config/productionSpec.js) before a deploy. Reads only; prints no value.
 *
 *   node scripts/checkProductionEnv.js --file path/to/api.env                       # API settings, real-launch bar
 *   node scripts/checkProductionEnv.js --file web.env --scope web                   # website settings
 *   node scripts/checkProductionEnv.js --file api.env --profile boot                # only what the server itself enforces
 *   node scripts/checkProductionEnv.js --env                                        # the variables of this shell instead of a file
 *
 * Profiles: "launch" (default) is the real production bar: live key prefixes, https addresses, nothing for local testing set.
 * "boot" is only what a production-mode server refuses to start without (a staging run with test payments passes it).
 * Exit code 1 if anything fails, so a deploy step can stop on it.
 */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { SPEC, check, present, productionRule } = require('../src/config/productionSpec');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : d; };
const profile = arg('--profile', 'launch');
const scope = arg('--scope', 'backend');
if (!['boot', 'launch'].includes(profile) || !['backend', 'web'].includes(scope)) { console.error('Use --profile boot|launch and --scope backend|web.'); process.exit(2); }

let env;
if (process.argv.includes('--env')) env = process.env;
else {
  const file = arg('--file');
  if (!file) { console.error('Give --file <env file> (or --env to read this shell).'); process.exit(2); }
  env = dotenv.parse(fs.readFileSync(path.resolve(file)));
}

// A deploy file that does not say NODE_ENV is judged as production (that is what it is for).
const production = (env.NODE_ENV || 'production') === 'production';
const problems = check({ NODE_ENV: 'production', ...env }, { profile, scope, production });
const byKey = new Map();
for (const p of problems) { if (!byKey.has(p.key) || p.level === 'fail') byKey.set(p.key, p); }

let fails = 0; let warns = 0;
for (const s of SPEC.filter((x) => x.scope === scope)) {
  const p = byKey.get(s.key);
  const v = env[s.key];
  const shown = !present(v) ? 'not set' : (s.secret ? `set (${String(v).length} characters)` : 'set');
  if (p && p.level === 'fail') { fails += 1; console.log(`FAIL  ${s.key.padEnd(34)} ${shown.padEnd(24)} ${p.message}`); }
  else if (p) { warns += 1; console.log(`warn  ${s.key.padEnd(34)} ${shown.padEnd(24)} ${p.message}`); }
  else if (s.boot === 'required' || (profile === 'launch' && s.launchRequired)) console.log(`ok    ${s.key.padEnd(34)} ${shown}`);
}
console.log(`\n${fails} failed, ${warns} warning(s), profile "${profile}", scope "${scope}". ${fails ? 'Not ready.' : 'Ready for this profile.'}`);
if (profile === 'launch' && !fails) console.log('Not checked here: that the values are the right ones (the production Clerk instance, the live Razorpay account) and that DNS, email records and Atlas are ready.');
process.exitCode = fails ? 1 : 0;
