# Architecture

How a call to `predict()` turns your `SeasonData` into a ranked, diagnosed recap
— the layers, the shipped assets, and the parity tests that keep the SDK
byte-faithful to the production v10.5 pipeline.

- [Pipeline](#pipeline)
- [Layer map](#layer-map)
- [Shipped assets](#shipped-assets)
- [Parity-test story](#parity-test-story)
- [Reproducing the TYPES.md sample](#reproducing-the-typesmd-sample)
- [Further reading](#further-reading)

---

## Pipeline

Every entry point (core, `/simple`, `/effect`, `/browser`) funnels into one core
`predict()` in `src/predict.ts`. The stages:

```
                       PredictInput  (SeasonData: seasonInfo + history + target)
                             │
        ┌────────────────────▼────────────────────┐
        │ 1. VALIDATE  (Appendix B.4 invariants)   │  src/predict.ts › validate()
        │    • leakage guard: target strictly      │  ── throws DciValidationError
        │      after every history date            │     on leakage / out-of-season
        │    • out-of-season target                │  ── row problems → drop+caveat
        │    • per-row: 8 captions ∈ [0,20],       │     (or throw under strict)
        │      total ±0.05, no dupes               │  ── panel ⇄ scoresheet cross-check
        └────────────────────┬────────────────────┘     (non-blocking caveats)
                             │  clean SeasonData
        ┌────────────────────▼────────────────────┐
        │ 2. BUILD FEATURES                        │  src/features/build.ts
        │    seeded TemporalState replay of each   │  ── replays same-season shows
        │    corps' same-season shows, then        │     into per-corps temporal state
        │    assemble sequence + static vector     │  ── + packaged FeatureContext
        │      sequence: [15][101] (left-padded)   │     (cross-season curves/ranges)
        │      static:   [216]  (212 + 4 fieldpace)│  ── emits FeatureBuildDiagnostics
        └────────────────────┬────────────────────┘     (priorShows, coverage, fieldPace)
                             │  BuiltFeatureRow[] + diagnostics
        ┌────────────────────▼────────────────────┐
        │ 3. ENSEMBLE  (cached, tfjs CPU)          │  src/model/loader.ts + inference.ts
        │    8-seed LayersModel ensemble;          │  ── static extended [216]→[224]
        │    static → [224] (+8 trend slopes);     │     with per-caption trend slopes
        │    judge/corps identity ZEROED (masked); │  ── maskJudgeContext
        │    per-seed p10/p50/p90, mean-pooled     │  src/model/serve.ts › servePrediction
        └────────────────────┬────────────────────┘
                             │  raw per-caption p50 + intervals
        ┌────────────────────▼────────────────────┐
        │ 4. CALIBRATE                             │  src/model/serve.ts
        │    total = rawTotal                      │  ── bias: `${division}|${bucket}`
        │          + biasOffset (shipped table)    │     (bucket = debut/sparse/established)
        │          + recalOffset (division recal)  │  src/recal/recal.ts › fitRecalOffsets
        │    captions rescaled proportionally      │  ── leakage-safe, shrunk, tapered, ±1.5
        └────────────────────┬────────────────────┘
                             │  ServedPrediction per corps
        ┌────────────────────▼────────────────────┐
        │ 5. RANK + DIAGNOSE                        │  src/predict.ts
        │    sort by total desc → rank 1..n;       │  ── tier per corps (T0..T3)
        │    assemble readiness, inputAudit,        │  ── caveats (warns then infos)
        │    caveats, model_metadata, explain?      │  ── explain[] when options.explain
        └────────────────────┬────────────────────┘
                             ▼
                       PredictedShowResult
```

The `/simple` entry prepends a normalization stage (smart corps/caption matching,
division inference) before stage 1; the `/effect` entry wraps the whole thing in
`Effect.tryPromise` and maps thrown errors to tags; the `/browser` entry swaps the
Node fs asset provider for a `fetch`-backed one. **None duplicate the prediction
logic** — one validation path, one prediction path.

---

## Layer map

| Layer | Files | Responsibility |
|---|---|---|
| **domain** | `src/domain/{domain,corps-namespace,generated-corps}.ts` | Corps/judge/caption identities, smart matching, the typed `Corps` namespace. |
| **features** | `src/features/{build,temporal,helpers,types}.ts` | `SeasonData` → `[15][101]` sequence + `[216]` static + diagnostics. |
| **model** | `src/model/{contract,loader,inference,serve}.ts` | Frozen input/output contract, tfjs load, per-seed inference, serve-time pooling/calibration. |
| **recal** | `src/recal/recal.ts` | Division-aware, leakage-safe additive recalibration. |
| **predict** | `src/predict.ts` | Orchestration: validate → build → serve → rank + diagnostics. |
| **assets** | `src/assets/{provider,node-provider}.ts` | The provider seam (Node fs / `fetch`) that lets the same code run everywhere. |
| **entries** | `src/{index,simple,effect,browser}.ts` | The four public surfaces over the one pipeline. |

The model contract (`src/model/contract.ts`) freezes the dimensions the whole
pipeline agrees on: `CAPTIONS` (8), `SEQ_LEN` 15, `FEAT_DIM` 101, `STATIC_DIM`
216 (→ 224 with trend slopes), `captionDerivedTotal`, and the serving-time
`historyBucket` mapping. Every constant is asserted by the parity suite.

---

## Shipped assets

Everything the model needs ships in the package's `assets/` dir, addressed by
package-relative path through the `AssetProvider` seam:

| Asset | Path | Loaded by |
|---|---|---|
| Corps registry | `registries/corps.json` | domain matching, `Corps` namespace |
| Judge registry | `registries/judges.json` | `matchJudge` |
| Feature context | `registries/featureContext.json` | feature builder (cross-season curves/ranges/finals) |
| Reference curves | `curves/referenceCurvesV4.json` | feature builder (curve-anchor baseline) |
| Bias calibration | `calibration/biasCalibration.json` | serve-time bias (optional; `{}` if absent) |
| Model seeds ×8 | `models/<seed>/{model.json,weights.bin,target-norm.json}` | ensemble loader (~32 MB total) |
| Seeds manifest | `models/MANIFEST.json` | seed enumeration + per-seed byte length & sha256 |

The first five JSON assets are the `PRELOAD_JSON` set that `init()` fetches up
front in non-Node runtimes so the synchronous domain matchers work. In Node they
resolve lazily via an fs walk-up. `MANIFEST.json` (from
`tools/gen-model-manifest.ts`) records input dims and integrity hashes and is
preferred for seed enumeration by both the Node and browser loaders.

---

## Parity-test story

The SDK is a faithful TS port of the production pipeline; the parity suite (`npx
vitest run`, **53 tests**) gates each layer against frozen production fixtures so
a refactor can't drift. Which fixture gates what:

| Test file | Gates | Fixture(s) |
|---|---|---|
| `test/feature-parity.test.ts` | the feature builder produces the exact prod feature rows | `season-2026-2026-dci-kentucky.json` → `kentucky-feature-rows-clean.json` |
| `test/inference-parity.test.ts` | per-seed inference + serve pooling match prod v10.5 | `kentucky-feature-rows(-clean).json`, `kentucky-prod-run.json` |
| `test/predict-e2e.test.ts` | end-to-end `predict()` totals + the `/simple` path | `season-2026-2026-dci-kentucky.json`, `kentucky-prod-run.json`, `kentucky-offsets.json` |
| `test/recal.test.ts` | `fitRecalOffset` math matches prod `Recal.fit_offset` | `kentucky-offsets.json` |
| `test/effect-api.test.ts` | Schema decode + `predictEffect` parity with the Promise API | (in-fixture) |
| `test/browser-parity.test.ts` | `dist/browser.js` via the fetch provider matches Node | (built bundle + fetch) |
| `test/corps-namespace.test.ts` | the typed `Corps` namespace (lookup/named/make/Unknown) | registry snapshot |
| `test/panel-validation.test.ts` | §3.2 score-sheet ⇄ judge-panel cross-checks | (in-fixture) |

The through-line fixture is **`2026-dci-kentucky`**: the full `SeasonData` input,
the feature rows it must build (`kentucky-feature-rows-clean.json`), the prod
prediction it must reproduce (`kentucky-prod-run.json`), and the recal offsets it
must fit (`kentucky-offsets.json`). The stated parity bar (MODEL_CARD): the SDK
reproduces the production clean-v10 totals to **≤ 1e-6** on these frozen
fixtures. Known, deliberate deviations (excluded judge-Elo block; curve-version
skew on rank baselines) are documented in
[FEATURE_PARITY_NOTES.md](./FEATURE_PARITY_NOTES.md).

---

## Reproducing the TYPES.md sample

The real output embedded in [TYPES.md](./TYPES.md#a-real-predictedshowresult) was
generated with a short script over the shipped fixture:

```ts
import { readFileSync } from 'node:fs';
import { predict } from 'dci-score-predictor';

const d = JSON.parse(readFileSync('test/fixtures/season-2026-2026-dci-kentucky.json', 'utf8'));
const res = await predict(
  { seasonInfo: d.seasonInfo, history: d.shows, target: d.target },
  { explain: true, members: 1 },
);
console.log(JSON.stringify(res, null, 2));
```

Run with `npx tsx <file>.ts` from the repo root (top line: rank 1 — Phantom
Regiment — total 86.745). Use `members: 8` for the full-accuracy result.

---

## Further reading

- **[MODEL_CARD.md](./MODEL_CARD.md)** — model lineage (v10.4 → v10.5), the
  tensor-level input contract, training data/provenance, and headline accuracy.
- **[TIER_ACCURACY.md](./TIER_ACCURACY.md)** — measured 2026 backtest MAE/bias per
  degradation tier and per division, with methodology and caveats.
- **[FEATURE_PARITY_NOTES.md](./FEATURE_PARITY_NOTES.md)** — the deliberate,
  documented deviations from prod (judge-Elo exclusion; rank-baseline curve skew).
- **PLAN.md** — the full design & delivery plan. Appendix A is the feature
  inventory (A.1 sequence `[15,101]`, A.2 static `[216]`, A.3 trend `216→224`,
  A.4 targets); Appendix B is the serving math (B.1 field-pace, B.2 ensemble, B.3
  bias + recal, B.4 the data-quality invariants applied to your input). §3.1–3.6
  cover the domain namespace, the four APIs, the degradation contract, and the
  diagnostics/audit design.
- **[API.md](./API.md)** / **[TYPES.md](./TYPES.md)** / **[RECIPES.md](./RECIPES.md)**
  — the consumer-facing reference, type tour, and task recipes.
