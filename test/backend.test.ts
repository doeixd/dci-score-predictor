// Backend knob (PLAN §5). ensureBackend selects cpu/wasm with graceful
// fallback; predict honors options.backend. @tensorflow/tfjs-backend-wasm is a
// devDependency here, so the wasm path activates (no fallback expected).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ensureBackend } from '../src/model/backend.js';
import { predict, _clearEnsembleCache, type PredictInput } from '../src/predict.js';
import type { SeasonData } from '../src/features/types.js';

const season: SeasonData = JSON.parse(
  readFileSync(new URL('./fixtures/season-2026-2026-dci-kentucky.json', import.meta.url), 'utf-8')
);
const input: PredictInput = {
  seasonInfo: season.seasonInfo,
  history: season.shows,
  target: season.target,
};

describe('ensureBackend', () => {
  it('activates cpu', async () => {
    const r = await ensureBackend('cpu');
    expect(r.requested).toBe('cpu');
    expect(r.active).toBe('cpu');
    expect(r.fellBack).toBe(false);
  });

  it('activates wasm when the optional peer dep is present', async () => {
    const r = await ensureBackend('wasm');
    // wasm is installed in devDependencies for testing → should activate.
    expect(r.active).toBe('wasm');
    expect(r.fellBack).toBe(false);
    await ensureBackend('cpu'); // reset for other suites
  });
});

describe('predict with backend option', () => {
  it('runs on wasm without a fallback caveat', async () => {
    _clearEnsembleCache();
    const out = await predict(input, { backend: 'wasm', members: 1 });
    expect(out.predictions.length).toBe(season.target.lineup.length);
    expect(out.caveats.some((c) => c.message.startsWith("backend 'wasm' unavailable"))).toBe(false);
    _clearEnsembleCache();
    await ensureBackend('cpu');
  }, 120_000);

  // Byte-parity is guaranteed only for cpu (see docs/BENCHMARKS.md). wasm
  // (XNNPACK) may reorder float ops, so this pins the observed divergence: on
  // the kentucky fixture cpu and wasm totals match EXACTLY. If a tfjs/XNNPACK
  // upgrade ever makes them diverge, loosen this tolerance AND strengthen the
  // BENCHMARKS.md caveat — never silently widen it.
  it('cpu and wasm agree on the kentucky fixture (to the documented tolerance)', async () => {
    _clearEnsembleCache();
    const cpu = await predict(input, { members: 2 });
    const wasm = await predict(input, { backend: 'wasm', members: 2 });
    _clearEnsembleCache();
    await ensureBackend('cpu');

    expect(wasm.predictions.length).toBe(cpu.predictions.length);
    // Tolerance is 3 decimals per the published parity claim; the fixture in
    // fact matches to full float precision (observed maxDiff = 0).
    for (let i = 0; i < cpu.predictions.length; i++) {
      const c = cpu.predictions[i]!;
      const w = wasm.predictions[i]!;
      expect(w.corpsKey).toBe(c.corpsKey);
      expect(w.total).toBeCloseTo(c.total, 3);
    }
  }, 120_000);
});
