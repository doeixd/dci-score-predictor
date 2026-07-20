// Effect-native API contract: schema decode (success + precise failure), the
// predictEffect happy path (parity with the core Promise predict on the frozen
// kentucky fixture), and tagged-error mapping catchable via Effect.catchTag.
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Effect, Schema } from 'effect';
import {
  decodePredictInput,
  predictEffect,
  PredictInput,
} from '../src/effect.js';
import { predict } from '../src/predict.js';
import { loadEnsemble } from '../src/model/loader.js';
import type { SeasonData } from '../src/features/types.js';

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8'));

describe('effect API — schema decode', () => {
  const season = fixture('season-2026-2026-dci-kentucky.json') as SeasonData;
  const validInput = {
    seasonInfo: season.seasonInfo,
    history: season.shows,
    target: season.target,
  };

  it('decodes a valid PredictInput', async () => {
    const decoded = await Effect.runPromise(decodePredictInput(validInput));
    expect(decoded.seasonInfo.year).toBe(2026);
    expect(decoded.history!.length).toBe(season.shows.length);
    expect(decoded.target.lineup.length).toBe(season.target.lineup.length);
  });

  it('rejects an out-of-range caption score with a SchemaError detail', async () => {
    const bad = JSON.parse(JSON.stringify(validInput));
    bad.history[0].results[0].captions.GE1 = 99; // > 20
    const res = await Effect.runPromise(Effect.result(decodePredictInput(bad)));
    if (res._tag !== 'Failure') throw new Error('expected decode to fail');
    const err = res.failure;
    expect(err._tag).toBe('ValidationError');
    // The wrapped SchemaError message names the failing constraint + path.
    expect(err.message).toMatch(/between 0 and 20/);
    expect(err.message).toMatch(/GE1/);
  });

  it('rejects a malformed date string', async () => {
    const bad = JSON.parse(JSON.stringify(validInput));
    bad.target.date = 'not-a-date';
    const res = await Effect.runPromise(Effect.result(decodePredictInput(bad)));
    if (res._tag !== 'Failure') throw new Error('expected decode to fail');
    expect(res.failure._tag).toBe('ValidationError');
  });

  it('exposes PredictInput as a usable schema (decodeUnknownSync)', () => {
    const decoded = Schema.decodeUnknownSync(PredictInput)(validInput);
    expect(decoded.seasonInfo.year).toBe(2026);
  });
});

describe('effect API — predictEffect', () => {
  const season = fixture('season-2026-2026-dci-kentucky.json') as SeasonData;
  const offsets: Record<string, number> = fixture('kentucky-offsets.json');

  beforeAll(async () => {
    await loadEnsemble();
  }, 120_000);

  it('produces the same top total as the core Promise predict', async () => {
    const input = { seasonInfo: season.seasonInfo, history: season.shows, target: season.target };
    const opts = { recalOffsets: offsets };
    const [core, viaEffect] = await Promise.all([
      predict(input, opts),
      Effect.runPromise(predictEffect(input, opts)),
    ]);
    expect(viaEffect.predictions.length).toBe(core.predictions.length);
    expect(viaEffect.predictions[0]!.corpsKey).toBe(core.predictions[0]!.corpsKey);
    expect(viaEffect.predictions[0]!.total).toBeCloseTo(core.predictions[0]!.total, 6);
  }, 300_000);

  it('maps target-date leakage to a ValidationError catchable via Effect.catchTag', async () => {
    const leaky = {
      seasonInfo: season.seasonInfo,
      history: season.shows.map((s) => ({ ...s, date: season.target.date })),
      target: season.target,
    };
    const program = predictEffect(leaky, { recalOffsets: offsets }).pipe(
      Effect.catchTag('ValidationError', (e) => Effect.succeed(`caught: ${e._tag}` as const))
    );
    const out = await Effect.runPromise(program);
    expect(out).toBe('caught: ValidationError');
  }, 120_000);
});
