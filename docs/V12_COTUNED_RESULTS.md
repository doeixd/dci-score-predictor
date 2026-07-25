# V12t — co-tuned wrapper results (v12a core + wrapper params fit FOR that core)

Written 2026-07-25. Tool: `tools/backtest-v12t.ts` (out: `tools/backtest-v12t.out.json`).

## The question

The v12aw probe ([V12_ARM_A_RESULTS.md], commit 0908b3b) bolted final2's **exact**
wrapper — constants tuned over months for its **v9** core — onto the v12a core and
got held-out 1.001 (vs final2's served ~0.81 on that window). Those constants were
never fit for v12a. This experiment asks: **does the gap close if the wrapper's
parameters are co-tuned for the v12a core**, the way final2's were for v9 — done
here leakage-safely in one pass?

## Method

- **Core:** frozen 8-seed v12a persistence-residual ensemble (`/home/patrick/v12a-seeds`),
  agnostic identity, standard serving path. Raw pre-show inference cached once,
  reused across all 26 208 candidates (raw preds are independent of wrapper params).
- **Tuned parameters** (wrapper only): `H` in `persistW = max(0, 1 − horizonDays/H)`
  (grid 5..30); blend `beta` in `modelBlend = beta·raw + (1−beta)·curveΔ` (0..1
  step 0.05); bias damping `d` (0.3..1.0) and `cap` (1.25..3.0). Comparable-revert
  schedule NOT applied — the published v11w/v12aw implementations also omit it, so
  the comparison is apples-to-apples.
- **Bias source — honest option (a), self-referential:** for each candidate `(H,beta)`
  the bias is the mean of the wrapper's **own pre-correction** pre-show forecast
  residuals on prior shows (strictly before D, corps with ≥1 prior same-season
  score). Excluding the correction term from the residual definition keeps it
  non-circular while still self-referential to the tuned persist/blend params.
  Computed **inside** the tuning loop for every candidate (not a two-pass default-param
  approximation).
- **Leakage discipline:** parameters tuned ONLY on **2026-07-17..07-21** (tuning
  window); the single best candidate is FROZEN and evaluated on the untouched
  **2026-07-22..07-24** validation window (includes the four 07-24 championship-week
  shows; no 07-25 shows scored yet). v12a's training cutoff is 07-20, so the entire
  validation window is genuinely out-of-sample for the core; the headline number is
  validation MAE.

## Tuned constants vs final2's

| param | v12t (tuned for v12a) | final2 (tuned for v9) | reading |
|---|---|---|---|
| `H` (persistence horizon) | **25** | 14 | LONGER — decays persistence slower, trusts the last real score longer |
| `beta` (model vs curveΔ) | **0.45** | 0.50 | leans slightly MORE on curveΔ than on the v12a model |
| `d` (bias damping) | **0.5** | 0.67 | damps the bias correction more |
| `cap` (bias cap) | **1.25** | 1.25 | same |

## Results — both windows

| model | tuning MAE (n=57) | tuning bias | **validation MAE (n=43)** | validation bias |
|---|---|---|---|---|
| **v12t (co-tuned)** | 0.749 | +0.022 | **0.953** | −0.443 |
| final2 (served) | 0.966 | +0.268 | **0.813** | +0.108 |
| v11w (published) | 0.867 | +0.368 | 1.028 | −0.090 |
| v12aw (published wrapper) | 0.850 | +0.354 | 1.001 | −0.118 |

## Verdict

**v12t does NOT reach final2 (±0.1) on the untouched validation window: 0.953 vs
0.813, gap +0.140 MAE.**

Co-tuning helped and generalized — the same v12a core improves from v12aw's 1.001
(published wrapper) to v12t's 0.953 out-of-sample — but roughly a third of the way,
not enough to close the gap. So the residual gap to final2 is **structural, not a
wrapper-calibration artifact → arm C** (per-corps curveΔ quality / craft).

**Diagnostic — the validation bias tells the story.** On the championship-week
validation shows v12t carries a **−0.443** bias (systematic under-prediction) while
final2 sits at **+0.108**. The tuner, fit on the calmer 07-17..21 regime, chose a
long horizon (H=25) and gentle damping (d=0.5) that lean hard on the last real
score; when late-July score inflation accelerates (the exact non-stationarity
[V12_TRAINING_NOTES.md] was built to fix), that persistence-heavy blend lags the
field and under-shoots. final2's craft — a shorter horizon plus a bias correction
tuned across an inflating late season — absorbs that climate better. This is the
regime the tuning window cannot see, and it is precisely where 5 days of one regime
mis-generalizes.

## Recommendation

Do **not** promote v12t on this evidence. The gap is structural; pursue **arm C**
(improve the per-corps curveΔ / craft rather than re-calibrate the thermostat). Even
if a future variant were to reach final2 on this window, the constants here were
tuned on **5 days of a single regime** — any promotion case must re-validate over
the full championships week before a flip is considered.
