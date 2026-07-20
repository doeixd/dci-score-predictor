# Model card — dci-score-predictor v10.5

## Summary

`dci-score-predictor` serves **v10.5**, the production DCI recap-score model,
packaged self-contained. Given a corps's same-season score history and the
target show, it predicts the recap: eight caption scores
(`GE1 GE2 VP VA CG MB MA MP`) and a total, with per-corps intervals and full
diagnostics.

- **Task:** regression — per-corps caption + total recap for an upcoming show.
- **Output range:** captions ∈ [0, 20]; total ≈ 60–100
  (`GE1 + GE2 + (VP+VA+CG)/2 + (MB+MA+MP)/2`).
- **Runtime:** TensorFlow.js (CPU backend), 8-seed ensemble, ~32 MB weights
  shipped in-package. Runs in Node, Bun, Deno, browsers, edge workers.

## Lineage

- **v10.4** — field-pace **8-seed ensemble**. Each seed is a tfjs LayersModel
  taking a `[15, 101]` sequence (last 15 same-season performances, left-padded)
  plus a `[216]` static vector (extended to `[224]` with 8 per-caption trend
  slopes at inference). Per-seed p50/p10/p90 are pooled by arithmetic mean.
- **v10.5** = v10.4 + **division-aware additive recalibration**: a per-division
  offset fit at predict time from user-supplied resolved shows, shrunk
  (`n/(n+8)`), thin-pool-tapered (`× min(1, n/20)`), and clamped to ±1.5.
  With sparse history it tapers to 0.

**Identity-agnostic:** corps-identity embeddings and judge-Elo context are
masked (zeroed) at serving (`maskV9JudgeContext`), so every live feature derives
from score history + schedule + reference curves — no private database is needed
to reproduce production predictions.

## Training data

- **Source:** publicly posted DCI recap scores, seasons **2013–2025**.
- **Unit:** one (season, show, division, corps) row; features are leakage-safe
  (strictly before the target date).
- **Provenance / IP:** scores originate from public DCI recaps. This project is
  **not affiliated with or endorsed by Drum Corps International**. No DCI
  trademark is claimed.

## Accuracy

Measured on held-out 2026 events, identity-agnostic serving path:

- **Bias:** −0.35 total (slight under-projection).
- **MAE:** **0.78** total, versus the `final2` baseline — a **+23% recap
  improvement** in aggregate.
- Parity gate: the SDK reproduces the production clean-v10 pipeline totals to
  ≤ 1e-6 on frozen fixtures (see `test/predict-e2e.test.ts`,
  `test/feature-parity.test.ts`).

### Accuracy by degradation tier

Each tier is what the model saw when history is truncated to that depth; the
tier is reported per corps in `readiness.corps[].tier`.

| tier | code | condition | expectation |
|---|---|---|---|
| `established` | T0 | > 2 prior shows, confident field-pace | parity with production v10.5 |
| `partial` | T1 | ≥ 3 prior shows, thin field-pace | live, lower-confidence; recal tapered |
| `sparse` | T2 | 1–2 prior shows | `sparse` bias bucket; most trajectory features at defaults; wider error |
| `cold_start` | T3 | 0 prior shows (debut) | `debut` bias bucket; curve-anchored baseline; widest error |

## Limitations

- **World Class / Open Class only.** All-Age / A-Class / SoundSport are not
  covered; supplying such a division raises a validation error.
- **Finals-week World Class under-projection** persists (top-end compression);
  a full August retrain is pending.
- **Debuts / very early season** are the weakest regime — no same-season
  trajectory, so predictions fall back to curve anchors (T3).
- Registry snapshots ship with each release; unknown corps are supported via a
  division hint (the model is identity-agnostic) but do not carry alias history.
- Defaults are the production-trained neutral imputations, so they are the
  statistically correct fill — but every non-free default is surfaced in
  `readiness` and `caveats`, and should be read before trusting a number.

## Intended use

Analytical / hobbyist forecasting of DCI recap scores. Not an official DCI
product; not for wagering or any use requiring guaranteed accuracy.

## License

MIT © Patrick Glenn 2026. Model weights included under the same license.
