// Input contract for the pure feature builder, plus the shapes of the packaged
// cross-season context asset (assets/registries/featureContext.json).
import type { Caption } from '../model/contract.js';

export type DivisionName = 'World Class' | 'Open Class' | 'All Age';

export interface PerformanceInput {
  corpsKey: string;
  corpsName?: string;
  division: DivisionName;
  /** Caption scores 0–20. All 8 required for a usable scored row. */
  captions: Partial<Record<Caption, number>>;
  /** Optional; derived (GE1+GE2+(VP+VA+CG+MB+MA+MP)/2) when absent. */
  total?: number;
  /** Subcaption sheet values (raw 0–10 scale after prod normalization /10 is applied by the builder). */
  subcaptions?: Partial<Record<Caption, { content: number; achievement: number }>>;
  performanceOrder?: {
    inClass?: number;
    inClassCount?: number;
    overall?: number;
    overallCount?: number;
  };
}

export interface ShowInput {
  slug: string;
  /** ISO date YYYY-MM-DD. */
  date: string;
  /** 0–100; derived from seasonInfo dates when absent. */
  percentThrough?: number;
  results: PerformanceInput[];
  /** Judge panel: caption → judge ids (registry ids or arbitrary consistent ids). */
  judges?: Partial<Record<Caption, string[]>>;
}

export interface SeasonInfo {
  year: number;
  /** First event date of the season (used to derive percentThrough). */
  startDate: string;
  /** Last event date of the season. */
  endDate: string;
}

export interface TargetEventInput {
  slug: string;
  date: string;
  percentThrough?: number;
  lineup: Array<{ corpsKey: string; corpsName?: string; division: DivisionName }>;
  judges?: Partial<Record<Caption, string[]>>;
}

export interface SeasonData {
  seasonInfo: SeasonInfo;
  shows: ShowInput[];
  target: TargetEventInput;
}

// ── Packaged cross-season context (generated from the private DB at build time) ──

export interface CurveCell {
  sum: number;
  count: number;
}

export interface PriorFinal {
  season: number;
  rank: number;
  total: number;
  date: string;
}

export interface FingerprintEntry {
  season: number;
  date: string;
  percentThrough: number;
  residuals: Record<Caption, number>;
}

export interface CorpsHistoricalFallback {
  years_in_world_class: number;
  historical_mean_rank: number;
  historical_std_rank: number;
  historical_best_rank: number;
  best_rank_recency: number;
  made_finals_rate: number;
  first_season: number;
}

export interface FeatureContext {
  /** As-of reference curve state at the season boundary: `${division}|${rankBucket}|${pctBucket}|${caption}` → cell. */
  curve: Record<string, CurveCell>;
  /** Prior score ranges: `${division}|${pctBucket}|${caption}` → {min,max}. */
  ranges: Record<string, { min: number; max: number }>;
  /** Prior-season finals per `${division}:${corpsKey}` (one per season, ascending). */
  priorFinals: Record<string, PriorFinal[]>;
  /** Caption fingerprint entries per `${division}:${corpsKey}` (prior seasons only). */
  fingerprints: Record<string, FingerprintEntry[]>;
  /** Historical field-pace per-season residual slopes per division (prior seasons). */
  fieldPaceHistoricalSlopes: Record<string, number[]>;
  /** corps_historical_features_v6 fallback per corpsKey (diagnostics only). */
  corpsHistorical: Record<string, CorpsHistoricalFallback>;
  /** Prev-season best totals from corps_competition_results (MAX(total_score)
   *  per corps), PER DIVISION, sorted desc; index+1 = the prod prev-season "rank".
   *  Keyed by feature-builder division name ('World Class' | 'Open Class'). */
  prevSeasonBestTotals: Record<string, Array<{ corpsKey: string; bestTotal: number }>>;
  /** Season the context is frozen at (features valid for season = contextSeason + 1). */
  contextSeason: number;
}

export interface BuiltFeatureRow {
  corpsKey: string;
  corpsName?: string;
  division: DivisionName;
  sequence: number[][];
  staticFeatures: number[];
}

export interface FeatureBuildDiagnostics {
  corpsKey: string;
  priorShows: number;
  seasonDebut: boolean;
  knownPriorSeasons: boolean;
  subcaptionCoverage: number; // fraction of prior shows with subcaption data
  performanceOrderKnown: boolean;
  judgesKnown: boolean;
  fieldPace: { observations: number; corps: number; dates: number; confidence: number };
  defaultedBlocks: string[];
}
