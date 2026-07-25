# V12 arm A results — persistence-residual targets, held-out judging

Written 2026-07-25. Judges **V12 arm A** (target = `next_recap − last_real_recap`
per caption; the persistence anchor as the model's identity path) under the full
Phase-3 protocol of [MODEL_IMPROVEMENT_PLAN](MODEL_IMPROVEMENT_PLAN.md) §Phase 3.
Companion: [V12_TRAINING_NOTES](V12_TRAINING_NOTES.md),
[V11W_DECOMPOSITION](V11W_DECOMPOSITION.md).

**Bottom line: arm A does NOT beat final2 and does NOT reach v11w on the held-out
inflation window. Served through the (correct) standard path it performs
essentially identically to v11 raw. Not a promote candidate on its own.**

## Setup

- **Seeds:** 8 v12a seeds (42–49), `--baseline-mode last`, identity-dropout 0.5,
  training cutoff 2026-07-20, table `ml_sequence_rows_v10_field_pace`. Pulled to
  `/home/patrick/v12a-seeds/models/` in asset layout (per-seed `model.json` +
  `weights.bin` + `target-norm.json` + `MANIFEST.json`). Embedding capacity
  judge 245 / corps 709 / show 349 — the SDK loader reads vocab from the model;
  **all 8 load and predict sanely** (kentucky pooled top ≈ 88.3, range 76.9–88.3,
  zero out-of-range; every seed loads individually).
- **Checkpoint choice (assumption):** the mini-PC held **two** complete training
  runs per seed (Jul 23 afternoon batch + Jul 24 morning batch, same
  config/norm/cutoff — a robustness re-run, `startEpoch 0` both). To avoid
  selecting on the 52-row internal test MAE (which would bias this evaluation),
  the pool uses the **chronologically-first complete run per seed**. The second
  batch has comparable internal test MAE (mean ≈0.77 vs ≈0.71) and would not
  change the verdict.
- **v12a serving path is correct (verified).** `src/model/serve.ts` L99–105 feeds
  the corps' **last-observed recap** as `baselineRecap` for every model, and
  `inference.ts` reconstructs `recap = denorm(delta) + baselineRecap`. v12a's
  delta head was trained against exactly this last-real baseline, so the standard
  path is the correct v12a path — **no wrapper applied to the v12a column.** (This
  also means the persistence anchor was already in serving for v11; see §Why.)
- **Data / leakage:** contract DB regenerated at cutoff **2026-07-25T23:59:59.999Z**
  (`prepareV10TrainingData --serving --seasons 2026`, live prod DB). Latest scored
  WC/OC show is **2026-07-22** — **no World/Open shows have scored 2026-07-23..25**
  (only 4 competitions exist in that window; ingest shows nothing past 07-22). So
  the true held-out window is **07-21..07-22**, not 07-25. All model inputs are
  leakage-safe: `SeasonData` built strictly from shows before each target date;
  v11w bias correction uses only v11 pre-show residuals before D.
- **Harness validated:** `tools/backtest-v12a.ts` reproduces the published
  decomposition numbers **exactly** over the 9-show window (n=74): final2 0.949,
  v11w 1.000 (see V11W_DECOMPOSITION). High confidence the v12a numbers are real.

## Full protocol table — window 2026-07-17..07-22 (per-event MAE, points)

`H` = held-out for v12a (date > 07-20 cutoff) vs `in` = in-sample-for-v12a.

| event | date | n | H | **v12a (8)** | **final2 (served)** | v11 raw | v11w | pure persist |
|---|---|--:|:--:|--:|--:|--:|--:|--:|
| dci-houston | 07-17 | 10 | in | 0.908 | 0.561 | 0.954 | 0.457 | 3.947 |
| dci-southwestern-championship | 07-18 | 22 | in | 1.493 | 1.099 | 1.751 | 1.100 | 3.843 |
| the-buccaneer-classic | 07-18 | 2 | in | 0.910 | 2.493 | 1.154 | 0.570 | 4.969 |
| dci-dallas | 07-19 | 10 | in | 1.814 | 1.247 | 2.116 | 0.763 | 1.003 |
| dci-mckinney | 07-20 | 6 | in | 1.298 | 0.628 | 1.497 | 1.001 | 1.848 |
| **dci-st-louis** | 07-21 | 7 | **HO** | **3.047** | 0.577 | 3.266 | 1.383 | 2.195 |
| **dci-southern-mississippi** | 07-22 | 6 | **HO** | **3.232** | 0.423 | 2.995 | 0.833 | 3.374 |
| **drums-on-the-ohio** | 07-22 | 8 | **HO** | **3.367** | 0.540 | 3.381 | 0.936 | 1.594 |
| **march-on** | 07-22 | 3 | **HO** | **2.162** | 2.764 | 2.586 | 2.755 | 6.266 |
| **POOLED — HELD-OUT** | | **24** | | **3.089** | **0.800** | 3.151 | 1.268 | 2.798 |
| POOLED — in-sample-for-v12a *(reported separately, NOT pooled with HO)* | | 50 | | 1.393 | 1.020 | 1.610 | 0.871 | 3.102 |

**Pooled bias (points).** Held-out: v12a **−1.906** · final2 +0.239 · v11 raw
−1.467 · v11w −0.301 · persist +2.062. In-sample: v12a −0.348 · final2 +0.348 ·
v11 raw −0.326 · v11w −0.447 · persist +2.322.

### Held-out tier splits (n | MAE | bias)

| tier | v12a | final2 |
|---|---|---|
| T0 established | 22 / 3.292 / −2.087 | 22 / 0.794 / +0.183 |
| T1 partial | — | — |
| T2 sparse | 2 / 0.861 / +0.077 | 2 / 0.856 / +0.856 |
| T3 cold_start | — | — |

The held-out window is almost entirely established WC corps (T0), which is exactly
where the late-July inflation regime bites and where final2's wrapper earns its
keep. v12a's failure is concentrated there (T0 MAE 3.29, bias −2.09).

## Verdicts (Phase-3)

**(a) Does v12a beat final2 (~0.95–1.1) on the true held-out window?** **NO.**
v12a 3.089 vs final2 0.800 (held-out, n=24). Not final2-class; ~4× worse. Even
*in-sample* (07-17..20, data v12a trained on) v12a 1.393 loses to final2 1.020.

**(b) Does v12a ≈/beat v11w (architecture internalizes the wrapper)?** **NO.**
v12a 3.089 vs v11w 1.268 held-out. The target-space change did **not** internalize
the wrapper's inflation-tracking. v12a lands right on top of v11 raw (3.089 vs
3.151), not on top of v11w.

**(c) Bias vs clamp.** Held-out |bias| **1.906 > 1.25 clamp capacity → BLOCKING
FLAG.** Same failure class as v11: a persistent under-prediction that the ±1.25
division-recal clamp cannot absorb in a regime shift. (In-sample |bias| 0.348 is
fine — the problem is strictly out-of-distribution.)

**(d) Degenerate seeds.** None detected. All 8 seeds load, read their own vocab,
and predict sanely on kentucky (per-seed tops 87.99–89.01, tight); the pool is
coherent and slightly *better* than v11 raw on 4/9 events (houston, buccaneer,
dallas, march-on), confirming the 8 are distinct, non-degenerate v12a models —
they are simply, collectively, still too attenuated for the regime.

## Why — the anchor was already in serving; the delta head is still attenuated

The plan's arm-A thesis was "make the persistence anchor the model's identity
path so OOD failure degrades to 'predict the anchor' (final2's behavior)." The
measured result says that, *by itself, at serving time, it changes almost
nothing*, for a concrete reason:

- **The SDK already anchors every model to the last-real recap.** `serve.ts`
  L99–105 sets `baselineRecap` = the corps' last observed recap for v11 AND v12a;
  the recap is reconstructed as `baseline + denorm(delta)`. So v11 "raw" is
  *already* `last_real + learned_delta`. Arm A's retarget moves the anchor from
  the training objective's frame into the serving frame — but the serving frame
  was already anchored. Net serving behavior barely moves (v12a 3.09 ≈ v11 3.15).
- **The learned delta stays attenuated either way.** Both heads are MSE-trained
  on 13+ seasons where hot streaks mean-revert, so both predict small/timid
  growth for a corps sprinting upward. v12a's average delta (deltaMean ≈0.108) is
  if anything *smaller* than v11's (≈0.126) — consistent with v12a's slightly
  more-negative held-out bias. Persistence-residual targeting did not de-attenuate
  the growth term; it only re-based it.
- **What actually carries final2/v11w's win is the EXTRA blend beyond the bare
  anchor** — the `(model + curveΔ)/2` ensemble and the horizon-weighted
  `persistW·lastTotal + (1−persistW)·modelBlend` pull the prediction *toward*
  curve-projected persistence and *away* from the attenuated model. Neither v11
  raw nor v12a includes that extra pull; v12a therefore does not reach v11w.

Pure persistence (last + leakage-safe curve gain) alone is also not the answer
(held-out 2.798, bias +2.062 — it *over*-shoots the inflation). The win is the
*damped blend* of anchor and model, i.e. the wrapper — which arm A does not
reproduce.

## Recommendation

**Do not promote arm A. Keep final2 serving (unchanged).** Specifically:

1. **Arm A is insufficient alone → run arm B** (field-level-relative targets:
   predict `score − field_level(t)`, field level added back unshrunk). Arm A
   proved the residual can be *re-based* without de-attenuating; arm B makes the
   season-climate term *explicit and unshrunk*, which is the property arm A
   lacked. This is the more promising target-space fix.
2. **The structural wrapper stays permanent (Phase 4.1), not optional.** This
   result is direct evidence that the win is the damped anchor↔model blend, not
   the core or the bare serving anchor. Whatever V12 core ships, serve it under
   the persistence/curve blend + adaptive recal.
3. **Cheap follow-up: shadow `v12aw` (v12a core + final2 wrapper)** on this same
   window. If v12a-under-wrapper ≈ v11w, the core swap is (again) worth tenths and
   the decision reduces to arm B vs cadence; if it beats v11w, arm A's better
   in-distribution posing helps once the wrapper supplies the OOD anchor.
4. **Re-judge on a *later* held-out window once 07-23+ WC/OC shows ingest** — the
   current held-out is only 1–2 days past cutoff and 4 events; the verdict is
   directionally strong (4× gap, blocking bias) but the window is thin.

## Reproduce

```
DCI_DB=/root/corps-place/sdk/dci-relational.db \
CONTRACT_DB=/tmp/sdk-assets-contract-0725.db \
V12A_DIR=/home/patrick/v12a-seeds/models V11_050_DIR=/home/patrick/v11-seeds \
npx tsx tools/backtest-v12a.ts
```

Outputs `tools/backtest-v12a.out.json`. Seeds in `/home/patrick/v12a-seeds/`.
Contract rebuild: `cd /home/patrick/cp-branch/sdk && npx tsx
scripts/prepareV10TrainingData.ts --serving --seasons 2026 --development-cutoff
2026-07-25T23:59:59.999Z --source /root/corps-place/sdk/dci-relational.db --out
/tmp/sdk-assets-contract-0725.db --contract-version v10-training-performances-serving-0725`.
