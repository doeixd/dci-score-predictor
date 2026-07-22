#!/usr/bin/env bash
# Stage the Kaggle Model version 6 package (v11 ensemble) into a temp dir.
# STAGING ONLY — does not upload. Upload is one command afterwards (see below,
# and kaggle/model/README.md; requires KAGGLE_API_TOKEN in the env, never in
# the repo). Run AFTER the prod flip when the Kaggle page should follow.
#
#   bash kaggle/tools/stage-model-v6.sh [SDK_TRAINING_REPO]
#
# SDK_TRAINING_REPO = the training-side repo the scrubbed training files come
# from (default /home/patrick/cp-branch/sdk — has all five files). The recipe is
# unchanged for v11 except identityDropoutRate 0.5 — same files apply.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
SDK="${1:-/home/patrick/cp-branch/sdk}"
STAGE=/tmp/kaggle-model-upload-v6

rm -rf "$STAGE"
mkdir -p "$STAGE/models" "$STAGE/inference" "$STAGE/training" "$STAGE/docs"

# models/ — the shipped v11 seeds + MANIFEST (assets are the source of truth)
cp -r "$REPO"/assets/models/* "$STAGE/models/"

# inference/ — same three files as v5
cp "$REPO"/src/model/inference.ts "$REPO"/src/model/serve.ts \
   "$REPO"/src/model/contract.ts "$STAGE/inference/"

# training/ — scrubbed copies from the training repo (recipe unchanged in v11
# except identityDropoutRate: 0.5; re-scrub before upload if these changed)
cp "$SDK"/src/training/trainModelV95.ts "$SDK"/src/training/v9FeatureModes.ts \
   "$SDK"/src/buildMlSequencesV9Subcaption.ts \
   "$SDK"/scripts/prepareV10TemporalFeatures.ts \
   "$SDK"/scripts/prepareV10TrainingData.ts "$STAGE/training/" 2>/dev/null || \
  echo "WARN: some training files missing from $SDK — copy/scrub manually"

# docs/ — refreshed v11 docs
# (V11_ARM1_RESULTS / V11_OVERFIT_AUDIT stay repo-only — they reference
# private paths; their headline numbers live in the page description.)
cp "$REPO"/docs/MODEL_CARD.md "$REPO"/docs/TIER_ACCURACY.md \
   "$REPO"/docs/BENCHMARKS.md "$REPO"/docs/FEATURE_PARITY_NOTES.md \
   "$STAGE/docs/"

# Scrub check: no absolute private paths / tokens in staged text files
if grep -rlE '/root/|/home/patrick/|KGAT_|KAGGLE_API' "$STAGE" --include='*.ts' --include='*.md' >/dev/null 2>&1; then
  echo "SCRUB WARNING — staged files reference private paths/tokens:"
  grep -rlE '/root/|/home/patrick/|KGAT_|KAGGLE_API' "$STAGE" --include='*.ts' --include='*.md'
  exit 1
fi

du -sh "$STAGE"
echo "Staged v6 package at $STAGE. Upload (after prod flip) with:"
echo '  kaggle models instances versions create \'
echo '    patrickwglenn/dci-score-predictor/TfJs/default \'
echo "    -p $STAGE -n \"v11 identity-dropout-0.5 8-seed ensemble + division recal (-16.6% backtest MAE vs v10.5)\" -r tar"
