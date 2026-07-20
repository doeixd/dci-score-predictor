// Effect-native surface (dci-score-predictor/effect). THIN by design: the value
// here is (1) Schema validation of the public input shapes at the boundary and
// (2) typed, catchable errors — the prediction internals stay the existing plain
// `predict()` code in ./predict.ts (no logic is duplicated). The Promise API is
// the default entry; this is for consumers already living in Effect.
//
// Effect v4 beta (effect@4.0.0-beta.99): Schema lives in core
// (`import { Schema } from 'effect'`); constraints are applied with
// `.check(Schema.isBetween(...) | Schema.isPattern(...))`; decoding is
// `Schema.decodeUnknownEffect`; validation failures surface as `Schema.SchemaError`
// (tag 'SchemaError'); tagged errors use `Data.TaggedError`.
// Eager Node provider install (parity with the Promise entry); browser uses ./browser.
import { installNodeProvider } from './assets/node-provider.js';
installNodeProvider();
import { Data, Effect, Schema } from 'effect';
import {
  predict as corePredict,
  DciValidationError,
  type PredictInput as CorePredictInput,
  type PredictOptions,
  type PredictedShowResult,
} from './predict.js';

// ── Reusable checked primitives ──

/** Caption score on the 0–20 recap scale. */
const CaptionScore = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 20 }));
/** ISO date string (YYYY-MM-DD, optional trailing time — matches fixture `...T00:00:00.000Z`). */
const IsoDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}/));
/** Percent-through-season, 0–100. */
const PercentThrough = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

const Division = Schema.Literals(['World Class', 'Open Class', 'All Age']);

const optScore = Schema.optional(CaptionScore);
/** Partial per-caption record of 0–20 scores (all 8 optional). */
const CaptionScores = Schema.Struct({
  GE1: optScore, GE2: optScore, VP: optScore, VA: optScore,
  CG: optScore, MB: optScore, MA: optScore, MP: optScore,
});

const optJudges = Schema.optional(Schema.Array(Schema.String));
/** Partial per-caption record of judge-id arrays (all 8 optional). */
const JudgePanel = Schema.Struct({
  GE1: optJudges, GE2: optJudges, VP: optJudges, VA: optJudges,
  CG: optJudges, MB: optJudges, MA: optJudges, MP: optJudges,
});

const optBreakdown = Schema.optional(
  Schema.Struct({ content: Schema.Number, achievement: Schema.Number })
);
const Subcaptions = Schema.Struct({
  GE1: optBreakdown, GE2: optBreakdown, VP: optBreakdown, VA: optBreakdown,
  CG: optBreakdown, MB: optBreakdown, MA: optBreakdown, MP: optBreakdown,
});

const PerformanceOrder = Schema.Struct({
  inClass: Schema.optional(Schema.Number),
  inClassCount: Schema.optional(Schema.Number),
  overall: Schema.optional(Schema.Number),
  overallCount: Schema.optional(Schema.Number),
});

// ── Public input schemas ──

export const SeasonInfo = Schema.Struct({
  year: Schema.Int.check(Schema.isBetween({ minimum: 1900, maximum: 2100 })),
  startDate: IsoDate,
  endDate: IsoDate,
});

export const PerformanceInput = Schema.Struct({
  corpsKey: Schema.String,
  corpsName: Schema.optional(Schema.String),
  division: Division,
  captions: CaptionScores,
  total: Schema.optional(Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 200 }))),
  subcaptions: Schema.optional(Subcaptions),
  performanceOrder: Schema.optional(PerformanceOrder),
});

export const ShowInput = Schema.Struct({
  slug: Schema.String,
  date: IsoDate,
  percentThrough: Schema.optional(PercentThrough),
  results: Schema.Array(PerformanceInput),
  judges: Schema.optional(JudgePanel),
});

export const TargetEventInput = Schema.Struct({
  slug: Schema.String,
  date: IsoDate,
  percentThrough: Schema.optional(PercentThrough),
  lineup: Schema.Array(
    Schema.Struct({
      corpsKey: Schema.String,
      corpsName: Schema.optional(Schema.String),
      division: Division,
    })
  ),
  judges: Schema.optional(JudgePanel),
});

const RecalObservation = Schema.Struct({
  predicted: Schema.Number,
  actual: Schema.Number,
  division: Schema.String,
  date: IsoDate,
});

export const PredictInput = Schema.Struct({
  seasonInfo: SeasonInfo,
  history: Schema.optional(Schema.Array(ShowInput)),
  shows: Schema.optional(Schema.Array(ShowInput)),
  target: TargetEventInput,
  recalObservations: Schema.optional(Schema.Array(RecalObservation)),
});

/** Validated input type (decoded output of the {@link PredictInput} schema). */
export type PredictInput = Schema.Schema.Type<typeof PredictInput>;

// ── Tagged errors (Data.TaggedError — catchable via Effect.catchTag) ──

/** Input failed schema validation or a data-quality invariant (Appendix B.4). */
export class ValidationError extends Data.TaggedError('ValidationError')<{
  readonly message: string;
  /** The underlying SchemaError (decode failures) or DciValidationError (invariants). */
  readonly cause?: unknown;
}> {}

/** The tfjs ensemble / calibration assets could not be loaded. */
export class ModelLoadError extends Data.TaggedError('ModelLoadError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Inference or serving failed after inputs validated and models loaded. */
export class PredictionError extends Data.TaggedError('PredictionError')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// ── Decode: unknown → validated input ──

/**
 * Decode arbitrary unknown input into a validated {@link PredictInput}, failing
 * with a {@link ValidationError} (wrapping the underlying `Schema.SchemaError`,
 * whose `.message` carries the precise field path + constraint).
 */
export const decodePredictInput = (
  input: unknown
): Effect.Effect<PredictInput, ValidationError> =>
  Schema.decodeUnknownEffect(PredictInput)(input).pipe(
    Effect.catchTag(
      'SchemaError',
      (error) => new ValidationError({ message: error.message, cause: error })
    )
  );

// ── Predict: wrap the core Promise pipeline, mapping thrown errors to tags ──

const MODEL_ERROR_HINT = /(model|weights|ensemble|tfjs|tensor|ENOENT|assets)/i;

const toTaggedError = (
  err: unknown
): ValidationError | ModelLoadError | PredictionError => {
  if (err instanceof DciValidationError) {
    return new ValidationError({ message: err.message, cause: err });
  }
  const message = err instanceof Error ? err.message : String(err);
  if (MODEL_ERROR_HINT.test(message)) {
    return new ModelLoadError({ message, cause: err });
  }
  return new PredictionError({ message, cause: err });
};

/**
 * Effect-native predict. Wraps the core Promise `predict()` and maps its thrown
 * failures onto typed, catchable errors:
 * `DciValidationError → ValidationError`, asset/tfjs failures → `ModelLoadError`,
 * anything else during inference → `PredictionError`. Success is the same
 * `PredictedShowResult` the Promise API returns.
 */
export const predictEffect = (
  input: CorePredictInput,
  options?: PredictOptions
): Effect.Effect<PredictedShowResult, ValidationError | ModelLoadError | PredictionError> =>
  Effect.tryPromise({
    try: () => corePredict(input, options),
    catch: toTaggedError,
  });

export type { PredictedShowResult, PredictOptions } from './predict.js';
