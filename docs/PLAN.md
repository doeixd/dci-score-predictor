# dci-score-predictor — Full Design & Delivery Plan

Goal: package the production v10.5 model (identity-agnostic field-pace ensemble +
division recalibration) as an open-source, self-contained TypeScript SDK with a
type-safe Effect-Schema API, a zero-Effect simple API, and companion Claude agent
skills. Consumers need **nothing but the npm package** — no database, no server,
no Python.

---

## 0. Ground truths (from the production system)

These facts drive every architectural choice:

1. **The model is already TensorFlow.js.** Each of the 8 v10.4 field-pace seeds is
   a tfjs LayersModel (`model.json` + `weights.bin`), ~4 MB each, 32 MB total.
   Input: `sequence [15, 101]` + static `[216]` (+ 8 trend appended → 224).
   Inference today runs via `@tensorflow/tfjs` with the CPU backend in Node.
   → **No WASM port is needed.** tfjs runs in Node, Bun, Deno, browsers, and edge
   workers. `@tensorflow/tfjs-backend-wasm` is an *optional speed knob* (XNNPACK
   SIMD), not a portability requirement. Decision: **pure-JS default backend,
   wasm backend as an opt-in peer dep.** (Answering the "maybe use wasm?" question:
   no for portability, optional for performance.)

2. **v10 is identity-agnostic and judge context is masked at serving**
   (`maskV9JudgeContext`). Corps-identity embeddings and judge-Elo features are
   zeroed in production inference. → The SDK does NOT need the private database to
   reproduce production predictions; every live feature derives from **score
   history + schedule + reference curves**, all of which the user supplies or the
   package ships.

3. **The hard part is the feature builder**, not the model. Production computes
   the 216 static + 15×101 sequence features in `buildMlSequencesV9Subcaption.ts`
   + `prepareV10TemporalFeatures.ts` against the prod SQLite DB. The SDK must
   reimplement this as a **pure function of user-supplied `SeasonHistory`**
   (leakage-safe: everything strictly before the target date). Byte-exact parity
   with the prod pipeline on frozen fixtures is the acceptance gate (we already
   have the `v9FeatureParity`-style test discipline for this).

4. **Shipped static assets** (all frozen, versioned in-package):
   - 8 tfjs seed models (32 MB) — `assets/models/`
   - `target-norm.json` per seed, `cleanV10BiasCalibration.json`
   - reference curves (`referenceCurves*.json`, percent-of-season curves)
   - canonical registries generated from the prod DB at package build time:
     corps (names + aliases + divisions), judges (name normalization), shows
     (slugs), captions (labels + breakdown structure)
   - recal defaults (shrink_k=8, recency_days=14, max_abs=1.5, thin-pool taper)

5. **Recalibration is data-dependent, not an asset.** The per-division offset is
   fit at predict time from the *user-supplied* resolved shows in the trailing
   window — the SDK ports `Recal.fit_offset` + the thin-pool taper to TS. With
   sparse history it tapers toward 0, exactly like far-future events in prod.

---

## 1. Package architecture

```
dci-score-predictor/
├── src/
│   ├── domain/        # Corps, Judge, Show, Caption, Division registries + smart matching
│   ├── schema/        # Effect Schema classes: SeasonHistory, SeasonResult, LineupEntry,
│   │                  #   JudgeAssignment, ScoreSheet, ShowToPredict, PredictedShowResult
│   ├── features/      # pure feature builder: sequence [15,101] + static [216] + trend [8]
│   │   ├── temporal.ts      # field-pace (field_level_vs_reference, shrunk_residual_slope,
│   │   │                    #   residual_ema, confidence) — leakage-safe, /10-scaled
│   │   ├── trajectory.ts    # per-corps season trajectory + curve-relative features
│   │   └── contract.ts      # frozen feature index map + masking (judge/embedding zeros)
│   ├── model/         # tfjs ensemble loader + inference + bias calibration + pooling
│   ├── recal/         # division-aware additive recal (port of Recal.fit_offset + taper)
│   ├── simple/        # the loose "plain objects in" API → normalizes into schema types
│   ├── effect.ts      # Effect-native entry (returns Effect values, typed errors, Layers)
│   └── index.ts       # Promise entry (ManagedRuntime facade over effect.ts)
├── assets/            # models + curves + registries (shipped in the npm tarball)
├── skills/            # companion Claude agent skills (see §5)
├── tools/             # build-time: registry generator (runs against prod DB, we run it)
├── test/              # parity fixtures + unit + property tests
└── docs/              # PLAN.md (this), API.md, MODEL_CARD.md
```

**Runtime deps:** `@tensorflow/tfjs` (peer or bundled-slim: only
`tfjs-layers` + `tfjs-core` + `tfjs-backend-cpu` are needed), `effect` (peer).
Nothing else. No sqlite, no fetch, no fs at predict time (models loaded via a
pluggable `ModelSource`: filesystem in Node, `fetch`/bundled in browser).

**Model asset strategy:** 32 MB is fine for npm (`files` includes `assets/`) but
we also publish the weights to a GitHub release + jsDelivr CDN URL so browser
users can lazy-load instead of bundling. `DCI.loadModel()` defaults: Node → read
from the package's `assets/`; browser → CDN with subresource-integrity hashes.
An `ensemble: 1 | 4 | 8` option trades accuracy for download size (1 seed = 4 MB,
documented accuracy deltas from our backtests).

---

## 2. Effect v4 decision

Research findings (July 2026): **Effect v4 is beta** (`effect@4.0.0-beta.x`);
the repo merged so `main` is v4, v3 is feature-frozen. Schema lives in core
(`import { Schema } from "effect"`) in both; Schema v4 is a full redesign
(`.check()` constraints, `decodeUnknownEffect`, `Schema.SchemaError`, ~20 kB core).

**Recommendation: build on v4 beta.** Rationale: this SDK is greenfield and
pre-1.0; Schema v4 is the API we'd otherwise migrate to within months; the v4
runtime is 3× smaller (matters for browser); and our Promise facade insulates
non-Effect consumers from any beta churn entirely. Policy:
- pin the exact beta in `devDependencies`, declare `"effect": "^4.0.0-beta.20"`
  (or current) as a **peerDependency**;
- our own **1.0 releases only when Effect v4 goes stable**; until then we publish
  `0.x` and absorb beta breakage in minors;
- fallback if a beta break is disruptive: the internal Effect usage is thin
  (Schema + typed errors + ManagedRuntime), so a v3 retreat is contained.

---

## 3. Public API design

### 3.1 Type-safe domain objects (the `DCI.*` namespace)

Registries are **generated at package build time** from the prod DB into literal
TS types + JSON data, giving autocomplete AND runtime smart matching:

```ts
import * as DCI from 'dci-score-predictor'

// Generated const-object: autocompletes every known corps, returns a Corps instance.
const bd = DCI.Corps.BlueDevils                    // Corps (World Class)
// Smart lookup: alias/canonical/fuzzy-normalized ("blue devils", "BD", "Blue Devils A")
const bd2 = DCI.Corps.lookup('blue devils')        // Corps | throws CorpsNotFoundError
// Template-literal-typed strict form: known names typecheck, unknown are a type error
const scv = DCI.Corps.named('Santa Clara Vanguard')
// New/unknown corps are first-class (the model is identity-agnostic!):
const newCorps = DCI.Corps.make('Star of Tomorrow', { division: DCI.Division.WorldClass })
const unknown  = DCI.Corps.Unknown

const judge = DCI.Judge.lookup('a anderson')       // normalization: "A. Anderson",
                                                   // "Anderson, Amy" → same judge
const ma = DCI.Caption.MA                           // { key:'MA', label:'Music Analysis',
                                                   //   breakdown:['Content','Achievement'] }
```

Implementation: `Schema.Class` entities (opaque, structural-equality via
Data.Class), branded IDs (`CorpsKey`, `JudgeKey`, `ShowSlug`), name matching via
the same normalization used by prod's `corps_aliases`/judge canonicalization
(lowercase, punctuation-strip, initial-expansion, alias table). `lookup` is
total-with-typed-error in the Effect API, throwing in the Promise API.

### 3.2 Rich API (fully typed, schema-validated)

```ts
const history = DCI.SeasonHistory.make({
  seasonInfo: { year: 2026, start: '2026-06-25', end: '2026-08-08' },
  results: [
    DCI.SeasonResult.make({
      show: { slug: 'dci-southwestern-championship', date: '2026-07-18',
              location: 'San Antonio, TX' },
      lineup: [ DCI.LineupEntry.make({ corps: bd, performanceOrder: 12 }) ],
      judges: [ DCI.JudgeAssignment.make({ judge, caption: DCI.Caption.MA }) ],
      scores: DCI.ScoreSheet.make({ /* caption → corps → breakdown numbers,
        validated against the lineup + judge panel + caption breakdown labels */ })
    }),
  ],
})

const target = DCI.ShowToPredict.make({   // SeasonResult minus scores
  show: { slug: 'dci-world-championship-prelims', date: '2026-08-06' },
  lineup: [...], judges: [...],           // judges optional (masked anyway)
})

const result: DCI.PredictedShowResult = await DCI.predict({ history, target })
// result.recap: per-corps { total, captions: {GE1,GE2,VP,VA,CG,MB,MA,MP}, rank,
//   interval }, plus model_metadata, readiness, caveats, recal audit
```

Cross-field validation is where Effect Schema earns its keep: `ScoreSheet` keys
are checked against the declared judge panel's captions and the lineup's corps;
breakdown arrays are checked against `Caption.breakdown` length; dates are
checked in-season and leakage-safe (`target.date` strictly after all history).
Divisions default from the corps registry. All failures are precise
`Schema.SchemaError`s (Effect API) / descriptive thrown `DciValidationError`s
(Promise API).

### 3.3 Simple API (`dci-score-predictor/simple`)

Loose plain-object input; the SDK normalizes (smart-matches names, infers
divisions, tolerates missing judges/breakdowns) and reports what it inferred:

```ts
import { predict } from 'dci-score-predictor/simple'

const out = await predict({
  history: [
    { show: 'DCI Southwestern Championship', date: '2026-07-18',
      scores: [
        { corps: 'Blue Devils',
          captions: [{ caption: 'MA', judge: 'a anderson', breakdown: [9.5, 9.3] }] },
      ] },
  ],
  target: { show: 'Prelims', date: '2026-08-06',
            lineup: ['Blue Devils', 'Bluecoats', 'Carolina Crown'] },
})
// out.recap + out.normalization: [{input:'a anderson', matched:'Amy Anderson'}, ...]
// out.caveats: e.g. 'only 1 prior show supplied — recal tapered to 0'
```

Internally this decodes through the SAME rich schema (simple = a lenient
`SchemaTransformation` into `SeasonHistory`), so there is one validation and one
prediction path.

### 3.4 Effect-native API (`dci-score-predictor/effect`)

Everything above returned as `Effect<PredictedShowResult, PredictError, ModelService>`
with `Layer`s for model loading (cacheable, scoped release of tfjs tensors) and
tagged errors (`CorpsNotFoundError | ModelLoadError | InsufficientHistoryError |
ValidationError`). The Promise API is a `ManagedRuntime` facade over this —
one implementation, two entry points, per the standard pattern.

### 3.5 Graceful degradation contract (important, documented)

Production has full multi-season history; SDK users may paste one show. The SDK
must be honest, not silently worse:
- **≥ full season history** → parity with production v10.5 output.
- **Partial history** → trajectory/field-pace features computed from what exists;
  `readiness` reports feature coverage; recal tapers by pool size (same
  `MIN_POOL_N=20` taper as prod).
- **Cold start (no history)** → prior-season reference-curve projection with an
  explicit `caveat` (this mirrors prod's debut handling).
Each tier gets a documented accuracy figure from backtests run BEFORE release.

---

## 4. Delivery phases

**Phase 1 — Extraction & parity (the core, ~60% of effort)**
1. Registry generator (`tools/gen-registries.ts`): dump corps/aliases/judges/
   shows/captions from prod DB → `assets/registries/*.json` + generated
   `src/domain/generated.ts` literal types. Re-runnable; committed output.
2. Port the feature builder to pure TS: sequence assembly, static 216 (with
   masks), trend 8, field-pace temporal (from `SeasonHistory`, not the DB).
3. Port inference: ensemble load → per-seed predict → target-norm denorm →
   pool → bias calibration → caption scaling. Reuse `v9SubcaptionInference.ts`
   (already tfjs) as the starting point; strip DB/serving coupling.
4. Port recal (`fit_offset` + taper) from `apply_recal_serve.py` to TS.
5. **Parity gate:** fixture suite exported from prod (real 2026 events: inputs
   as SeasonHistory JSON + prod v10.5 outputs); SDK must match totals to ≤1e-6.
   This is the release blocker.

**Phase 2 — API & schema layer**
6. Schema classes, branded keys, smart matching, cross-field checks.
7. Effect entry + Promise facade + simple API transformation.
8. Error taxonomy + readiness/caveats surfaces.

**Phase 3 — Packaging & OSS release**
9. tsup dual ESM/CJS build, `sideEffects:false`, `arethetypeswrong` check;
   `effect` + `@tensorflow/tfjs` as peers; browser model-loading path + CDN
   publish of weights; optional `ensemble: n` size tiers.
10. Docs: README quickstart (simple API first), API.md, MODEL_CARD.md (training
    data provenance, accuracy by tier, limitations, license note that scores
    originate from public DCI recaps), CONTRIBUTING, MIT license.
11. CI: typecheck + vitest + parity fixtures on Node 20/22 + bun; npm publish
    with provenance; CHANGELOG via changesets.
12. Repo goes public on GitHub (fresh repo — NEVER connected to corps-place;
    registry/fixture generation runs locally and only committed JSON crosses).
    **Secrets discipline: no `git add -A`, review every commit for tokens.**

**Phase 4 — Agent skills** (see §5)

**Phase 5 — Nice-to-haves (post-1.0 candidates)**
- `@tensorflow/tfjs-backend-wasm` opt-in + benchmark table.
- Streaming/what-if API (`predictMany`, lineup perturbation).
- A tiny CLI (`npx dci-predict fixture.json`).
- Season-data companion package (`dci-score-predictor-data-2026`) publishing the
  public recap history as ready-made `SeasonHistory` JSON so users don't have to
  type score sheets at all — this makes the quickstart a 3-liner.

---

## 5. Agent skills plan

Research findings: skills = directory with `SKILL.md` (YAML frontmatter +
body); only `name`+`description` are needed for portability; distribution for an
npm SDK = ship a `skills/` dir in the package + document
`npx skills add <github-repo> --skill <name>` and/or publish the repo as a
Claude plugin marketplace (`.claude-plugin/marketplace.json`). Precedent:
Anthropic's own `claude-api` skill ships current API knowledge to agents.

We ship **two skills** in `skills/`:

1. **`dci-score-predictor`** (API usage skill — the `claude-api` pattern):
   teaches an agent the SDK surface so generated integration code is correct on
   the first try. SKILL.md: when-to-use triggers ("predict DCI scores",
   "drum corps prediction"), the simple-API quickstart, links to
   `reference.md` (full API), `examples.md` (worked SeasonHistory payloads),
   and a `scripts/validate-input.ts` the agent can run to check a payload
   before predicting (executable script > prose, per Anthropic guidance).

2. **`dci-predict`** (task skill, `argument-hint: [history.json]`): a runnable
   workflow — validate input → run prediction via the bundled script →
   present the recap table with caveats. `allowed-tools: Bash(npx tsx *)`.

Distribution: (a) `skills/` shipped in the npm tarball with README one-liner
`npx skills add https://github.com/<org>/dci-score-predictor` ; (b) the repo
doubles as a plugin marketplace (add `.claude-plugin/marketplace.json`) so
`/plugin marketplace add` works too. Keep SKILL.md <150 lines, progressive
disclosure for the reference material.

---

## 6. Open questions (defaults chosen, flag if you disagree)

- **License:** MIT assumed. Model weights included under the same license.
- **Org/repo name:** `dci-score-predictor` under your personal GitHub.
- **Data provenance note:** the model is trained on publicly posted DCI recap
  scores; MODEL_CARD.md will state this plainly. No DCI trademark in the org
  name; add a "not affiliated with Drum Corps International" disclaimer.
- **Effect v4 beta risk:** accepted per §2; retreat path documented.
- **Registry freshness:** shipped registries are a snapshot; `Corps.make` covers
  anything new, and we re-cut registries each release.
