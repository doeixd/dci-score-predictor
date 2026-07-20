import { describe, it, expect } from 'vitest';
import { fitRecalOffset, PRODUCTION_RECAL_CONFIG } from '../src/recal/recal.js';

const obs = (n: number, residual: number, date: string, division = 'World Class') =>
  Array.from({ length: n }, () => ({ predicted: 80, actual: 80 + residual, division, date }));

describe('recal fit (prod parity math)', () => {
  it('returns 0 with an empty pool', () => {
    expect(fitRecalOffset([], 'World Class', '2026-07-20')).toEqual({
      offset: 0,
      poolN: 0,
      thinTaper: 0,
    });
  });

  it('excludes same-day and later observations (leakage guard)', () => {
    const pool = [...obs(5, 1, '2026-07-20'), ...obs(5, 1, '2026-07-21')];
    expect(fitRecalOffset(pool, 'World Class', '2026-07-20').poolN).toBe(0);
  });

  it('excludes other divisions and stale observations beyond recencyDays', () => {
    const pool = [...obs(3, 1, '2026-07-01'), ...obs(3, 1, '2026-07-18', 'Open Class')];
    expect(fitRecalOffset(pool, 'World Class', '2026-07-20').poolN).toBe(0);
  });

  it('applies shrink n/(n+8), clamp ±1.5, and thin-pool taper n/20', () => {
    // 8 identical residuals of +2.0: trim removes min+max (both 2.0), mean 2.0,
    // shrink 8/16 = 0.5 → 1.0, clamp no-op, taper 8/20 = 0.4 → 0.4.
    const fit = fitRecalOffset(obs(8, 2, '2026-07-19'), 'World Class', '2026-07-20');
    expect(fit).toEqual({ offset: 0.4, poolN: 8, thinTaper: 0.4 });
  });

  it('clamps large residual means at maxAbs before taper', () => {
    // 40 residuals of +10: shrink 40/48 → 8.33, clamp 1.5, taper 1 → 1.5.
    const fit = fitRecalOffset(obs(40, 10, '2026-07-19'), 'World Class', '2026-07-20');
    expect(fit.offset).toBe(1.5);
    expect(fit.thinTaper).toBe(1);
  });

  it('trims min/max only when n >= trimMin', () => {
    // n=4 < trimMin=5: no trim. Residuals 0,0,0,+4 → mean 1, shrink 4/12 → 1/3, taper 4/20.
    const pool = [...obs(3, 0, '2026-07-19'), ...obs(1, 4, '2026-07-19')];
    const fit = fitRecalOffset(pool, 'World Class', '2026-07-20');
    expect(fit.offset).toBeCloseTo((1 / 3) * 0.2, 4);
  });

  it('production config matches the deployed constants', () => {
    expect(PRODUCTION_RECAL_CONFIG).toEqual({
      shrinkK: 8,
      recencyDays: 14,
      trim: 1,
      trimMin: 5,
      maxAbs: 1.5,
      minPoolN: 20,
    });
  });
});
