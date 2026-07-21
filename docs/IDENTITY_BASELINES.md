# Identity serving knob — measured baselines

Does re-enabling the trained corps/judge/show identity inputs beat the shipped
identity-**agnostic** serving? This is the head-to-head measurement.

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

## Results (n | MAE | bias)

The harness builds the SAME full-fidelity inputs as `backtest-tiers.ts`
(including subcaption sheets and performance order). Validation anchor: the
agnostic mode reproduces the tier backtest's no-recal overall MAE (2.494 ≈
2.49) exactly.

```
--- agnostic (default) ---
  T0 established    105 |  2.439 | -2.319
  T1 partial         13 |  0.851 | -0.371
  T2 sparse          57 |  1.817 | -1.416
  T3 cold_start      22 |  5.482 | -5.071
  overall           197 |  2.494 | -2.237
    World Class     142 |  2.945 | -2.944
    Open Class       55 |  1.329 | -0.411

--- identity-full ---
  T0 established    105 |  2.379 | -2.215
  T1 partial         13 |  0.973 | -0.753
  T2 sparse          57 |  1.870 | -1.503
  T3 cold_start      22 |  5.389 | -4.902
  overall           197 |  2.475 | -2.213
    World Class     142 |  2.880 | -2.876
    Open Class       55 |  1.431 | -0.499

--- identity corps-only ---
  T0 established    105 |  2.444 | -2.308
  T1 partial         13 |  0.913 | -0.297
  T2 sparse          57 |  1.848 | -1.399
  T3 cold_start      22 |  5.457 | -5.060
  overall           197 |  2.507 | -2.220
    World Class     142 |  2.960 | -2.959
    Open Class       55 |  1.338 | -0.311
```

### Overall summary

| mode | overall MAE | Δ vs agnostic | overall bias |
|------|-------------|---------------|--------------|
| agnostic (default) | **2.494** | — | −2.237 |
| identity-full | **2.475** | **−0.019 (−0.8%)** | −2.213 |
| identity corps-only | **2.507** | +0.013 (wash) | −2.220 |

> The shared negative bias (~−2.2) is the early-season no-recal systematic
> offset (predictions run low in early July), **not** an identity effect — it
> is corrected by the recal pass in `backtest-tiers.ts` (overall MAE 1.64 with
> recal). It moves in lock-step across modes, so the identity comparison is
> clean.

## Recommendation: keep the default `agnostic`

Identity-full is a **statistical tie** overall (−0.019 MAE on 197 obs, well
inside noise) and identity corps-only is a wash. Re-enabling identity does **not**
justify changing the default. Concretely:

- **Where identity helps:** established, rich-history **World Class** corps —
  `T0 established` MAE 2.439 → **2.379** and World Class overall 2.945 →
  **2.880** under identity-full. These are corps/panels with strong in-vocab
  embeddings and same-season judge-Elo signal.
- **Where identity hurts:** thin-history regimes — `T1 partial` (0.851 → 0.973),
  `T2 sparse` (1.817 → 1.870), and **Open Class** overall (1.329 → **1.431**).
  The embeddings add variance where there's little identity evidence, and the
  net Open-Class regression roughly cancels the World-Class gain.
- **corps-only** captures neither the upside nor the downside — essentially
  indistinguishable from agnostic.

**Guidance:** leave `identity` at its default `'agnostic'`. Consider
`identity: 'full'` only for **established World Class** targets with a **known
real judge panel** and in-vocab corps, where a ~2% division-level MAE improvement
is worth the added variance. Never enable it for cold-start/debut or Open-Class
predictions. This mirrors the model's training regime (identity was dropped out
~95–100% of the time; the agnostic state is the dominant in-distribution mode).

## Reproduce

```
npx tsx tools/backtest-identity.ts   # writes tools/backtest-identity.out.json
```
Env: `DCI_DB` (prod relational, read-only), `CONTRACT_DB`, `BT_START`/`BT_END`,
`BT_MEMBERS`.

## Future direction

A v11 experiment — retraining with identity dropout lowered from 0.95 to ~0.3–0.5 so the embeddings actually learn — is written up in [V11_IDENTITY_NOTES.md](V11_IDENTITY_NOTES.md).
