// The frozen v10.5 model input/output contract. Every constant here is asserted
// against production behavior by the parity suite (test/parity) — see
// docs/PLAN.md Appendix A/B for the audited spec these values come from.

export const CAPTIONS = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const;
export type Caption = (typeof CAPTIONS)[number];
export const CAPTION_COUNT = CAPTIONS.length;

export const SEQ_LEN = 15;
export const FEAT_DIM = 101;
export const STATIC_DIM = 216; // 212 base + 4 field-pace; 8 trend slopes appended → 224
export const TREND_DIM = 8;
export const PADDING_INDEX = 3;
export const CAPTION_SCALE = 20;

// Sequence recap channel: offset 21, stride 4 per caption; +2 = score/20.
export const RECAP_OFFSET = 21;
export const CAPTION_STRIDE = 4;

// Static blocks referenced at serving time.
export const JUDGE_ELO_START = 101; // ..112 zeroed by maskJudgeContext (identity-agnostic serving)
export const JUDGE_ELO_END = 112;
export const RANK_BASELINE_START = 121; // ..128: curve-anchor baseline per caption /20

// Total from caption scores — the DCI scoring formula the whole pipeline uses.
export const captionDerivedTotal = (caps: readonly number[]): number =>
  caps[0]! + caps[1]! + (caps[2]! + caps[3]! + caps[4]!) / 2 + (caps[5]! + caps[6]! + caps[7]!) / 2;

// Serving-time history buckets keying the bias calibration.
export type HistoryBucket = 'debut' | 'sparse' | 'established';
export const historyBucket = (nonPadSteps: number): HistoryBucket =>
  nonPadSteps === 0 ? 'debut' : nonPadSteps <= 2 ? 'sparse' : 'established';

// Zero the judge-Elo block — production serves identity-agnostic (panel unknown).
export const maskJudgeContext = (staticFeatures: number[]): void => {
  for (let i = JUDGE_ELO_START; i <= JUDGE_ELO_END; i++) staticFeatures[i] = 0;
};

export interface TargetStats {
  deltaMean: number[];
  deltaStd: number[];
  recapMean: number[];
  recapStd: number[];
  categoryMean: number[];
  categoryStd: number[];
  totalMean: number;
  totalStd: number;
}

export interface CaptionInterval {
  low_offset: number;
  high_offset: number;
}

export interface FeatureRow {
  sequence: number[][]; // [15][101], pad rows flagged at PADDING_INDEX
  staticFeatures: number[]; // [216]
}
