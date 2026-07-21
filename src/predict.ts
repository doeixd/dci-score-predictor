// End-to-end predict orchestration (Promise API). Wires the tested layers:
// validate (Appendix B.4 invariants) → buildFeatureRows (features) → loadEnsemble
// (cached tfjs ensemble) → recal (division offsets) → servePrediction (per corps)
// → rank + diagnostics/readiness/caveats (PLAN §3.6). The Effect/Schema surface
// layers on top of this later; here validation is hand-rolled per Appendix B.4.
import { CAPTIONS, captionDerivedTotal, type Caption, type HistoryBucket } from './model/contract.js';
import { getJsonSync, ensureNodeProvider, type AssetProvider } from './assets/provider.js';
import { buildFeatureRows, replayTemporal, type ReferenceCurvesArtifact, type TemporalReplay } from './features/build.js';
import type {
  DivisionName,
  FeatureBuildDiagnostics,
  FeatureContext,
  SeasonData,
  SeasonInfo,
  ShowInput,
  TargetEventInput,
} from './features/types.js';
import { loadEnsemble, loadBiasCalibration } from './model/loader.js';
import type { EnsembleMember } from './model/inference.js';
import { servePrediction, type ServedPrediction } from './model/serve.js';
import {
  fitRecalOffsets,
  PRODUCTION_RECAL_CONFIG,
  type RecalConfig,
  type RecalObservation,
} from './recal/recal.js';

export const SDK_MODEL_DIR = 'clean-v10-fieldpace-recal-sdk';

// ── Public input/output shapes (plain objects; the schema layer comes later) ──

export interface PredictInput {
  seasonInfo: SeasonInfo;
  /** Resolved (already-scored) shows strictly before the target date. */
  history?: ShowInput[];
  /** Alias for `history` when passing a full SeasonData-like object. */
  shows?: ShowInput[];
  target: TargetEventInput;
  /** Resolved shows used to fit the per-division recal offset (leakage-safe). */
  recalObservations?: RecalObservation[];
}

export interface PredictOptions {
  /** Number of ensemble seeds to load (accuracy vs load-time). Default: all 8. */
  members?: number;
  /** Explicit asset provider (e.g. fetchAssets(baseUrl)) — required off-Node. */
  provider?: AssetProvider;
  /** Attach per-corps interpretable attribution (§3.6 explain). Off by default. */
  explain?: boolean;
  /**
   * Row-level validation failures (caption-sum mismatch, out-of-range captions,
   * duplicates, out-of-season dates) throw when true, or are downgraded to drops
   * + warnings when false. Leakage (target date not after all history) always
   * throws. Default: false.
   */
  strict?: boolean;
  /** Precomputed per-division additive offsets — overrides recalObservations fitting. */
  recalOffsets?: Record<string, number>;
  /** Override shipped bias calibration (keyed `${division}|${bucket}`). */
  biasCalibration?: Record<string, number>;
  recalConfig?: RecalConfig;
}

export type ReadinessTier = 'established' | 'partial' | 'sparse' | 'cold_start';
export type TierCode = 'T0' | 'T1' | 'T2' | 'T3';

export interface CorpsReadiness {
  corpsKey: string;
  corps: string;
  division: string;
  tier: ReadinessTier;
  tierCode: TierCode;
  /** Prior scored shows for this corps (drives the tier). */
  priorShows: number;
  /** Non-pad steps of 15 (sequence fill: prior shows + inference target). */
  sequenceFill: number;
  /** Per feature group: present | defaulted | masked. */
  featureCoverage: Record<string, 'present' | 'defaulted' | 'masked'>;
  fieldPace: FeatureBuildDiagnostics['fieldPace'];
}

export interface DivisionRecalAudit {
  division: string;
  offset: number;
  poolN: number;
  thinTaper: number;
  active: boolean;
}

export interface DroppedRow {
  show: string;
  corpsKey: string;
  reason:
    | 'caption_total_mismatch'
    | 'caption_out_of_range'
    | 'duplicate_corps_show'
    | 'out_of_season_date'
    | 'missing_captions';
  detail?: string;
}

export interface NameNormalization {
  input: string;
  matched: string;
  method: 'exact' | 'alias' | 'fuzzy' | 'made';
  kind: 'corps' | 'judge' | 'caption';
}

export interface InputAudit {
  showsCounted: number;
  corpsCounted: number;
  scoreRowsCounted: number;
  droppedRows: DroppedRow[];
  /** Divisions inferred from the registry (simple API only). */
  normalizations: NameNormalization[];
  /** History shows that supplied a judge panel (§3.2 cross-field check). */
  showsWithPanels: number;
  /** Whether the target event supplied a judge panel. */
  targetHasPanel: boolean;
}

export interface Caveat {
  severity: 'info' | 'warn';
  message: string;
  corpsKey?: string;
}

export interface CorpsExplain {
  corpsKey: string;
  baselineRecap: number[];
  trendSlopes: number[];
  fieldPace: FeatureBuildDiagnostics['fieldPace'];
  biasOffset: number;
  recalOffset: number;
  historyBucket: HistoryBucket;
}

export interface CorpsPrediction {
  corps: string;
  corpsKey: string;
  division: string;
  rank: number;
  total: number;
  GE: number;
  Visual: number;
  Music: number;
  captions: Record<Caption, number>;
  intervals: ServedPrediction['intervals'];
}

export interface ModelMetadata {
  model_dir: string;
  ensembleSize: number;
  generated_at: string;
}

export interface PredictedShowResult {
  predictions: CorpsPrediction[];
  readiness: {
    corps: CorpsReadiness[];
    recal: DivisionRecalAudit[];
  };
  inputAudit: InputAudit;
  caveats: Caveat[];
  model_metadata: ModelMetadata;
  explain?: CorpsExplain[];
}

export class DciValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DciValidationError';
  }
}

// ── Asset loading (through the provider seam) ──

// Read through getJsonSync: the Node provider serves these from disk; in a
// browser, init()/the browser entry preloads them into the cache first.
let featureContextCache: FeatureContext | null = null;
const loadFeatureContext = (): FeatureContext =>
  (featureContextCache ??= getJsonSync<FeatureContext>('registries/featureContext.json'));

let curvesCache: ReferenceCurvesArtifact | null = null;
const loadReferenceCurves = (): ReferenceCurvesArtifact =>
  (curvesCache ??= getJsonSync<ReferenceCurvesArtifact>('curves/referenceCurvesV4.json'));

// Ensemble load is ~2s / 8 models — cache the promise across predict() calls.
const ensembleCache = new Map<string, Promise<EnsembleMember[]>>();
const getEnsemble = (options: PredictOptions): Promise<EnsembleMember[]> => {
  const key = `${options.provider ? 'custom' : 'default'}|${options.members ?? 'all'}`;
  let cached = ensembleCache.get(key);
  if (!cached) {
    cached = loadEnsemble({ provider: options.provider, members: options.members });
    ensembleCache.set(key, cached);
  }
  return cached;
};

/** Test/embedder hook: drop cached ensembles (e.g. to reload a different dir). */
export const _clearEnsembleCache = (): void => void ensembleCache.clear();

// ── Validation (Appendix B.4) ──

const TOTAL_TOLERANCE = 0.05;

// The 8 canonical caption keys a judge panel may reference (Appendix B.4).
const CAPTION_SET = new Set<string>(CAPTIONS);

interface PanelStats {
  showsWithPanels: number;
  targetHasPanel: boolean;
}

interface ValidationResult {
  cleanShows: ShowInput[];
  dropped: DroppedRow[];
  warnings: Caveat[];
  panelStats: PanelStats;
}

/**
 * Cross-field score-sheet ⇄ judge-panel consistency (PLAN §3.2). Non-blocking:
 * prod tolerates unknown panels and masks judge context at serving, so mismatches
 * are surfaced as caveats, never drops. Returns true if a panel was supplied.
 *   - malformed caption keys (not one of the 8)                → 'warn' (names the show)
 *   - captions scored but with no judge assignment (or v.v.)   → 'info'
 */
const validatePanel = (
  showLabel: string,
  judges: Partial<Record<Caption, string[]>> | undefined,
  scoredCaptions: Set<Caption> | null,
  caveats: Caveat[]
): boolean => {
  if (!judges) return false;
  const entries = Object.entries(judges) as Array<[string, string[] | undefined]>;
  if (entries.length === 0) return false;

  // Malformed caption keys → warn, naming the show.
  const malformed = entries.map(([k]) => k).filter((k) => !CAPTION_SET.has(k));
  if (malformed.length)
    caveats.push({
      severity: 'warn',
      message: `${showLabel}: judge panel has caption key${malformed.length === 1 ? '' : 's'} not among the 8 (${malformed.join(', ')}) — ignored.`,
    });

  // Captions with a real (non-empty) judge assignment.
  const assigned = new Set<Caption>();
  for (const [k, v] of entries)
    if (CAPTION_SET.has(k) && Array.isArray(v) && v.filter(Boolean).length > 0) assigned.add(k as Caption);

  if (scoredCaptions) {
    const scoredNoJudge = [...scoredCaptions].filter((c) => !assigned.has(c));
    if (scoredNoJudge.length)
      caveats.push({
        severity: 'info',
        message: `${showLabel}: ${scoredNoJudge.length} scored caption${scoredNoJudge.length === 1 ? '' : 's'} without a declared judge (${scoredNoJudge.join(', ')}) — panel unknown, judge context is masked anyway.`,
      });
    const judgedNotScored = [...assigned].filter((c) => !scoredCaptions.has(c));
    if (judgedNotScored.length)
      caveats.push({
        severity: 'info',
        message: `${showLabel}: judge assigned for caption${judgedNotScored.length === 1 ? '' : 's'} not present in scores (${judgedNotScored.join(', ')}).`,
      });
  } else {
    // No scores to cross-check (e.g. the target): flag well-formed keys with empty assignment.
    const emptyAssign = entries
      .filter(([k, v]) => CAPTION_SET.has(k) && !(Array.isArray(v) && v.filter(Boolean).length > 0))
      .map(([k]) => k);
    if (emptyAssign.length)
      caveats.push({
        severity: 'info',
        message: `${showLabel}: judge panel lists caption${emptyAssign.length === 1 ? '' : 's'} with no judge (${emptyAssign.join(', ')}).`,
      });
  }
  return true;
};

const validate = (
  seasonInfo: SeasonInfo,
  shows: ShowInput[],
  target: TargetEventInput,
  strict: boolean
): ValidationResult => {
  const dropped: DroppedRow[] = [];
  const warnings: Caveat[] = [];
  const fail = (row: DroppedRow) => {
    if (strict) throw new DciValidationError(`row rejected (${row.reason}) ${row.show}/${row.corpsKey}${row.detail ? `: ${row.detail}` : ''}`);
    dropped.push(row);
  };

  const start = seasonInfo.startDate;
  const end = seasonInfo.endDate;
  const targetDate = target.date;

  // Hard leakage guard: target date must be strictly after every history date.
  for (const show of shows) {
    if (show.date >= targetDate)
      throw new DciValidationError(
        `leakage: history show ${show.slug} (${show.date}) is not strictly before target date ${targetDate}`
      );
  }
  if (targetDate < start || targetDate > end)
    throw new DciValidationError(`target date ${targetDate} is outside the season (${start}..${end})`);

  const cleanShows: ShowInput[] = [];
  for (const show of shows) {
    const dateOk = show.date >= start && show.date <= end;
    if (!dateOk) {
      // Drop the whole show's rows (a single bad date for all rows).
      for (const r of show.results)
        fail({ show: show.slug, corpsKey: r.corpsKey, reason: 'out_of_season_date', detail: show.date });
      if (!strict) continue;
    }
    const seen = new Set<string>();
    const keptResults = [];
    for (const r of show.results) {
      // Duplicate (corps, show).
      if (seen.has(r.corpsKey)) {
        fail({ show: show.slug, corpsKey: r.corpsKey, reason: 'duplicate_corps_show' });
        continue;
      }
      seen.add(r.corpsKey);

      // Caption range + completeness.
      let outOfRange: string | null = null;
      let missing = false;
      for (const cap of CAPTIONS) {
        const v = r.captions[cap];
        if (v == null || !Number.isFinite(v)) missing = true;
        else if (v < 0 || v > 20) outOfRange = `${cap}=${v}`;
      }
      if (outOfRange) {
        fail({ show: show.slug, corpsKey: r.corpsKey, reason: 'caption_out_of_range', detail: outOfRange });
        continue;
      }
      if (missing) {
        // Incomplete rows are silently dropped by the builder; record for audit but
        // don't hard-throw (a partial sheet is a coverage gap, not a data error).
        dropped.push({ show: show.slug, corpsKey: r.corpsKey, reason: 'missing_captions' });
        continue;
      }
      // Caption-derived total consistency (only when a stated total is supplied).
      if (r.total != null && Number.isFinite(r.total)) {
        const derived = captionDerivedTotal(CAPTIONS.map((c) => r.captions[c]!));
        if (Math.abs(derived - r.total) > TOTAL_TOLERANCE) {
          fail({
            show: show.slug,
            corpsKey: r.corpsKey,
            reason: 'caption_total_mismatch',
            detail: `derived ${derived.toFixed(3)} vs stated ${r.total}`,
          });
          continue;
        }
      }
      keptResults.push(r);
    }
    if (keptResults.length) cleanShows.push({ ...show, results: keptResults });
  }

  // Cross-field score-sheet ⇄ judge-panel validation (§3.2). Runs on the supplied
  // shows (so panels on fully-dropped shows still get key-checked); non-blocking.
  let showsWithPanels = 0;
  for (const show of shows) {
    const scored = new Set<Caption>();
    for (const r of show.results)
      for (const cap of CAPTIONS) {
        const v = r.captions[cap];
        if (v != null && Number.isFinite(v)) scored.add(cap);
      }
    if (validatePanel(show.slug, show.judges, scored.size ? scored : null, warnings)) showsWithPanels++;
  }
  const targetHasPanel = validatePanel(`target ${target.slug}`, target.judges, null, warnings);

  return { cleanShows, dropped, warnings, panelStats: { showsWithPanels, targetHasPanel } };
};

export interface ValidationReport {
  ok: boolean;
  showsAccepted: number;
  scoreRowsAccepted: number;
  droppedRows: DroppedRow[];
  warnings: Caveat[];
}

/**
 * Run ONLY the Appendix B.4 input-consistency checks (no model load, no
 * prediction). Leakage and out-of-season target dates throw a
 * {@link DciValidationError}; row-level problems are reported as dropped rows
 * (strict:false, default) or throw (strict:true). Handy for a pre-flight check.
 */
export function validateInput(input: PredictInput, options: { strict?: boolean } = {}): ValidationReport {
  const shows = input.history ?? input.shows ?? [];
  const { cleanShows, dropped, warnings } = validate(input.seasonInfo, shows, input.target, options.strict ?? false);
  let scoreRows = 0;
  for (const show of cleanShows) scoreRows += show.results.length;
  return {
    ok: dropped.length === 0,
    showsAccepted: cleanShows.length,
    scoreRowsAccepted: scoreRows,
    droppedRows: dropped,
    warnings,
  };
}

// ── Tier + coverage mapping ──

const FIELD_PACE_CONFIDENT = 1;
const tierFor = (diag: FeatureBuildDiagnostics): { tier: ReadinessTier; code: TierCode } => {
  const n = diag.priorShows;
  if (n === 0) return { tier: 'cold_start', code: 'T3' };
  if (n <= 2) return { tier: 'sparse', code: 'T2' };
  return diag.fieldPace.confidence >= FIELD_PACE_CONFIDENT
    ? { tier: 'established', code: 'T0' }
    : { tier: 'partial', code: 'T1' };
};

const featureCoverage = (diag: FeatureBuildDiagnostics): Record<string, 'present' | 'defaulted' | 'masked'> => {
  const defaulted = new Set(diag.defaultedBlocks);
  const mark = (block: string): 'present' | 'defaulted' => (defaulted.has(block) ? 'defaulted' : 'present');
  return {
    trajectory: diag.seasonDebut ? 'defaulted' : mark('trajectory'),
    prior_seasons: diag.knownPriorSeasons ? mark('prior_seasons') : 'defaulted',
    subcaptions: diag.subcaptionCoverage > 0 ? mark('subcaptions') : 'defaulted',
    performance_order: diag.performanceOrderKnown ? 'present' : 'defaulted',
    judge_context: 'masked', // zeroed at serving (identity-agnostic) — no accuracy cost
    field_pace: diag.fieldPace.confidence > 0 ? mark('field_pace') : 'defaulted',
  };
};

// ── Core predict ──

export async function predict(input: PredictInput, options: PredictOptions = {}): Promise<PredictedShowResult> {
  // Ensure an asset provider is active (Node auto-installs; browsers must init() first).
  await ensureNodeProvider();
  const strict = options.strict ?? false;
  const shows = input.history ?? input.shows ?? [];
  const { seasonInfo, target } = input;

  // 1) Validate (B.4) → clean SeasonData for the builder.
  const validation = validate(seasonInfo, shows, target, strict);
  return runPrediction(input, validation, options);
}

/**
 * Post-validation prediction core, shared by {@link predict} and
 * {@link predictMany}. `replay` lets a caller inject a memoized temporal replay
 * (history-only) so a batch over one history replays just once.
 */
async function runPrediction(
  input: PredictInput,
  validation: ValidationResult,
  options: PredictOptions,
  replay?: TemporalReplay
): Promise<PredictedShowResult> {
  const { seasonInfo, target } = input;
  const { cleanShows, dropped, warnings, panelStats } = validation;
  const seasonData: SeasonData = { seasonInfo, shows: cleanShows, target };

  // 2) Build features (reusing a shared temporal replay when supplied).
  const context = loadFeatureContext();
  const curves = loadReferenceCurves();
  const { rows, diagnostics } = buildFeatureRows(seasonData, context, curves, replay);
  const diagByKey = new Map(diagnostics.map((d) => [d.corpsKey, d]));
  const nameByKey = new Map(target.lineup.map((e) => [e.corpsKey, e.corpsName ?? e.corpsKey]));

  // 3) Ensemble (cached) + bias calibration.
  const members = await getEnsemble(options);
  const biasCalibration = options.biasCalibration ?? loadBiasCalibration();

  // 4) Recal offsets: explicit override > fit from observations > inactive ({}).
  const divisions = [...new Set(target.lineup.map((e) => e.division))];
  const recalConfig = options.recalConfig ?? PRODUCTION_RECAL_CONFIG;
  let recalOffsets: Record<string, number> = {};
  const recalAudit: DivisionRecalAudit[] = [];
  if (options.recalOffsets) {
    recalOffsets = options.recalOffsets;
    for (const division of divisions)
      recalAudit.push({
        division,
        offset: recalOffsets[division] ?? 0,
        poolN: -1,
        thinTaper: 1,
        active: (recalOffsets[division] ?? 0) !== 0,
      });
  } else if (input.recalObservations?.length) {
    const fits = fitRecalOffsets(input.recalObservations, divisions, target.date, recalConfig);
    for (const division of divisions) {
      const fit = fits[division]!;
      recalOffsets[division] = fit.offset;
      recalAudit.push({ division, offset: fit.offset, poolN: fit.poolN, thinTaper: fit.thinTaper, active: fit.poolN > 0 });
    }
  } else {
    for (const division of divisions)
      recalAudit.push({ division, offset: 0, poolN: 0, thinTaper: 0, active: false });
  }

  // 5) Serve each row.
  const served = rows.map((row) => {
    const prediction = servePrediction(
      members,
      { sequence: row.sequence, staticFeatures: row.staticFeatures },
      { division: row.division, biasCalibration, recalOffsets }
    );
    return { row, prediction };
  });

  // 6) Rank by total desc (per whole field — matches prod output ordering).
  const ranked = served
    .filter((s): s is { row: (typeof served)[number]['row']; prediction: ServedPrediction } => s.prediction != null)
    .sort((a, b) => b.prediction.total - a.prediction.total);

  const predictions: CorpsPrediction[] = ranked.map(({ row, prediction }, i) => ({
    corps: nameByKey.get(row.corpsKey) ?? row.corpsName ?? row.corpsKey,
    corpsKey: row.corpsKey,
    division: row.division,
    rank: i + 1,
    total: prediction.total,
    GE: prediction.GE,
    Visual: prediction.Visual,
    Music: prediction.Music,
    captions: prediction.captions,
    intervals: prediction.intervals,
  }));

  // 7) Readiness per corps.
  const readinessCorps: CorpsReadiness[] = ranked.map(({ row, prediction }) => {
    const diag = diagByKey.get(row.corpsKey);
    const t = diag ? tierFor(diag) : { tier: 'cold_start' as ReadinessTier, code: 'T3' as TierCode };
    return {
      corpsKey: row.corpsKey,
      corps: nameByKey.get(row.corpsKey) ?? row.corpsName ?? row.corpsKey,
      division: row.division,
      tier: t.tier,
      tierCode: t.code,
      priorShows: diag?.priorShows ?? 0,
      sequenceFill: prediction.nonPadSteps,
      featureCoverage: diag
        ? featureCoverage(diag)
        : { judge_context: 'masked' },
      fieldPace: diag?.fieldPace ?? { observations: 0, corps: 0, dates: 0, confidence: 0 },
    };
  });

  // 8) Caveats (ordered: warns before infos within each source; dropped rows first).
  const caveats: Caveat[] = [...warnings];
  if (dropped.length) {
    const byReason = new Map<string, number>();
    for (const d of dropped) byReason.set(d.reason, (byReason.get(d.reason) ?? 0) + 1);
    for (const [reason, count] of byReason)
      caveats.push({
        severity: reason === 'missing_captions' ? 'info' : 'warn',
        message: `${count} score row${count === 1 ? '' : 's'} dropped: ${reason.replace(/_/g, ' ')}`,
      });
  }
  for (const r of readinessCorps) {
    if (r.tier === 'cold_start')
      caveats.push({ severity: 'warn', corpsKey: r.corpsKey, message: `${r.corps}: no prior shows supplied — 'debut' calibration bucket, curve-anchored (widest error).` });
    else if (r.tier === 'sparse')
      caveats.push({ severity: 'warn', corpsKey: r.corpsKey, message: `${r.corps}: only ${r.priorShows} prior show${r.priorShows === 1 ? '' : 's'} — 'sparse' calibration bucket, expect wider error.` });
    if (r.fieldPace.confidence > 0 && r.fieldPace.confidence < 1)
      caveats.push({ severity: 'info', corpsKey: r.corpsKey, message: `${r.corps}: thin field-pace pool (${r.fieldPace.corps} corps / ${r.fieldPace.dates} dates, confidence ${r.fieldPace.confidence.toFixed(2)}) — trajectory shrunk toward historical.` });
  }
  for (const audit of recalAudit) {
    if (!audit.active && audit.poolN === 0)
      caveats.push({ severity: 'info', message: `recal inactive for ${audit.division}: no resolved observations supplied — offset defaults to 0.` });
    else if (audit.active && audit.thinTaper > 0 && audit.thinTaper < 1)
      caveats.push({ severity: 'info', message: `recal pool for ${audit.division} is thin (n=${audit.poolN}) — offset damped to ${Math.round(audit.thinTaper * 100)}%.` });
  }

  // 9) Input audit.
  const corpsKeys = new Set<string>();
  let scoreRows = 0;
  for (const show of cleanShows) for (const r of show.results) { corpsKeys.add(r.corpsKey); scoreRows++; }
  const inputAudit: InputAudit = {
    showsCounted: cleanShows.length,
    corpsCounted: corpsKeys.size,
    scoreRowsCounted: scoreRows,
    droppedRows: dropped,
    normalizations: [],
    showsWithPanels: panelStats.showsWithPanels,
    targetHasPanel: panelStats.targetHasPanel,
  };

  const result: PredictedShowResult = {
    predictions,
    readiness: { corps: readinessCorps, recal: recalAudit },
    inputAudit,
    caveats,
    model_metadata: {
      model_dir: SDK_MODEL_DIR,
      ensembleSize: members.length,
      generated_at: new Date().toISOString(),
    },
  };

  // 10) Optional explain.
  if (options.explain) {
    result.explain = ranked.map(({ row, prediction }) => ({
      corpsKey: row.corpsKey,
      baselineRecap: prediction.baselineRecap,
      trendSlopes: prediction.trendSlopes,
      fieldPace: diagByKey.get(row.corpsKey)?.fieldPace ?? { observations: 0, corps: 0, dates: 0, confidence: 0 },
      biasOffset: prediction.biasOffset,
      recalOffset: prediction.recalOffset,
      historyBucket: prediction.historyBucket,
    }));
  }

  return result;
}

// ── Batch prediction + what-if (PLAN §5 streaming/what-if) ──

/**
 * Assign a stable id to a `shows` array by reference so batches that share one
 * history object (the common what-if / lineup-sweep case) collapse to a single
 * temporal replay. Different array references — even with identical content —
 * get different ids and are replayed separately (cache-by-reference contract).
 */
const _replayShowsIds = new WeakMap<object, number>();
let _replayNextId = 0;
const replayKey = (input: PredictInput, strict: boolean): string => {
  const shows = input.history ?? input.shows;
  let id = -1;
  if (shows) {
    let got = _replayShowsIds.get(shows);
    if (got === undefined) {
      got = _replayNextId++;
      _replayShowsIds.set(shows, got);
    }
    id = got;
  }
  const s = input.seasonInfo;
  // The replay depends only on (shows, seasonInfo, target.date, strict).
  return `${id}|${s.year}|${s.startDate}|${s.endDate}|${input.target.date}|${strict ? 1 : 0}`;
};

/**
 * Predict many targets in one call. Shares a single (cached) tfjs ensemble load
 * across every input, and replays each unique `(seasonInfo, shows, target.date)`
 * history through the {@link TemporalState} machine exactly once — reusing it for
 * all inputs that share that history (keyed by the `shows` array reference).
 *
 * The temporal replay + feature-context load is the bulk of per-call CPU, so a
 * lineup sweep / what-if fan-out over one history (dozens of targets sharing the
 * same `history` array) runs the replay a single time instead of N times, on top
 * of the ensemble already being loaded once. Results preserve input order.
 *
 * ```ts
 * const base = { seasonInfo, history, target };
 * const scenarios = [base, whatIf(base, { addCorps: [{ corps: Corps.Bluecoats }] })];
 * const [a, b] = await predictMany(scenarios);   // one ensemble load, one replay
 * ```
 */
export async function predictMany(
  inputs: PredictInput[],
  options: PredictOptions = {}
): Promise<PredictedShowResult[]> {
  await ensureNodeProvider();
  const strict = options.strict ?? false;
  const context = loadFeatureContext();
  const replayCache = new Map<string, TemporalReplay>();
  const out: PredictedShowResult[] = [];
  for (const input of inputs) {
    const shows = input.history ?? input.shows ?? [];
    const validation = validate(input.seasonInfo, shows, input.target, strict);
    const key = replayKey(input, strict);
    let replay = replayCache.get(key);
    if (!replay) {
      replay = replayTemporal(
        { seasonInfo: input.seasonInfo, shows: validation.cleanShows, target: input.target },
        context
      );
      replayCache.set(key, replay);
    }
    out.push(await runPrediction(input, validation, options, replay));
  }
  return out;
}

/** A corps to splice into the target lineup — a `Corps`-like object or a bare key. */
export interface WhatIfAddCorps {
  /** Explicit corps key (registry key or any consistent id). */
  corpsKey?: string;
  /** A `Corps`-like identity (e.g. `Corps.Bluecoats` or `Corps.make(...)`). */
  corps?: { key: string; name?: string; division?: DivisionName };
  corpsName?: string;
  /** Required unless `corps.division` is set. */
  division?: DivisionName;
}

export interface WhatIfChanges {
  /** Corps to add to `target.lineup` (deduped by key). */
  addCorps?: WhatIfAddCorps[];
  /** Corps keys to remove from `target.lineup`. */
  removeCorps?: string[];
  /** Move the prediction to a different target date. */
  date?: string;
}

/**
 * Pure lineup-perturbation helper: returns a NEW {@link PredictInput} with the
 * target lineup and/or date modified. Does not predict — feed the result to
 * {@link predict} or {@link predictMany}. `seasonInfo`, `history`, and
 * `recalObservations` are carried through by reference (so a batch of what-ifs
 * shares one history → one replay in `predictMany`).
 */
export function whatIf(base: PredictInput, changes: WhatIfChanges): PredictInput {
  const removed = new Set(changes.removeCorps ?? []);
  let lineup = base.target.lineup.filter((entry) => !removed.has(entry.corpsKey));
  for (const add of changes.addCorps ?? []) {
    const key = add.corpsKey ?? add.corps?.key;
    if (!key) throw new DciValidationError('whatIf.addCorps entry needs a corpsKey or corps');
    const division = add.division ?? add.corps?.division;
    if (!division) throw new DciValidationError(`whatIf.addCorps "${key}" needs a division`);
    if (lineup.some((entry) => entry.corpsKey === key)) continue;
    lineup = [...lineup, { corpsKey: key, corpsName: add.corpsName ?? add.corps?.name, division }];
  }
  return {
    ...base,
    target: {
      ...base.target,
      lineup,
      ...(changes.date ? { date: changes.date } : {}),
    },
  };
}
