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
   **The complete audited feature inventory is Appendix A** (sequence dims,
   static index map, scaling constants, masks) and **the serving math is
   Appendix B** (field-pace formulas, trend slopes, ensemble pooling, bias cal,
   recal). These appendices ARE the implementation spec — the TS port is written
   against them, and every constant in them is asserted by the parity suite.

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

The pipeline audit (Appendix A §4) shows every feature group already has a
production-defined neutral default — the SDK adopts those defaults VERBATIM
(they are what the model saw in training, so they are the statistically correct
imputation), and layers honest reporting on top. Per feature group:

| Missing input | Production default (SDK adopts) | Surfaced as |
|---|---|---|
| No prior shows for a corps (debut) | sequence = 15 pad rows; trajectory zeros; `is_season_debut=1`; caption ranges fall back to division bucket then 0–20; recap baseline ← curve-anchor rank baseline | `readiness.corps[k].tier = 'cold_start'` + caveat |
| No prior seasons for a corps | corps-history defaults (mean rank 15, score 70, `is_new=1`); caption fingerprint zeros + confidence 0 | `tier = 'no_prior_seasons'` |
| No judge panel supplied | Elo neutral 1500 → 0; masked anyway at serving (indices 101–112) | info-level note (no accuracy cost — prod masks these too) |
| No subcaption breakdowns | indices 137–168 zero (trained-in degradation) | info-level note + which shows lacked breakdowns |
| No performance order | −1 sentinel (trained-in) | info-level note |
| Thin field-pace pool | confidence → 0, slope falls back to historical (or 0 with no prior seasons) | `readiness.fieldPace = {observations, corps, dates, confidence}` |
| Thin recal pool (n < 20) | shrink `n/(n+8)` × taper `n/20`, clamp ±1.5, → 0 at n=0 | `recal: {division, offset, pool_n, taper}` per division |
| No reference-curve cell | nearest-cell fallback (div penalty 100 000, rank ×25, bucket ×1) → constant 15 | warning caveat (rare; shipped curves cover all divisions) |

Accuracy tiers, each with a backtested MAE figure published in MODEL_CARD.md
BEFORE release (measured by re-running our 2026 backtests with history
artificially truncated to each tier):
- **T0 full-season history** → parity with production v10.5.
- **T1 partial season (≥3 prior shows/corps, ≥2 field dates)** — trajectory +
  field-pace live but lower-confidence; recal tapered.
- **T2 sparse (1–2 prior shows)** — bias-cal bucket `sparse`; most trajectory
  features at defaults.
- **T3 cold start (0 prior shows)** — bias-cal bucket `debut`; curve-anchored.
The returned `readiness.tier` names the tier per corps and overall, and the docs
state each tier's expected error so users can decide whether to trust the output.

### 3.6 Diagnostics & input audit (new — prod doesn't have this)

The audit found prod's payload `readiness` block is a stub (hardcoded zeros, no
caveats/input_audit). The SDK builds the real thing, because open-source users
won't have our operational context. Every `PredictedShowResult` carries:

- **`inputAudit`** — what was received and how it was interpreted: shows/corps/
  scores counted; name normalizations applied (`input → matched`, with match
  method: exact | alias | fuzzy); rows dropped and why (caption-total mismatch
  > 0.05, invalid rank, duplicate corps-show, out-of-season date); divisions
  inferred from the registry vs supplied.
- **`readiness`** — per-corps tier (§3.5), sequence fill (n of 15 steps),
  feature-coverage map per group (present | defaulted | masked), field-pace
  snapshot stats, recal pool stats per division.
- **`caveats`** — ordered, human-readable, severity-tagged (`info | warn`):
  e.g. "Blue Devils: only 2 prior shows supplied — 'sparse' calibration bucket,
  expect ±X wider error", "recal pool for Open Class has 4 shows — offset damped
  to 20%", "3 score rows dropped: caption sum ≠ total by >0.05".
- **`consistency` (validation stage, before predict)** — the prod data-quality
  invariants applied to user data with clear errors: per-row
  `|Σcaptions − total| ≤ 0.05` (using the GE1+GE2+(VP+VA+CG)/2+(MB+MA+MP)/2
  formula), caption scores ∈ [0, 20], ranks 1–25, dates inside `seasonInfo`,
  target date strictly after all history dates (leakage guard — hard error, not
  a caveat). `strict: false` downgrades row-level failures to drops+warnings.
- **`explain` (optional, `predict({..., explain: true})`)** — per-corps feature
  attribution lite: the computed baseline (caption EMA), curve residuals, trend
  slopes, field-pace values, bias-cal bucket + offset, recal offset — i.e. the
  interpretable additive pieces around the neural delta, so a user can see WHY a
  number moved. Cheap to emit (all computed anyway); off by default to keep
  payloads small.

Design rule: **defaults are silent only when they cost nothing** (judge masking);
anything that plausibly changes the number produces a caveat. Nothing is ever
imputed without appearing in `readiness`.

---

## 4. Delivery phases

**Phase 1 — Extraction & parity (the core, ~60% of effort)**
1. Registry generator (`tools/gen-registries.ts`): dump corps/aliases/judges/
   shows/captions from prod DB → `assets/registries/*.json` + generated
   `src/domain/generated.ts` literal types. Re-runnable; committed output.
2. Port the feature builder to pure TS against the Appendix A spec: sequence
   assembly [15,101], static 216 (with masks), trend 8, field-pace temporal
   (Appendix B.1) — all from `SeasonHistory`, not the DB. Every index range and
   constant in Appendix A becomes a named constant with a unit test.
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
8. Diagnostics layer (§3.6): inputAudit, per-corps readiness tiers, severity-
   tagged caveats, consistency validation (Appendix B.4), optional `explain`.
   This is net-new (prod's readiness block is a stub) and a headline feature of
   the SDK, not an afterthought — build it alongside the feature builder so
   every default the builder applies registers a readiness entry at the source.

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

**Phase 4.5 — End-to-end publish smoke test (release gate, every release)**
The final gate before announcing any release is a full consumer-fidelity smoke
test that exercises the ACTUAL published artifact, not the repo checkout:
1. Publish to npm (first time: `npm publish --access public`; rehearsals can use
   `npm pack` + a local registry like verdaccio, but the release gate runs
   against the real registry).
2. In a CLEAN throwaway directory (fresh `npm init -y`, no repo access, no
   node_modules reuse): `npm install dci-score-predictor` from the registry.
3. Run a scripted consumer that uses ONLY the public API:
   a. simple API: predict a real 2026 event from pasted season history → verify
      totals are within expected range of the recorded production predictions
      for that event (fixture shipped in the smoke script, not the package);
   b. rich API: same event via `SeasonHistory`/`ShowToPredict` classes;
   c. diagnostics: assert readiness tiers, caveats, and inputAudit populate;
   d. degraded input: truncate history and assert the tier changes + caveats
      appear rather than a crash;
   e. `members: 1` reduced-ensemble load (size-tier path).
4. Verify packaging health in the same sandbox: ESM `import` AND CJS
   `require`, `npx arethetypeswrong` on the tarball, assets resolve from the
   installed package location (the loader's package-root resolution is the #1
   thing that breaks between repo and installed layouts).
5. Only after this passes: tag the release + publish the GitHub release with
   the CDN weight artifacts.
Automate as `test/smoke/` scripts so the gate is one command
(`npm run smoke -- <version>`), and run it in CI against the packed tarball on
every PR (registry publish step skipped) so layout regressions surface early.

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
`npx skills add https://github.com/doeixd/dci-score-predictor` ; (b) the repo
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

---

## Appendix A — Feature inventory (implementation spec, audited from prod code)

Source of truth: `buildMlSequencesV9Subcaption.ts` (clean-v10 contract,
field-pace profile), `v10FeatureSchema.ts` (asserts 101/216/224),
`v9FeatureModes.ts` (masks). One row = one (season, show, division, corps).

### A.1 Sequence input [15, 101]

One timestep = one prior scored performance by the same corps, same season,
strictly date-before the target. Last 15 shows, **left-padded**; pad rows are
all-zero except dim 3 (`padding`) = 1.

| idx | feature | scaling / default |
|---|---|---|
| 0 | percent_through | /100 |
| 1 | days since previous show | min(d,14)/14; **0.5 if first show** |
| 2 | sequence position (showIdx+1) | /15 |
| 3 | padding flag | 1 only on pad rows |
| 4 | days since corps' season start | min(d,120)/120 |
| 5 | observed fraction (showIdx+1)/pastCount | ratio |
| 6 | remaining fraction | ratio |
| 7–8 | day-of-year sin, cos | rad = doy/366·2π |
| 9 | show-count progress | /40 |
| 10 | total_score | (x−70)/30 |
| 11 | rank | /25 |
| 12 | rank delta vs prev show | /25 |
| 13 | gap to leader | /25 |
| 14 | gap to next rank up | /25 |
| 15 | field percentile 1−(rank−1)/(fieldSize−1) | [0,1] |
| 16 | total delta vs prev show | /25 |
| 17–20 | performance order: in-class, in-class norm, overall, overall norm | **−1 = missing** |
| 21–52 | per caption ×8 (GE1,GE2,VP,VA,CG,MB,MA,MP), stride 4 from offset 21: curve residual (raw pts), caption rank/fieldSize, score/20, score delta vs prev/20 | 0,0,0,0 if caption missing |
| 53–59 | opponents at show: residual mean, residual std, rank mean/25, rank best/25, top-3-by-rank residuals (raw) | zeros if no opponent history |
| 60–86 | opponents last-3: total mean (x−70)/30, slope/25, volatility/25; 8 caption means/20, 8 slopes/20, 8 vols/20 | zeros |
| 87–90 | is_finals, is_semifinals, is_regional (slug substring), is_early_season (month < July) | binary |
| 91–100 | field-relative: total z vs show avg/std; 8 caption diffs vs show averages; show std_total/10 | all 0 if no show aggregate |

Training-only guard (must hold in SDK fixtures): the caption block (21–52) of
the last valid step is zeroed when it is the target show.

### A.2 Static input [216] = 212 base + 4 field-pace

| idx | block | contents (scaling / defaults) |
|---|---|---|
| 0–24 | corps_history_summary | 0 prev_season_rank/25; 1 years_in_WC/20; 2 hist_mean_rank/25; 3 hist_rank_std/10; 4 hist_best_rank/25; 5 best_rank_recency/20; 6 made_finals_rate; 7 is_new; 8 pastShows/15; 9 rank EMA(α=0.3)/25; 10 mean-residual EMA; 11 residual OLS slope; 12 residual volatility; 13 (currentRank−hist_mean)/25; 14 days_since_season_start; 15 days_since_last_match (0.5 if none); 16 shows-remaining max(0,15−(k+1))/15; 17 field_size/25; 18–21 target perf order (−1 missing); 22 topCorpsPresent/12; 23 divisionStrength/25; 24 is_major_show |
| 25–40 | caption_ranges | per caption prior min,max /20; fallback division×5%-bucket range, then 0/20 |
| 41–57 | recent_residuals | last mean residual; 8 last per-caption residuals; 8 per-caption residual EMAs (α=0.3) — raw points vs reference curve |
| 58–100 | target_opponents | residual mean/median/std/min/max/p25/p75/rank-weighted mean; rank mean/25, best/25; top-3 residuals; top-3 ranks/25; opponent last-3 total mean/slope/vol; 8 caption means/slopes/vols |
| 101–112 | judge_elo | 8 per-caption avg judge Elo (x−1500)/200; panel mean/std/max/min. **Zeroed at serving by `maskV9JudgeContext`** |
| 113–120 | corps_elo | per-caption corps Elo pre-show (x−1500)/200; default 1500→0 |
| 121–128 | rank_baselines | reference-curve baseline (entering rank × pct bucket) per caption /20 |
| 129–131 | division one-hot | world, open, all-age |
| 132–136 | target date | month/12, day/31; premiere month/12, day/31; pastShows/40 |
| 137–168 | subcaption_history | per caption: last Content, last Achievement, EMA Content, EMA Achievement, /10; **0 when absent** |
| 169–178 | cold_start | is_season_debut; same-season count/40; days since same-season show /14 (1 if none); days since ANY scored show /365 (prev-season finals; 1 if none); last-season final score (x−70)/30 (default 70); last-season rank/25; is_first_scored_event_of_season; event week/12; day-of-season/120; percent_through/100 |
| 179–211 | caption_fingerprint | per caption: prior-season mean residual /2; 3-yr recency-weighted (0.65^age) residual /2; growth (late≥75% − early≤35%) /2; volatility min(σ/2,2); + confidence min(1, priorEntries/24). **Zeros + conf 0 with no prior seasons** |
| 212–215 | field_pace | field_level_vs_reference/10, shrunk_residual_slope/10, residual_ema/10, confidence (Appendix B.1) |

Separate integer inputs (all forced to "unknown" at serving — identity-agnostic):
`judge_indices[8]`=0, `corps_id`=0, `agnostic_show_id`=0.

### A.3 Trend features (216 → 224)

Appended at inference: per caption, OLS-free slope of last ≤3 strictly-prior
recap scores: `(last − first)/(n−1)/0.1`; 0 if <2 shows. (Serving reconstructs
these from the sequence's recap channel `step[21+c*4+2]×20`.) The same layer
computes `globalBaseline` = per-caption EMA (α=0.3) of prior recaps — the
delta-head baseline.

### A.4 Targets & reconstruction

Target vector [8 delta, 8 recap, 3 category, 1 total], z-normed per seed with
stats in `target-norm.json`. Delta = recap − corps caption-EMA baseline.
Reconstruction: caption = denorm(delta) + baseline; total =
`GE1+GE2+(VP+VA+CG)/2+(MB+MA+MP)/2`; consistency invariant |Σ−total| ≤ 0.05.

## Appendix B — Serving math (implementation spec)

### B.1 Field-pace temporal (per season × division, strictly date-prior)

Processed date-by-date; state updates only after ALL shows on a date resolve
(no same-day leakage). Reference curve = as-of running mean keyed
`division|rank_bucket|pct_bucket|caption`; missing-cell fallback = nearest cell
(cross-division penalty 100 000, |Δrank|×25, |Δbucket|), else constant 15.
Residual = total − referenceTotal. Then, over same-season same-division
observations with rank ≤ 25 strictly before the target date:
- `field_level_vs_reference` = mean residual of latest observation per corps
- `rawSlope` = OLS slope of residual vs pct/100 (0 if <2 rows)
- `historicalSlope` = mean per-season slope over earlier seasons (seasons with
  ≥4 obs and ≥2 dates)
- `confidence = min(1, corpsCount/12) × min(1, distinctDates/6)`
- `shrunk_residual_slope = conf·rawSlope + (1−conf)·historicalSlope`
- `residual_ema`: chronological, α=0.2 (`0.2·r + 0.8·ema`), seed = first r
Empty pool → all zeros (natural cold-start default).

### B.2 Inference & ensemble

Mask non-pad steps via dim 3; zero pad steps. Append 8 trend features, apply
`maskV9JudgeContext` (zero static 101–112), identity inputs to 0. Run all 8
seeds; **pool = arithmetic mean** of per-caption p50 (and p10/p90). Intervals:
`{low: mean(p10)−mean(p50), high: mean(p90)−mean(p50)}`. Baseline recap for
denorm = last non-pad recap step ×20, else curve-anchor block (static 121–128)
×20. `historyLen = nonPadSteps − 1`.

### B.3 Bias calibration + recal

`rawTotal = GE1+GE2+(VP+VA+CG)/2+(MB+MA+MP)/2`.
1. Bias cal (shipped JSON) keyed `division|bucket`, bucket = debut (0 non-pad) |
   sparse (≤2) | established (>2); offset ADDED to total; missing key → 0.
2. Recal offset per division, fit from user-supplied resolved shows:
   residuals = actual − pred, strictly date-before target, same division, within
   14 days; if n ≥ 5 drop min & max; `off = clamp(±1.5, n/(n+8) · mean)`
   (shrink uses untrimmed n); thin-pool taper `off ×= min(1, n/20)`.
3. Captions rescaled proportionally: `scale = total/rawTotal` (1 if ≤0) so
   GE/Visual/Music stay consistent with the recalibrated total.

### B.4 Data-quality invariants applied to user input (from the prod contract)

- caption-derived total within 0.05 of stated total (or total derived if absent)
- no null/negative caption scores; caption ∈ [0,20]
- ranks 1–25; percent_through ∈ [0,100]
- all history strictly before target date (hard error)
- duplicate (corps, show) rows rejected
- judge captions ∈ {GE1,GE2,VP,VA,CG,MB,MA,MP} after normalization; unknown
  judges allowed (masked anyway)
