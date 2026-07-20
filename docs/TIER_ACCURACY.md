# Measured tier accuracy (2026 backtest)

These are the backtested per-degradation-tier accuracy figures promised in
PLAN §3.5 and referenced by the tier table in `MODEL_CARD.md`. They are produced
by `tools/backtest-tiers.ts` and are reproducible against the private prod DB.

## Methodology

- **Harness:** `tools/backtest-tiers.ts` — replays the public `predict()` over
  every resolved 2026 event in the window, exactly as an SDK consumer would call
  it (`members: 8`).
- **Window:** all scored 2026 events from **2026-07-01 through 2026-07-19**,
  World Class + Open Class. 27 events, 197 per-corps observations, 0 skips.
- **No-leakage construction:** for each target event the SeasonData input is
  rebuilt from **only the shows strictly before that event's date** (the same
  construction `tools/gen-season-fixture.ts` uses, generalized by target slug and
  enforced by the SDK's own hard leakage guard). The target lineup is the set of
  corps that **actually scored** at that event; predicted totals are compared to
  those actual totals.
- **Tiering:** each corps is bucketed by the tier the SDK itself reports in
  `readiness.corps[].tierCode` for that event (T0/T1/T2/T3 = established / partial
  / sparse / cold_start). Because the input is truncated to real season-to-date
  history, the tier a corps lands in is the tier its true history depth produces —
  early events populate T2/T3, later events T0.
- **Two passes:**
  - **No recal** — `recalObservations` omitted (the honest zero-config default a
    first-time caller gets).
  - **With recal** — `recalObservations` = the SDK's **own** no-recal predictions
    on resolved shows strictly before the target within a 14-day trailing window
    (leakage-safe self-calibration; the exact per-division recal the SDK ships).
- **Metrics:** MAE and mean bias (predicted − actual, in recap points) with `n`
  per cell so thin tiers are visible.

## Per-tier accuracy

| tier | code | n | MAE (no recal) | bias (no recal) | MAE (recal) | bias (recal) |
|---|---|---|---|---|---|---|
| established | T0 | 105 | 2.44 | −2.32 | **1.27** | −0.95 |
| partial | T1 | 13 | 0.85 | −0.37 | **0.74** | +0.12 |
| sparse | T2 | 57 | 1.82 | −1.42 | **1.27** | −0.65 |
| cold_start | T3 | 22 | 5.48 | −5.07 | **4.89** | −4.43 |
| **overall** | — | 197 | 2.49 | −2.24 | **1.64** | −1.18 |

## Per-division accuracy

| division | n | MAE (no recal) | bias (no recal) | MAE (recal) | bias (recal) |
|---|---|---|---|---|---|
| World Class | 142 | 2.95 | −2.94 | **1.75** | −1.60 |
| Open Class | 55 | 1.33 | −0.41 | **1.35** | −0.09 |

## Reading the numbers

- The tier **ordering** holds as designed: T1/T0 are tightest, T2 wider, **T3
  (debut / cold start) is by far the weakest regime** (MAE ≈ 5 points, strongly
  under-projecting) — this is the documented "predictions fall back to curve
  anchors" limitation, not a defect.
- The **negative bias** across tiers is the known finals-approach /
  early-in-tenure under-projection. The trailing-window recal is exactly what it
  is for: it roughly halves overall MAE (2.49 → 1.64) and pulls World Class bias
  from −2.94 toward −1.60. Callers who supply resolved observations get the recal
  column; callers who don't get the no-recal column.
- T1 has the smallest error but also the **smallest n (13)** — it is a narrow
  regime (≥3 prior shows but field-pace not yet confident), so read that cell as
  indicative, not definitive.

## Caveats

- **Single-season window.** These figures are one 2026 in-season slice
  (2026-07-01..2026-07-19); they are not a multi-year generalization estimate.
- **Thin tiers.** T1 (n=13) and T3 (n=22) are thin; their cells carry wide
  sampling uncertainty. T0 (n=105) and T2 (n=57) are the well-populated cells.
- **Self-recal pool.** The recal pass calibrates on the SDK's own earlier
  predictions (not an external oracle), so it reflects real deployment behavior;
  very early targets have small/empty trailing pools and therefore little recal.
- Reproduce with `npx tsx tools/backtest-tiers.ts` (writes
  `tools/backtest-tiers.out.json`); requires the private prod + serving-contract
  DBs (see the header of the tool).
