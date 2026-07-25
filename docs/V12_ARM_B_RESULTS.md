# V12 arm B results — field-level-relative targets + serving add-back, judged

Written 2026-07-25. Judges **V12 arm B** (target = `recap_c − field_level·w_c/5`
per caption; the season climate as an **explicit, additive, unshrunk** term added
back OUTSIDE the network at serving) under the full Phase-3 protocol of
[MODEL_IMPROVEMENT_PLAN](MODEL_IMPROVEMENT_PLAN.md) §Phase 3. Serving spec:
[V12_ARM_B_NOTES](V12_ARM_B_NOTES.md). Companion: [V12_ARM_A_RESULTS](V12_ARM_A_RESULTS.md).

**Bottom line: arm B does NOT beat final2 and does NOT reach the wrapper (v11w/v12aw)
on the held-out window. The add-back mechanism is correct and self-consistent — it is
independently proven in-sample (pooled bias −3.379 → −0.315, MAE 3.461 → 1.439) — but
it is INSUFFICIENT: the field-level signal collapses to ≈0 (and negative) exactly in
the late-season / championship-week regime that matters, so the served prediction
reverts to the attenuated v11-raw core (held-out bias −2.021 > 1.25 clamp = BLOCKING).
The 0.70 add-back factor is the self-consistent exact inverse and is already near-
optimally calibrated in-sample; a full-strength "arm B′" (factor 1.0) would OVERSHOOT
in-sample and still not fix held-out. Not a promote candidate. Keep final2 serving.**

## Setup

- **Seeds:** 8 v12b seeds (42–49), `--climate-mode subtract`, baseline EMA (v11
  semantics), identity-dropout 0.5, cutoff 2026-07-20, table
  `ml_sequence_rows_v10_field_pace`. Pulled to `/home/patrick/v12b-seeds/models/`
  in asset layout (per-seed `model.json` + `weights.bin` + `target-norm.json`; the
  norm carries `climateMode:"subtract"`, `climateCaptionWeights [1,1,.5,.5,.5,.5,.5,.5]`,
  `climateWeightSum 5`). Weights sha match v12a size (4,207,324 B). **All 8 load and
  predict sanely; no degenerate seed** — best-checkpoint epochs 24–75, bestDeltaMae
  tight 0.355–0.371 (root == best checkpoint, one complete run per seed → no
  selection ambiguity).
- **The add-back (verified):** `served_total = model_total + field_level_live ·
  (Σ w_c²)/5 = model_total + 0.70·field_level_live`. `field_level_live =
  TemporalState.fieldSnapshot(2026, division, D).level` — the UNSCALED, **division-
  wide** (constant across corps), strictly-pre-show field level, computed on the fly
  from the leakage-safe SeasonData exactly as `src/features/build.ts` L870 does (the
  materialized `v10_temporal_field_pace` table is not needed and its slug-keying is
  stale for the late window). Harness reconstructs `served` from the standard serving
  path total.
- **Data / leakage:** contract regenerated at cutoff **2026-07-25T23:59:59.999Z**
  (`/tmp/sdk-assets-contract-0725b.db`, 40 shows). **Championship-week data has since
  ingested:** four WC/OC shows scored **2026-07-24** — `2026-dci-birmingham` (5 WC / 2
  OC), `2026-dci-middle-tennessee` (7 WC), `2026-dci-syracuse` (4 OC),
  `2026-drums-on-parade` (7 WC / 1 OC) — the true held-out window is now **07-21..07-24,
  n=50** (arm A had only 07-21..22, n=24). All inputs leakage-safe: SeasonData strictly
  pre-D; each wrapper's bias uses only its own pre-show residuals before D.
- **Harness:** `tools/backtest-v12b.ts` (reuses the v12a/v12aw machinery; final2 /
  v11w reproduce the published decomposition). Output `tools/backtest-v12b.out.json`.

## Full protocol table — window 2026-07-17..07-24 (per-event MAE, points)

`fieldLvl` = the live field level (WC / OC) added back ×0.70. `H` = held-out (date >
07-20) vs `in` = in-sample.

| event | date | n | H | fieldLvl WC/OC | **v12b** | v12b-noAB | **v12bw** | **final2** | v11w | v12a raw | persist |
|---|---|--:|:--:|--:|--:|--:|--:|--:|--:|--:|--:|
| 2026-dci-houston | 07-17 | 10 | in | 3.75 / 4.77 | 0.856 | 2.814 | 0.498 | 0.561 | 0.457 | 0.908 | 3.947 |
| 2026-dci-southwestern-championship | 07-18 | 22 | in | 4.69 / 4.62 | 1.369 | 3.478 | 1.075 | 1.099 | 1.100 | 1.493 | 3.843 |
| 2026-the-buccaneer-classic | 07-18 | 2 | in | 4.69 / 4.62 | 1.718 | 1.515 | 0.508 | 2.493 | 0.570 | 0.910 | 4.969 |
| 2026-dci-dallas | 07-19 | 10 | in | 4.73 / 4.32 | 1.936 | 3.982 | 0.793 | 1.247 | 0.763 | 1.814 | 1.003 |
| 2026-dci-mckinney | 07-20 | 6 | in | 3.59 / 3.63 | 1.745 | 4.261 | 1.083 | 0.628 | 1.001 | 1.298 | 1.848 |
| **2026-dci-st-louis** | 07-21 | 7 | **HO** | 2.05 / 3.63 | **3.355** | 3.878 | 1.429 | 0.577 | 1.383 | 3.047 | 2.195 |
| **2026-dci-southern-mississippi** | 07-22 | 6 | **HO** | 0.44 / 2.96 | **2.917** | 3.224 | 0.849 | 0.423 | 0.833 | 3.232 | 3.374 |
| **2026-drums-on-the-ohio** | 07-22 | 8 | **HO** | 0.44 / 2.96 | **3.141** | 2.854 | 0.964 | 0.540 | 0.936 | 3.367 | 1.594 |
| **2026-march-on** | 07-22 | 3 | **HO** | 0.44 / 2.96 | **2.232** | 1.543 | 2.578 | 2.764 | 2.755 | 2.162 | 6.266 |
| **2026-dci-birmingham** | 07-24 | 7 | **HO** | −0.56 / 1.57 | **4.615** | 4.333 | 2.116 | 0.725 | 1.892 | 4.946 | 1.050 |
| **2026-dci-middle-tennessee** | 07-24 | 7 | **HO** | −0.56 / 1.57 | **2.070** | 1.676 | 0.720 | 0.388 | 0.647 | 1.692 | 0.977 |
| **2026-dci-syracuse** | 07-24 | 4 | **HO** | −0.56 / 1.57 | **2.601** | 3.069 | 2.780 | 1.870 | 2.629 | 2.701 | 2.668 |
| **2026-drums-on-parade** | 07-24 | 8 | **HO** | −0.56 / 1.57 | **2.835** | 2.353 | 0.432 | 0.566 | 0.444 | 3.221 | 0.598 |
| **POOLED — HELD-OUT** | | **50** | | | **3.054** | **2.942** | **1.299** | **0.780** | **1.245** | **3.144** | **1.954** |
| POOLED — in-sample *(reported separately, NOT pooled with HO)* | | 50 | | | **1.439** | **3.461** | 0.882 | 1.020 | 0.871 | 1.393 | 3.102 |

**Pooled bias (points).** Held-out: v12b **−2.021** · v12b-noAB −2.550 · v12bw −0.800
· final2 +0.050 · v11w −0.705 · v12a −2.227 · persist +0.836. In-sample: v12b **−0.315**
· v12b-noAB **−3.379** · v12bw −0.518 · final2 +0.348 · v11w −0.447 · v12a −0.348 ·
persist +2.322.

### Worked example (hand-verified) — 2026-dci-houston, World Class

`field_level_live = 3.7531` (matches the table). Add-back at total level =
`0.70 × 3.7531 = 2.6272`, applied uniformly to every WC corps. Top-3 predicted WC corps:

| corps | model (noAB) | +2.627 = served | actual | \|err\| noAB → served |
|---|--:|--:|--:|--:|
| 001j…iwwsraal | 86.295 | 88.922 | 91.150 | 4.855 → 2.228 |
| 001j…iwwssaal | 85.914 | 88.541 | 89.500 | 3.586 → 0.959 |
| 001j…iwx91aad | 84.011 | 86.638 | 88.500 | 4.489 → 1.862 |

The climate-removed core systematically under-predicts by ≈ the field level (the
smoke prediction of the notes); the add-back restores it. Confirmed at the pool level:
in-sample the add-back shifts pooled bias **−3.379 → −0.315 (Δ +3.064)**, which equals
`0.70 × 4.38` — i.e. 0.70 × the mean in-sample field level. Exact, correct, and
self-consistent.

## Verdicts (Phase-3)

**(a) Does v12b beat final2 (~0.80) on the held-out window?** **NO.** v12b 3.054 vs
final2 0.780 (held-out, n=50) — ≈4× worse. Even in-sample (07-17..20) v12b 1.439 loses
to final2 1.020. Not final2-class.

**(b) Does the built-in climate term match the external wrapper (v11w/v12aw ~1.23–1.27)?**
**NO.** v12b 3.054 vs v11w 1.245 held-out. The additive division-wide climate term is
**not** equivalent to the wrapper's per-corps curve+persistence blend; v12b lands on
top of v11 raw / v12a raw (3.14), not on the wrapper. The climate term and the wrapper
solve different problems — the wrapper tracks each corps's own upward trajectory, which
a division-wide constant cannot.

**(c) Bias vs clamp.** Held-out |bias| **2.021 > 1.25 → BLOCKING FLAG** (same failure
class as v11/v12a: OOD under-prediction the ±1.25 recal clamp cannot absorb). In-sample
|bias| 0.315 is fine — the add-back calibrates it beautifully in-distribution.

**(d) Add-back ablation (mechanism proof).** In-sample the add-back is decisively
correct: v12b-noAB 3.461 / bias −3.379 → v12b 1.439 / bias −0.315 (**ΔMAE +2.022**),
and the houston worked example shows per-corps errors of 4.9/3.6/4.5 collapsing to
2.2/1.0/1.9. **But held-out the add-back does essentially nothing** (noAB 2.942 → v12b
3.054, ΔMAE −0.112, i.e. marginally *worse*): the field level has collapsed to 0.44
(07-22) and −0.56 (07-24), so `0.70 × field_level ≈ 0`, and at 07-24 it even pushes
predictions the wrong way. The mechanism fires; there is simply no climate left to add
back in the regime where the model under-predicts. The held-out under-prediction is a
**corps-specific growth-attenuation** problem, not a climate problem — and the field-
level term is a division-wide climate signal.

**(e) Degenerate seeds.** None. All 8 load, read vocab, and predict sanely (houston WC
pool tops ~88–89 after add-back); best-checkpoint epochs 24–75, bestDeltaMae 0.355–0.371;
one complete run per seed.

## The 0.70 factor and the arm-B′ projection

The add-back applies the **full, self-consistent 0.70 factor** (`Σ w_c²/5 = 3.5/5`) —
the exact total-level inverse of the training subtraction, not a partial fraction of a
needed 1.0. Evidence it is already near-optimally calibrated: **in-sample it lands the
pooled bias at −0.315** (near zero). A "corrected-normalization" **arm B′** that
distributes the climate at full caption weight (total factor 1.0, full externalization)
would add `1/0.70 = 1.43×` more: in-sample bias would move from the noAB −3.379 by
`+4.38` to **+1.00 — an overshoot**, strictly worse than the self-consistent 0.70. And
it would **not** help held-out, where the field level is ≈0/negative so the extra 0.30×
changes the add-back by hundredths of a point.

So the 0.70 factor is *not* the defect, and arm B′ is **not worth training**: the
improvement is directionally correct but partial for a reason the factor cannot fix —
the field-level-vs-reference signal is a division-wide climate that goes flat/negative
in championship week while individual corps keep climbing. Reparametrizing its strength
cannot recover a per-corps growth signal it never contained.

## Why — same root cause as arm A, one layer deeper

Arm A proved the persistence anchor was already in serving, so retargeting the residual
barely moved serving. Arm B makes the **climate** term explicit and unshrunk — and,
in-sample, that term is real and correctly restored (unlike arm A, arm B *does* change
the served function in-distribution: v12b 1.439 vs v12a 1.393 ≈ tie in-sample, but with
a well-calibrated bias). The failure is that the explicit term is the **wrong kind of
signal for the OOD regime**: a division-wide additive constant that collapses exactly
when the individual-corps inflation it is meant to proxy accelerates. The wrapper wins
because it is **per-corps** (each corps's own last score + curve growth + horizon
persist), and it remains core-agnostic: **v12bw 1.299 ≈ v11w 1.245 ≈ v12aw 1.227** —
the wrapper collapses v12b's blocking −2.021 bias to −0.800 and does ~1.76 pts of MAE
work (3.054 → 1.299), while the core swap is worth tenths at most. Third independent
confirmation of the decomposition thesis: **the adaptive wrapper carries the win; the
fitted core (v11 / arm A / arm B) is interchangeable.**

## Recommendation

**Do not promote arm B. Keep final2 serving (unchanged). Do not train arm B′.**
Target-space climate reparametrization is a dead end for the OOD inflation regime.
Specifically for August (see plan Phase 1.1 / 2):

1. **The Phase-4.1 wrapper is permanent, not optional** — three cores (v11, v12a, v12b)
   all reach ~1.23–1.30 held-out only *through* it; none reaches it raw. Whatever V12
   core ships, serve it under the persistence/curve blend + damped-capped recal.
2. **Drop the target-space climate arm from the headline.** Arms A and B both fail to
   internalize the wrapper; the remaining target-space idea (arm B′) is projected to
   overshoot in-sample and not fix held-out.
3. **The real levers are cadence + de-attenuation, not target space:** Phase 2 weekly
   in-season fine-tune (never train >7 days stale — this directly attacks the collapsed-
   field-level / OOD window), plus loss-shaping / recency-weighting to de-attenuate the
   growth head (the persistent under-prediction survives every retarget).

Reproduce:
```
DCI_DB=/root/corps-place/sdk/dci-relational.db \
CONTRACT_DB=/tmp/sdk-assets-contract-0725b.db \
V12B_DIR=/home/patrick/v12b-seeds/models V12A_DIR=/home/patrick/v12a-seeds/models \
V11_050_DIR=/home/patrick/v11-seeds BT_END=2026-07-24 npx tsx tools/backtest-v12b.ts
```
Outputs `tools/backtest-v12b.out.json`. Seeds in `/home/patrick/v12b-seeds/`. Contract
rebuild: `cd /home/patrick/cp-branch/sdk && npx tsx scripts/prepareV10TrainingData.ts
--serving --seasons 2026 --development-cutoff 2026-07-25T23:59:59.999Z --source
/root/corps-place/sdk/dci-relational.db --out /tmp/sdk-assets-contract-0725b.db
--contract-version v10-training-performances-serving-0725b`.
