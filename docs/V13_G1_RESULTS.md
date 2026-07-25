# V13 Gate G1 — W-alone ≈ final2-served (structural layer sanity)

Written 2026-07-25. Gate **G1** of [V13_PLAN.md](V13_PLAN.md) §4: build the full
STRUCTURAL LAYER **W** as a standalone, **training-free** forecaster and verify it
reproduces final2-served accuracy (**±0.2 MAE**) on the standing held-out window
**before any training happens**. This is the pre-registered checkpoint of §3.1.

- Module (reusable): [`src/structural/wLayer.ts`](../src/structural/wLayer.ts)
- Harness: [`tools/backtest-w.ts`](../tools/backtest-w.ts) → `tools/backtest-w.out.json`
- Reproduce:
  ```
  DCI_DB=/root/corps-place/sdk/dci-relational.db \
  CONTRACT_DB=/tmp/sdk-assets-contract-0725b.db \
  V12A_DIR=/home/patrick/v12a-seeds/models npx tsx tools/backtest-w.ts
  ```

## What W is (no neural core)

W is final2's serving arithmetic with the **model term removed** — the pure
structural spine of V13 (L2: *put the level in arithmetic, the shape in weights*). Per
(corps, target event), leakage-safe at both train and serve time, per caption then
reconciled to the total (`totalFromV9Captions`):

1. **persistence anchor** — last real per-caption recap strictly before D (from
   `v10_training_performances`).
2. **curve growth (curveΔ)** — per-caption additive gain `clamp(lastCaps_c +
   growth_c, [0,20])` from the clean reference curves (`referenceCurvesV4.json`),
   rank from the `currentSeasonRank` analog (latest same-season total in division
   before D), percent-through from `estimatePercentThrough`. Ported verbatim from
   `predictEventRecap.ts` L873–896 / L1747–1782. Because W has **no model**, the
   `modelBlend = (rawModel + curveΔ)/2` degenerates to **curveΔ** (beta = 0 — the
   co-tuned V12t formulation).
3. **persistence blend** — `persistW = max(0, 1 − h/H)`, **H = 25** (co-tuned V12t,
   not final2's 14); `inSeason = persistW·lastTotal + (1−persistW)·curveΔ`.
4. **comparable revert** — thin-history schedule 0.5/0.3/0.15/0 for 1/2/3/≥4
   same-season shows, blending toward the prior-season comparable total
   (`getPriorSeasonComparableTotal`, nearest percent-through, `corps_scores`).
5. **rolling bias correction** — damped **d = 0.5**, cap **±1.25**, dormant < **10**
   samples, computed from **W's OWN pre-correction pre-show residuals** on shows
   strictly before D (self-referential / honest option (a); leakage-safe). SUBTRACTED.

Constants are the co-tuned set from [V12_COTUNED_RESULTS.md](V12_COTUNED_RESULTS.md)
(H=25, d=0.5, cap=1.25). All DB access (rank, comparable) is **injected**, so the
module carries no DB dependency and is reused unchanged as the V13 training
preprocessor and the serve-time layer.

## Results — held-out 2026-07-21..24 (n=50) + in-sample 2026-07-17..20 (n=50)

Per-event and pooled MAE (points). Columns: **W** | **final2 served** | **final2 raw**
| **v12t** (v12a core + co-tuned wrapper) | **persistence**.

| event | date | H/in | n | **W** | f2 served | f2 raw | v12t | persist |
|---|---|:--:|--:|--:|--:|--:|--:|--:|
| 2026-dci-houston | 07-17 | in | 10 | 0.307 | 0.561 | 1.407 | 0.237 | 1.038 |
| 2026-dci-southwestern-championship | 07-18 | in | 22 | 1.179 | 1.099 | 1.521 | 1.095 | 0.934 |
| 2026-the-buccaneer-classic | 07-18 | in | 2 | 0.527 | 2.493 | 10.055 | 1.384 | 4.175 |
| 2026-dci-dallas | 07-19 | in | 10 | 0.516 | 1.247 | 2.503 | 0.506 | 0.726 |
| 2026-dci-mckinney | 07-20 | in | 6 | 0.650 | 0.628 | 1.099 | 0.610 | 1.104 |
| 2026-dci-st-louis | 07-21 | **HO** | 7 | 0.718 | 0.577 | 1.813 | 0.680 | 2.477 |
| 2026-dci-southern-mississippi | 07-22 | **HO** | 6 | 0.420 | 0.423 | 1.258 | 0.411 | 1.092 |
| 2026-drums-on-the-ohio | 07-22 | **HO** | 8 | 0.640 | 0.540 | 1.819 | 0.625 | 0.897 |
| 2026-march-on | 07-22 | **HO** | 3 | 1.840 | 2.764 | 1.898 | 1.401 | 4.875 |
| 2026-dci-birmingham | 07-24 | **HO** | 7 | 0.665 | 0.725 | 3.014 | 1.483 | 1.300 |
| 2026-dci-middle-tennessee | 07-24 | **HO** | 7 | 0.378 | 0.388 | 1.813 | 0.351 | 0.916 |
| 2026-dci-syracuse | 07-24 | **HO** | 4 | 2.222 | 1.870 | 1.687 | 2.933 | 4.575 |
| 2026-drums-on-parade | 07-24 | **HO** | 8 | 0.587 | 0.566 | 1.459 | 0.593 | 0.419 |
| **POOLED — HELD-OUT** | | | **50** | **0.781** | **0.780** | **1.854** | **0.915** | **1.664** |
| **POOLED — IN-SAMPLE** | | | **50** | **0.782** | **1.020** | **1.986** | **0.759** | **1.063** |

**Pooled bias (points).** Held-out: W **−0.161** · f2 served +0.050 · f2 raw −0.850 ·
v12t −0.470 · persist −1.560. In-sample: W +0.131 · f2 served +0.348 · f2 raw −0.023 ·
v12t +0.114 · persist −0.863.

**Tier splits (held-out).**

| tier | n | **W** | f2 served | f2 raw | v12t | persist |
|---|--:|--:|--:|--:|--:|--:|
| World Class | 36 | 0.564 | 0.517 | 1.534 | 0.565 | 0.987 |
| Open Class | 14 | 1.339 | 1.457 | 2.676 | 1.814 | 3.538 |
| top (≥85) | 15 | 0.346 | 0.281 | 1.443 | 0.371 | 0.898 |
| mid (80–85) | 11 | 0.560 | 0.603 | 1.918 | 0.502 | 0.900 |
| low (<80) | 24 | 1.155 | 1.173 | 2.081 | 1.444 | 2.529 |

## G1 VERDICT: **PASS on iteration 1** — no iteration required

**W 0.781 vs final2-served 0.780 on the held-out window: gap +0.002 MAE, |gap| ≪ 0.2.**
W matches the incumbent's served accuracy to a **fifth of a point better than the bar**,
while carrying **none** of final2's neural core — it is pure structural arithmetic on
live data. W also:

- **beats** the wrapped-new-core line **v12t (0.915)** by 0.134 and **halves final2's
  own raw core (1.854)** — consistent with the [FINAL2_RAW_DECOMPOSITION](FINAL2_RAW_DECOMPOSITION.md)
  thesis that the *wrapper carries the win*; W **is** that wrapper, standalone;
- has a held-out bias of **−0.161**, comfortably inside the ±1.25 corrector capacity
  (no blocking flag — contrast v11/v12a/v12b's −1.9…−2.2);
- is **better than final2 in-sample** (0.782 vs 1.020) and across every held-out tier
  except top-end WC, where it trails by ~0.05–0.07 (final2's frozen model core adds a
  little top-end shape there — exactly the residual the V13 learned core will target).

### Component-level agreement vs final2 (spot check, 10 held-out corps)

W's components track final2's payload fields tightly. `W_preCorr` (persist+curve+revert,
pre-bias) sits within ~0.1–0.4 pt of final2's `caption_shape_total` for most corps, and
`W_total` lands within ~0.1–0.3 pt of `f2_served`. Two informative divergences:

- **Bias sign flips, both land right.** W's self-referential correction is **−0.52**
  (W slightly over-predicts pre-correction, so subtracts down) while final2 reports
  **+0.55** (its served-run source ran cold, so it adds up). Different residual sources,
  opposite signs, both converge on the actual — evidence the *mechanism* is sound and
  the source choice is second-order at this density.
- **curveΔ runs hotter than final2's** (e.g. `W_curveDeltaTotal` 92–95 where final2's
  frozen-model curveΔ is gentler): W anchors curveΔ on the **real** last recap +
  growth, final2 on a *frozen model* recap. At H=25 the persistence weight (~0.9) mutes
  this to hundredths at the total, but it is the one lever most likely to matter for
  short-horizon / thin-history corps — flagged for G2.
- **Comparable revert reproduces exactly** (corps `001j000001`: W_revert 0.3,
  comparable 72.4 == final2's `comparable_revert_weight` 0.3 / `prior_season_comparable_total`
  72.4), confirming the v9 comparables port is faithful.

## The reusable module API (this exact code becomes the V13 preprocessor + serve layer)

`src/structural/wLayer.ts` — three pure pieces (mirroring final2's "bias once per
event, apply per corps"), DB-agnostic (rank + comparable injected via `WContext`):

```ts
// per-corps structural forecast BEFORE bias — persist + curveΔ + comparable revert.
// history MUST be leakage-safe (< target date); returns per-caption W + total + full components.
wPreCorrection(history: WHistoryShow[], target: WTarget, ctx: WContext): WPreResult

// damped/capped rolling mean of W's OWN pre-correction residuals on shows before D.
biasCorrectionFromResiduals(resids: Residual[], D: string, cfg: WConfig): { correction; rawBias; samples }

// subtract the correction from W's total, rescale captions (shape-preserving).
applyBias(pre: WPreResult, correction: number): WResult
// convenience:
computeW(history, target, ctx, correction = 0): WResult
```

- **`WPreResult.components`** exposes every intermediate (persistW, lastTotal,
  curveGrowthCaps, curveDeltaCaps/Total, revertWeight, comparableTotal,
  inSeasonPreRevertTotal, preCorrTotal, rank, lastPct/targetPct) — the exact
  **feature vector** the V13 residual core consumes, plus `preCorrTotal` (the residual
  anchor for `target = actual − W`).
- **`Residual[]`** is the rolling-residual pool; per-corps and per-division trailing
  statistics over it are the **L3 online channel** features (well-defined because W is
  frozen), fed to the core.
- Same function both places → **no train/serve skew** (the arm-A/B failure mode).

## What G2 needs next (per V13_PLAN §3.2 / §4)

1. **Residual targets:** build `target_c = actual_c − W_c` (per caption) over the full
   contract using `wPreCorrection` as the preprocessor; z-norm on that. G2 bar: the
   residual spread must be **well below** the raw-target spread, and targets must be
   **small where W is good** (they are — W's held-out MAE is 0.78, so most residuals
   are sub-point). Emit the residual smoke table (spread raw-target vs residual-target;
   per-tier).
2. **Rolling-residual features:** materialize per-corps / per-division trailing 7/14-day
   statistics from the `Residual[]` pool as core inputs.
3. **One curveΔ fidelity check** before training: W's curveΔ anchors on the real last
   recap vs final2's frozen-model recap (the §component divergence above). Decide
   whether the residual core should see `curveDeltaCaps` as a feature (recommended) so
   it can learn the short-horizon correction rather than W over-trusting a hot curve.
4. Then G3 full-protocol judging (add V13 = W + residual core), G4 late-season promotion
   bar, G5 overfit audit, G6 live shadow — unchanged from the plan.

**Bottom line: the structural spine is proven before a single weight is trained. W
alone is a shippable, level-safe, final2-class forecaster; the V13 learned core now has
exactly one honest job — the sub-point residual W leaves on the table (notably top-end
WC shape).**
