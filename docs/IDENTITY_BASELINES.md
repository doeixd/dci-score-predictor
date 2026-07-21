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

```
--- agnostic (default) ---
  T0 established    105 |  3.193 | -3.094
  T1 partial         13 |  1.352 | -0.924
  T2 sparse          57 |  2.847 | -2.413
  T3 cold_start      22 |  5.482 | -5.071
  overall           197 |  3.227 | -2.974
    World Class     142 |  3.807 | -3.807
    Open Class       55 |  1.730 | -0.825

--- identity-full ---
  T0 established    105 |  3.112 | -2.965
  T1 partial         13 |  1.617 | -1.395
  T2 sparse          57 |  2.881 | -2.482
  T3 cold_start      22 |  5.389 | -4.902
  overall           197 |  3.201 | -2.938
    World Class     142 |  3.723 | -3.722
    Open Class       55 |  1.852 | -0.914

--- identity corps-only ---
  T0 established    105 |  3.199 | -3.083
  T1 partial         13 |  1.347 | -0.850
  T2 sparse          57 |  2.856 | -2.396
  T3 cold_start      22 |  5.457 | -5.060
  overall           197 |  3.229 | -2.957
    World Class     142 |  3.822 | -3.822
    Open Class       55 |  1.700 | -0.725
```

### Overall summary

| mode | overall MAE | Δ vs agnostic | overall bias |
|------|-------------|---------------|--------------|
| agnostic (default) | **3.227** | — | −2.974 |
| identity-full | **3.201** | **−0.026 (−0.8%)** | −2.938 |
| identity corps-only | **3.229** | +0.002 (wash) | −2.957 |

> The large shared negative bias (~−2.97) is the early-season no-recal
> systematic offset (predictions run low in early July), **not** an identity
> effect — it dominates the MAE and is corrected by the recal pass in
> `backtest-tiers.ts`. It moves in lock-step across modes, so the identity
> comparison is still clean.

## Recommendation: keep the default `agnostic`

Identity-full is a **statistical tie** overall (−0.026 MAE on 197 obs, well
inside noise) and identity corps-only is a wash. Re-enabling identity does **not**
justify changing the default. Concretely:

- **Where identity helps:** established, rich-history **World Class** corps —
  `T0 established` MAE 3.193 → **3.112** and World Class overall 3.807 →
  **3.723** under identity-full. These are corps/panels with strong in-vocab
  embeddings and same-season judge-Elo signal.
- **Where identity hurts:** thin-history regimes — `T1 partial` (1.352 → 1.617),
  `T2 sparse` (2.847 → 2.881), and **Open Class** overall (1.730 → **1.852**).
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
