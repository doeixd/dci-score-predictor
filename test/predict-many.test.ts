// predictMany + whatIf (PLAN §5). Uses the shipped kentucky fixture as a real
// season history; asserts batch == individual predict() calls, and that whatIf
// add/remove is reflected in the produced lineup + downstream predictions.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { predict, predictMany, whatIf, type PredictInput } from '../src/index.js';
import type { SeasonData } from '../src/features/types.js';

const season: SeasonData = JSON.parse(
  readFileSync(new URL('./fixtures/season-2026-2026-dci-kentucky.json', import.meta.url), 'utf-8')
);

const base: PredictInput = {
  seasonInfo: season.seasonInfo,
  history: season.shows,
  target: season.target,
};

describe('predictMany', () => {
  it('matches two independent predict() calls over 2 targets', async () => {
    // Second target: a subset lineup (drop one corps) sharing the same history.
    const dropKey = season.target.lineup[0]!.corpsKey;
    const second = whatIf(base, { removeCorps: [dropKey] });

    const [batchA, batchB] = await predictMany([base, second]);
    const soloA = await predict(base);
    const soloB = await predict(second);

    const totals = (r: { predictions: { corpsKey: string; total: number }[] }) =>
      r.predictions.map((p) => `${p.corpsKey}:${p.total.toFixed(6)}`);

    expect(totals(batchA!)).toEqual(totals(soloA));
    expect(totals(batchB!)).toEqual(totals(soloB));
    // The two scenarios differ (one fewer corps in the field).
    expect(batchB!.predictions.length).toBe(batchA!.predictions.length - 1);
  }, 300_000);

  it('preserves input order', async () => {
    const results = await predictMany([base, base, base]);
    expect(results).toHaveLength(3);
    for (const r of results)
      expect(r.predictions.length).toBe(season.target.lineup.length);
  }, 300_000);
});

describe('whatIf', () => {
  it('removeCorps drops the corps from the lineup + predictions', async () => {
    const key = season.target.lineup[0]!.corpsKey;
    const modified = whatIf(base, { removeCorps: [key] });
    expect(modified.target.lineup.some((e) => e.corpsKey === key)).toBe(false);
    // Base is untouched (pure function).
    expect(base.target.lineup.some((e) => e.corpsKey === key)).toBe(true);

    const out = await predict(modified);
    expect(out.predictions.some((p) => p.corpsKey === key)).toBe(false);
  }, 300_000);

  it('addCorps splices a new corps into the lineup + predictions', async () => {
    const division = season.target.lineup[0]!.division;
    const modified = whatIf(base, {
      addCorps: [{ corpsKey: 'whatif-new-corps', corpsName: 'What-If New Corps', division }],
    });
    expect(modified.target.lineup.some((e) => e.corpsKey === 'whatif-new-corps')).toBe(true);
    expect(modified.target.lineup.length).toBe(season.target.lineup.length + 1);

    const out = await predict(modified);
    expect(out.predictions.some((p) => p.corpsKey === 'whatif-new-corps')).toBe(true);
    expect(out.predictions.length).toBe(season.target.lineup.length + 1);
  }, 300_000);

  it('accepts a Corps-like object and dedupes by key', () => {
    const division = season.target.lineup[0]!.division;
    const modified = whatIf(base, {
      addCorps: [
        { corps: { key: 'x', name: 'X Corps', division } },
        { corps: { key: 'x', name: 'X Corps', division } }, // dup — ignored
      ],
    });
    expect(modified.target.lineup.filter((e) => e.corpsKey === 'x')).toHaveLength(1);
  });

  it('date change is reflected', () => {
    const modified = whatIf(base, { date: '2026-08-07' });
    expect(modified.target.date).toBe('2026-08-07');
    expect(base.target.date).not.toBe('2026-08-07');
  });
});
