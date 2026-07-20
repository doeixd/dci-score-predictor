// Numeric helpers — faithful ports of the production builder's math
// (buildMlSequencesV9Subcaption.ts). Do not "fix" anything here: bug-for-bug
// compatibility is what makes the parity suite pass.

export const EMA_ALPHA = 0.3;

export const normalizeRank = (rank: number) => rank / 25;
export const normalizeScore = (score: number) => (score - 70) / 30;
export const normalizeGap = (gap: number) => gap / 25;
export const normalizeCaptionScore = (score: number) => score / 20;
export const normalizeDays = (days: number) => Math.min(days, 120) / 120;
export const normalizeRecentGap = (days: number) => Math.min(days, 14) / 14;
export const normalizeOffseasonGap = (days: number) => Math.min(days, 365) / 365;
export const bucketPercent = (percent: number) =>
  Math.max(0, Math.min(100, Math.round(percent / 5) * 5));

export const daysBetween = (date1: string, date2: string): number =>
  Math.round((new Date(date2).getTime() - new Date(date1).getTime()) / 86_400_000);

export const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

/** Population std (÷n) — used by computeStats/fingerprint volatility. */
export const stdPop = (values: number[]) => {
  if (!values.length) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
};

/** Sample std (÷(n−1)) — used by the temporal corps-history block. */
export const stdSample = (values: number[]) => {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1));
};

export const computeSlope = (values: number[]): number => {
  if (values.length < 2) return 0;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumX2 = 0;
  for (let i = 0; i < values.length; i++) {
    sumX += i;
    sumY += values[i]!;
    sumXY += i * values[i]!;
    sumX2 += i * i;
  }
  const denom = values.length * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (values.length * sumXY - sumX * sumY) / denom;
};

export const computeEma = (values: number[], alpha: number): number => {
  if (values.length === 0) return 0;
  let ema = values[0]!;
  for (let i = 1; i < values.length; i++) ema = alpha * values[i]! + (1 - alpha) * ema;
  return ema;
};

export const quantile = (sorted: number[], q: number): number => {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base]!;
  const upper = sorted[base + 1] ?? lower;
  return lower + rest * (upper - lower);
};

export const computeStats = (values: number[]) => {
  if (values.length === 0)
    return { mean: 0, median: 0, std: 0, min: 0, max: 0, p25: 0, p75: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const avg = mean(sorted);
  return {
    mean: avg,
    median: quantile(sorted, 0.5),
    std: stdPop(sorted),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    p25: quantile(sorted, 0.25),
    p75: quantile(sorted, 0.75),
  };
};

export const computeSeriesStats = (values: number[]) => {
  if (values.length === 0) return { mean: 0, slope: 0, volatility: 0 };
  const avg = mean(values);
  const slope = computeSlope(values);
  const volatility =
    values.length > 1
      ? Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length)
      : 0;
  return { mean: avg, slope, volatility };
};

export const computeWeightedMean = (values: number[], weights: number[]) => {
  if (values.length === 0) return 0;
  let total = 0,
    weightSum = 0;
  for (let i = 0; i < values.length; i++) {
    const weight = weights[i] ?? 0;
    total += values[i]! * weight;
    weightSum += weight;
  }
  return weightSum === 0 ? 0 : total / weightSum;
};

/** Field-pace OLS slope over (percentThrough/100, residual) pairs (temporal builder variant). */
export const fieldSlope = (rows: Array<{ percentThrough: number; residual: number }>): number => {
  if (rows.length < 2) return 0;
  const xs = rows.map((row) => row.percentThrough / 100);
  const ys = rows.map((row) => row.residual);
  const xMean = mean(xs);
  const yMean = mean(ys);
  const denominator = xs.reduce((sum, value) => sum + (value - xMean) ** 2, 0);
  return denominator > 1e-9
    ? rows.reduce((sum, _row, index) => sum + (xs[index]! - xMean) * (ys[index]! - yMean), 0) /
        denominator
    : 0;
};
