#!/usr/bin/env node
// dci-predict — CLI for dci-score-predictor. Runs a DCI score prediction from a
// season-data JSON file and prints a ranked recap table with readiness tiers,
// recal audit, and caveats (or raw JSON with --json).
//
// Usage: npx dci-predict <season-data.json> [--members N] [--explain] [--strict] [--json]
//
// Auto-detects the payload shape:
//   - loose (target.lineup is a list of NAMES)          → dci-score-predictor/simple
//   - core  (target.lineup is a list of {corpsKey,...})  → dci-score-predictor
//
// Imports the package via self-reference ('dci-score-predictor'), so it uses the
// installed package's OWN built exports — not repo-relative source.
import { readFileSync } from 'node:fs';
import process from 'node:process';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const USAGE = 'usage: dci-predict <season-data.json> [--members N] [--explain] [--strict] [--json]';
if (!file || args.includes('--help') || args.includes('-h')) {
  console.error(USAGE);
  process.exit(file ? 0 : 2);
}
const flag = (name) => args.includes(`--${name}`);
const membersArg = args.indexOf('--members');
const members = membersArg >= 0 ? Number(args[membersArg + 1]) : undefined;
const asJson = flag('json');
const options = { explain: flag('explain'), strict: flag('strict'), ...(members ? { members } : {}) };

let payload;
try {
  payload = JSON.parse(readFileSync(file, 'utf-8'));
} catch (e) {
  console.error(`Could not read/parse "${file}": ${String(e?.message ?? e)}`);
  process.exit(2);
}
const isLoose = Array.isArray(payload?.target?.lineup) && typeof payload.target.lineup[0] === 'string';

const modName = isLoose ? 'dci-score-predictor/simple' : 'dci-score-predictor';
let predict, validateInput;
try {
  ({ predict } = await import(modName));
  if (!isLoose) ({ validateInput } = await import('dci-score-predictor'));
} catch (e) {
  console.error(`Could not load "${modName}". Install dci-score-predictor first.`);
  console.error(String(e?.message ?? e));
  process.exit(2);
}

// Pre-flight validation for core payloads (cheap; no model load).
if (validateInput && !asJson) {
  try {
    const report = validateInput(payload, { strict: options.strict });
    if (!report.ok)
      console.error(`note: ${report.droppedRows.length} row(s) will be dropped during validation.`);
  } catch (e) {
    console.error(`VALIDATION ERROR: ${String(e?.message ?? e)}`);
    process.exit(1);
  }
}

const t0 = Date.now();
let result;
try {
  result = await predict(payload, options);
} catch (e) {
  console.error(`PREDICTION FAILED: ${String(e?.message ?? e)}`);
  process.exit(1);
}

if (asJson) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

const tierByKey = new Map(result.readiness.corps.map((r) => [r.corpsKey, r]));
const pad = (s, n) => String(s).padEnd(n);
const num = (x) => x.toFixed(3).padStart(7);

console.log(`\nPredicted recap — ${result.predictions.length} corps · ` +
  `${result.model_metadata.ensembleSize}-seed ensemble · ${Date.now() - t0}ms\n`);
console.log(`${pad('#', 3)}${pad('Corps', 26)}${pad('Total', 9)}${pad('GE', 8)}${pad('Vis', 8)}${pad('Mus', 8)}${pad('Tier', 14)}`);
console.log('-'.repeat(76));
for (const p of result.predictions) {
  const r = tierByKey.get(p.corpsKey);
  console.log(`${pad(p.rank, 3)}${pad(p.corps.slice(0, 24), 26)}${num(p.total)}  ${num(p.GE)} ${num(p.Visual)} ${num(p.Music)}  ${pad(r ? `${r.tier} (${r.tierCode})` : '?', 14)}`);
}

console.log('\nReadiness & recal:');
for (const a of result.readiness.recal)
  console.log(`  recal ${pad(a.division, 14)} offset ${a.offset.toFixed(3)} (pool n=${a.poolN}, taper ${a.thinTaper}, active=${a.active})`);

if (result.caveats.length) {
  console.log('\nCaveats:');
  for (const c of result.caveats) console.log(`  [${c.severity}] ${c.message}`);
} else {
  console.log('\nNo caveats — full-season history, established tiers.');
}

if (result.explain)
  console.log('\nExplain (per corps): baseline/trend/offsets attached in result.explain[] (use --json to see it).');

console.log(
  '\nReminder: inspect the tier before trusting a number — sparse/cold_start are ' +
  'wider-error. Not affiliated with Drum Corps International.');
