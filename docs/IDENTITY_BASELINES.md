# Identity serving knob — measured baselines

Does re-enabling the trained corps/judge/show identity inputs beat the shipped
identity-**agnostic** serving? This is the head-to-head measurement, re-run
against the shipped **v11** ensemble (2026-07-22; the prior v10.4 figures are
kept below for reference).

## Method

`tools/backtest-identity.ts` reruns the SAME resolved-2026 per-event backtest as
`tools/backtest-tiers.ts` (window `2026-07-01..2026-07-19`, **27 events / 197
corps observations**, leakage-safe: only shows strictly *before* each target feed
the input, 8-seed ensemble, **no recal** so the identity effect is isolated), in
three serving modes:

- **agnostic** — production default (all identity zeroed, judge-Elo block 101–112
  masked).
- **identity-full** — corps + judges + show embeddings live, `judge_bias_scale =
  corps_scale = 1`, judge-Elo block populated.
- **identity corps-only** — corps embedding live, judges/show agnostic.

Judge panels are the **real** per-show assignments from the prod DB
(`judge_assignments.judge_id`) — fair for a resolved-show backtest, since the
panel that actually judged the target is known. Corps use the registry
`corps_key`; shows use the year-stripped slug.

## Results — v11 ensemble (n | MAE | bias)

Validation anchor: the agnostic mode reproduces the tier backtest's no-recal
overall MAE (2.079) exactly.

```
--- agnostic (default) ---
  T0 established    105 |  1.965 | -1.763
  T1 partial         13 |  0.868 | +0.199
  T2 sparse          57 |  1.512 | -0.951
  T3 cold_start      22 |  4.803 | -4.155
  overall           197 |  2.079 | -1.666
    World Class     142 |  2.359 | -2.355
    Open Class       55 |  1.353 | +0.114

--- identity-full ---
  T0 established    105 |  2.026 | -1.764
  T1 partial         13 |  1.169 | -0.261
  T2 sparse          57 |  1.598 | -1.080
  T3 cold_start      22 |  4.714 | -3.904
  overall           197 |  2.146 | -1.706
    World Class     142 |  2.375 | -2.361
    Open Class       55 |  1.555 | -0.014

--- identity corps-only ---
  T0 established    105 |  2.013 | -1.766
  T1 partial         13 |  1.127 | +0.130
  T2 sparse          57 |  1.571 | -0.920
  T3 cold_start      22 |  4.794 | -4.073
  overall           197 |  2.137 | -1.654
    World Class     142 |  2.385 | -2.370
    Open Class       55 |  1.496 | +0.196
```

### Overall summary

| mode | overall MAE | Δ vs agnostic | overall bias |
|------|-------------|---------------|--------------|
| agnostic (default) | **2.079** | — | −1.666 |
| identity-full | 2.146 | +0.067 (+3.2%) | −1.706 |
| identity corps-only | 2.137 | +0.058 (+2.8%) | −1.654 |

> The shared negative bias (~−1.7) is the early-season no-recal systematic
> offset, **not** an identity effect — it is corrected by the recal pass in
> `backtest-tiers.ts` (overall MAE 1.37 with recal). It moves in lock-step
> across modes, so the identity comparison is clean.

### v10.4 reference (previous assets, same harness/window)

| mode | overall MAE | Δ vs agnostic |
|------|-------------|---------------|
| agnostic | 2.494 | — |
| identity-full | 2.475 | −0.019 (−0.8%, tie) |
| identity corps-only | 2.507 | +0.013 (wash) |

## Recommendation: keep the default `agnostic` — the knob matters even less now

Under v10.4 identity-full was a statistical tie; under v11 it is **mildly but
consistently worse** (+0.067 overall, worse in T0/T1/T2 and both divisions;
only the thin-n T3 cold-start cell improves, 4.803 → 4.714). This is exactly
the expected consequence of the v11 training change: identity dropout 0.5 in
phases A/B gave the embeddings real gradient as an **auxiliary training
signal**, improving the shared network that the agnostic path uses — but
phase C still finalizes agnostic, so serving-time embeddings add variance
without signal. The same pattern held in the Arm-1 pool judging
([V11_ARM1_RESULTS.md](V11_ARM1_RESULTS.md)): v11-full 2.146 loses to
v11-agnostic 2.079.

**Guidance:** leave `identity` at its default `'agnostic'`. The v10.4-era niche
recommendation (identity-full for established World Class with a known real
panel) no longer holds under v11 — T0 established now *worsens* under
identity-full (1.965 → 2.026), and the World Class gain has vanished
(2.359 → 2.375). One caveat kept honest: on the late-season WC under-projection
regime the held-out event hinted identity-full can help
([V11_OVERFIT_AUDIT.md](V11_OVERFIT_AUDIT.md)); re-examine after the August
retrain rather than enabling it now.

## Reproduce

```
npx tsx tools/backtest-identity.ts   # writes tools/backtest-identity.out.json
```
Env: `DCI_DB` (prod relational, read-only), `CONTRACT_DB`, `BT_START`/`BT_END`,
`BT_MEMBERS`.

## Background

The v11 experiment this shipped from — retraining with identity dropout lowered
0.95 → 0.5 so the embeddings actually learn — is written up in
[V11_IDENTITY_NOTES.md](V11_IDENTITY_NOTES.md), judged in
[V11_ARM1_RESULTS.md](V11_ARM1_RESULTS.md), and audited in
[V11_OVERFIT_AUDIT.md](V11_OVERFIT_AUDIT.md).
