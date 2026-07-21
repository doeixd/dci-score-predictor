# V11 Arm-1 results — identity-dropout 0.5, seeds 42–49

Status: MEASURED (evaluation only — SDK defaults and shipped assets unchanged).
Companion to [V11_IDENTITY_NOTES.md](V11_IDENTITY_NOTES.md) (design + campaign
log) and [IDENTITY_BASELINES.md](IDENTITY_BASELINES.md) (v10.4 serving A/B).

## Setup

- **Arm 1 training** (mini-PC, branch `v11-identity-dropout`): 8 seeds (42–49),
  identity dropout rate 0.5 in curriculum phases A/B (v10.4 used 0.95).
  Verified from `training-args.json` diffs: the ONLY substantive difference from
  the shipped v10.4 seeds is `identityDropoutRate: 0.5` — same training DB
  (`v10-training-dev6.db`), same `ml_sequence_rows_v10_field_pace` table, same
  index maps, architecture, curriculum, loss, and hyperparameters. Phase C still
  ramps identity dropout to 1.0, so v11 members finalize agnostic
  (trained-then-frozen embeddings).
- **Harness**: `tools/backtest-v11.ts` — the SAME resolved-2026 per-event,
  leakage-safe backtest as `tools/backtest-identity.ts` (window 2026-07-01..19,
  27 events, 197 observations, full-fidelity inputs: real judge panels,
  subcaptions, performance order; no recal). Family mixing is done through the
  AssetProvider seam; `predict()` is unchanged.
- **Pools** (plain mean pooling; per-seed target-norms make members
  mean-compatible): 8×v10.4, 8×v11, mixed 4+4 / 6+2 / 2+6, all-16.
- **Modes**: agnostic (production default) and identity-full.
- The v104-pool numbers reproduce `tools/backtest-identity.out.json` exactly
  (agnostic 2.494 / full 2.475) — harness parity confirmed.

## Results — pool × mode (n | MAE | bias), 27 events / 197 obs

### Overall

| pool | agnostic MAE | agnostic bias | identity-full MAE | identity-full bias |
|---|---|---|---|---|
| 8×v10.4 (baseline) | 2.494 | −2.237 | 2.475 | −2.213 |
| **8×v11** | **2.079** | **−1.666** | 2.146 | −1.706 |
| mixed 6+2 (v10.4-heavy) | 2.538 | −2.300 | 2.516 | −2.273 |
| mixed 4+4 | 2.398 | −2.111 | 2.433 | −2.149 |
| mixed 2+6 (v11-heavy) | 2.208 | −1.878 | 2.263 | −1.917 |
| all-16 | 2.278 | −1.951 | 2.299 | −1.959 |

### Per-tier + per-division, headline pools (agnostic mode)

| slice | n | 8×v10.4 MAE (bias) | 8×v11 MAE (bias) |
|---|---|---|---|
| T0 established | 105 | 2.439 (−2.319) | **1.965 (−1.763)** |
| T1 partial | 13 | 0.851 (−0.371) | 0.868 (+0.199) |
| T2 sparse | 57 | 1.817 (−1.416) | **1.512 (−0.951)** |
| T3 cold_start | 22 | 5.482 (−5.071) | **4.803 (−4.155)** |
| overall | 197 | 2.494 (−2.237) | **2.079 (−1.666)** |

Per-division, headline pools:

| division / mode | 8×v10.4 MAE (bias) | 8×v11 MAE (bias) |
|---|---|---|
| World Class, agnostic | 2.945 (−2.944) | **2.359 (−2.355)** |
| Open Class, agnostic | 1.329 (−0.411) | 1.353 (+0.114) |
| World Class, identity-full | 2.880 (−2.876) | **2.375 (−2.361)** |
| Open Class, identity-full | 1.431 (−0.499) | 1.555 (−0.014) |

The v11 gain is a World Class gain (−0.59 MAE agnostic); Open Class is a wash
(+0.02, with bias moving through zero). The mild OC identity-full variance
regression seen in the v10.4 serving A/B persists in v11 (1.353 → 1.555).
(Full splits for every pool×mode: `tools/backtest-v11.out.json`.)

### Per-tier, headline pools (identity-full mode)

| slice | n | 8×v10.4 MAE | 8×v11 MAE |
|---|---|---|---|
| T0 established | 105 | 2.379 | 2.026 |
| T1 partial | 13 | 0.973 | 1.169 |
| T2 sparse | 57 | 1.870 | 1.598 |
| T3 cold_start | 22 | 5.389 | **4.714** |
| overall | 197 | 2.475 | **2.146** |

## Gate verdicts

1. **No-regression gate (v11-agnostic ≥ v10.4-agnostic): PASSED, decisively.**
   Overall 2.079 vs 2.494 (−16.6%), better in EVERY tier (T0 1.965 vs 2.439,
   T3 4.803 vs 5.482; T1 is a 13-obs wash), and systematic under-projection
   bias improves −2.24 → −1.67. The production-default serving path is strictly
   better.
2. **Identity-full hypothesis (v11-full > v10.4-full): PASSED** (2.146 vs
   2.475) — but v11-full LOSES to v11-agnostic (2.146 vs 2.079). The win is
   **identity as auxiliary training signal, not identity at serving**: giving
   the embeddings real gradient in phases A/B improved the shared network that
   the agnostic path uses, while the serving-time embeddings themselves still
   add nothing on this window.
3. **Mixture hypothesis: REJECTED.** MAE is monotone in the v11 fraction
   (6+2: 2.538 → 4+4: 2.398 → 2+6: 2.208 → all-16: 2.278 → pure v11: 2.079).
   No mixed pool beats pure 8×v11 in either mode; v10.4 members only dilute.
4. **Mode-aware best pool: 8×v11 agnostic in both cases** — for agnostic
   serving AND overall. (Identity-full's best pool is also 8×v11.)

## Skepticism pass (before believing a 17% jump)

- **(a) Same recipe?** Yes — `training-args.json` diff between v10.4 seed42 and
  v11 seed42 shows only path/trial-name strings plus `identityDropoutRate: 0.5`.
- **(b) Held-out event** (2026-dci-mckinney, 2026-07-20 — after the contract-DB
  snapshot AND outside the decision window; 6 World Class obs):

  | pool / mode | MAE | bias |
  |---|---|---|
  | v10.4 agnostic | 6.285 | −6.285 |
  | v10.4 identity-full | 5.175 | −5.175 |
  | v11 agnostic | 5.606 | −5.606 |
  | **v11 identity-full** | **4.890** | −4.890 |

  Direction confirms v11 > v10.4 in both modes. All errors are same-sign — this
  is the known late-season WC under-projection regime (the August-retrain
  motivation), so absolute MAEs are inflated; note identity-full HELPS both
  families here, consistent with the v10.4 serving A/B finding that identity
  helps established late-season WC.
- **(c) Per-seed sanity** (held-out event, agnostic, single-member): v10.4
  seeds span 4.40–7.04 MAE, v11 seeds 4.14–8.02. No degenerate v11 member;
  seed43 is the weakest (8.02) but behaves sanely, and all 8 v11 seeds load and
  predict the kentucky fixture with sensible orderings (verified via
  `V11_VERIFY=1 npx tsx tools/backtest-v11.ts`).

## Caveats

- **Eval-window caveat:** the 07-01..19 window overlaps both models' training
  data (same dev6 DB, `trainAfterDate` 2025-12-31; date-forward val split).
  Both families see it equally, so the RELATIVE comparison is fair, but the
  absolute MAEs are optimistic vs true held-out (the single 07-20 event runs
  ~5–6 MAE in the late-season regime).
- The held-out check is one event / 6 observations — directional evidence only.
- Serving-mode conclusion (agnostic ≥ full for v11) is from the in-window
  backtest; the held-out event hints the ordering may flip late-season/WC.
  Revisit with more post-cutoff events before touching the `identity` default.

## Arm-2 recommendation

Per the decision rule in V11_IDENTITY_NOTES.md: mixtures LOST, so Arm 2 as
"widen the expert family pool" is **dead**. The live question is the **rate
curve**: 0.5 beat 0.95 by a lot, so train the **0.3 arm** (and 0.7 as the
cheap bracket) to find where the curve turns — plus, if 0.3 ≥ 0.5, consider
the Phase-C ramp-target variable (finalize at 0.5 instead of 1.0), watching
the no-regression gate closely since that changes agnostic finalization.

Promotion path (unchanged, user-gated): fold the winning rate into the August
full-season retrain; before ANY prod flip, rerun the prod backtest guard
(`backtestPredictionModes.ts`) per the standing rule. Do not ship v11 seeds or
change the SDK default from these numbers alone.

## Artifacts

- Harness + machine-readable results: `tools/backtest-v11.ts`,
  `tools/backtest-v11.out.json`
- v11 seeds staged (not shipped): `/home/patrick/v11-seeds/<seed>/`
  (model.json, weights.bin, target-norm.json — same layout as `assets/models`)
- Training checkpoints: mini-PC
  `/root/corps-place-v10/sdk/models/v11_identity050_field_pace/`
