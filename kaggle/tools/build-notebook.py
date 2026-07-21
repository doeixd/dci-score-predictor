#!/usr/bin/env python3
"""Build kaggle/notebook/dci-scores-eda.ipynb from cell sources defined here.

Keeping the cell text in one place lets us (a) execute the exact same code as a
plain script to validate it, and (b) emit a clean .ipynb. Run:

    PYTHONPATH=/tmp/pylibs python3 kaggle/tools/build-notebook.py

Set VALIDATE=1 to additionally execute the notebook end-to-end with nbconvert.
"""
import os
import nbformat
from nbformat.v4 import new_notebook, new_markdown_cell, new_code_cell

HERE = os.path.dirname(os.path.abspath(__file__))
NB_DIR = os.path.join(HERE, "..", "notebook")
os.makedirs(NB_DIR, exist_ok=True)
NB_PATH = os.path.join(NB_DIR, "dci-scores-eda.ipynb")

MD = new_markdown_cell
CODE = new_code_cell

cells = [
    MD(
        "# DCI Drum Corps Scores - EDA & baseline\n"
        "\n"
        "Starter notebook for the **DCI Drum Corps Scores (2013-2026, cleaned)** dataset.\n"
        "\n"
        "We load the cleaned scores, plot season overviews and score-progression curves for\n"
        "top corps, run a naive *predict-next-total = last-total* baseline (report MAE), and\n"
        "compare that baseline against the published accuracy of the open-source **v10.5**\n"
        "SDK model. At the end we point at the SDK for real predictions.\n"
        "\n"
        "- Dataset card & columns: see the dataset's `README.md`.\n"
        "- Model + cleaning pipeline (open source): https://github.com/doeixd/dci-score-predictor\n"
        "\n"
        "*Independent / unofficial - not affiliated with Drum Corps International.*"
    ),
    CODE(
        "# --- config -------------------------------------------------------------\n"
        "# On Kaggle the dataset mounts at /kaggle/input/<slug>/. Locally, override\n"
        "# KAGGLE_INPUT to point at the generated CSVs (e.g. kaggle/dataset).\n"
        "import os\n"
        "\n"
        "KAGGLE_INPUT = os.environ.get(\n"
        "    'KAGGLE_INPUT', '/kaggle/input/dci-scores'\n"
        ")\n"
        "print('Reading CSVs from:', KAGGLE_INPUT)"
    ),
    CODE(
        "import pandas as pd\n"
        "import numpy as np\n"
        "import matplotlib.pyplot as plt\n"
        "\n"
        "def load(name):\n"
        "    return pd.read_csv(os.path.join(KAGGLE_INPUT, name))\n"
        "\n"
        "scores = load('scores.csv')\n"
        "events = load('events.csv')\n"
        "corps = load('corps.csv')\n"
        "subcaptions = load('subcaptions.csv')\n"
        "judges = load('judges.csv')\n"
        "\n"
        "scores['date'] = pd.to_datetime(scores['date'])\n"
        "print({k: v for k, v in zip(\n"
        "    ['scores', 'events', 'corps', 'subcaptions', 'judges'],\n"
        "    [len(scores), len(events), len(corps), len(subcaptions), len(judges)])})\n"
        "scores.head()"
    ),
    MD("## Season overview\n\nHow many performances and shows per season, split by division. "
       "Note 2020/2021 are absent (COVID) and 2026 is in-progress."),
    CODE(
        "by_season = (scores.groupby(['season', 'division'])\n"
        "                   .size().unstack(fill_value=0))\n"
        "print(by_season)\n"
        "\n"
        "ax = by_season.plot(kind='bar', stacked=True, figsize=(10, 4))\n"
        "ax.set_title('Cleaned corps performances per season')\n"
        "ax.set_xlabel('season'); ax.set_ylabel('performances')\n"
        "plt.tight_layout(); plt.show()"
    ),
    CODE(
        "# Distribution of World Class winning (max) totals per season.\n"
        "wc = scores[scores['division'] == 'World Class']\n"
        "season_max = wc.groupby('season')['total'].max()\n"
        "ax = season_max.plot(marker='o', figsize=(10, 4))\n"
        "ax.set_title('World Class top total by season')\n"
        "ax.set_xlabel('season'); ax.set_ylabel('max total')\n"
        "plt.grid(alpha=0.3); plt.tight_layout(); plt.show()"
    ),
    MD("## Score-progression curves\n\nTotals rise across a season as corps develop their show. "
       "We plot `total` vs `percent_through` for the top World Class corps by peak score in the "
       "latest complete season."),
    CODE(
        "latest = sorted(s for s in wc['season'].unique() if s != 2026)[-1]\n"
        "season = wc[wc['season'] == latest]\n"
        "top = (season.groupby('corps_name')['total'].max()\n"
        "             .sort_values(ascending=False).head(6).index)\n"
        "\n"
        "plt.figure(figsize=(10, 5))\n"
        "for name in top:\n"
        "    d = season[season['corps_name'] == name].sort_values('percent_through')\n"
        "    plt.plot(d['percent_through'], d['total'], marker='.', label=name)\n"
        "plt.title(f'Score progression - top World Class corps, {latest}')\n"
        "plt.xlabel('percent through season'); plt.ylabel('total')\n"
        "plt.legend(fontsize=8); plt.grid(alpha=0.3); plt.tight_layout(); plt.show()"
    ),
    MD("## Caption mix of the champion\n\nThe eight captions for the top corps at the latest "
       "World Class finals-type show (highest `percent_through`)."),
    CODE(
        "cap_cols = ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP']\n"
        "finale = season[season['percent_through'] == season['percent_through'].max()]\n"
        "champ = finale.sort_values('total', ascending=False).iloc[0]\n"
        "ax = champ[cap_cols].plot(kind='bar', figsize=(8, 4))\n"
        "ax.set_title(f\"{champ['corps_name']} caption scores - {champ['event_name']}\")\n"
        "ax.set_ylabel('caption score (0-20)')\n"
        "plt.tight_layout(); plt.show()"
    ),
    MD(
        "## Baseline: predict next total = last total\n"
        "\n"
        "The simplest possible forecaster: a corps' next show total equals its previous show\n"
        "total (same season). We compute the mean absolute error (MAE) of that rule over every\n"
        "corps/season with at least two shows. This is the bar any real model must beat."
    ),
    CODE(
        "df = scores.sort_values(['season', 'corps_key', 'percent_through']).copy()\n"
        "df['prev_total'] = df.groupby(['season', 'corps_key'])['total'].shift(1)\n"
        "pairs = df.dropna(subset=['prev_total'])\n"
        "abs_err = (pairs['total'] - pairs['prev_total']).abs()\n"
        "mae = abs_err.mean()\n"
        "print(f'Last-total baseline MAE: {mae:.2f} recap points  (n={len(pairs)})')\n"
        "\n"
        "wc_pairs = pairs[pairs['division'] == 'World Class']\n"
        "oc_pairs = pairs[pairs['division'] == 'Open Class']\n"
        "print(f\"  World Class: {(wc_pairs['total']-wc_pairs['prev_total']).abs().mean():.2f}\"\n"
        "      f\"  (n={len(wc_pairs)})\")\n"
        "print(f\"  Open Class:  {(oc_pairs['total']-oc_pairs['prev_total']).abs().mean():.2f}\"\n"
        "      f\"  (n={len(oc_pairs)})\")"
    ),
    CODE(
        "plt.figure(figsize=(9, 4))\n"
        "plt.hist(abs_err, bins=40)\n"
        "plt.axvline(mae, color='k', linestyle='--', label=f'MAE={mae:.2f}')\n"
        "plt.title('Last-total baseline absolute error')\n"
        "plt.xlabel('|actual - predicted| (recap points)'); plt.ylabel('count')\n"
        "plt.legend(); plt.tight_layout(); plt.show()"
    ),
    MD(
        "## How the v10.5 SDK model compares\n"
        "\n"
        "The open-source `dci-score-predictor` SDK serves **v10.5**, an identity-agnostic\n"
        "8-seed field-pace ensemble with per-division recalibration. Its published 2026\n"
        "backtest (`docs/TIER_ACCURACY.md`) reports, over 197 held-out per-corps observations:\n"
        "\n"
        "| metric | last-total baseline (this notebook) | v10.5 (no recal) | v10.5 (with recal) |\n"
        "|---|---|---|---|\n"
        "| overall MAE (recap pts) | see cell above | 2.49 | **1.64** |\n"
        "| World Class MAE | | 2.95 | **1.75** |\n"
        "| Open Class MAE | | 1.33 | **1.35** |\n"
        "\n"
        "Note the comparison is *indicative, not apples-to-apples*: the SDK backtest is a\n"
        "no-leakage next-event forecast that rebuilds each corps' season-to-date from only\n"
        "prior shows and buckets by data-availability tier - a harder, more realistic task\n"
        "than our in-sample last-total rule. The tier breakdown shows the model is tight for\n"
        "established corps (T0 recal MAE 1.27) and weakest for debut / cold-start corps\n"
        "(T3 MAE ~4.9). Full methodology + numbers:\n"
        "https://github.com/doeixd/dci-score-predictor/blob/master/docs/TIER_ACCURACY.md"
    ),
    CODE(
        "labels = ['last-total\\n(this nb)', 'v10.5\\nno recal', 'v10.5\\nrecal']\n"
        "vals = [mae, 2.49, 1.64]\n"
        "plt.figure(figsize=(7, 4))\n"
        "bars = plt.bar(labels, vals, color=['#888', '#4c78a8', '#54a24b'])\n"
        "for b, v in zip(bars, vals):\n"
        "    plt.text(b.get_x() + b.get_width()/2, v + 0.05, f'{v:.2f}', ha='center')\n"
        "plt.ylabel('overall MAE (recap points, lower is better)')\n"
        "plt.title('Baseline vs published v10.5 SDK accuracy')\n"
        "plt.tight_layout(); plt.show()"
    ),
    MD(
        "## Get real predictions\n"
        "\n"
        "This notebook only demonstrates the data + a toy baseline. For actual forecasts, use\n"
        "the open-source SDK - it ships the trained v10.5 ensemble and runs anywhere JS runs:\n"
        "\n"
        "```bash\n"
        "npm install dci-score-predictor\n"
        "```\n"
        "```js\n"
        "import { predict } from 'dci-score-predictor';\n"
        "// build SeasonData from shows so far, then:\n"
        "const out = await predict({ season, target, members: 8 /*, recalObservations */ });\n"
        "```\n"
        "\n"
        "- Repo: https://github.com/doeixd/dci-score-predictor\n"
        "- Model card: https://github.com/doeixd/dci-score-predictor/blob/master/docs/MODEL_CARD.md\n"
        "- Accuracy: https://github.com/doeixd/dci-score-predictor/blob/master/docs/TIER_ACCURACY.md\n"
        "\n"
        "If you build something with this data, cite the dataset and the repo. Happy analyzing!"
    ),
]

nb = new_notebook(cells=cells)
nb.metadata["kernelspec"] = {
    "display_name": "Python 3",
    "language": "python",
    "name": "python3",
}
nb.metadata["language_info"] = {"name": "python"}

with open(NB_PATH, "w") as f:
    nbformat.write(nb, f)
print("Wrote", NB_PATH, "with", len(cells), "cells")
