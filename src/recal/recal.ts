// Division-aware, leakage-safe recalibration — TS port of the production v10.5
// Recal.fit_offset (sdk/scripts/v10_5_recal.py) plus the serve-side thin-pool
// taper (apply_recal_serve.py). The offset corrects the ensemble's residual bias
// per division using ONLY the caller's resolved shows strictly before the target
// date; with a thin pool it shrinks/tapers toward a no-op.

export interface RecalObservation {
  /** Ensemble-predicted total for a resolved (already scored) performance. */
  predicted: number;
  /** Actual scored total. */
  actual: number;
  division: string;
  /** ISO date (YYYY-MM-DD) of the resolved show. */
  date: string;
}

export interface RecalConfig {
  /** Shrinkage constant: offset scaled by n/(n+shrinkK). */
  shrinkK: number;
  /** Only prior rows within this many days of the target inform the fit (0 = all). */
  recencyDays: number;
  /** Drop min & max residual before averaging when n >= trimMin (0 = no trim). */
  trim: number;
  trimMin: number;
  /** Hard cap on |offset|. */
  maxAbs: number;
  /** Below this pool size the offset tapers linearly toward 0. */
  minPoolN: number;
}

// Production v10.5 config (single pct bucket).
export const PRODUCTION_RECAL_CONFIG: RecalConfig = {
  shrinkK: 8,
  recencyDays: 14,
  trim: 1,
  trimMin: 5,
  maxAbs: 1.5,
  minPoolN: 20,
};

export interface RecalFit {
  offset: number;
  poolN: number;
  thinTaper: number;
}

const daysBetween = (a: string, b: string): number =>
  Math.abs((Date.parse(`${a.slice(0, 10)}T00:00:00Z`) - Date.parse(`${b.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

/**
 * Fit the per-division additive offset for a target date. Residual = actual −
 * predicted (positive = under-prediction → ADD to correct). Leakage guard:
 * only observations dated STRICTLY before the target date participate.
 */
export const fitRecalOffset = (
  observations: readonly RecalObservation[],
  division: string,
  targetDate: string,
  config: RecalConfig = PRODUCTION_RECAL_CONFIG
): RecalFit => {
  const target = targetDate.slice(0, 10);
  const resids: number[] = [];
  for (const r of observations) {
    const date = r.date.slice(0, 10);
    if (date >= target) continue; // strictly before — the leakage guard
    if (r.division !== division) continue;
    if (config.recencyDays && daysBetween(date, target) > config.recencyDays) continue;
    resids.push(r.actual - r.predicted);
  }
  const n = resids.length;
  if (n === 0) return { offset: 0, poolN: 0, thinTaper: 0 };
  let pool = resids;
  if (config.trim && n >= config.trimMin) {
    pool = [...resids].sort((a, b) => a - b).slice(config.trim, resids.length - config.trim);
  }
  if (pool.length === 0) return { offset: 0, poolN: n, thinTaper: Math.min(1, n / config.minPoolN) };
  const raw = pool.reduce((s, v) => s + v, 0) / pool.length;
  const shrink = n / (n + config.shrinkK); // shrink uses UNTRIMMED n (prod behavior)
  const clamped = Math.max(-config.maxAbs, Math.min(config.maxAbs, shrink * raw));
  const thinTaper = Math.min(1, n / config.minPoolN);
  return { offset: Number((clamped * thinTaper).toFixed(4)), poolN: n, thinTaper: Number(thinTaper.toFixed(3)) };
};

/** Fit offsets for every division present in the target lineup. */
export const fitRecalOffsets = (
  observations: readonly RecalObservation[],
  divisions: readonly string[],
  targetDate: string,
  config: RecalConfig = PRODUCTION_RECAL_CONFIG
): Record<string, RecalFit> =>
  Object.fromEntries(
    [...new Set(divisions)].map((division) => [
      division,
      fitRecalOffset(observations, division, targetDate, config),
    ])
  );
