# V13 Gate G2 — residual-core training data + 8-seed launch

Written 2026-07-27. Gate **G2** of [V13_PLAN.md](V13_PLAN.md) §3.2/§4: build the
residual-core training data on top of the frozen G1 structural layer
([`src/structural/wLayer.ts`](../src/structural/wLayer.ts)) and launch the 8-seed
training run. **The same wLayer code generates the training targets here and serves
later** — no train/serve skew (the arm-A/B lesson).

## Supersedes arm C

V12 arm C (`v12c_stacked`, interrupted at launch ~07-25) is superseded by this build —
same stacking idea, better W (the G1-passed structural layer instead of the reduced-scope
pure-structural prototype). Inventory of the mini-PC found **no arm-C leftovers**: no
`v12-arm-c` branch, no scheduled task, no scripts/checkpoints/logs. Nothing to disable.

## Data

- Source snapshot: prod DCI (scored through 2026-07-26) transferred to the mini-PC and
  frozen as `data/v10-source-2026-07-27.db` + hash manifest
  (`src/training/baselines/v10-source-2026-07-27.json`, freezeV10Source.ts).
- Contract: `prepareV10TrainingData.ts` with `--dev-train-through 2026-07-24T23:59:59.999Z`
  → `data/v13-training-cutoff0724.db`, **7,585 rows** (7,317 through 2025 + 268 of 2026
  through 07-24; the 43 scored rows on 07-25/26 + everything forward are true held-out).
- Temporal features: `prepareV10TemporalFeatures.ts` (field_pace coverage 7,585/7,585).
- Sequences: `buildMlSequencesV9Subcaption.ts --data-contract clean-v10
  --feature-profile field-pace` → `ml_sequence_rows_v10_field_pace` (dev1 artifacts,
  216-dim base static).

## The preprocessor — tools/gen-v13-training-data.ts

Runs `wPreCorrection` + `biasCorrectionFromResiduals` (frozen G1 module, co-tuned
H=25/d=0.5/cap=1.25) over every contract row **chronologically and leakage-safely**,
per season: W for row R uses only that corps' shows strictly before R's date; the bias
pool and the rolling-residual features use only W's OWN pre-correction residuals on
shows strictly before R's date. Prior-season comparables come from the DCI DB
(`getPriorSeasonComparableTotal` port, unchanged from `tools/backtest-w.ts`).

Written per row into the training DB alongside the ml table:

| column | content |
|---|---|
| `w_caption_json` | W_c per caption, bias correction applied (the residual baseline) |
| `w_total` / `w_precorr_total` / `w_bias_correction` | W total, pre-correction total, per-event correction |
| `v13_resid_features_json` | the k=7 L3 features (below) |
| `x_static_json` | rebuilt as base(216) ++ features(7) = **223** |
| `x_static_base_json` | frozen copy of the original 216-dim static (determinism anchor) |

**k = 7 rolling W-residual features (the L3 online channel)** — trailing statistics of
W's own pre-correction residuals (err = W_pre − actual), all strictly-before-date:

1. `corps_resid_mean_7d` — this corps' mean W-residual, trailing 7 days (was W hot/cold on THIS corps lately)
2. `corps_resid_mean_14d` — same, 14 days (slower, more support)
3. `corps_resid_support_14d` — min(n,4)/4 — how much to trust 1–2
4. `div_resid_mean_7d` — division-level mean W-residual, 7 days (the regime/level shock channel)
5. `div_resid_mean_14d` — same, 14 days
6. `div_resid_std_14d` — division residual spread (regime turbulence)
7. `div_resid_support_14d` — min(n,40)/40

Compact by design: means capture level, supports gate trust, one std captures
turbulence; per-caption variants were rejected as 8x dimensionality for a total-level
phenomenon (L2: the level is a total-level shock).

Determinism: no randomness/timestamps in emitted columns; static always rebuilt from
the frozen base — two full runs are byte-identical (verified, see smoke).

## Trainer changes (mini-PC branch v13-g2, commit 62470a5)

`--baseline-mode w` in the v95 engine: `applyBaselines` sets `globalBaseline` from
`w_caption_json`, so the existing delta-target machinery produces
`target_c = actual_c − W_c`, and `computeTargetStats` z-norms on those residuals —
norms on residual targets for free. Rows without W (absent from contract) fall back to
the persistence anchor. `--raw-static-dim 223` grows the static input. Identity-dropout
0.5 + the v11 recipe otherwise unchanged (see `scripts/runV13Residual.sh`).

`target-norm.json` records v13 metadata: `baselineMode: "w"`, `version:
"v13-residual-g2"`, the serve composition and the feature list.

## Serving composition (for G3+ and the serve path)

```
prediction_c = W_c(live) + residual_output_c
```

- W(live) = `computeW(history, target, ctx, correction)` from wLayer — persistence +
  curveΔ + comparable revert + damped/capped rolling bias — computed at serve time
  from live season data, exactly as the preprocessor computed it for training rows.
- The residual model consumes the 216 v10 field-pace statics + the 7 rolling-residual
  features (computed at serve time from the same live W residual pool).
- The model's zero is W: if the net contributes nothing, serving degrades to the
  G1-passed W (0.781 held-out MAE) — level-safe by construction (L2).

## STATUS 2026-07-27: PAUSED after data build (user decision)

The G2 campaign is intentionally stopped after sequence generation. The training DB
(contract + temporal + field-pace sequences, cutoff 07-24) is built and verified on the
mini-PC; the preprocessor, smokes, and the 8-seed launch are STAGED but NOT run. **No
Scheduled Task exists or auto-starts anything.** Everything below is the resume recipe.

### G2 smoke — residual targets vs raw targets (TO BE FILLED AT RESUME)

References: raw caption-target mad ~0.72 in-sample regime / ~0.97 late-season (G1-era
reference points). The preprocessor prints the full smoke table (TOTAL + CAPTION mad/std,
per-tier) on stderr; bar = residual spread markedly below raw spread, smallest where W is
good (top-end WC).

- determinism: two preprocessor runs byte-equal — TBD at resume
- one-epoch smoke: `[baseline] mode=w` live in trainer logs — TBD at resume

## RESUME — exact commands

**1. Preprocessor (main box, SDK repo `/home/patrick/dci-score-predictor`).** Copy the
built training DB over (or run against a local copy), run the wLayer preprocessor, then
the determinism check:

```bash
# pull the training DB from the mini-PC (~150MB)
ssh mini-pc 'wsl bash -c "cat /root/corps-place-v10/sdk/data/v13-training-cutoff0724.db"' \
  > /tmp/v13-training-cutoff0724.db

cd /home/patrick/dci-score-predictor
DCI_DB=/root/corps-place/sdk/dci-relational.db \
CONTRACT_DB=/tmp/v13-training-cutoff0724.db \
TRAIN_DB=/tmp/v13-training-cutoff0724.db \
npx tsx tools/gen-v13-training-data.ts        # prints the G2 smoke table on stderr

# determinism: run twice, dumps must be byte-equal
cp /tmp/v13-training-cutoff0724.db /tmp/v13-det-a.db
DCI_DB=/root/corps-place/sdk/dci-relational.db CONTRACT_DB=/tmp/v13-det-a.db \
  TRAIN_DB=/tmp/v13-det-a.db npx tsx tools/gen-v13-training-data.ts
sqlite3 /tmp/v13-training-cutoff0724.db "select * from ml_sequence_rows_v10_field_pace order by row_id" | sha256sum
sqlite3 /tmp/v13-det-a.db                 "select * from ml_sequence_rows_v10_field_pace order by row_id" | sha256sum

# push the augmented DB back
cat /tmp/v13-training-cutoff0724.db | \
  ssh mini-pc 'wsl bash -c "cat > /root/corps-place-v10/sdk/data/v13-training-cutoff0724.db"'
```

(Contract and ml table live in the same sqlite file, so CONTRACT_DB = TRAIN_DB.)

**2. One-epoch smoke (mini-PC, branch v13-g2).** Expect `[baseline] mode=w` and a
residual delta distribution (mean≈0, mad well under the raw ~0.72/0.97) in the log:

```bash
ssh mini-pc  # then in WSL:
export PATH=/root/.hermes/node/bin:$PATH
cd /root/corps-place-v10/sdk && bash scripts/v13_smoke.sh w
grep -E "\[baseline\] mode=w|delta-target dist" logs/v13_smoke_w.log
```

**3. Launch (only if smokes pass).** 8 seeds 42–49, concurrency 3, slug `v13_residual`,
DONE flag `logs/v13_residual_training_DONE.flag` (~1–2 days):

```powershell
# on the mini-PC (Windows), create + fire the Scheduled Task:
schtasks /create /tn v13_training /tr "wsl bash /root/launch-v13.sh" /sc once /st 23:59 /f
schtasks /run /tn v13_training
# progress:
#   wsl bash -c "tail -5 /root/corps-place-v10/sdk/logs/v13_residual_driver.log"
```

Judging (G3–G5) is a separate step — not part of this gate.
