// Backend benchmark (PLAN §5): time a full-event predict on cpu vs wasm.
// Loads the shipped kentucky fixture, runs members:8 with each backend, and
// reports load + predict wall time. wasm falls back to cpu (reported) if the
// optional @tensorflow/tfjs-backend-wasm peer dep is missing.
//
// Run: npx tsx tools/bench-backends.ts
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { predict, _clearEnsembleCache, type PredictInput } from '../src/predict.js';
import type { Backend } from '../src/model/backend.js';
import type { SeasonData } from '../src/features/types.js';

const fixture = new URL('../test/fixtures/season-2026-2026-dci-kentucky.json', import.meta.url);
const season: SeasonData = JSON.parse(readFileSync(fixture, 'utf-8'));
const input: PredictInput = {
  seasonInfo: season.seasonInfo,
  history: season.shows,
  target: season.target,
};

const MEMBERS = 8;
const RUNS = 5;

async function bench(backend: Backend) {
  _clearEnsembleCache();
  // Cold: first call includes ensemble load + backend activation.
  const t0 = performance.now();
  const first = await predict(input, { backend, members: MEMBERS });
  const loadPlusFirst = performance.now() - t0;

  // Warm predicts (ensemble cached): median of RUNS.
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) {
    const t = performance.now();
    await predict(input, { backend, members: MEMBERS });
    times.push(performance.now() - t);
  }
  times.sort((a, b) => a - b);
  const medianPredict = times[Math.floor(times.length / 2)]!;
  const fellBack = first.caveats.some((c) => c.message.startsWith("backend 'wasm' unavailable"));
  return { backend, loadPlusFirst, medianPredict, fellBack, corps: first.predictions.length };
}

const cpu = await bench('cpu');
const wasm = await bench('wasm');

const fmt = (x: number) => x.toFixed(0).padStart(8);
console.log(`\nBackend benchmark — kentucky full event (${cpu.corps} corps, members:${MEMBERS}, warm median of ${RUNS})\n`);
console.log(`backend   load+first(ms)  warm predict(ms)  note`);
console.log('-'.repeat(60));
console.log(`cpu     ${fmt(cpu.loadPlusFirst)}        ${fmt(cpu.medianPredict)}`);
console.log(`wasm    ${fmt(wasm.loadPlusFirst)}        ${fmt(wasm.medianPredict)}  ${wasm.fellBack ? 'FELL BACK TO CPU' : 'wasm active'}`);
console.log('');
