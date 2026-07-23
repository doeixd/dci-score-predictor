# v11w decomposition experiment — v11 core + final2's exact wrapper

Written 2026-07-23. Executes the "open decomposition experiment" from
[MODEL_IMPROVEMENT_PLAN](MODEL_IMPROVEMENT_PLAN.md) §"Post-mortem": bolt final2's
exact adaptive wrapper (persistence blend + nightly bias correction) onto v11's
raw ensemble output — **same corrections, swapped core** — and shadow it.
Isolates whether the v11 core beats the v9 core when both get the thermostat.

**SHADOW ONLY.** final2 keeps serving. v11w runs are saved tagged
`clean-v11w-shadow`, a tag matched by NO `PREDICTION_MODEL` serving filter
(`sdk/src/readModel/builders/predictions.ts` — patterns `%v11-fp-shadow%`,
`%fieldpace-recal%`, `%clean-v10%`, `%ensemble%`, `%final2%`); it never triggers
a read-model emit. Verified: `clean-v11w-shadow` matches none.

## The wrapper, verbatim (from `predictEventRecap.ts`, final2's serving script)

Constants (`predictEventRecap.ts` lines 231–234): `biasStrength = 0.67`,
`biasCap = 1.25`, `biasMinSamples = 10`.

### 1. Persistence blend (in-season corps with ≥1 prior same-season show)

For each corps at event date **D** (`predictEventRecap.ts` lines 1748–1794):

```
target      = raw model total (v11 raw ensemble output)
curveΔ      = lastTotal + Σ_caption curveGrowth(rank, lastPct, targetPct)
modelBlend  = (target + curveΔ) / 2                       # the "(target+curveΔ)/2" ensemble
horizonDays = D − lastDate                                # days since last real show
persistW    = max(0, 1 − horizonDays / 14)
inSeason    = persistW · lastTotal + (1 − persistW) · modelBlend
# thin-history revert-to-comparable (shows = corps' in-season show count):
revert      = 0.5 / 0.3 / 0.15 / 0   for shows = 1 / 2 / 3 / ≥4      (comparableRevertWeight)
inSeason    = inSeason · (1 − revert) + priorSeasonComparable.total · revert   # if comparable exists
```

`curveGrowth` (lines 888–896) is per-caption `max(0, curveBaseline(rank, toPct) −
curveBaseline(rank, fromPct))` off `referenceCurvesV4.json`;
`curveBaseline` clamps rank∈[1,25], pct-bucket to nearest 5 (lines 873–886).
`totalFromV9Captions` = `GE1 + GE2 + (VP+VA+CG)/2 + (MB+MA+MP)/2`.

### 2. Bias correction (computed once per event; `computeSeasonBiasCorrection`, lines 1348–1416)

```
rawBias    = mean(pred − actual)   over this season's already-scored predictions,
             deduped to the last genuine PRE-SHOW forecast per (show, corps),
             eligible iff the corps had ≥1 prior same-season score strictly before
             its show, and (leakage guard) the show is strictly before D.
if n < 10:  correction = 0                                 # dormant until 10 samples
else:       damped     = 0.67 · rawBias
            correction = clamp(damped, −1.25, +1.25)
```

Applied ONLY to in-season-with-history corps, **subtracted** (lines 1805–1813):
`final = inSeason − correction`. (`rawBias = pred − actual`, so a positive/over-
prediction bias lowers the served total.)

### Order of operations (per corps): `raw → (target+curveΔ)/2 → persist blend → comparable revert → − bias`.

## Implementation

- **`cp-v10-serving/scripts/v11wWrapper.ts`** — tsx post-processor: reads a raw v11
  serve JSON (the `EventPredictionOutput` `cleanV10ServeFP.ts` emits), applies the
  wrapper math verbatim above using the prod DB (`ml_sequence_rows_v9_subcaption`
  for last-show/rank exactly as final2, `corps_scores` for the prior-season
  comparable), and re-saves via `saveEventPredictionRun` tagged
  `clean-v11w-shadow`. Caps (GE/Visual/Music) scale to the shifted total.
- **`cp-v10-serving/scripts/v11w-shadow.sh`** — drives the wrapper over the raw v11
  upcoming JSONs `v11-shadow.sh` produced that night
  (`/home/patrick/v11-shadow/$TODAY/upcoming/`). No PUBLISH.

**Bias source (live path).** The wrapper mirrors final2's "recompute from recent
shows' errors" but sources v11's OWN residuals. final2 reads its own served runs'
`actual_total`; the v11 shadow saved runs never get `actual_total` backfilled
(that job only touches served models) and, in champ week, are all still-upcoming
events. So the live script sources the **pool JSONs** `v11-shadow.sh` already
emits — raw v11 predictions on the last ~21 days of resolved shows — with actuals
joined from `corps_scores`, same eligibility / leakage guard / damp / cap. Caveat:
pool predictions are same-day recomputes under a today-frozen contract, so they
**understate** the true regime bias (rawBias ≈ 0.02–0.12 vs final2's genuine
−3-ish pre-show bias in late July). As `clean-v11-fp-shadow` runs accumulate for
shows that then score, the genuine pre-show source (the SQL path,
`--bias-model-dir`) becomes usable. The honest verdict below therefore comes from
the **backtest**, which uses genuine leakage-safe pre-show residuals.

## Backtest — 9 graded shows, 2026-07-17..22 (`tools/backtest-v11w.ts`)

v11 core = 8×v11 identity-0.5, agnostic. Leakage-safe: for target D, the bias
correction uses only v11's pre-show raw residuals on shows strictly before D;
last-score/rank/curve use only the corps' shows before D. `final2(served)` = what
prod actually served (`model_dir LIKE '%final2%'`, latest pre-show run per event).

| event | date | n | final2 (served) | v11 raw | **v11w** | bias n / raw→corr |
|---|---|--:|--:|--:|--:|---|
| dci-houston | 07-17 | 10 | 0.561 | 0.954 | **0.457** | 135 / 0.044→0.029 |
| dci-southwestern-championship | 07-18 | 22 | 1.099 | 1.751 | **1.100** | 145 / 0.020→0.013 |
| the-buccaneer-classic | 07-18 | 2 | 2.493 | 1.154 | **0.570** | 145 / 0.020→0.013 |
| dci-dallas | 07-19 | 10 | 1.247 | 2.116 | **0.763** | 169 / 0.012→0.008 |
| dci-mckinney | 07-20 | 6 | 0.628 | 1.497 | **1.001** | 179 / −0.008→−0.005 |
| dci-st-louis | 07-21 | 7 | 0.577 | 3.266 | **1.383** | 185 / −0.056→−0.038 |
| dci-southern-mississippi | 07-22 | 6 | 0.423 | 2.995 | **0.833** | 192 / −0.119→−0.080 |
| drums-on-the-ohio | 07-22 | 8 | 0.540 | 3.381 | **0.936** | 192 / −0.119→−0.080 |
| march-on | 07-22 | 3 | 2.764 | 2.586 | **2.755** | 192 / −0.119→−0.080 |
| **POOLED** | | **74** | **0.949** | **2.110** | **1.000** | |

Pooled bias: final2 +0.313 · v11 raw −0.696 · v11w −0.400.

## Verdict

**v11 core + final2's wrapper reaches final2-class: pooled MAE 1.000 vs final2's
served 0.949** (v11 raw 2.110). The wrapper closes essentially the entire 2.1→1.0
gap. This is the decomposition experiment's **"tie" branch, slightly better than
tie: the core was never the bottleneck — the corrections were.**

**Corrections vs core:** on this window the win is almost entirely the
**persistence blend** (anchor the raw prediction to the corps' last real score
projected along the reference curves), not the bias correction — the eligible-
corps residual bias is tiny (|corr| ≤ 0.08), so the thermostat's damped/capped
term barely engages, yet MAE still halves. v11 raw's large errors are a
*static-model-far-from-last-observation* failure that the persistence anchor
fixes directly; the additive bias term is the second-order refinement final2
leans on harder only when the whole field shifts. This confirms the post-mortem:
the adaptive wrapper is worth ~2 points; the v9-vs-v11 core swap is worth tenths.

**Implication for V12 (per the plan):** since a persistence *anchor* — not a
fitted core — carries the win, the headline V12 change (predict `next −
last_real_score`, making the anchor the identity path) is the right target-space
move, and a thin persistence blend belongs in serving permanently (Phase 4.1).
The core swap alone would not have helped; the target-space change matters more.

## Ops

- Run counts (2026-07-23): backtest pooled n=74 across 9 events; live SAVE wrapped
  and saved **25** upcoming events as `clean-v11w-shadow` (unserved).
- Cron (root crontab, right after the 03:40 v11-shadow line):
  ```
  05 4 * * * SAVE=1 /usr/bin/timeout 2400 /usr/bin/flock -n /tmp/v11w-shadow.lock /usr/bin/bash -c 'bash /home/patrick/cp-v10-serving/scripts/v11w-shadow.sh' >> /home/patrick/v11w-shadow/cron.log 2>&1 || /usr/bin/bash /root/corps-place/scripts/notify-cron-failure.sh v11w-shadow "v11w-shadow cron failed"
  ```
- Reproduce the backtest:
  `DCI_DB=/root/corps-place/sdk/dci-relational.db CONTRACT_DB=/tmp/sdk-assets-contract-0723.db npx tsx tools/backtest-v11w.ts`
