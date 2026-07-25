# V12 arm B — field-level-relative targets: the serving ADD-BACK

Written 2026-07-25. Companion to [V12_TRAINING_NOTES](V12_TRAINING_NOTES.md)
(arm B design) and [V12_ARM_A_RESULTS](V12_ARM_A_RESULTS.md) (why arm A failed:
the retarget did not change the served function — the persistence anchor was
already in serving). Arm B makes the season-climate term **explicit, additive,
and OUTSIDE the learned network** — that is the wrapper's extrapolation property
arm A lacked. This note is the authoritative spec for the eval/judging harness:
**an arm-B model is only correct when the field level is added back at serving.**

## What the model was trained to predict

Trainer flag `--climate-mode subtract` (branch `v12-arm-b`,
`runV12ArmBFieldRel.sh`). For every training row the trainer subtracts that row's
**leakage-safe field level**, distributed across captions, from the recap
target BEFORE norm computation:

```
share_c        = field_level_train * w_c / 5
recap_target_c = recap_c - share_c
```

- `field_level_train` = `v10_temporal_field_pace.field_level_vs_reference` for
  that row (`row_key = season|slug|division|corps_key`). **UNSCALED, total-level
  points**, strictly-prior / as-of, leakage-safe by construction. It is NOT the
  `/10`-scaled value that also lives in `x_static_json` — that scaled feature is
  a separate model input and is unchanged.
- Weights `w` follow the total formula, caption order
  `[GE1, GE2, VP, VA, CG, MB, MA, MP]`:

  ```
  w = [1.0, 1.0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]     Σ w = 5
  ```

- The delta head target is `(recap_c - share_c) - baseline_c`; the baseline stays
  the **raw** EMA of prior real recaps (v11 semantics — arm B changes ONE
  variable, climate only, NOT the baseline; contrast arm A's `--baseline-mode
  last`). `target-norm.json` records `climateMode`, `climateCaptions`,
  `climateCaptionWeights`, `climateWeightSum` so serving can detect the shifted
  target space. z-norm stats (`deltaMean`/`deltaStd`) are computed over the
  climate-ADJUSTED targets.

So the reconstructed model output at serving,
`recap_removed_c = baselineRecap_serve_c + denorm(delta_c)` (the existing
`serve.ts` L99–105 path), estimates the **climate-removed** recap.

## The add-back (apply this at serving / in the judging harness)

Add the **LIVE** field level back, distributed with the SAME weights, **unshrunk
and unclamped** — pure arithmetic outside the network:

```
served_recap_c = recap_removed_c + field_level_live * w_c / 5          (per caption)
served_total   = Σ_c  W_total_c * served_recap_c                        (standard total formula)
               = total_removed + field_level_live * (Σ w_c²) / 5
               = total_removed + 0.70 * field_level_live                (Σ w_c² = 3.5)
```

- `field_level_live` = the temporal **fieldSnapshot level** for the corps'
  `(division, as-of date)` — i.e. the same
  `v10_temporal_field_pace.field_level_vs_reference` (UNSCALED, total-level
  points) resolved for the serving as-of snapshot the pipeline already builds.
  **Use the snapshot level, NOT `x_static_json[fieldPaceIdx] * 10`** (the scaled
  feature); they are numerically the field level / 10 but the snapshot is the
  canonical, unshrunk source.
- **No shrinkage, no `/10`, no recal clamp on the add-back term.** The whole point
  of arm B vs the existing `/10`-scaled, shrinkage-damped field-pace *input* is
  that the climate term is now applied at full strength, additively, in score
  space.
- The per-caption subtraction (train) and add-back (serve) use an identical
  distribution, so they are **exact inverses at the caption/delta level**. The
  total-level consequence of the caption distribution is `0.70 * field_level`
  (half-weighted visual/music captions), applied consistently on both sides — the
  harness simply reconstructs `served_total` from `served_recap` with the standard
  total formula and inherits this automatically.

## Harness checklist

1. Load the arm-B seed pool from `models/v12b_fieldrel_field_pace/` (norm files
   `results/v12b_fieldrel-field-pace-seed-{42..49}-target-norm.json`, which carry
   `climateMode: "subtract"`).
2. Reconstruct `recap_removed` via the standard serving path (last-real
   `baselineRecap` + `denorm(delta)`), exactly as v11/arm-A.
3. Resolve `field_level_live` from the temporal field-pace snapshot for each
   corps' `(division, as-of date)`, unshrunk.
4. Add `field_level_live * w_c / 5` per caption; recompute total.
5. Only then compare against final2 / v11w / persistence on a matched recent
   window (per V12_TRAINING_NOTES §5). A model judged WITHOUT the add-back is
   mis-served and will look like v11-raw (that was arm A's whole failure).

## Smoke evidence (one epoch each mode, baseline EMA fixed)

`--climate-mode subtract` shifts the delta-target distribution over the 7535
training rows (7426 with nonzero field level, mean|field_level| = 2.47 pts):

```
delta-target   mean 0.2035 -> 0.1422   (climate removed)
per-caption deltaMean   GE1 0.141 -> 0.074 (full weight w=1.0)
                        VP  0.135 -> 0.101 (half weight w=0.5)
```

The GE shift is ~2× the visual/music shift — exactly the `w_c/5` distribution —
confirming the subtraction uses each row's own leakage-safe field level.
