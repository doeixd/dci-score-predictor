# Kaggle Model upload — dci-score-predictor

Documents what was pushed to the Kaggle Model
[patrickwglenn/dci-score-predictor](https://www.kaggle.com/models/patrickwglenn/dci-score-predictor)
and how to regenerate/stage it. **No API token lives in this repo** — auth is
env-var only (see below).

## Current state

| field | value |
|-------|-------|
| Model | `patrickwglenn/dci-score-predictor` |
| Instance | `TfJs/default` (framework `MODEL_FRAMEWORK_TF_JS`) |
| Latest version | **5** — v10.5 identity-agnostic 8-seed field-pace ensemble + division recal |
| URL | https://www.kaggle.com/models/patrickwglenn/dci-score-predictor/TfJs/default/5 |
| Uncompressed size | ~33.7 MB |
| Visibility | **Public** (`is_private: false`) |
| Page metadata | **Filled** — title, subtitle, full markdown description, and instance overview/usage/inputs/outputs/changelog |

v10.5 is a **new version of the existing `TfJs/default` instance** (not a new
instance). Held-out accuracy: bias −0.35, MAE 0.78 (per-tier in
`docs/TIER_ACCURACY.md`).

## Version 6 (v11) — STAGED, upload pending the prod flip

The SDK repo's `assets/models/` now carry the **v11** ensemble (v10.4 recipe +
identity-dropout 0.5 in phases A/B, agnostic-finalized — see
`docs/V11_ARM1_RESULTS.md` / `docs/V11_OVERFIT_AUDIT.md`). Version 6 of
`TfJs/default` ships those seeds with refreshed docs. **Do not upload until
production has flipped to v11** (the Kaggle page mirrors what serves).

- Stage: `bash kaggle/tools/stage-model-v6.sh` → `/tmp/kaggle-model-upload-v6`
  (same layout as v5: models/ inference/ training/ docs/; includes the v11
  result docs; built-in scrub check for private paths/tokens).
- Upload (ONE command, after the flip; env-var auth only):
  `kaggle models instances versions create patrickwglenn/dci-score-predictor/TfJs/default -p /tmp/kaggle-model-upload-v6 -n "v11 identity-dropout-0.5 8-seed ensemble + division recal (-16.6% backtest MAE vs v10.5)" -r tar`
- Version notes / page description updates: resolved-2026 backtest MAE
  2.49 → 2.08 no-recal (1.64 → 1.37 with recal) vs v10.5, better in every
  tier; gain is mid-season World Class (Open Class + championship week are
  washes); serving contract unchanged (drop-in weights swap, agnostic default).
  Update the model-page description figures from the refreshed
  `docs/MODEL_CARD.md` + `docs/TIER_ACCURACY.md` when uploading.
- Training recipe files are unchanged for v11 except `identityDropoutRate: 0.5`
  — the staged training/ folder notes this.

## Page metadata + public status (filled 2026-07-21)

The model page is fully populated and **public**. Metadata was applied with the
CLI from a staging dir kept **outside the repo** (`/tmp`, never committed):

- **Model level** (`kaggle models update`): title "DCI Score Predictor (v10.5)",
  subtitle, `isPrivate: false`, and a thorough markdown description (summary,
  architecture, training data, evaluation-results table, links, provenance,
  MIT license). Sourced only from `docs/MODEL_CARD.md`, `docs/TIER_ACCURACY.md`,
  `docs/BENCHMARKS.md`, and `README.md` — no invented numbers.
- **Instance level** (`kaggle models instances update`, `TfJs/default`):
  overview + usage markdown (Model Format / Training Data / Inputs / Outputs /
  Usage with the SDK 10-liner + raw-tfjs custom-layer caveat / Fine-tuning /
  Changelog), `licenseName: MIT`, `fineTunable: false`,
  `trainingData: ["Public DCI recap scores 2013–2025 (cleaned)"]`.
- **License choice:** **MIT** (accepted by Kaggle's model license list; matches
  the GitHub/SDK license).

Two CLI quirks worth noting for future edits: `kaggle models update` rejects a
non-empty `provenanceSources` (server FieldMask bug on the `_`), so leave it
empty and put provenance in the description; and `kaggle models instances update`
returns an empty HTTP 200 body that makes the CLI raise a JSON-decode error even
though the update **succeeds** (verify with `kaggle models get`).

## Package layout (staged in a temp dir, then uploaded)

```
README.md                 # top-level model overview
models/                   # 8 tfjs seed folders (model.json + weights.bin + target-norm.json) + MANIFEST.json
inference/                # inference.ts, serve.ts, contract.ts + README-INFERENCE.md
training/                 # trainModelV95.ts, v9FeatureModes.ts, buildMlSequencesV9Subcaption.ts,
                          #   prepareV10TemporalFeatures.ts, prepareV10TrainingData.ts + README-TRAINING.md
docs/                     # MODEL_CARD.md, TIER_ACCURACY.md, BENCHMARKS.md, FEATURE_PARITY_NOTES.md
```

Sources: `models/` and `inference/` from this repo (`assets/models/`,
`src/model/`); `training/` copied read-only from the SDK repo
(`src/training/*`, `src/buildMlSequencesV9Subcaption.ts`, `scripts/prepareV10*.ts`).
The training files were scrubbed before upload — no absolute private paths,
tokens, or emails (only relative default paths like `./data/...` remain).

## Regeneration / staging steps

```bash
# 0. Install CLI (into a temp dir to keep the repo clean)
python3 -m pip install --target /tmp/kagglecli kaggle
export PYTHONPATH=/tmp/kagglecli

# 1. Auth — env var only, NEVER write the token into the repo.
#    Modern KGAT_ tokens work directly via KAGGLE_API_TOKEN:
export KAGGLE_API_TOKEN=KGAT_...        # your token; not stored anywhere
/tmp/kagglecli/bin/kaggle models get patrickwglenn/dci-score-predictor   # smoke test

# 2. Stage the package
STAGE=/tmp/kaggle-model-upload
rm -rf $STAGE && mkdir -p $STAGE/models $STAGE/inference $STAGE/training $STAGE/docs
cp -r assets/models/* $STAGE/models/
cp src/model/{inference,serve,contract}.ts $STAGE/inference/
cp <SDK>/src/training/{trainModelV95,v9FeatureModes}.ts \
   <SDK>/src/buildMlSequencesV9Subcaption.ts \
   <SDK>/scripts/prepareV10TemporalFeatures.ts \
   <SDK>/scripts/prepareV10TrainingData.ts $STAGE/training/
cp docs/{MODEL_CARD,TIER_ACCURACY,BENCHMARKS,FEATURE_PARITY_NOTES}.md $STAGE/docs/
#   (+ the README.md / README-INFERENCE.md / README-TRAINING.md in this folder set)

# 3. Upload a NEW VERSION of the existing instance (-r tar preserves subdirs)
kaggle models instances versions create \
  patrickwglenn/dci-score-predictor/TfJs/default \
  -p $STAGE -n "v10.5 ..." -r tar

# 4. Verify
kaggle models get patrickwglenn/dci-score-predictor   # check versionNumber
```

Note: `-r tar` uploads each subdirectory as an uncompressed `.tar` (the CLI
default `skip` would silently drop all subdirectories). The Kaggle model page
extracts them.
