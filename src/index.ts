// dci-score-predictor — public entrypoint.
// Layers: domain (identities) → features (SeasonData → model inputs) → model
// (tfjs ensemble) → recal (division offsets) → predict (orchestration +
// diagnostics). The Promise API here is the default; see ./effect for the
// Effect-native surface and ./simple for the loose-input API.

// Eagerly install the Node fs-backed asset provider (sync reader + default async
// provider) so the synchronous domain matchers work on import in Node. The
// browser entry ('dci-score-predictor/browser') deliberately omits this. Called
// as a function (not a bare import) so `sideEffects: false` can't tree-shake it.
import { installNodeProvider } from './assets/node-provider.js';
installNodeProvider();

export {
  init,
  fetchAssets,
  setAssetProvider,
  type AssetProvider,
  type InitOptions,
} from './assets/provider.js';
export {
  CAPTIONS,
  captionDerivedTotal,
  type Caption,
  type CaptionInterval,
  type FeatureRow,
  type HistoryBucket,
} from './model/contract.js';
export {
  Division,
  Caption as Captions,
  matchCorps,
  matchJudge,
  matchCaption,
  makeCorps,
  normalizeName,
  type Judge,
  type CaptionDef,
  type CorpsMatch,
} from './domain/domain.js';
// Type-safe corps namespace (PLAN §3.1): DCI.Corps.BlueDevils / .lookup / .named / .make / .Unknown.
// `Corps` here carries both the namespace value and the Corps instance type.
export { Corps, CorpsNotFoundError, type KnownCorpsName } from './domain/corps-namespace.js';
export {
  loadEnsemble,
  loadBiasCalibration,
  type LoadEnsembleOptions,
} from './model/loader.js';
export { servePrediction, type ServeOptions, type ServedPrediction } from './model/serve.js';
export type { EnsembleMember, MemberPrediction, PredictionInput } from './model/inference.js';
export {
  fitRecalOffset,
  fitRecalOffsets,
  PRODUCTION_RECAL_CONFIG,
  type RecalConfig,
  type RecalFit,
  type RecalObservation,
} from './recal/recal.js';
export type {
  DivisionName,
  SeasonInfo,
  ShowInput,
  PerformanceInput,
  TargetEventInput,
  SeasonData,
} from './features/types.js';
export {
  predict,
  validateInput,
  DciValidationError,
  SDK_MODEL_DIR,
  type ValidationReport,
  type PredictInput,
  type PredictOptions,
  type PredictedShowResult,
  type CorpsPrediction,
  type CorpsReadiness,
  type DivisionRecalAudit,
  type InputAudit,
  type DroppedRow,
  type NameNormalization,
  type Caveat,
  type CorpsExplain,
  type ModelMetadata,
  type ReadinessTier,
  type TierCode,
} from './predict.js';
