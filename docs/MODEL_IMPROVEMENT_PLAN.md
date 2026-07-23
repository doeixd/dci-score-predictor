# Model improvement plan

Written 2026-07-23, consolidating a week of measurements. Companion docs:
[V11_ARM1_RESULTS](V11_ARM1_RESULTS.md), [V11_OVERFIT_AUDIT](V11_OVERFIT_AUDIT.md),
[V11_RECENT_SHOWDOWN](V11_RECENT_SHOWDOWN.md), [V11_BLEND_EXPERIMENT](V11_BLEND_EXPERIMENT.md),
[V12_TRAINING_NOTES](V12_TRAINING_NOTES.md), [TIER_ACCURACY](TIER_ACCURACY.md),
[V11_HISTORY_REGEN_PLAN](V11_HISTORY_REGEN_PLAN.md).

## Where we actually stand (measured, not vibes)

| Fact | Number | Source |
|---|---|---|
| v11 vs v10.4, within family, held-out | **−16.6% MAE** (2.08 vs 2.49) | Arm-1 + overfit audit |
| v11 vs pure persistence, normal regime | 3.65 vs 7.60 (2× better) | prod guard |
| final2 vs v11, late-July regime (6 shows, 57 preds) | **1.08 vs 2.41** (final2 2.2× better) | matched-show grading |
| Season-long served accuracy (all eras) | MAE 1.89, winner 94% | /accuracy page |
| External benchmark (Field Read, day-of, ~25 shows) | 1.12 avg off | their /record page |
| Identity serving knob | agnostic best; value is TRAINING-time | identity baselines |
| Root cause of late failure | score-inflation regime outside training support (cutoff 07-11); MSE attenuation; clamped recal saturated | V12 notes |

The one-sentence story: **the learned model beats structural baselines inside
its training distribution and loses badly outside it; the serving stack lost
its structural anchor in the v10 port; evaluation compared within-family and
missed it.**

## Post-mortem: what final2 actually is, and why "build it into the model" failed

*(Added 2026-07-23 after the rollback — the causal account behind every fix in
this plan.)*

### final2 is a model + an adaptive wrapper

"final2" as served is a v9-era neural model wrapped in an **adaptive serving
stack**: a persistence blend (model output ensembled with last-real-score
projection) plus a gentle bias correction **recomputed nightly from recent
shows' errors** (damped ×0.67, capped ±1.25). The net inside is static; the
wrapper is a small online learner that tracks the season in real time. When
the late-July scoring regime shifted, the wrapper read its own recent errors
and adjusted. v11 serves nearly raw — its only adaptive part (division recal)
was clamped at ±1.5 and silently saturated when true bias hit −3..−4.5. A
thermostat versus a brick. The core-model quality difference (v11's core >
v9's core in every within-family test) is worth tenths of a point; the
adaptive wrapper is worth ~2 points in a regime shift.

### Why the end-to-end thesis failed — representability vs learnability

The v10 thesis ("bake the corrections into the model") was not wrong that
learned corrections beat hand-tuned ones; it was wrong that a **static**
learned function can replace a **dynamic** one across regime shifts:

1. **The information was sufficient — the proof is that final2's wrapper
   computes its correction from inputs v11 already has** (last score is in the
   sequence; recent field-wide error is the field-pace feature). The
   correcting function — "add the field's recent average miss" — is trivially
   representable by the network. Representability was never the issue.
2. **Gradient descent only learns the function where the data is.** Outside
   the training support a net extrapolates *smoothness*, not *structure* — it
   regresses toward average seen behavior. And the objective actively taught
   attenuation: on 13 historical seasons, fully trusting a "+3 field signal"
   would have overshot (such excursions mean-reverted), so the MSE-optimal
   response was to damp it. The model didn't fail to learn the correction —
   it correctly learned that in its world the correction was wrong. Its world
   ended on the training cutoff (07-11).
3. **The wrapper generalizes for one reason: a human-imposed structural
   prior** ("errors are additive; recent errors predict imminent errors") that
   is valid everywhere but demonstrated nowhere in the training data. That
   knowledge lives in the wrapper's *form*, not in fitted parameters — which
   is why it works in regimes nobody has sampled.

### The correct conclusion (drives Phase 1 and Phase 4)

Not "keep the apparatus around the model" — **move the apparatus's structural
knowledge into the model's architecture, not its feature list**:
- Predicting `next − last_real_score` (V12 target A) makes the persistence
  anchor the **identity path** — the thing the model outputs when it has
  nothing to say. Out-of-distribution failure then degrades to "predict the
  anchor" (final2's behavior) instead of "predict the historical average"
  (v11's behavior). Same principle as a ResNet skip connection: make the safe
  behavior the parameterization's default and learn deviations from it.
- Weekly fine-tuning (Phase 2) shrinks the no-data region so the default path
  is needed less often.
- Caveat that keeps Phase 4.1 permanent: "provide all the information" can
  never fully substitute for "sample the regime" — a truly novel shock (rule
  change, judging-philosophy shift) always favors structural priors over
  fitted responses. A thin anchor blend stays in serving as cheap insurance
  for regimes nobody has data on yet, even after V12.

### How the mistake happened — five stacked process failures

1. The original "v10 beats final2" evidence came from an early-July window —
   a regime where the static model shines. A regime-conditional result was
   treated as a general one.
2. The correction layers were dropped based on a shadow finding *in that same
   window* that they didn't help the new model — also regime-conditional.
3. Every subsequent judging (v10.4 → v10.5 → v11, arms, mixtures) was
   within-family; the incumbent never sat in the comparison table (now banned
   by Phase 3).
4. The warnings were each explained away individually — growing negative
   bias, the saturating recal, the accuracy page's era table — when jointly
   they were one signal (hence the saturation alarm and the bias-vs-clamp
   blocking flag).
5. Promotion moved ~24 h after training, when truly held-out evidence was one
   event (hence the overfit-audit + matched-recent-window requirements).

### Open decomposition experiment (cheap, shadow-only)

Bolt final2's exact wrapper (persist blend + adaptive bias correction) onto
v11's raw output and shadow it: *same corrections, swapped core* — isolates
whether the v11 core beats the v9 core when both get the thermostat. Win →
championship-week ship candidate and V12 design evidence; tie → the core was
never the bottleneck and the target-space change matters even more.

## Phase 0 — Championships (this week; serving decisions)

0.1 **RESOLVED 2026-07-23: rolled back to final2.** Fresh 07-22 shows confirmed
    the gap (final2 1.07 vs v11 3.47 pooled; v11 won only the OC oddball).
    The blend experiment was cancelled; the graded-production evidence
    sufficed. v11 shadows on. (Original decision rule: v11.1 = α·v11 + (1−α)·persistence, α fit leakage-safely.
    Decision rule: v11.1 ≲ final2 (1.08) → ship blend layer; else → rollback
    to final2 for championships. Either way final2 and v11 both keep writing
    runs — dual shadow.)
0.2 **Recal saturation alarm**: alert when the division recal fit hits its
    clamp — a saturated corrector is a regime alarm. (Small script change +
    notify hook; do regardless of 0.1.)
0.3 **Benchmark tracking**: scrape Field Read's day-of predictions per show and
    grade side-by-side on our grading pipeline (private table first; optional
    /accuracy display later). Free regression canary + honest competitive
    signal.
0.4 Freeze non-essential model churn until finals; keep the daily accuracy
    page as the public scoreboard.

## Phase 1 — August full-season retrain (= V12; the real fix)

Per [V12_TRAINING_NOTES](V12_TRAINING_NOTES.md), one campaign, arms judged by
the Phase-3 protocol below:

1.1 **Target-space sweep (the headline change)**: (A) persistence-residual
    targets (predict next − last-real-score; climate rides the anchor) vs
    (B) field-level-relative targets (climate is an explicit additive term).
    Hypothesis: A or B ≥ final2 in inflation regimes while keeping the
    within-family gains.
1.2 **Recency weighting sweep** (current-season rows ×{2,4,8}) and/or
    pretrain-all → fine-tune-current two-stage.
1.3 **Keep v11's identity-dropout 0.5** (proven within-family win; identity as
    auxiliary training signal). Optional: Phase-C ramp-target arm if serving
    knob re-tests matter.
1.4 **Loss shaping re-tune on the new data** (high-end weight / asym tau were
    calibrated on historical inflation; re-sweep on data that now contains
    2026's regime).
1.5 Data: full 2026 season through finals; clean-view contract; regenerate
    curves + featureContext afterwards (the SDK's per-season re-cut).

## Phase 2 — Always-on cadence (kills the frozen-cutoff failure class)

2.1 **Weekly in-season fine-tune** on the mini-PC (scripted: contract rebuild →
    8-seed fine-tune → auto-judge → stage; flip stays manual). Target: no
    serving model ever trains on data older than 7 days in-season.
2.2 **Nightly auto-judging**: extend the accuracy builder to grade every
    model's latest pre-show run per show (incumbent, shadows, persistence,
    external benchmark) — the standing comparison table updates itself as
    shows score.
2.3 History regeneration ([V11_HISTORY_REGEN_PLAN](V11_HISTORY_REGEN_PLAN.md))
    executes AFTER the champion model is settled, so history is rebuilt once,
    with the right model (decision gates unchanged: backup, preseason keep,
    ~10 h compute).

## Phase 3 — Evaluation protocol (process; prevents the class of miss)

Standing rules, mechanized in `tools/backtest-recent.ts` + the prod guard:
- Every judging includes: candidate, **incumbent**, **pure persistence**,
  final2 (while it exists), on a **matched recent window** + tier/division
  splits. Within-family-only comparisons are banned.
- Two windows always: full-season AND trailing-14-days (regime-sensitive).
- Bias reported alongside MAE; a |bias| > clamp capacity is a blocking flag.
- Overfit audit (in/out-of-sample split + clean-season val) required for any
  training-recipe change (the v11 audit is the template).

## Phase 4 — Serving architecture (permanent structure)

4.1 **Structural anchor stays in the stack forever**: the persistence blend
    (or residual-target equivalent once V12 ships) with leakage-safe weights —
    α should converge to ~0 when the model is trustworthy and take over when
    it isn't. Learned models interpolate; anchors extrapolate.
4.2 **Adaptive recal**: clamp scales with observed field-pace magnitude;
    saturation alerts (0.2).
4.3 Uncertainty honesty: widen served intervals by tier (T3 debut intervals
    should be ~3× T0's per measured tier MAEs); interval-calibration pass
    (the long-standing 4f TODO).
4.4 SDK parity follows whatever ships (asset + fixture re-cut per release —
    the pipeline for this is proven).

## Phase 5 — Research backlog (post-V12, ranked by expected value)

1. **Per-season climate latent**: a small learned season-scale parameter,
   estimated online from early-season shows (would let raw-score targets work
   under non-stationarity; alternative to target-space fixes).
2. **Distributional heads** (full quantile set) + CRPS training — better tails
   for debuts (T3 is the worst tier everywhere: MAE ~4.8–5.5).
3. **Judge-aware serving revisit**: identity-full showed a late-season WC hint
   in the held-out audit; re-test after V12 with real panels.
4. **Cross-family ensembling**: mixtures were monotone-rejected within-family,
   but final2+v11 are architecturally decorrelated (structural vs learned) —
   a 2-model stack with regime-dependent weights is the promising version.
5. Caption-level recal (division recal is total-level; captions inherit
   proportionally — per-caption offsets may claw back GE-specific drift).
6. All-age coverage (currently excluded everywhere; needs its own curve
   contract and data audit before any promise).

## What "done" looks like

- Championships served by whichever stack the blend verdict picks, with the
  saturation alarm live.
- V12 ships from the August campaign passing Phase-3 gates INCLUDING beating
  final2 on a matched late-season window — the first model allowed to retire
  final2's shadow.
- Weekly fine-tune running unattended by September; the 2027 season opens with
  no frozen-cutoff exposure and the accuracy page as the public scoreboard.
