#!/usr/bin/env node
// Pre-flight input validation for the dci-score-predictor SDK.
// Runs ONLY the Appendix B.4 consistency checks (validateInput) — NO model
// load, NO prediction. Reports dropped rows / warnings, throws on leakage.
//
// Usage: node validate-input.mjs <payload.json> [--strict]
// The payload is the CORE PredictInput shape:
//   { seasonInfo:{year,startDate,endDate}, history:[...], target:{...} }
// (loose simple-API payloads are validated inside `predict` from
//  'dci-score-predictor/simple' — run predict.mjs for those.)
import { readFileSync } from 'node:fs';
import process from 'node:process';

const [file, ...flags] = process.argv.slice(2);
if (!file) {
  console.error('usage: node validate-input.mjs <payload.json> [--strict]');
  process.exit(2);
}
const strict = flags.includes('--strict');

let validateInput, DciValidationError;
try {
  ({ validateInput, DciValidationError } = await import('dci-score-predictor'));
} catch (e) {
  console.error('Could not load "dci-score-predictor". Install it in this project first.');
  console.error(String(e?.message ?? e));
  process.exit(2);
}

const payload = JSON.parse(readFileSync(file, 'utf-8'));
if (Array.isArray(payload?.target?.lineup) && typeof payload.target.lineup[0] === 'string') {
  console.error(
    'This looks like a loose (simple-API) payload (lineup is a list of names).\n' +
    'Run scripts/predict.mjs instead — the simple API validates as it normalizes.'
  );
  process.exit(2);
}

try {
  const report = validateInput(payload, { strict });
  console.log(`validation ${report.ok ? 'PASSED' : 'PASSED with drops'}`);
  console.log(`  shows accepted:      ${report.showsAccepted}`);
  console.log(`  score rows accepted: ${report.scoreRowsAccepted}`);
  if (report.droppedRows.length) {
    console.log(`  dropped rows (${report.droppedRows.length}):`);
    for (const d of report.droppedRows)
      console.log(`    - ${d.show}/${d.corpsKey}: ${d.reason}${d.detail ? ` (${d.detail})` : ''}`);
  }
  for (const w of report.warnings) console.log(`  [${w.severity}] ${w.message}`);
  process.exit(0);
} catch (e) {
  if (DciValidationError && e instanceof DciValidationError) {
    console.error(`VALIDATION ERROR: ${e.message}`);
    process.exit(1);
  }
  console.error(`unexpected error: ${String(e?.message ?? e)}`);
  process.exit(1);
}
