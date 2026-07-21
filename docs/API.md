# API reference

Complete public surface of `dci-score-predictor` across its four entry points.
Every prediction — no matter which entry you call — flows through one core
`predict()` pipeline (see [ARCHITECTURE.md](./ARCHITECTURE.md)); the entries
differ only in how input is shaped and how errors surface.

| Import specifier | Purpose |
|---|---|
| `dci-score-predictor` | Typed **core** API — keyed input, Promise-based. |
| `dci-score-predictor/simple` | **Loose** plain-object input, smart name/division matching + audit. |
| `dci-score-predictor/effect` | **Effect-native** — Schema validation at the boundary, tagged catchable errors. |
| `dci-score-predictor/browser` | Same internals, but every asset is loaded over `fetch` (no `node:*`). |

All entries are async and resolve to the same [`PredictedShowResult`](#predictedshowresult).
Type declarations below are copied verbatim from source; field tables document
defaults and semantics.

- [Core API](#core-api-dci-score-predictor)
- [Simple API](#simple-api-dci-score-predictorsimple)
- [Effect API](#effect-api-dci-score-predictoreffect)
- [Browser API](#browser-api-dci-score-predictorbrowser)
- [Domain identities](#domain-identities)
- [Shared result & input types](#shared-result--input-types)
- [Advanced / low-level layer](#advanced--low-level-layer)

---

## Core API — `dci-score-predictor`

```ts
import {
  predict, validateInput, DciValidationError,
  Corps, CorpsNotFoundError,
  Division, Captions, matchCorps, matchJudge, matchCaption, makeCorps, normalizeName,
} from 'dci-score-predictor';
```

Importing the core (or `/simple`, `/effect`) entry eagerly installs the Node
`fs`-backed asset provider, so the synchronous domain matchers and `predict()`
work on import in Node with zero setup. (The `/browser` entry deliberately omits
this — see [Browser API](#browser-api-dci-score-predictorbrowser).)

### `predict(input, options?)`

```ts
function predict(input: PredictInput, options?: PredictOptions): Promise<PredictedShowResult>
```

Validate → build features → run the 8-seed tfjs ensemble → bias-calibrate →
division-recal → rank the field. Returns a fully-diagnosed
[`PredictedShowResult`](#predictedshowresult).

#### `PredictInput`

```ts
interface PredictInput {
  seasonInfo: SeasonInfo;
  /** Resolved (already-scored) shows strictly before the target date. */
  history?: ShowInput[];
  /** Alias for `history` when passing a full SeasonData-like object. */
  shows?: ShowInput[];
  target: TargetEventInput;
  /** Resolved shows used to fit the per-division recal offset (leakage-safe). */
  recalObservations?: RecalObservation[];
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `seasonInfo` | [`SeasonInfo`](#seasoninfo) | yes | `{ year, startDate, endDate }`; drives `percentThrough`. |
| `history` | `ShowInput[]` | no | Scored shows **strictly before** `target.date`. Omit for a debut/cold-start run. |
| `shows` | `ShowInput[]` | no | Alias for `history` (accepts a full `SeasonData`-shaped object). If both are set, `history` wins. |
| `target` | [`TargetEventInput`](#targeteventinput) | yes | The show to predict; `lineup` is the corps to score. |
| `recalObservations` | [`RecalObservation`](#recalobservation)`[]` | no | Fit the per-division offset from your own resolved shows. See [recal](#recal). |

#### `PredictOptions`

```ts
interface PredictOptions {
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
```

| Option | Type | Default | Notes |
|---|---|---|---|
| `members` | `number` | `8` (all seeds) | `1`–`8`. Fewer seeds = faster/lighter load, slightly wider error. `members: 1` is the fast tier. |
| `provider` | [`AssetProvider`](#assetprovider) | Node fs provider | Explicit asset source; required in non-Node runtimes (or use `/browser`). |
| `explain` | `boolean` | `false` | Attach [`explain[]`](#corpsexplain) attribution. |
| `strict` | `boolean` | `false` | Row problems throw vs. drop-and-warn. Leakage & out-of-season target **always** throw regardless. |
| `recalOffsets` | `Record<string, number>` | — | Precomputed per-division additive offset; **overrides** `recalObservations`. |
| `biasCalibration` | `Record<string, number>` | shipped asset | Override the `${division}|${bucket}` bias table. |
| `recalConfig` | [`RecalConfig`](#recalconfig) | `PRODUCTION_RECAL_CONFIG` | Shrinkage/recency/trim/taper knobs for recal fitting. |

Precedence for the division offset: `recalOffsets` (explicit) > fit from
`recalObservations` > inactive (`0`).

#### Error behavior

- **Leakage** (any `history` show dated on/after `target.date`) → throws
  [`DciValidationError`](#dcivalidationerror), always.
- **Out-of-season target** (`target.date` outside `seasonInfo.startDate..endDate`)
  → throws `DciValidationError`, always.
- **Row-level problems** (caption total mismatch, caption out of `[0,20]`,
  duplicate corps in a show, out-of-season show date, missing captions): under
  `strict: true` they throw; under the default `strict: false` the offending
  rows are dropped and reported in `inputAudit.droppedRows` + `caveats`.
- **Asset/model failures** (missing weights, tfjs errors) bubble up as plain
  `Error`s (the Effect entry maps these to `ModelLoadError`).

#### Example — core predict

```ts
import { predict } from 'dci-score-predictor';

const result = await predict(
  {
    seasonInfo: { year: 2026, startDate: '2026-06-26', endDate: '2026-08-08' },
    history: [
      {
        slug: 'dci-southwestern',
        date: '2026-07-18',
        results: [
          { corpsKey: 'blue-devils', division: 'World Class',
            captions: { GE1: 19.5, GE2: 19.4, VP: 19.3, VA: 19.2, CG: 19.1, MB: 19.6, MA: 19.4, MP: 19.7 } },
          { corpsKey: 'bluecoats', division: 'World Class',
            captions: { GE1: 19.1, GE2: 18.9, VP: 18.8, VA: 18.7, CG: 18.6, MB: 19.2, MA: 19.0, MP: 19.3 } },
        ],
      },
    ],
    target: {
      slug: 'dci-prelims', date: '2026-08-06',
      lineup: [
        { corpsKey: 'blue-devils', corpsName: 'Blue Devils', division: 'World Class' },
        { corpsKey: 'bluecoats',   corpsName: 'Bluecoats',   division: 'World Class' },
      ],
    },
  },
  { members: 8, explain: true },
);

for (const p of result.predictions) console.log(p.rank, p.corps, p.total.toFixed(3));
for (const c of result.caveats) console.log(`[${c.severity}] ${c.message}`);
```

### `validateInput(input, options?)`

```ts
function validateInput(input: PredictInput, options?: { strict?: boolean }): ValidationReport

interface ValidationReport {
  ok: boolean;
  showsAccepted: number;
  scoreRowsAccepted: number;
  droppedRows: DroppedRow[];
  warnings: Caveat[];
}
```

Runs **only** the input-consistency checks (Appendix B.4) — no model load, no
prediction. A cheap pre-flight. Leakage and out-of-season target dates throw
`DciValidationError`; row-level problems are reported as `droppedRows`
(default) or throw (`strict: true`). `ok` is `true` when nothing was dropped.

```ts
import { validateInput } from 'dci-score-predictor';

const report = validateInput({ seasonInfo, history, target });
if (!report.ok) {
  console.warn(`${report.droppedRows.length} rows dropped`, report.droppedRows);
}
console.log(`accepted ${report.showsAccepted} shows / ${report.scoreRowsAccepted} rows`);
```

### `DciValidationError`

```ts
class DciValidationError extends Error { name: 'DciValidationError' }
```

Thrown for leakage, out-of-season target dates, `strict` row rejections, and (in
the simple API) unknown captions / uncovered divisions.

### `SDK_MODEL_DIR`

```ts
const SDK_MODEL_DIR = 'clean-v10-fieldpace-recal-sdk';
```

The model-dir tag echoed in `result.model_metadata.model_dir`.

---

## Simple API — `dci-score-predictor/simple`

```ts
import { predict, CorpsNotFoundError } from 'dci-score-predictor/simple';
```

Loose plain objects in: corps and caption names are smart-matched to the shipped
registry, divisions inferred, and everything inferred is reported in
`inputAudit.normalizations`. It normalizes, then delegates to the **same** core
`predict()` — one validation path, one prediction path. Same `PredictOptions`,
same `PredictedShowResult`.

### `predict(input, options?)`

```ts
function predict(input: LooseInput, options?: PredictOptions): Promise<PredictedShowResult>
```

#### `LooseInput`

```ts
interface LooseInput {
  seasonInfo?: { year?: number; start?: string; end?: string };
  history: LooseShow[];
  target: LooseTarget;
}

interface LooseShow {
  show: string;            // free text; slugified
  date: string;            // ISO date
  scores: LooseScoreRow[];
}

interface LooseScoreRow {
  corps: string;                              // smart-matched to the registry
  /** Overall total; derived from captions when absent. */
  total?: number;
  /** { GE1: 17.4, ... } or { MA: 8.9, ... } — caption keys/labels normalized. */
  captions?: Record<string, number>;
  /** Alternative sheet form with a judge/breakdown per caption (breakdown summed). */
  sheet?: Array<{ caption: string; judge?: string; breakdown?: number[]; score?: number }>;
  performanceOrder?: number;
  /** Division hint (used when the corps is unknown to the registry). */
  division?: string;
}

interface LooseTarget {
  show: string;
  date: string;
  lineup: string[];        // corps names, smart-matched
}
```

| Field | Default when omitted |
|---|---|
| `seasonInfo.start` / `.end` | Earliest / latest date across `history` + `target`. |
| `seasonInfo.year` | Year parsed from `target.date` (or `start`). |
| `scores[].total` | Derived from captions when all 8 are present (`GE1+GE2+(VP+VA+CG)/2+(MB+MA+MP)/2`). |
| `scores[].captions` vs `.sheet` | Either form works; `sheet` sums `breakdown` when no explicit `score`. |

Caption labels are normalized (`"Music Analysis"` → `MA`,
`"Visual - Analysis"` → `VA`, `"guard"` → `CG`). Divisions are mapped from the
registry (or the `division` hint) to World Class / Open Class; **All Age /
A-Class / SoundSport raise `DciValidationError`** (uncovered).

#### Errors

- `CorpsNotFoundError` — a corps name can't be matched and no `division` hint was
  supplied to add it as a new corps. Carries `.suggestions: string[]`.
- `DciValidationError` — unknown caption key, uncovered division, or any core
  invariant (leakage/consistency).

#### Example — simple predict

```ts
import { predict } from 'dci-score-predictor/simple';

const out = await predict({
  history: [
    { show: 'DCI Southwestern', date: '2026-07-18', scores: [
      { corps: 'blue devils', captions: { GE1: 17.5, GE2: 17.3, VP: 17.0, VA: 17.1, CG: 16.9, MB: 18.0, MA: 17.6, MP: 18.1 } },
      { corps: 'bluecoats',   captions: { GE1: 17.1, GE2: 16.9, VP: 16.8, VA: 16.7, CG: 16.5, MB: 17.4, MA: 17.2, MP: 17.5 } },
      // Unknown corps: allowed with a division hint (model is identity-agnostic):
      { corps: 'New Startup Corps', division: 'Open Class', captions: { GE1: 12, GE2: 12, VP: 11, VA: 11, CG: 11, MB: 12, MA: 12, MP: 12 } },
    ] },
  ],
  target: { show: 'Prelims', date: '2026-08-06', lineup: ['blue devils', 'bluecoats', 'New Startup Corps'] },
});

console.log(out.inputAudit.normalizations);   // [{ input: 'blue devils', matched: 'Blue Devils', method: 'alias', kind: 'corps' }, ...]
```

### `CorpsNotFoundError`

```ts
class CorpsNotFoundError extends Error {
  readonly suggestions: string[];
  name: 'CorpsNotFoundError';
}
```

Re-exported from `/simple` for compatibility; the canonical definition lives in
the domain layer (see [`Corps`](#corps-namespace)).

---

## Effect API — `dci-score-predictor/effect`

```ts
import {
  predictEffect, decodePredictInput,
  ValidationError, ModelLoadError, PredictionError,
  PredictInput, SeasonInfo, PerformanceInput, ShowInput, TargetEventInput,
} from 'dci-score-predictor/effect';
```

Thin by design: the value here is (1) `Schema` validation of the public input
shapes at the boundary and (2) typed, catchable errors. The prediction internals
are the same core `predict()`. Built on `effect@4.0.0-beta` (`Schema` lives in
core: `import { Schema } from 'effect'`).

### `predictEffect(input, options?)`

```ts
const predictEffect: (
  input: PredictInput, options?: PredictOptions
) => Effect.Effect<PredictedShowResult, ValidationError | ModelLoadError | PredictionError>
```

Wraps the core Promise `predict()` and maps thrown failures onto typed errors:

| Thrown by core | Mapped tag |
|---|---|
| `DciValidationError` | `ValidationError` |
| message matching `/(model\|weights\|ensemble\|tfjs\|tensor\|ENOENT\|assets)/i` | `ModelLoadError` |
| anything else during inference | `PredictionError` |

### `decodePredictInput(input)`

```ts
const decodePredictInput: (input: unknown) => Effect.Effect<PredictInput, ValidationError>
```

Decode arbitrary `unknown` into a validated `PredictInput`, failing with a
`ValidationError` that wraps the underlying `Schema.SchemaError` (whose
`.message` carries the exact field path + constraint). Use it to validate
untrusted input (an HTTP body) before predicting.

### Tagged errors

```ts
class ValidationError extends Data.TaggedError('ValidationError')<{ readonly message: string; readonly cause?: unknown }> {}
class ModelLoadError extends Data.TaggedError('ModelLoadError')<{ readonly message: string; readonly cause?: unknown }> {}
class PredictionError extends Data.TaggedError('PredictionError')<{ readonly message: string; readonly cause?: unknown }> {}
```

All catchable via `Effect.catchTag('ValidationError', …)`.

### Exported Schemas

`SeasonInfo`, `PerformanceInput`, `ShowInput`, `TargetEventInput`, `PredictInput`
are `Schema.Struct`s mirroring the core input types, with checked primitives:
caption scores `0–20`, ISO date pattern `^\d{4}-\d{2}-\d{2}`, `percentThrough`
`0–100`, `year` `1900–2100`, division ∈ `'World Class' | 'Open Class' | 'All Age'`.
`type PredictInput = Schema.Schema.Type<typeof PredictInput>`.

#### Example — decode then predict, catching by tag

`decodePredictInput` first validates the untrusted JSON at the boundary (a
`ValidationError` on failure); `predictEffect` then runs the prediction. The
decoded value is deeply `readonly`, so predict from the original (now-validated)
input rather than passing the decoded value straight through:

```ts
import { Effect } from 'effect';
import { decodePredictInput, predictEffect } from 'dci-score-predictor/effect';

const program = decodePredictInput(untrustedJson).pipe(
  // decode succeeded → the shape is valid; predict from the original input
  Effect.flatMap(() => predictEffect(untrustedJson as never, { members: 8 })),
  Effect.map((result) => result.predictions),
  Effect.catchTag('ValidationError', (e) => Effect.succeed(`bad input: ${e.message}`)),
  Effect.catchTag('ModelLoadError', (e) => Effect.succeed(`assets unavailable: ${e.message}`)),
);

const outcome = await Effect.runPromise(program);
```

---

## Browser API — `dci-score-predictor/browser`

```ts
import { predict, simplePredict, init, loadEnsemble, fetchAssets } from 'dci-score-predictor/browser';
```

Same prediction internals, but **no `node:*` import** — every asset (registries,
curves, calibration, model weights) is loaded over global `fetch` from a
`baseUrl` you host. There is **no silent Node fallback**: an `assets` option is
required on every call. The 8-seed ensemble is ~32 MB of weights; use
`members: N` to load fewer seeds.

### `predict(input, options)` / `simplePredict(input, options)`

```ts
interface BrowserPredictOptions extends Omit<PredictOptions, 'provider'> {
  /** REQUIRED — where to fetch the package assets from. */
  assets: BrowserAssets;
}
type BrowserAssets = { baseUrl: string } | AssetProvider;

function predict(input: PredictInput, options: BrowserPredictOptions): Promise<PredictedShowResult>
function simplePredict(input: LooseInput, options: BrowserPredictOptions): Promise<PredictedShowResult>
```

`predict` takes core keyed input; `simplePredict` takes `LooseInput`. Both
require `assets`; everything else matches the core `PredictOptions`
(`provider` is injected for you). `init()` is called internally and is
idempotent per provider.

### `init(options)`

```ts
function init(options: { assets: BrowserAssets }): Promise<void>
```

Preload registries/curves/calibration and activate the fetch provider once, so
the synchronous domain matchers (`matchCorps` / `matchCaption` / `makeCorps` /
the `Corps` namespace) resolve. Call once at startup if you use those helpers
before predicting.

### `loadEnsemble(options?)`

```ts
function loadEnsemble(
  options?: { assets?: BrowserAssets } & Omit<LoadEnsembleOptions, 'provider'>
): Promise<EnsembleMember[]>
```

Load the tfjs ensemble over fetch (pass `assets`, or rely on a prior `init()`).

#### Example — browser end-to-end

```ts
import { predict } from 'dci-score-predictor/browser';

const result = await predict(input, {
  assets: { baseUrl: 'https://cdn.jsdelivr.net/npm/dci-score-predictor@latest/assets/' },
  members: 4,   // 4 of 8 seeds — lighter/faster, slightly wider error
});
```

Host options for `baseUrl`:
- **CDN** — `https://cdn.jsdelivr.net/npm/dci-score-predictor@latest/assets/`
  (or unpkg). Zero setup.
- **Self-host** — copy this package's `assets/` dir into your app's static dir
  and pass `{ baseUrl: '/assets/' }`.

The browser entry also re-exports the domain helpers, the `Corps` namespace, and
`fetchAssets`. See [RECIPES.md](./RECIPES.md#browser) for a full bundler +
service-worker walkthrough.

---

## Domain identities

Exported from the core and browser entries (in Node they work on import; in the
browser after `init()`).

### `Division`

```ts
const Division = { WorldClass: 'World Class', OpenClass: 'Open Class', AllAge: 'All Age' } as const;
type Division = (typeof Division)[keyof typeof Division];
```

The model covers **World Class** and **Open Class** only; `All Age` exists as a
registry value but raises a validation error if supplied to predict.

### `Captions` (exported name for `Caption`)

```ts
interface CaptionDef {
  key: Caption;                                  // 'GE1' | 'GE2' | 'VP' | 'VA' | 'CG' | 'MB' | 'MA' | 'MP'
  label: string;                                 // 'General Effect 1', 'Music Percussion', ...
  category: 'GE' | 'Visual' | 'Music';
  breakdown: readonly ['Content', 'Achievement'];
}
// Captions.GE1 → { key:'GE1', label:'General Effect 1', category:'GE', breakdown:['Content','Achievement'] }
```

The 8 caption keys and their labels/categories:

| key | label | category |
|---|---|---|
| `GE1` | General Effect 1 | GE |
| `GE2` | General Effect 2 | GE |
| `VP` | Visual Proficiency | Visual |
| `VA` | Visual Analysis | Visual |
| `CG` | Color Guard | Visual |
| `MB` | Music Brass | Music |
| `MA` | Music Analysis | Music |
| `MP` | Music Percussion | Music |

### Matchers

```ts
function matchCorps(input: string): CorpsMatch;
function matchJudge(input: string): Judge | null;
function matchCaption(input: string): Caption | null;
function makeCorps(name: string, options: { division: Division; key?: string }): Corps;
function normalizeName(name: string): string;

type CorpsMatch =
  | { corps: Corps; method: 'exact' | 'alias' }
  | { corps: null; method: 'none'; suggestions: string[] };

interface Corps { key: string; name: string; division: Division; unknown?: boolean }
interface Judge { id: string; initials: string | null; captions: string[] }
```

- `matchCorps` — normalization (lowercase, punctuation strip) + alias table;
  returns suggestions on a miss.
- `makeCorps` — build a first-class **unknown** corps (`unknown: true`) with a
  division; the model is identity-agnostic so this predicts fine.
- `matchCaption` — `"Music Analysis"` / `"Visual - Analysis"` / `"guard"` → keys.

### `Corps` namespace

```ts
import { Corps, CorpsNotFoundError, type KnownCorpsName } from 'dci-score-predictor';
```

`Corps` is a namespace-object merged with the corps *instance* type. It gives
autocomplete over known corps plus runtime helpers:

```ts
Corps.BlueDevils          // frozen { key, name:'Blue Devils', division:'World Class' } — autocompleted
Corps.Unknown             // identity-agnostic sentinel { key:'unknown', name:'Unknown', division:'World Class', unknown:true }
Corps.lookup('bluecoats') // fuzzy/alias runtime match → Corps; throws CorpsNotFoundError on miss
Corps.named('Blue Devils')// strict: only a KnownCorpsName string typechecks
Corps.make('New Corps', { division: 'Open Class' })  // first-class new/unknown corps
```

| Member | Signature | Notes |
|---|---|---|
| `Corps.<PascalName>` | `Corps` | Generated, frozen, autocompleted from the registry snapshot (e.g. `Corps.CarolinaCrown`). |
| `Corps.Unknown` | `Corps` | The identity-agnostic sentinel. |
| `Corps.lookup(name)` | `(name: string) => Corps` | Smart match; throws `CorpsNotFoundError` (with `.suggestions`) on miss. |
| `Corps.named(name)` | `(name: KnownCorpsName) => Corps` | Compile-time-checked: only known names typecheck. Same runtime as `lookup`. |
| `Corps.make(name, opts)` | `(name: string, { division, key? }) => Corps` | New/unknown corps, `unknown: true`. |

`KnownCorpsName` is a template-literal union of every registry name and alias
(e.g. `"Blue Devils"`, `"Carolina Crown"`, `"SCV Cadets"`).

---

## Shared result & input types

### `SeasonInfo`

```ts
interface SeasonInfo { year: number; startDate: string; endDate: string }
```

### `ShowInput`

```ts
interface ShowInput {
  slug: string;
  date: string;                    // ISO date YYYY-MM-DD
  percentThrough?: number;         // 0–100; derived from seasonInfo dates when absent
  results: PerformanceInput[];
  judges?: Partial<Record<Caption, string[]>>;   // caption → judge ids
}
```

### `PerformanceInput`

```ts
interface PerformanceInput {
  corpsKey: string;
  corpsName?: string;
  division: DivisionName;          // 'World Class' | 'Open Class' | 'All Age'
  captions: Partial<Record<Caption, number>>;    // 0–20; all 8 required for a usable row
  total?: number;                  // derived when absent
  subcaptions?: Partial<Record<Caption, { content: number; achievement: number }>>;
  performanceOrder?: { inClass?: number; inClassCount?: number; overall?: number; overallCount?: number };
}
```

### `TargetEventInput`

```ts
interface TargetEventInput {
  slug: string;
  date: string;
  percentThrough?: number;
  lineup: Array<{ corpsKey: string; corpsName?: string; division: DivisionName }>;
  judges?: Partial<Record<Caption, string[]>>;
}
```

### `PredictedShowResult`

```ts
interface PredictedShowResult {
  predictions: CorpsPrediction[];          // ranked by total desc, rank 1..n
  readiness: { corps: CorpsReadiness[]; recal: DivisionRecalAudit[] };
  inputAudit: InputAudit;
  caveats: Caveat[];
  model_metadata: ModelMetadata;
  explain?: CorpsExplain[];                // present only when options.explain
}
```

#### `CorpsPrediction`

```ts
interface CorpsPrediction {
  corps: string; corpsKey: string; division: string;
  rank: number; total: number;
  GE: number; Visual: number; Music: number;
  captions: Record<Caption, number>;
  intervals: Record<Caption, { low_offset: number; high_offset: number }>;
}
```

`total = GE1 + GE2 + (VP+VA+CG)/2 + (MB+MA+MP)/2`. `intervals[cap]` are p10/p90
**offsets relative to the p50** caption score (so `low_offset` is negative,
`high_offset` positive).

#### `CorpsReadiness`

```ts
interface CorpsReadiness {
  corpsKey: string; corps: string; division: string;
  tier: 'established' | 'partial' | 'sparse' | 'cold_start';
  tierCode: 'T0' | 'T1' | 'T2' | 'T3';
  priorShows: number;              // scored shows for this corps (drives the tier)
  sequenceFill: number;            // non-pad sequence steps (prior shows + target)
  featureCoverage: Record<string, 'present' | 'defaulted' | 'masked'>;
  fieldPace: { observations: number; corps: number; dates: number; confidence: number };
}
```

Tiering: `priorShows === 0` → `cold_start`/T3; `1–2` → `sparse`/T2;
`> 2` → `established`/T0 if field-pace `confidence >= 1`, else `partial`/T1.
See [TYPES.md](./TYPES.md) for the full tier + caveat enumeration and measured
per-tier accuracy in [MODEL_CARD.md](./MODEL_CARD.md).

#### `DivisionRecalAudit`, `InputAudit`, `DroppedRow`, `NameNormalization`, `Caveat`, `ModelMetadata`, `CorpsExplain`

```ts
interface DivisionRecalAudit { division: string; offset: number; poolN: number; thinTaper: number; active: boolean }

interface InputAudit {
  showsCounted: number; corpsCounted: number; scoreRowsCounted: number;
  droppedRows: DroppedRow[];
  normalizations: NameNormalization[];   // populated by the simple API
  showsWithPanels: number;               // history shows that supplied a judge panel
  targetHasPanel: boolean;               // whether the target supplied a judge panel
}

interface DroppedRow {
  show: string; corpsKey: string;
  reason: 'caption_total_mismatch' | 'caption_out_of_range' | 'duplicate_corps_show' | 'out_of_season_date' | 'missing_captions';
  detail?: string;
}

interface NameNormalization { input: string; matched: string; method: 'exact' | 'alias' | 'fuzzy' | 'made'; kind: 'corps' | 'judge' | 'caption' }

interface Caveat { severity: 'info' | 'warn'; message: string; corpsKey?: string }

interface ModelMetadata { model_dir: string; ensembleSize: number; generated_at: string }

interface CorpsExplain {
  corpsKey: string;
  baselineRecap: number[];         // per-caption anchor
  trendSlopes: number[];           // per-caption recent slope
  fieldPace: { observations: number; corps: number; dates: number; confidence: number };
  biasOffset: number; recalOffset: number;
  historyBucket: 'debut' | 'sparse' | 'established';
}
```

> **Panel ⇄ score-sheet caveat.** `showsWithPanels` / `targetHasPanel` reflect
> whether you supplied a judge panel (`judges`). Panels are cross-checked against
> the scored captions (§3.2) and surfaced as caveats, but they are **never
> blocking** and judge context is masked at serving — so a mismatched or absent
> panel changes nothing in the prediction. See
> [TYPES.md](./TYPES.md#panel--scoresheet-caveats).

---

## Advanced / low-level layer

`predict()` composes these tested layers; you rarely call them directly, but they
are exported for embedders who want to cache the ensemble, serve a single row,
or fit recal offsets independently.

### `loadEnsemble(options?)` / `loadBiasCalibration()`

```ts
interface LoadEnsembleOptions { provider?: AssetProvider; members?: number }
function loadEnsemble(options?: LoadEnsembleOptions): Promise<EnsembleMember[]>
function loadBiasCalibration(): Record<string, number>   // shipped `${division}|${bucket}` table; {} if absent
```

Loads the 8-seed tfjs ensemble (`~2s` cold). `members: N` loads the first `N`
seeds. `predict()` caches the ensemble promise across calls internally.

### `servePrediction(members, row, options)`

```ts
interface ServeOptions {
  biasCalibration?: Record<string, number>;
  recalOffsets?: Record<string, number>;
  division: string;
}
interface ServedPrediction {
  total: number; GE: number; Visual: number; Music: number;
  captions: Record<Caption, number>;
  intervals: Record<Caption, CaptionInterval>;
  rawTotal: number;
  historyBucket: 'debut' | 'sparse' | 'established';
  nonPadSteps: number;
  biasOffset: number; recalOffset: number;
  baselineRecap: number[]; trendSlopes: number[];
}
function servePrediction(members: EnsembleMember[], row: FeatureRow, options: ServeOptions): ServedPrediction | null
```

The faithful port of the production serve loop: pad-mask, trend-slope append,
judge masking, curve-anchor baseline fallback, ensemble mean-pooling, bias
calibration, division recal, proportional caption rescale. Returns `null` if the
row shape is wrong (`sequence` not `[15][101]` or `staticFeatures` not `[216]`).

### `buildFeatureRows` / `TemporalState` (features layer)

The feature builder replays a corps' same-season shows into a `TemporalState`,
assembling the `[15][101]` sequence + `[216]` static vector from your
`SeasonData` and the packaged cross-season `FeatureContext`. It is the internal
step between validation and serving; `FeatureRow`, `FeatureContext`,
`FeatureBuildDiagnostics`, `BuiltFeatureRow` are exported from
`features/types` (see [ARCHITECTURE.md](./ARCHITECTURE.md)).

### Recal — `fitRecalOffset` / `fitRecalOffsets` / `PRODUCTION_RECAL_CONFIG`

```ts
interface RecalObservation { predicted: number; actual: number; division: string; date: string }
interface RecalConfig { shrinkK: number; recencyDays: number; trim: number; trimMin: number; maxAbs: number; minPoolN: number }
interface RecalFit { offset: number; poolN: number; thinTaper: number }

const PRODUCTION_RECAL_CONFIG: RecalConfig; // { shrinkK:8, recencyDays:14, trim:1, trimMin:5, maxAbs:1.5, minPoolN:20 }

function fitRecalOffset(observations: readonly RecalObservation[], division: string, targetDate: string, config?: RecalConfig): RecalFit
function fitRecalOffsets(observations: readonly RecalObservation[], divisions: readonly string[], targetDate: string, config?: RecalConfig): Record<string, RecalFit>
```

Fit a per-division additive offset from resolved (already-scored) shows.
`residual = actual − predicted`; only observations **strictly before** the target
date participate (leakage guard). The mean is shrunk (`n/(n+shrinkK)`),
optionally trimmed, clamped to `±maxAbs`, and thin-pool-tapered
(`× min(1, n/minPoolN)`). `predict()` calls `fitRecalOffsets` for you when you
pass `recalObservations`. See [recal](#recal) and
[RECIPES.md](./RECIPES.md#recalibrate-from-your-own-resolved-shows).

### AssetProvider & `fetchAssets`

```ts
interface AssetProvider {
  readJson(relPath: string): Promise<unknown>;
  readBinary(relPath: string): Promise<ArrayBuffer>;
  listModelSeeds?(): Promise<string[]>;
}
function fetchAssets(baseUrl: string): AssetProvider;   // fetch-backed provider
function setAssetProvider(provider: AssetProvider): void;
function init(options?: InitOptions): Promise<void>;
interface InitOptions { assets?: { baseUrl: string } | AssetProvider }
```

`relPath` is package-relative to the shipped `assets/` dir (e.g.
`registries/corps.json`, `models/<seed>/weights.bin`). Implement `AssetProvider`
to load assets from anywhere (a bundler virtual FS, KV store, etc.); pass it as
`options.provider` (core) or `options.assets` (browser). See
[RECIPES.md](./RECIPES.md#custom-asset-hosting).

### Low-level inference types

```ts
type PredictionInput = {
  sequence: number[][]; staticFeatures: number[];
  sequenceMask?: Array<boolean | number>;
  judgeIndices?: number[]; corpsId?: number; agnosticShowId?: number;
  baselineRecap?: number[]; historyLen?: number; judgeBiasScale?: number; corpsScale?: number;
};
type MemberPrediction = {
  captions: Record<Caption, { p10: number; p50: number; p90: number }>;
  categories: { ge: number; visual: number; music: number };
  total: number;
};
class EnsembleMember { predictOne(input: PredictionInput): MemberPrediction }
```

These are the raw per-seed contract; `servePrediction` pools `MemberPrediction`s
across seeds. See [MODEL_CARD.md](./MODEL_CARD.md) for the tensor-level input
spec.
