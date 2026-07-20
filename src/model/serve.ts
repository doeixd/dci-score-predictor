// Serve-time orchestration for one corps' feature row — the faithful port of the
// production cleanV10ServeFP.ts inner loop: pad-mask, trend-slope append, judge
// masking, curve-anchor baseline fallback, ensemble mean-pooling, bias
// calibration, division recal offset, proportional caption rescale.
import {
  CAPTIONS,
  SEQ_LEN,
  FEAT_DIM,
  STATIC_DIM,
  PADDING_INDEX,
  CAPTION_SCALE,
  RECAP_OFFSET,
  CAPTION_STRIDE,
  RANK_BASELINE_START,
  captionDerivedTotal,
  historyBucket,
  maskJudgeContext,
  type Caption,
  type CaptionInterval,
  type FeatureRow,
  type HistoryBucket,
} from './contract.js';
import type { EnsembleMember } from './inference.js';

export interface ServeOptions {
  /** Per-`${division}|${bucket}` additive total offset (shipped asset). */
  biasCalibration?: Record<string, number>;
  /** Per-division additive recal offset (fit from the caller's resolved shows). */
  recalOffsets?: Record<string, number>;
  division: string;
}

export interface ServedPrediction {
  total: number;
  GE: number;
  Visual: number;
  Music: number;
  captions: Record<Caption, number>;
  intervals: Record<Caption, CaptionInterval>;
  rawTotal: number;
  historyBucket: HistoryBucket;
  nonPadSteps: number;
  biasOffset: number;
  recalOffset: number;
  /** Interpretable additive pieces (for `explain`); cheap by-products of serving. */
  baselineRecap: number[];
  trendSlopes: number[];
}

export const servePrediction = (
  members: EnsembleMember[],
  row: FeatureRow,
  options: ServeOptions
): ServedPrediction | null => {
  const { sequence: rawSequence, staticFeatures: staticRaw } = row;
  if (rawSequence.length !== SEQ_LEN || staticRaw.length !== STATIC_DIM) return null;
  const mask = rawSequence.map((step) => step[PADDING_INDEX] !== 1);
  const sequence = rawSequence.map((step) =>
    step[PADDING_INDEX] === 1 ? new Array<number>(FEAT_DIM).fill(0) : step
  );

  // Trend slopes (8): per-caption slope over the last ≤3 observed recaps,
  // reconstructed from the sequence recap channel.
  const recapHist: number[][] = Array.from({ length: 8 }, () => []);
  for (let s = 0; s < sequence.length; s++) {
    if (!mask[s]) continue;
    for (let c = 0; c < 8; c++) {
      const v = sequence[s]![RECAP_OFFSET + c * CAPTION_STRIDE + 2];
      if (typeof v === 'number') recapHist[c]!.push(v * CAPTION_SCALE);
    }
  }
  const trendSlopes = recapHist.map((vals) => {
    const last = vals.slice(-3);
    return last.length >= 2 ? (last.at(-1)! - last[0]!) / (last.length - 1) / 0.1 : 0;
  });
  const staticFeatures = [...staticRaw, ...trendSlopes];
  maskJudgeContext(staticFeatures);

  // Baseline: the corps' last-observed recap; curve-anchor fallback (rank-baseline
  // block) only when that is all-zero (first-ever appearance).
  const maskArr = mask.map((v) => (v ? 1 : 0));
  const lastValid = maskArr.lastIndexOf(1);
  const baseline: number[] = CAPTIONS.map((_, i) =>
    lastValid >= 0 ? (sequence[lastValid]?.[RECAP_OFFSET + i * CAPTION_STRIDE + 2] ?? 0) * CAPTION_SCALE : 0
  );
  if (baseline.every((v) => v === 0)) {
    for (let i = 0; i < 8; i++)
      (baseline as number[])[i] = (staticFeatures[RANK_BASELINE_START + i] ?? 0) * CAPTION_SCALE;
  }
  const nonPadSteps = mask.filter(Boolean).length;
  const historyLen = Math.max(0, nonPadSteps - 1);

  const perMember = members.map((m) =>
    m.predictOne({
      sequence,
      sequenceMask: mask,
      staticFeatures,
      judgeIndices: new Array<number>(8).fill(0),
      corpsId: 0,
      agnosticShowId: 0,
      baselineRecap: baseline,
      historyLen,
      judgeBiasScale: 0,
      corpsScale: 0,
    })
  );
  const avgAt = (cap: Caption, q: 'p10' | 'p50' | 'p90') =>
    perMember.reduce((s, p) => s + p.captions[cap][q], 0) / perMember.length;
  const caps = CAPTIONS.map((cap) => avgAt(cap, 'p50'));
  const intervals = Object.fromEntries(
    CAPTIONS.map((cap) => [
      cap,
      {
        low_offset: Number((avgAt(cap, 'p10') - avgAt(cap, 'p50')).toFixed(3)),
        high_offset: Number((avgAt(cap, 'p90') - avgAt(cap, 'p50')).toFixed(3)),
      },
    ])
  ) as Record<Caption, CaptionInterval>;

  const rawTotal = captionDerivedTotal(caps);
  const bucket = historyBucket(nonPadSteps);
  const biasOffset = options.biasCalibration?.[`${options.division}|${bucket}`] ?? 0;
  const recalOffset = options.recalOffsets?.[options.division] ?? 0;
  const total = rawTotal + biasOffset + recalOffset;
  const scale = rawTotal > 0 ? total / rawTotal : 1;
  const sc = caps.map((c) => c * scale);
  return {
    total: Number(total.toFixed(3)),
    GE: Number((sc[0]! + sc[1]!).toFixed(3)),
    Visual: Number(((sc[2]! + sc[3]! + sc[4]!) / 2).toFixed(3)),
    Music: Number(((sc[5]! + sc[6]! + sc[7]!) / 2).toFixed(3)),
    captions: Object.fromEntries(
      CAPTIONS.map((c, i) => [c, Number(sc[i]!.toFixed(3))])
    ) as Record<Caption, number>,
    intervals,
    rawTotal,
    historyBucket: bucket,
    nonPadSteps,
    biasOffset,
    recalOffset,
    baselineRecap: baseline.map((v) => Number(v.toFixed(4))),
    trendSlopes: trendSlopes.map((v) => Number(v.toFixed(4))),
  };
};
