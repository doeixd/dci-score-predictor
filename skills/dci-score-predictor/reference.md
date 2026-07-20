# dci-score-predictor — API reference

Two import paths over one prediction path:

- `dci-score-predictor` — typed core API (keyed input).
- `dci-score-predictor/simple` — loose input, smart name matching, inference
  audit. Normalizes then delegates to the core `predict`.

Both are async and return the same `PredictedShowResult`.

## Simple API — `import { predict } from 'dci-score-predictor/simple'`

```ts
predict(input: LooseInput, options?: PredictOptions): Promise<PredictedShowResult>
```

```ts
interface LooseInput {
  seasonInfo?: { year?: number; start?: string; end?: string }; // inferred from dates if omitted
  history: Array<{
    show: string;                 // free text; slugified
    date: string;                 // ISO date
    scores: Array<{
      corps: string;              // smart-matched to the registry
      total?: number;             // derived from captions when absent
      captions?: Record<string, number>;               // { GE1: 17.4, ... }
      sheet?: Array<{ caption: string; judge?: string;  // alt form; breakdown summed
                      breakdown?: number[]; score?: number }>;
      performanceOrder?: number;
      division?: string;          // required to add an unknown corps
    }>;
  }>;
  target: { show: string; date: string; lineup: string[] };    // lineup = corps names
}
```

Throws `CorpsNotFoundError` (unknown corps, no division hint),
`DciValidationError` (unknown caption, uncovered division, leakage/consistency).
Caption labels and keys are normalized (`Music Analysis` → `MA`).

## Core API — `import { predict, validateInput } from 'dci-score-predictor'`

```ts
predict(input: PredictInput, options?: PredictOptions): Promise<PredictedShowResult>

interface PredictInput {
  seasonInfo: { year: number; startDate: string; endDate: string };
  history?: ShowInput[];          // resolved (scored) shows before the target
  shows?: ShowInput[];            // alias for history
  target: TargetEventInput;
  recalObservations?: RecalObservation[];   // fit per-division recal offset
}

interface ShowInput {
  slug: string; date: string; percentThrough?: number;
  results: Array<{
    corpsKey: string; corpsName?: string; division: 'World Class' | 'Open Class';
    total?: number;
    captions: Record<'GE1'|'GE2'|'VP'|'VA'|'CG'|'MB'|'MA'|'MP', number>;
    subcaptions?: Record<string, { content: number; achievement: number }>;
    performanceOrder?: { inClass?: number; overall?: number };
  }>;
}

interface TargetEventInput {
  slug: string; date: string; percentThrough?: number;
  lineup: Array<{ corpsKey: string; corpsName?: string; division: string }>;
}

interface PredictOptions {
  members?: number;               // ensemble seeds to load, 1–8 (default all 8)
  modelsDir?: string;             // override packaged assets/models
  explain?: boolean;              // attach explain[] (default false)
  strict?: boolean;               // row failures throw vs drop (default false)
  recalOffsets?: Record<string, number>;   // precomputed; overrides fitting
  biasCalibration?: Record<string, number>;
  recalConfig?: RecalConfig;
}
```

### `validateInput(input, { strict? }): ValidationReport`

Runs only the input-consistency checks — no model load, no prediction. Leakage
(history not strictly before target) and out-of-season target dates throw
`DciValidationError`; row problems are dropped (or throw under `strict`).

```ts
interface ValidationReport {
  ok: boolean; showsAccepted: number; scoreRowsAccepted: number;
  droppedRows: DroppedRow[]; warnings: Caveat[];
}
```

## Result — `PredictedShowResult`

```ts
interface PredictedShowResult {
  predictions: CorpsPrediction[];           // ranked by total desc, rank 1..n
  readiness: { corps: CorpsReadiness[]; recal: DivisionRecalAudit[] };
  inputAudit: InputAudit;
  caveats: Caveat[];
  model_metadata: { model_dir: string; ensembleSize: number; generated_at: string };
  explain?: CorpsExplain[];
}

interface CorpsPrediction {
  rank: number; corps: string; corpsKey: string; division: string;
  total: number; GE: number; Visual: number; Music: number;
  captions: Record<Caption, number>;
  intervals: { low: Record<Caption, number>; high: Record<Caption, number> };
}

interface CorpsReadiness {
  corpsKey: string; corps: string; division: string;
  tier: 'established' | 'partial' | 'sparse' | 'cold_start';
  tierCode: 'T0' | 'T1' | 'T2' | 'T3';
  priorShows: number; sequenceFill: number;   // of 15
  featureCoverage: Record<string, 'present' | 'defaulted' | 'masked'>;
  fieldPace: { observations: number; corps: number; dates: number; confidence: number };
}

interface DivisionRecalAudit { division: string; offset: number; poolN: number; thinTaper: number; active: boolean }
interface DroppedRow { show: string; corpsKey: string; reason: string; detail?: string }
interface NameNormalization { input: string; matched: string; method: 'exact'|'alias'|'fuzzy'|'made'; kind: 'corps'|'judge'|'caption' }
interface InputAudit { showsCounted: number; corpsCounted: number; scoreRowsCounted: number; droppedRows: DroppedRow[]; normalizations: NameNormalization[] }
interface Caveat { severity: 'info' | 'warn'; message: string; corpsKey?: string }
interface CorpsExplain { corpsKey: string; baselineRecap: number[]; trendSlopes: number[]; fieldPace: {...}; biasOffset: number; recalOffset: number; historyBucket: string }
```

`total = GE1 + GE2 + (VP+VA+CG)/2 + (MB+MA+MP)/2`; captions ∈ [0,20]; totals
land ~60–100. Errors: `DciValidationError`, `CorpsNotFoundError` (simple).

## Recal (optional)

Supply either `recalOffsets` (precomputed per-division additive offset) or
`recalObservations` (resolved actual-vs-context shows, within 14 days, same
division) to fit an offset; with a thin pool it tapers toward 0.
