# Publishing to Kaggle

Step-by-step for pushing the dataset, the starter notebook, and (optionally) the
model to Kaggle. **You** run these - the agent does not push or publish.

Before anything, replace the placeholder username `doeixd` with your real Kaggle
username in three files:

- `kaggle/dataset/dataset-metadata.json` -> `"id": "<username>/dci-scores"`
- `kaggle/notebook/kernel-metadata.json` -> `"id"` and `"dataset_sources"`
- (optional model) the `ownerSlug` fields shown in the model section below

The dataset slug (`dci-scores`) is **immutable after first `create`** - pick the
final slug now.

## 0. Install & authenticate the CLI

```bash
pip install kaggle
# Kaggle.com -> your avatar -> Settings -> API -> "Create New API Token"
# downloads kaggle.json
mkdir -p ~/.kaggle
mv ~/Downloads/kaggle.json ~/.kaggle/kaggle.json
chmod 600 ~/.kaggle/kaggle.json      # the CLI refuses to run if this is world-readable
kaggle datasets list -m               # smoke test: lists your datasets
```

## 1. Publish the dataset

From the repo root:

```bash
# First publish (creates the dataset). Default visibility is public; use --public
# explicitly, or omit and toggle in the UI. Nested dirs -> add --dir-mode zip.
kaggle datasets create -p kaggle/dataset --public

# Later refreshes (new season, corrections) - dataset must already exist and the
# id in dataset-metadata.json must match:
kaggle datasets version -p kaggle/dataset -m "Add end-of-2026 season"
```

Notes:
- Total size is ~7.7 MB (well under the ~20 GB per-file / ~100 GB dataset limits).
- After publishing, open the dataset page and confirm the data card (README.md) and
  per-column descriptions render; add tags + a cover image in the UI for a higher
  Usability score.

## 2. Publish the starter notebook

The notebook consumes the dataset at `/kaggle/input/dci-scores/` (that's the default
of the `KAGGLE_INPUT` variable in cell 1 - no edit needed on Kaggle). Locally it was
validated by overriding `KAGGLE_INPUT` to `kaggle/dataset`.

```bash
# create OR update - same command:
kaggle kernels push -p kaggle/notebook
kaggle kernels status <username>/dci-scores-eda
```

The kernel keeps `enable_internet: false` (it only reads the mounted dataset). It
starts private (`is_private: "true"`); make it public in the UI, or set
`"is_private": "false"` before pushing.

## 3. Publish the model to Kaggle Models — DONE (v11 = version 6, PUBLIC)

**Status:** the **v11** ensemble is live as **version 6** of the existing
`TfJs/default` instance (superseding v10.5 = version 5), and the model page is
**fully filled and public** (`is_private: false`):
https://www.kaggle.com/models/patrickwglenn/dci-score-predictor/TfJs/default/6
(~33.7 MB uncompressed). Model- and instance-level metadata (title, subtitle,
markdown description with v11 Evaluation Results + Lineage, instance
overview/usage/inputs/outputs/changelog, `licenseName: MIT`,
`fineTunable: false`) were refreshed 2026-07-22 via `kaggle models update` /
`kaggle models instances update` from an out-of-repo `/tmp` staging dir (both
raise a spurious JSONDecodeError on an empty-200 body — verify with
`kaggle models get`, not the exit output). Full details + regeneration steps in
[`kaggle/model/README.md`](model/README.md). Auth for the modern `KGAT_` token is
`export KAGGLE_API_TOKEN=KGAT_...` (env var only — never written into the repo);
new versions go via `kaggle models instances versions create
patrickwglenn/dci-score-predictor/TfJs/default -p <dir> -n "..." -r tar`
(`-r tar` is required — the default `skip` drops all subdirectories).

The instance is `TfJs/default` (not the `tfjs-v10-5` slug the template below
suggested); future retrains should **version that same instance**, not create a
new one. The template below is retained for reference / first-time setup.

The trained v10.5 ensemble ships as 8 tfjs seed folders under `assets/models/` in the
SDK repo (each: `model.json` + `weights.bin` + `target-norm.json`), plus a
`MANIFEST.json`. To mirror them as a Kaggle Model:

```bash
# 3a. Scaffold + create the model container
kaggle models init -p kaggle/model
#   edit kaggle/model/model-metadata.json (see template below), then:
kaggle models create -p kaggle/model

# 3b. Create an instance (the tfjs variation). Point the instance folder at a copy
#     of the whole assets/models tree (all 8 seed dirs + MANIFEST.json).
kaggle models instances init -p kaggle/model-instance
#   edit model-instance-metadata.json (framework: "tfJs"), copy the weight files in, then:
kaggle models instances create -p kaggle/model-instance
# later:
kaggle models instances versions create -p kaggle/model-instance -m "retrain"
```

`model-metadata.json` template (container):

```json
{
  "ownerSlug": "<username>",
  "title": "DCI Score Predictor",
  "slug": "dci-score-predictor",
  "subtitle": "v10.5 identity-agnostic ensemble for DCI recap scores",
  "isPrivate": false,
  "description": "See https://github.com/doeixd/dci-score-predictor/blob/master/docs/MODEL_CARD.md",
  "provenanceSources": "Trained on <username>/dci-scores (cleaned DCI recaps)",
  "licenseName": "MIT"
}
```

`model-instance-metadata.json` template (tfjs variation - weight files live in its folder):

```json
{
  "ownerSlug": "<username>",
  "modelSlug": "dci-score-predictor",
  "instanceSlug": "tfjs-v10-5",
  "framework": "tfJs",
  "overview": "8-seed field-pace tfjs LayersModels + norm stats. Load per seed with tf.loadLayersModel.",
  "usage": "Each seed dir has model.json + weights.bin; see MANIFEST.json and the SDK README.",
  "licenseName": "MIT",
  "fineTunable": false,
  "trainingData": ["<username>/dci-scores"],
  "modelInstanceType": "Unspecified"
}
```

Notes:
- On the Models side `licenseName` **does** accept `MIT` (matching the SDK code
  license), unlike the dataset license list.
- The canonical way to consume the model is still the npm SDK
  (`npm install dci-score-predictor`); the Kaggle Model upload is a mirror/citation
  target, so a Kaggle notebook can `model_sources: ["<username>/dci-score-predictor/tfJs/tfjs-v10-5/1"]`.

## Recap of files

| Path | Purpose |
|---|---|
| `kaggle/dataset/*.csv` | the data (5 files) |
| `kaggle/dataset/dataset-metadata.json` | dataset CLI metadata + column schemas |
| `kaggle/dataset/README.md` | the data card |
| `kaggle/notebook/dci-scores-eda.ipynb` | starter notebook |
| `kaggle/notebook/kernel-metadata.json` | kernel CLI metadata |
| `kaggle/tools/gen-kaggle-dataset.ts` | regenerates the CSVs from the prod DB |
| `kaggle/tools/build-notebook.py` | regenerates the notebook |
