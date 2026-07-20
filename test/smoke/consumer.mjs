// Consumer-fidelity smoke test — runs INSIDE a throwaway project that has
// `npm install`ed the packed tarball. Uses ONLY the public API. Exits non-zero
// on any failure. Proves installed-package asset resolution (models/curves/
// registries resolve from the installed layout, not the repo checkout).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
let failures = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ok  - ${msg}`);
  else { console.error(`  FAIL - ${msg}`); failures++; }
};
const inRange = (x, lo, hi) => Number.isFinite(x) && x >= lo && x <= hi;

// ── (a) simple API: tiny inline 3-show history ──────────────────────────────
console.log('a) simple API — inline 3-show history');
const { predict: simplePredict } = await import('dci-score-predictor/simple');
const capsFor = (base) => ({
  GE1: base, GE2: base - 0.2, VP: base - 0.5, VA: base - 0.4,
  CG: base - 0.6, MB: base + 0.4, MA: base, MP: base + 0.5,
});
const simpleOut = await simplePredict({
  history: [
    { show: 'DCI Southwestern', date: '2026-07-11', scores: [
      { corps: 'blue devils', captions: capsFor(17.0) },
      { corps: 'bluecoats',   captions: capsFor(16.6) },
    ] },
    { show: 'DCI Southeastern', date: '2026-07-18', scores: [
      { corps: 'blue devils', captions: capsFor(17.4) },
      { corps: 'bluecoats',   captions: capsFor(17.0) },
    ] },
    { show: 'DCI Masters', date: '2026-07-25', scores: [
      { corps: 'blue devils', captions: capsFor(17.8) },
      { corps: 'bluecoats',   captions: capsFor(17.4) },
    ] },
  ],
  target: { show: 'Prelims', date: '2026-08-06', lineup: ['blue devils', 'bluecoats'] },
});
ok(simpleOut.predictions.length === 2, 'simple: 2 ranked predictions');
ok(simpleOut.predictions.every((p) => inRange(p.total, 60, 100)), 'simple: totals in 60–100');
ok(simpleOut.predictions[0].rank === 1, 'simple: ranked (rank 1 present)');
ok(simpleOut.inputAudit.normalizations.some((n) => n.kind === 'corps'), 'simple: name normalization audited');

// ── (b) core API: the shipped kentucky fixture ──────────────────────────────
console.log('b) core API — kentucky fixture');
const { predict, validateInput } = await import('dci-score-predictor');
const season = JSON.parse(readFileSync(new URL('./season-2026-2026-dci-kentucky.json', import.meta.url), 'utf-8'));
const report = validateInput({ seasonInfo: season.seasonInfo, history: season.shows, target: season.target });
ok(report.showsAccepted === season.shows.length, `validateInput: ${report.showsAccepted} shows accepted`);
const core = await predict(
  { seasonInfo: season.seasonInfo, history: season.shows, target: season.target },
);
ok(core.predictions.length === season.target.lineup.length, `core: ${core.predictions.length} predictions (= lineup)`);
ok(core.predictions.length > 0, 'core: ranked output non-empty');
ok(core.predictions.every((p) => inRange(p.total, 60, 100)), 'core: all totals in 60–100');
ok(core.readiness.corps.length === core.predictions.length, 'core: readiness per corps');
ok(core.readiness.corps.every((r) => ['established', 'partial', 'sparse', 'cold_start'].includes(r.tier)), 'core: tiers populated');
ok(core.caveats.length > 0, 'core: caveats populated');
ok(core.model_metadata.ensembleSize === 8, 'core: 8-seed ensemble loaded from installed assets');

// ── (c) members:1 reduced ensemble load ─────────────────────────────────────
console.log('c) members:1 reduced ensemble');
const reduced = await predict(
  { seasonInfo: season.seasonInfo, history: season.shows, target: season.target },
  { members: 1 },
);
ok(reduced.model_metadata.ensembleSize === 1, 'members:1 loads a single seed');
ok(reduced.predictions.every((p) => inRange(p.total, 60, 100)), 'members:1 totals in 60–100');

// ── (d) CJS require() ───────────────────────────────────────────────────────
console.log('d) CJS require()');
const cjs = require('dci-score-predictor');
ok(typeof cjs.predict === 'function', 'require(): predict export present');
ok(typeof cjs.validateInput === 'function', 'require(): validateInput export present');
const cjsSimple = require('dci-score-predictor/simple');
ok(typeof cjsSimple.predict === 'function', 'require("…/simple"): predict export present');

console.log(failures ? `\nSMOKE FAILED — ${failures} check(s) failed` : '\nSMOKE PASSED');
process.exit(failures ? 1 : 0);
