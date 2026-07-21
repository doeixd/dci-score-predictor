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
});
