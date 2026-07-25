# V13 — design, evidence, and plan

Written 2026-07-25. This is the standalone, self-contained plan for the next
production model, consolidating everything measured during the July 2026
campaign. A reader should need no other document to understand what V13 is and
why every design choice was made — though each claim links to the doc that
measured it.

---

## 1. The story so far (how we got here, honestly)

1. **v11 was promoted on real but incomplete evidence.** It beat v10.4 by
   16.6% MAE on held-out data ([V11_ARM1_RESULTS]), survived a genuine overfit
   audit ([V11_OVERFIT_AUDIT]), and swept a rate sweep. Every comparison was
   within-family; the incumbent (final2) was never in the table.
2. **Production graded it within days.** On nine matched shows, final2 served
   ~1.07 MAE while v11 backtested 2.4–3.5. Serving was rolled back to final2
   on 2026-07-23 ([V11_RECENT_SHOWDOWN], accuracy page).
3. **Decomposition experiments then isolated every variable:**
   - **The wrapper**: bolting final2's adaptive serving wrapper onto v11's raw
     output closed most of the gap (v11 raw 2.11 → v11w 1.00 on the 9-show
     window) ([V11W_DECOMPOSITION]). The wrapper is worth ~1–2 points and is
     core-agnostic among the new cores.
   - **Target-space arm A** (persistence-residual training targets): FAILED —
     the serving path already fed the anchor; retargeting the training
     baseline barely changed the served function ([V12_ARM_A_RESULTS]).
   - **Target-space arm B** (field-level-relative targets with serve-time
     add-back): FAILED — mechanism proven in-sample, but the division-wide
     "climate" signal collapses at championship week while individual corps
     keep climbing; the inflation is per-corps trajectory, not an additive
     climate ([V12_ARM_B_RESULTS]).
   - **Wrapper co-tuning** for a new core closed another third of the
     remaining gap (v12aw 1.00 → v12t 0.95 on an untouched validation window)
     but froze constants can't track a moving regime (final2: 0.81)
     ([V12_COTUNED_RESULTS]).
   - **The raw-core comparison** delivered the final surprise: final2's v9
     core is genuinely ~1.2–1.3 points better RAW than every new core in this
     regime (1.85 vs ~3.1 held-out, bias −0.85 vs −2.0), despite far staler
     training data ([FINAL2_RAW_DECOMPOSITION]). The new-core line was a real
     core regression, not just a de-wrappered port.

**Where the numbers stand (held-out 2026-07-21..24, n=50):**

| system | MAE | bias |
|---|--:|--:|
| final2 served (v9 core + native wrapper) | **0.780** | +0.05 |
| final2 RAW core | 1.854 | −0.85 |
| v12t (v12a core + co-tuned wrapper) | 0.953¹ | −0.44¹ |
| v11w / v12aw / v12bw (new cores + wrapper) | 1.23–1.30 | −0.3..−0.8 |
| pure persistence | 1.95 | +0.84 |
| v11 / v12a / v12b RAW | 3.05–3.14 | −1.9..−2.2 |

¹ validation subwindow 07-22..24, n=43.

## 2. The learnings (each one paid for with a measurement)

**L1 — Structure extrapolates; learning interpolates.** A trained network
shapes its function only where data exists; outside support it regresses to
average behavior. Hand-written arithmetic (persistence anchors, additive
corrections) has no training distribution to fall out of. Every failure this
month was a learned component asked to extrapolate; every success was a
structural component doing arithmetic on live data.

**L2 — Put the level in arithmetic, the shape in weights.** The 2026
late-season shock was a LEVEL shift (scores inflating ~3 points); caption
proportions barely moved. v9 stores level in serve-time anchors and learns
only shape → raw bias −0.85. The v10/v11/v12 cores store level inside learned
mappings → bias −2.0+. Same shock, different landing zone. This is the single
most valuable sentence in this document.

**L3 — Adaptive correction is an online algorithm, not a function.** final2's
nightly bias correction consumes the model's OWN recent errors — an input that
does not exist at offline training time (it depends on the weights being
trained). No amount of "training it better" gives a feedforward net this
capability. The learnable route is stacking: freeze the structural layer,
feed its rolling residuals as features, train the net on what remains.

**L4 — MSE on a historical mixture actively teaches attenuation.** In 13
seasons of data, fully trusting a "+3 field-hot" signal would have overshot
(such excursions mean-reverted), so damping it was the optimal in-sample
response. The models didn't fail to learn the correction — they correctly
learned that, in their world, the correction was wrong. Their world ended at
the training cutoff.

**L5 — Data recency is secondary to architecture.** v9's training data is
months staler than v11's, and v9-raw wins the new regime by 1.3 points.
Weekly fine-tunes are cheap hygiene, not the fix.

**L6 — Co-adaptation is real and worth ~0.15–0.4.** Transplanting final2's
wrapper formulas onto new cores recovered most but not all of its value; its
constants were tuned jointly with its core against live season performance.
Constants can be re-fit (co-tuning closed a third of the residual); the
remainder must be learned or lived with.

**L7 — Evaluation protocol is a safety property.** The v11 promotion miss was
a process failure: within-family comparisons only, warning signs (growing
bias, saturating recal clamp) explained away individually. The standing rules
now: every judging includes the incumbent + pure persistence + final2 on a
matched recent window; bias exceeding corrector capacity is a blocking flag;
overfit audits are mandatory for recipe changes. These rules found every
failure in this document within 24 hours of it existing.

**L8 — Regime-conditional results must be labeled as such.** "v10 beats
final2" was true in early July and catastrophically false in late July. Every
result in this plan carries its window.

**L9 — Survivorship is a feature.** v9 is the ninth iteration of a line
shaped by observed live failures; its anchors, comparables, and fingerprints
are accumulated "never again" fixes. A clean-slate redesign discards scar
tissue precisely where scar tissue is the robustness.

## 3. The V13 design

**One sentence: v9's division of labor, built deliberately with the modern
data pipeline — structure computes the level, the network learns the shape
and the structural residual, an online channel feeds the model its own recent
errors, and the wrapper stays on top as insurance.**

### 3.1 The structural layer W (computed, never trained)
Per (corps, target event), leakage-safe at both train and serve time:
- persistence anchor: last real recap per caption;
- curve growth: expected per-caption gain from last show's percent-through to
  the target's, from the clean-view reference curves;
- prior-season comparables where same-season history is thin (the v9
  machinery, ported);
- rolling bias correction: damped, capped, computed from W's own trailing
  pre-show residuals (final2's discipline: n≥10, damp/cap co-tuned).
W alone must approximately reproduce final2-served accuracy (~0.8–1.0 in the
current regime) — this is checkpoint 1 and is verifiable before any training.

### 3.2 The learned core (modern recipe, residual duty)
- Targets: `actual_recap_c − W_c` (structural residual), z-normed on that.
- Contract: clean-v10 data contract + field-pace profile + the v11
  identity-dropout-0.5 recipe (the within-family wins were real: +16.6%).
- New inputs: W's rolling residual statistics (division and corps level,
  trailing 7/14 days) — the L3 online channel, well-defined because W is
  frozen; plus everything the current 216-dim contract carries.
- Loss: re-shaped on data that includes the 2026 inflation (re-sweep
  high-end weight / asym tau); recency weighting of current-season rows
  (secondary, per L5, but cheap).
- Serving: `prediction = W + residual_output`. The model's zero is W — safe
  by construction (L2).

### 3.3 The wrapper (kept, thin)
The horizon-weighted persistence blend + bias corrector stays ABOVE the model
output, constants co-tuned for the V13 system on a tuning window disjoint
from evaluation. Expected to be nearly inert when V13 is healthy (its
corrections ≈ 0) and to take over in unsampled regimes — its inertness is
itself a health metric, wired to the existing saturation alarm.

### 3.4 Cadence + ops
- Weekly in-season fine-tune of the residual core (mini-PC Scheduled Task
  pipeline, proven through arms A/B/C).
- Nightly self-grading via the accuracy builder (already live) and the
  external benchmark tracker.
- SDK/npm/Kaggle ship follows the proven per-model release pipeline (asset
  swap, fixture re-cut, measurement-doc refresh).

## 4. Gates (all must pass; no exceptions this time)

| # | Gate | Bar |
|---|---|---|
| G1 | W-alone sanity | W ≈ final2-served ±0.2 on the held-out window |
| G2 | Residual-target sanity | smoke: residual spread well below raw-target spread; targets small where W is good |
| G3 | Full protocol judging | columns: V13, final2 served, final2 raw, persistence, best wrapped-new-core; matched recent window + full-season window; tier/division splits |
| G4 | The promotion bar | V13 ≥ final2-served (0.78-class) on a matched LATE-SEASON window, with |bias| < corrector capacity |
| G5 | Overfit audit | in/out-of-sample split + clean-season val (the v11 audit template) |
| G6 | Live shadow | ≥1 week of genuine pre-show shadow runs graded before any flip; flip user-gated |

## 5. Timeline & compute

- **Now (championships freeze)**: arm C — currently launching on the mini-PC —
  is the V13 §3.1+§3.2 prototype at reduced scope (pure-structural W, cutoff
  07-20). Its judging calibrates the design cheaply before August.
- **Campaign status (updated 2026-07-25):** **G1 PASSED on iteration 1** —
  the standalone structural layer **W** (`src/structural/wLayer.ts`, no neural core,
  co-tuned H=25/d=0.5/cap=1.25) scored **0.781 MAE** on the held-out window
  2026-07-21..24 (n=50) vs **final2-served 0.780** (gap **+0.002**, bar ±0.2), beating
  v12t (0.915), final2-raw (1.854) and persistence (1.664), held-out bias −0.161 (inside
  ±1.25 capacity). W is also better than final2 in-sample (0.782 vs 1.020). No iteration
  needed; the wrapper-carries-the-win thesis is confirmed with W *being* the wrapper.
  Full table + component comparison + module API: [V13_G1_RESULTS](V13_G1_RESULTS.md).
  Harness `tools/backtest-w.ts` → `tools/backtest-w.out.json`. **Next: G2** (residual
  targets `actual − W` + rolling-residual features via the same module).
- **August (post-finals)**: full V13 campaign on complete 2026 data — W layer
  hardened (add comparables/fingerprints), loss re-sweep, 8-seed ensemble,
  gates G1–G6. Single campaign, ~1–2 mini-PC days of compute.
- **September**: weekly fine-tune automation unattended; history regeneration
  ([V11_HISTORY_REGEN_PLAN]) executed once with the settled champion.

## 6. Risks & pre-registered failure modes

- **W underperforms final2** (G1 fails): the comparables/fingerprint port is
  the likely gap — iterate W before training anything.
- **Residual core adds nothing** (V13 ≈ W alone): acceptable outcome; ship
  W+wrapper as the honest product and demote the network to the niches where
  it measurably wins (thin-data, rank-ordering). The learned family must earn
  its capacity.
- **Regime shifts again** (rules change, judging philosophy): W's anchors
  track by construction; the wrapper absorbs; the residual core may go inert.
  This is the designed failure mode — graceful, level-safe.
- **Silent evaluation drift**: prevented by the standing protocol (L7) — the
  incumbent and persistence are in every table, permanently.

## 7. Document map

[V11_ARM1_RESULTS](V11_ARM1_RESULTS.md) · [V11_OVERFIT_AUDIT](V11_OVERFIT_AUDIT.md) ·
[V11_RECENT_SHOWDOWN](V11_RECENT_SHOWDOWN.md) · [V11W_DECOMPOSITION](V11W_DECOMPOSITION.md) ·
[V12_TRAINING_NOTES](V12_TRAINING_NOTES.md) · [V12_ARM_A_RESULTS](V12_ARM_A_RESULTS.md) ·
[V12_ARM_B_RESULTS](V12_ARM_B_RESULTS.md) · [V12_COTUNED_RESULTS](V12_COTUNED_RESULTS.md) ·
[FINAL2_RAW_DECOMPOSITION](FINAL2_RAW_DECOMPOSITION.md) · [V13_G1_RESULTS](V13_G1_RESULTS.md) ·
[MODEL_IMPROVEMENT_PLAN](MODEL_IMPROVEMENT_PLAN.md) · [V12_TRAINING_NOTES](V12_TRAINING_NOTES.md) ·
[TIER_ACCURACY](TIER_ACCURACY.md) · [V11_HISTORY_REGEN_PLAN](V11_HISTORY_REGEN_PLAN.md)
