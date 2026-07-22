// Proves the `dci-score-predictor/data` subpath: seasons load from the vendored
// `data/data/*.json` submodule payload, and a loaded season feeds predict()'s
// input contract. Imports the SOURCE wrapper (walk-up resolves the season dir
// from the src tree just as it does from dist/an installed tarball). No model
// load needed — validateInput is enough to prove the shape.
import { describe, it, expect } from 'vitest';
import { season, seasons, SEASONS } from '../src/data.js';
import { validateInput } from '../src/index.js';

describe('dci-score-predictor/data subpath', () => {
  it('lists the bundled seasons', () => {
    expect(seasons()).toEqual(SEASONS);
    expect(seasons()).not.toBe(SEASONS); // defensive copy
  });

  it('loads a historical season with shows', () => {
    const s = season(2018);
    expect(s.seasonInfo.year).toBe(2018);
    expect(Array.isArray(s.shows)).toBe(true);
    expect(s.shows.length).toBeGreaterThan(0);
  });

  it('feeds predict() input shape via validateInput (2026)', () => {
    const { seasonInfo, shows } = season(2026);
    expect(shows.length).toBeGreaterThan(0);
    const report = validateInput({
      seasonInfo,
      history: shows as never,
      target: {
        slug: 'dci-prelims',
        date: '2026-08-06',
        lineup: [{ corpsKey: 'blue-devils', division: 'World Class' }],
      },
    });
    expect(report.showsAccepted).toBeGreaterThan(0);
  });

  it('throws for an unbundled season', () => {
    expect(() => season(1999)).toThrow(/no data for season 1999/);
  });
});
