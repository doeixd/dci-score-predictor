# V11 Arm-1 overfit / memorization audit

Status: MEASURED (evaluation only — SDK defaults and shipped assets unchanged).
Companion to [V11_ARM1_RESULTS.md](V11_ARM1_RESULTS.md) (the −16.6% headline) and
[V11_IDENTITY_NOTES.md](V11_IDENTITY_NOTES.md) (campaign log).

## Question

Is v11 Arm-1's −16.6% agnostic-MAE win over v10.4 **generalization** or
**contamination**? Both families trained on data ≤ 2026-07-11, and the headline
backtest window (2026-07-01..19) overlaps that training data. This audit runs
three independent, all-real-measurement checks to separate the two.

**Verdict: GENERALIZES (regime-specific).** No memorization signature on any of
the three checks. The win is a real, out-of-sample gain concentrated in the
mid-season World Class under-projection / sparse-history regime; it does not
show up on the championship-week finals regime (2024 test), which is why the
clean-season signal (Check 2) is a wash rather than a second −16%.

## Check 1 — in-sample vs post-cutoff vs true-held-out split

Harness: `tools/backtest-v11-split.ts` (variant of `backtest-v11.ts`; same
leakage-safe per-event backtest, **agnostic mode only**, **pure pools only**
`v104` / `v11` — the production question). Target events are bucketed by date:

- **in-sample** (≤ 2026-07-11): both families trained on these rows.
- **post-cutoff** (2026-07-12..19): in the contract snapshot but scored AFTER
  the 07-11 train cutoff — neither family could memorize them.
- **true-held-out** (≥ 2026-07-20): scored AFTER the contract snapshot
  (`/tmp/sdk-assets-contract.db` stops at 07-19). Pulled live from the prod DB
  `corps_scores` and injected in the same shape; `percent_through` recomputed as
  `(date − 2026-06-26)/(2026-08-08 − 2026-06-26)×100` (verified byte-exact vs
  contract rows: 07-19 → 23/43 → 53.4884). Target-only events, so only
  corps_key/division/total_score are read — model inputs still come from prior
  contract shows (leakage-safe). As of 2026-07-22 the only such event is
  `2026-dci-mckinney` (6 World Class obs); no 07-21/07-22 events scored yet.

Overall MAE / bias, agnostic (n | MAE | bias):

| bucket | events | v10.4 | v11 | v11 rel edge |
|---|---|---|---|---|
| in-sample (≤07-11) | 16 | 107 / 2.513 / −2.227 | 107 / 2.106 / −1.641 | **−16.2%** |
| post-cutoff (07-12..19) | 11 | 90 / 2.472 / −2.249 | 90 / 2.046 / −1.695 | **−17.2%** |
| true-held-out (≥07-20) | 1 | 6 / 3.760 / −3.760 | 6 / 3.280 / −3.280 | **−12.8%** |

**VERDICT: edge PERSISTS post-cutoff.** If the −16% were memorization of
training rows, the relative edge would collapse on the post-cutoff bucket.
Instead it is essentially **constant** (−16.2% in-sample vs −17.2% post-cutoff),
and the same-direction bias improvement (−2.2 → −1.6/−1.7) holds in both. The
single true-held-out event confirms direction (−12.8%).

Note on the held-out magnitude: V11_ARM1_RESULTS.md §(b) reported mckinney at
6.285 (v10.4) / 5.606 (v11) from the 07-20 snapshot. With the now-complete
07-01..19 prior-show context in the current contract DB the same event runs
lower (3.760 / 3.280) — more recent context, smaller under-projection — but v11
still leads by the same direction. The relative conclusion is unchanged.

## Check 2 — training-time val (2023) / test (2024-finals) — the clean signal

Extracted from the mini-PC trainer logs
(`/root/corps-place-v10/sdk/logs/{v11_identity050,v10_4}_field_pace_seed4[2-9].log`),
final `validation:` (363 rows, 2023 date-forward) and `test_all:` (52 rows,
2024 finals) evaluation blocks. These seasons **cannot** contain 2026
memorization. Family mean ± stdev (min–max), n=8 seeds each:

| metric | v10.4 | v11 | Δ |
|---|---|---|---|
| val total_mae_pts (2023) | 1.012 ± 0.039 (0.96–1.09) | **0.996 ± 0.062** (0.92–1.09) | v11 −1.6% |
| val delta_mae_pts (2023) | 0.372 ± 0.010 | **0.366 ± 0.014** | v11 −1.6% |
| test total_mae_pts (2024 finals) | **0.822 ± 0.074** (0.70–0.91) | 0.831 ± 0.126 (0.69–1.03) | v11 +1.2% |
| test delta_mae_pts (2024 finals) | **0.297 ± 0.009** | 0.309 ± 0.026 | v11 +4.2% |

**VERDICT: a statistical WASH on the clean seasons.** v11 is marginally better
on 2023 validation and marginally worse on 2024 finals, both well within the
seed spread (differences ≤ 4% vs stdevs of 4–17%). The families are
indistinguishable on unmemorizable 2023/2024 data. Crucially this is the
**opposite** of a memorization tell: a memorizing v11 would look *identical* to
v10.4 off-2026 (it does) while winning on-2026 (it does) — but so would a
regime-specific *generalizer*. Check 1 breaks the tie: the on-2026 win survives
on rows that were never trained on, so it is generalization, not memorization.
The absence of a 2024-finals win simply says the gain is **not** a universal
accuracy lift — it is a regime the finals test does not exercise (see below).

## Check 3 — memorization histogram (per-obs |err| distribution)

From `tools/backtest-v11-split.out.json` (per-observation errors, agnostic).
Memorization looks like a spike of **near-zero errors on in-sample rows only**;
generalization looks like a **uniform downward shift** of the whole
distribution, equal in-sample and post-cutoff.

| bucket / pool | n | p10 | p25 | p50 | p75 | p90 | min | <0.5pt |
|---|---|---|---|---|---|---|---|---|
| in v10.4 | 107 | 0.46 | 0.94 | 1.80 | 2.99 | 5.54 | 0.03 | 13 (12%) |
| in **v11** | 107 | 0.43 | 0.74 | **1.42** | 2.36 | 4.28 | 0.03 | 14 (13%) |
| post v10.4 | 90 | 0.78 | 1.50 | 2.23 | 3.54 | 4.26 | 0.11 | 4 (4%) |
| post **v11** | 90 | 0.71 | 1.10 | **1.80** | 2.97 | 3.45 | 0.01 | 7 (8%) |
| held v10.4 | 6 | 2.83 | 3.20 | 4.11 | 4.21 | 4.34 | 2.76 | 0 |
| held **v11** | 6 | 2.40 | 2.66 | 3.56 | 3.77 | 3.87 | 2.40 | 0 |

**VERDICT: NO memorization signature.** On the in-sample (training) rows v11's
near-zero fraction (<0.5pt: 13%) is essentially the same as v10.4's (12%) — no
spike of memorized rows. v11 improves the *whole* distribution (every quantile
p10→p90 lower), and by the *same shape* in-sample and post-cutoff (in-sample
p50 1.80→1.42; post-cutoff p50 2.23→1.80). That is the fingerprint of a better
shared network, not a lookup table.

## Synthesis — why the win is real but regime-specific

- Checks 1 + 3 prove the −16% is **out-of-sample real**: it survives on
  post-cutoff and true-held-out 2026 rows with no near-zero-error tell.
- Check 2 shows it is **not a universal lift**: on 2024 championship-week finals
  (dense history, all-established, minimal under-projection) v11 ≈ v10.4.
- Reconciliation (from Check 1 tier/division splits, agnostic in-sample):
  the v11 gain is a **World Class under-projection** gain (WC 3.03→2.42
  in-sample; 2.86→2.30 post-cutoff) concentrated in **T0/established WC and
  sparse/cold-start** tiers (T3 5.72→4.99). The 2024 finals test set does not
  exercise that regime, so it shows no gain — consistent, not contradictory.
  Identity-dropout-0.5 gave the shared network better mid-season / thin-history
  behaviour; that is exactly the regime the 07-01..22 window is dominated by.

## Overall verdict & promotion readiness

**GENERALIZES (regime-specific).** The −16.6% is trustworthy for the production
question it was measured on — agnostic serving over the mid-season window — and
is not contamination. Recommendation:

1. **Proceed toward promotion** on the existing plan: fold the 0.5 identity-
   dropout rate into the August full-season retrain (user-gated). The overfit
   risk that would have blocked this is cleared.
2. **Temper the headline for finals**: expect the gain to shrink toward zero in
   championship week (the 2024-finals wash). The win is mid-season / sparse /
   WC-under-projection, not a season-wide −16%.
3. **Keep the standing gate**: rerun the prod backtest guard
   (`backtestPredictionModes.ts`) before any prod flip; do not ship v11 seeds or
   change the SDK `identity` default from these numbers alone.

## Artifacts

- Harness: `tools/backtest-v11-split.ts`
- Machine-readable results (buckets + per-obs): `tools/backtest-v11-split.out.json`
- Training-log source (mini-PC): `/root/corps-place-v10/sdk/logs/`
  `{v11_identity050,v10_4}_field_pace_seed4[2-9].log`
