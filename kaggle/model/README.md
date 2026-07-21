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

v10.5 is a **new version of the existing `TfJs/default` instance** (not a new
instance). Held-out accuracy: bias −0.35, MAE 0.78 (per-tier in
`docs/TIER_ACCURACY.md`).

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
