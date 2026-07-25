/**
 * W — the V13 STRUCTURAL LAYER (computed, never trained). V13_PLAN.md §3.1.
 *
 * W is a standalone, trainable-free forecaster that reproduces final2's serving
 * "wrapper" arithmetic WITHOUT any neural core. It is the level-carrying spine of
 * V13 (L2: put the level in arithmetic, the shape in weights): persistence anchor
 * + reference-curve growth + prior-season comparable revert + a self-referential,
 * damped/capped rolling bias correction. In the full V13 build the learned core
 * predicts the residual `actual − W`, and this exact module is (a) the TRAINING-DATA
 * PREPROCESSOR — every training row gets its W and W's component/rolling-residual
 * features from `wPreCorrection` + `biasCorrectionFromResiduals` — and (b) the
 * SERVE-TIME structural layer under the model. Same code both places → no train/serve
 * skew (the arm-A/B lesson).
 *
 * FAITHFUL PORT of /root/corps-place/sdk/scripts/predictEventRecap.ts (lineage
 * 3d5bf03), the v9 "scar tissue":
 *   - curveΔ mode: predictEventRecap L873-896, L1747-1782 — per-caption growth from
 *     the clean reference curves (referenceCurvesV4.json), rank from currentSeasonRank,
 *     percent-through from estimatePercentThrough. In final2 the curveΔ base is a
 *     FROZEN model run (frozen.p50 + growth); W-alone replaces that frozen model
 *     estimate with the PERSISTENCE ANCHOR (last real per-caption recap) — the pure
 *     structural analog — so modelBlend degenerates to curveΔ (beta = 0, the co-tuned
 *     V12t formulation: V12_COTUNED_RESULTS.md, H=25/d=0.5/cap=1.25).
 *   - persistence blend: predictEventRecap L1777-1781 (H co-tuned 25, not 14).
 *   - comparable revert: predictEventRecap L1277-1278, L1786-1794 + getPriorSeason-
 *     ComparableTotal L931-967 (schedule 0.5/0.3/0.15/0 for 1/2/3/>=4 same-season shows).
 *   - bias correction: predictEventRecap L1348-1416 — SUBTRACTED, damped d, capped
 *     ±cap, dormant < minSamples; here sourced self-referentially from W's OWN
 *     pre-correction pre-show residuals (V12t honest option (a)), not from served runs.
 *   - per-caption reconcile: reconcileCapsToTotalPreservingShape L1218-1241 (additive
 *     shift (target−current)/5 per caption, clamp [0,20]).
 *
 * DB-AGNOSTIC BY DESIGN: rank lookup and prior-season comparable lookup are INJECTED
 * as functions (WContext.rankBefore / WContext.priorComparable), so this module has no
 * DB dependency and is reusable in the backtest harness (sqlite3 CLI), the training
 * preprocessor, and the serve path alike.
 *
 * API (three pure pieces, mirroring how final2 computes bias once-per-event then
 * applies per corps):
 *   wPreCorrection(history, target, ctx)      -> WPreResult   (persist+curve+revert, NO bias)
 *   biasCorrectionFromResiduals(resids, D,cfg)-> number       (damped/capped rolling mean)
 *   applyBias(pre, correction)                -> WResult      (subtract from total, rescale caps)
 * Convenience: computeW(history, target, ctx, correction) = applyBias(wPreCorrection(...), correction).
 */

export const CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
export type Caption = (typeof CAPTIONS)[number];
export type CaptionVec = Record<Caption, number>;

/** GE1+GE2+(VP+VA+CG)/2+(MB+MA+MP)/2 — totalFromV9Captions (v9PredictionFeatures.ts:81). */
export const totalFromCaps = (c: CaptionVec): number =>
  c.GE1 + c.GE2 + (c.VP + c.VA + c.CG) / 2 + (c.MB + c.MA + c.MP) / 2;

/** estimatePercentThrough — predictEventRecap.ts L315-324 (ms args). */
export const estimatePercentThrough = (dateMs: number, startMs: number, endMs: number): number => {
  if (!Number.isFinite(dateMs)) return 50;
  return Math.max(0, Math.min(100, ((dateMs - startMs) / Math.max(1, endMs - startMs)) * 100));
};

export interface ReferenceCurves {
  curves: Record<string, Record<string, number>>;
}

/** curveBaseline — predictEventRecap.ts L873-886. rank clamp [1,25], pct bucket round-to-5. */
export function curveBaseline(curves: ReferenceCurves, rank: number, pct: number, caption: string): number {
  const r = Math.max(1, Math.min(25, Math.round(Number.isFinite(rank) ? rank : 12)));
  const bucket = Math.round(Math.max(0, Math.min(100, pct)) / 5) * 5;
  const cu = curves.curves;
  return cu[`${r}-${bucket}`]?.[caption] ?? cu[`${r}-50`]?.[caption] ?? 15.0;
}

/** curveGrowth — predictEventRecap.ts L889-896. Per-caption, never negative. */
export function curveGrowth(curves: ReferenceCurves, rank: number, fromPct: number, toPct: number): CaptionVec {
  return Object.fromEntries(
    CAPTIONS.map((c) => [c, Math.max(0, curveBaseline(curves, rank, toPct, c) - curveBaseline(curves, rank, fromPct, c))])
  ) as CaptionVec;
}

/**
 * reconcileCapsToTotalPreservingShape — predictEventRecap.ts L1218-1241.
 * Additive per-caption shift (target−current)/5, clamp [0,20]; falls back to a tiny
 * proportional scale if the additive form can't reach the target within clamps.
 */
export function reconcileCapsToTotal(caps: CaptionVec, targetTotal: number): CaptionVec {
  const current = totalFromCaps(caps);
  const delta = targetTotal - current;
  if (Math.abs(delta) < 1e-9) return { ...caps };
  const shift = delta / 5; // total weight of the caption vector is 5 (2 + 3/2 + 3/2)
  const out = Object.fromEntries(
    CAPTIONS.map((c) => [c, Math.max(0, Math.min(20, caps[c] + shift))])
  ) as CaptionVec;
  // If clamping prevented us from reaching the target, fall back to a scale.
  const got = totalFromCaps(out);
  if (Math.abs(got - targetTotal) > 1e-6 && current > 0) {
    const scale = targetTotal / current;
    return Object.fromEntries(CAPTIONS.map((c) => [c, Math.max(0, Math.min(20, caps[c] * scale))])) as CaptionVec;
  }
  return out;
}

export const comparableRevertWeight = (sameSeasonShows: number): number =>
  sameSeasonShows === 1 ? 0.5 : sameSeasonShows === 2 ? 0.3 : sameSeasonShows === 3 ? 0.15 : 0;

// ── module inputs ────────────────────────────────────────────────────────────

/** One prior real recap for a corps (persistence anchor source), leakage-safe. */
export interface WHistoryShow {
  slug: string;
  date: string; // YYYY-MM-DD
  division: string;
  captions: CaptionVec; // real per-caption recap
  total: number; // real total (== totalFromCaps(captions))
}

export interface WTarget {
  corpsKey: string;
  division: string;
  targetDate: string; // YYYY-MM-DD of the event being forecast
  season: string;
}

export interface WConfig {
  H: number; // persistence horizon (co-tuned 25)
  biasDamp: number; // d (co-tuned 0.5)
  biasCap: number; // ± cap (co-tuned 1.25)
  biasMinSamples: number; // dormant below this (10)
}

export const DEFAULT_W_CONFIG: WConfig = { H: 25, biasDamp: 0.5, biasCap: 1.25, biasMinSamples: 10 };

export interface WContext {
  curves: ReferenceCurves;
  seasonStartMs: number;
  seasonEndMs: number;
  config: WConfig;
  /** Rank of corps within its division from latest same-season total strictly before D (currentSeasonRank analog). Fallback 12. */
  rankBefore: (corpsKey: string, division: string, D: string) => number;
  /** Prior-season comparable total at nearest percent-through (getPriorSeasonComparableTotal). Optional. */
  priorComparable?: (corpsKey: string, priorSeason: string, targetPct: number) => { total: number; percentThrough: number } | undefined;
}

// ── outputs ──────────────────────────────────────────────────────────────────

export interface WComponents {
  hasHistory: boolean;
  rank: number;
  lastDate: string | null;
  lastTotal: number | null;
  lastPct: number;
  targetPct: number;
  persistWeight: number;
  horizonDays: number;
  curveGrowthCaps: CaptionVec | null; // per-caption additive growth from lastPct -> targetPct
  curveDeltaCaps: CaptionVec | null; // clamp(lastCaps + growth, [0,20])
  curveDeltaTotal: number | null;
  sameSeasonShows: number;
  revertWeight: number;
  comparableTotal: number | null;
  inSeasonPreRevertTotal: number | null;
  preCorrTotal: number; // W total BEFORE bias correction (the residual-pool value)
}

export interface WPreResult {
  captions: CaptionVec; // per-caption W BEFORE bias
  total: number; // preCorrTotal
  components: WComponents;
}

export interface WResult {
  captions: CaptionVec; // per-caption W AFTER bias (rescaled to shifted total)
  total: number;
  biasCorrection: number; // SUBTRACTED points
  components: WComponents;
}

// ── the structural computation ────────────────────────────────────────────────

/**
 * W BEFORE bias correction. Pure. `history` MUST already be leakage-safe (only shows
 * strictly before target.targetDate) and sorted ascending by date; the caller owns
 * that discipline (the harness and the serve path both filter < D).
 */
export function wPreCorrection(history: WHistoryShow[], target: WTarget, ctx: WContext): WPreResult {
  const { curves, seasonStartMs, seasonEndMs, config } = ctx;
  const D = target.targetDate;
  const targetPct = estimatePercentThrough(Date.parse(D), seasonStartMs, seasonEndMs);
  const prior = history.filter((h) => h.date < D).sort((a, b) => (a.date < b.date ? -1 : 1));
  const sameSeasonShows = prior.length;

  if (sameSeasonShows === 0) {
    // No in-season history: W has no persistence anchor. Fall back to prior-season
    // comparable if available, else a rank-12 curve baseline at the target pct.
    const comp = ctx.priorComparable?.(target.corpsKey, String(Number(target.season) - 1), targetPct);
    const rank = ctx.rankBefore(target.corpsKey, target.division, D);
    let caps: CaptionVec;
    let total: number;
    if (comp) {
      // Distribute the comparable total across the rank/pct curve shape.
      const shape = Object.fromEntries(CAPTIONS.map((c) => [c, curveBaseline(curves, rank, targetPct, c)])) as CaptionVec;
      caps = reconcileCapsToTotal(shape, comp.total);
      total = comp.total;
    } else {
      caps = Object.fromEntries(CAPTIONS.map((c) => [c, curveBaseline(curves, rank, targetPct, c)])) as CaptionVec;
      total = totalFromCaps(caps);
    }
    const components: WComponents = {
      hasHistory: false, rank, lastDate: null, lastTotal: null, lastPct: targetPct, targetPct,
      persistWeight: 0, horizonDays: 0, curveGrowthCaps: null, curveDeltaCaps: null, curveDeltaTotal: null,
      sameSeasonShows: 0, revertWeight: 0, comparableTotal: comp?.total ?? null,
      inSeasonPreRevertTotal: null, preCorrTotal: total,
    };
    return { captions: caps, total, components };
  }

  const last = prior[prior.length - 1]!;
  const lastCaps = last.captions;
  const lastTotal = last.total;
  const lastPct = estimatePercentThrough(Date.parse(last.date), seasonStartMs, seasonEndMs);
  const rank = ctx.rankBefore(target.corpsKey, target.division, D);

  // curveΔ: per-caption growth added to the persistence anchor, clamped [0,20]
  // (final2 uses frozen.p50 as the base; W-alone uses the real last recap).
  const growth = curveGrowth(curves, rank, lastPct, targetPct);
  const curveDeltaCaps = Object.fromEntries(
    CAPTIONS.map((c) => [c, Math.min(20, Math.max(0, lastCaps[c] + growth[c]))])
  ) as CaptionVec;
  const curveDeltaTotal = totalFromCaps(curveDeltaCaps);

  // persistence blend. beta = 0: modelBlend degenerates to curveΔ (no neural core).
  const horizonDays = Math.max(0, (Date.parse(D) - Date.parse(last.date)) / 86_400_000);
  const persistWeight = Math.max(0, 1 - horizonDays / config.H);

  // Per-caption blend then reconcile to the blended total (keeps caption shape honest).
  const blendCaps = Object.fromEntries(
    CAPTIONS.map((c) => [c, persistWeight * lastCaps[c] + (1 - persistWeight) * curveDeltaCaps[c]])
  ) as CaptionVec;
  let inSeasonTotal = persistWeight * lastTotal + (1 - persistWeight) * curveDeltaTotal;
  const inSeasonPreRevertTotal = inSeasonTotal;

  // Thin-history revert toward prior-season comparable.
  const revertWeight = comparableRevertWeight(sameSeasonShows);
  let comparableTotal: number | null = null;
  if (revertWeight > 0 && ctx.priorComparable) {
    const comp = ctx.priorComparable(target.corpsKey, String(Number(target.season) - 1), targetPct);
    if (comp) {
      comparableTotal = comp.total;
      inSeasonTotal = inSeasonTotal * (1 - revertWeight) + comp.total * revertWeight;
    }
  }

  const caps = reconcileCapsToTotal(blendCaps, inSeasonTotal);
  const components: WComponents = {
    hasHistory: true, rank, lastDate: last.date, lastTotal, lastPct, targetPct,
    persistWeight, horizonDays, curveGrowthCaps: growth, curveDeltaCaps, curveDeltaTotal,
    sameSeasonShows, revertWeight, comparableTotal, inSeasonPreRevertTotal, preCorrTotal: inSeasonTotal,
  };
  return { captions: caps, total: inSeasonTotal, components };
}

export interface Residual {
  date: string; // show date D (YYYY-MM-DD)
  err: number; // pre-correction W total − actual total
}

/**
 * Damped/capped rolling bias from W's OWN pre-correction residuals on shows strictly
 * before D. predictEventRecap.ts L1348-1416 (self-referential variant). Returns the
 * SIGNED correction to SUBTRACT; 0 while dormant.
 */
export function biasCorrectionFromResiduals(resids: Residual[], D: string, cfg: WConfig): { correction: number; rawBias: number; samples: number } {
  const rs = resids.filter((r) => r.date < D);
  if (rs.length < cfg.biasMinSamples) return { correction: 0, rawBias: rs.length ? rs.reduce((s, r) => s + r.err, 0) / rs.length : 0, samples: rs.length };
  const rawBias = rs.reduce((s, r) => s + r.err, 0) / rs.length;
  const correction = Math.max(-cfg.biasCap, Math.min(cfg.biasCap, cfg.biasDamp * rawBias));
  return { correction, rawBias, samples: rs.length };
}

/** Subtract the bias correction from W's total and rescale captions (final2 L1809-1813). */
export function applyBias(pre: WPreResult, correction: number): WResult {
  const newTotal = pre.total - correction;
  const caps = reconcileCapsToTotal(pre.captions, newTotal);
  return { captions: caps, total: newTotal, biasCorrection: correction, components: pre.components };
}

export function computeW(history: WHistoryShow[], target: WTarget, ctx: WContext, correction = 0): WResult {
  return applyBias(wPreCorrection(history, target, ctx), correction);
}
