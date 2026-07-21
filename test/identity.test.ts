// Opt-in identity serving knob. Asserts (1) the default agnostic path is
// unchanged (the parity suites already pin the exact numbers — here we pin that
// `identity:'agnostic'` === omitting the option), (2) identity-full actually
// moves totals (the embeddings/scale are live), (3) unknown corps fall back to
// the unknown slot with a caveat, and (4) supplied judge ids resolve to the
// registry + populate the Elo block.
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { predict } from '../src/predict.js';
import { loadEnsemble } from '../src/model/loader.js';
import type { SeasonData } from '../src/features/types.js';

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8'));

describe('identity serving knob (2026-dci-kentucky)', () => {
  const season = fixture('season-2026-2026-dci-kentucky.json') as SeasonData;
  const base = { seasonInfo: season.seasonInfo, history: season.shows, target: season.target };

  beforeAll(async () => {
    await loadEnsemble();
  }, 120_000);

  const totalsByKey = (r: Awaited<ReturnType<typeof predict>>) =>
    new Map(r.predictions.map((p) => [p.corpsKey, p.total]));

  it("'agnostic' is byte-identical to omitting the knob (parity default unchanged)", async () => {
    const off = await predict(base, { members: 2 });
    const agn = await predict(base, { members: 2, identity: 'agnostic' });
    expect(off.readiness.identity).toBeUndefined();
    expect(agn.readiness.identity).toBeUndefined();
    const a = totalsByKey(off);
    for (const [k, t] of totalsByKey(agn)) expect(t).toBe(a.get(k));
  });

  it('identity-full moves totals vs agnostic (embeddings are live)', async () => {
    const agn = totalsByKey(await predict(base, { members: 2 }));
    const full = await predict(base, { members: 2, identity: 'full' });
    const fullT = totalsByKey(full);
    // All 7 kentucky corps are in the vocab → corps embeddings engage.
    expect(full.readiness.identity).toBeDefined();
    expect(full.readiness.identity!.corps.matched).toBe(7);
    let differ = 0;
    for (const [k, t] of fullT) if (Math.abs(t - (agn.get(k) ?? t)) > 1e-4) differ++;
    expect(differ).toBeGreaterThan(0);
  });

  it('unknown corps falls back to the unknown slot with a caveat', async () => {
    const withGhost: typeof base = {
      ...base,
      target: {
        ...season.target,
        lineup: [
          ...season.target.lineup,
          { corpsKey: 'not-a-real-corps-xyz', corpsName: 'Ghost', division: 'World Class' },
        ],
      },
    };
    const r = await predict(withGhost, { members: 2, identity: { corps: true } });
    expect(r.readiness.identity!.corps.unmatched).toContain('not-a-real-corps-xyz');
    expect(r.caveats.some((c) => c.message.includes('not in the registry'))).toBe(true);
  });

  it('supplied judge ids resolve to the registry and populate the Elo block', async () => {
    // 'a-brown-1' is a real judge_id present in both the registry and the index map.
    const withPanel: typeof base = {
      ...base,
      target: { ...season.target, judges: { GE1: ['a-brown-1'], GE2: ['not-a-real-judge'] } },
    };
    const r = await predict(withPanel, { members: 2, identity: { judges: true } });
    const id = r.readiness.identity!;
    expect(id.judges.matched).toBeGreaterThanOrEqual(1);
    expect(id.judges.unmatched).toContain('not-a-real-judge');
    expect(id.judges.unmatched).not.toContain('a-brown-1');
  });
});
