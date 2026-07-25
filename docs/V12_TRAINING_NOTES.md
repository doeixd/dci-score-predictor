# V12 training design note — fixing the non-stationarity failure

Motivated by the 2026-07-22 finding ([V11_BLEND_EXPERIMENT.md],
[V11_RECENT_SHOWDOWN.md], accuracy page): on the 6 late-July shows, final2
(persistence-anchored) served MAE **1.08** vs v11's **2.41** — despite v11
beating v10.4 by 16.6% within-family and beating pure persistence 2:1 on the
standing guard. Root cause: late-season score inflation is a **regime outside
v11's training support** (cutoff 2026-07-11), and three design assumptions
break under non-stationary scoring climate.

Diagnosis: the training is not "incorrect" — it optimizes its stated objective
correctly. The objective/target-space/cadence assume stationarity.

## Fixes, by leverage

### 1. Target space (deep fix — pick one, backtest both)
- **A. Persistence-residual targets**: predict `next_score − last_real_score`
  (per caption), serving = anchor + predicted growth. Climate rides the anchor
  by construction (final2's robustness property), the network learns growth
  (generalizes across eras). Replaces the current delta-from-EMA baseline —
  EMAs lag accelerating series systematically.
- **B. Field-level-relative targets**: predict `score − field_level(t)` with
  the field level added back at serving, unshrunk. Makes season climate an
  explicit additive term outside the learned mapping (today field-pace is an
  INPUT the model attenuates, /10-scaled and shrinkage-damped).

### 2. Data weighting
- Recency-weight current-season rows (sweep ×{2,4,8} effective weight).
- Or two-stage: pretrain all seasons → fine-tune on current season.
- Keep identity-dropout 0.5 (v11's within-family win transfers).

### 3. Cadence (highest ROI/effort)
- **Weekly in-season fine-tune** on the mini-PC (pipeline is fully scripted:
  one Scheduled Task per retrain, ~5 h for 8 seeds). A frozen mid-July cutoff
  serving championships is a choice, not a constraint. Automate: retrain
  Sunday nights from the latest contract DB; judge with the standing gates
  before auto-staging (flip stays manual).

### 4. Serving guardrails
- Recal clamp: ±1.5 was sized for historical bias and SATURATED silently at
  −3..−4.5. Make the cap adaptive (e.g. scale with |field-pace level|), and
  ALERT when the fit hits the cap — a saturated corrector is a regime alarm.
- Keep a structural persistence-blend layer in serving permanently (weight fit
  leakage-safely; ~0 in regimes where the model is trusted). Learned models
  interpolate; structural anchors extrapolate. Both, always.

### 5. Evaluation protocol (process fix — standing rule)
Every model judging MUST include, on a matched recent window:
1. the candidate, 2. the incumbent (whatever currently serves), 3. pure
persistence, 4. final2 while it exists. Within-family comparisons alone are
how the v11 promotion missed a 2.2× regression vs the incumbent's predecessor.
Add these columns to tools/backtest-recent.ts permanently.

## Slotting
- August full-season retrain = V12 arm 1: target-space A vs B sweep ×
  recency weighting, identity-dropout 0.5, judged per §5 + tier splits.
- Short term (pre-championships): per V11_BLEND_EXPERIMENT verdict — either
  v11.1 blend layer or rollback to final2.

## Campaign log

### 2026-07-25 — arm A (persistence-residual) judged. VERDICT: does not promote.
8 v12a seeds (42–49, `--baseline-mode last`, id-dropout 0.5, cutoff 07-20) trained
on the mini-PC, pulled to `/home/patrick/v12a-seeds/`, all load/predict sanely
(vocab 245/709/349). Full Phase-3 table in
[V12_ARM_A_RESULTS](V12_ARM_A_RESULTS.md); harness `tools/backtest-v12a.ts`
reproduces the published decomposition numbers exactly (final2 0.949 / v11w 1.000,
n=74) → trustworthy.

Held-out (07-21..22, n=24 — no WC/OC scored 07-23..25 yet): **v12a 3.089 · final2
0.800 · v11 raw 3.151 · v11w 1.268 · persist 2.798**; v12a bias **−1.906 > 1.25
clamp = BLOCKING**. In-sample-for-v12a (07-17..20, n=50, reported separately):
v12a 1.393 · final2 1.020 · v11w 0.871.

Findings: (a) v12a does NOT beat final2 (~4×); (b) does NOT reach v11w — the
target-space change did **not** internalize the wrapper; v12a lands on top of v11
raw. Root cause: `serve.ts` L99–105 already anchors EVERY model to the last-real
recap, so arm A's retarget barely moves serving behavior, and the MSE-trained
delta head stays attenuated (deltaMean 0.108 ≤ v11's 0.126). The win is the damped
anchor↔model *blend* (curveΔ + horizon persist), which arm A does not reproduce.
No degenerate seeds. Decision: **run arm B (field-level-relative, explicit unshrunk
climate term); keep the Phase-4.1 wrapper permanent; final2 stays serving.** Cheap
next probe: shadow `v12aw` (v12a core + final2 wrapper) on the same window.

### 2026-07-25 — v12aw probe (arm-A core + final2 wrapper). VERDICT: core interchangeable.
`tools/backtest-v12aw.ts` bolts final2's exact wrapper onto v12a raw (bias from
v12a's own pre-show residuals), same 9-show window; reproduces final2/v11w/v12a-raw
exactly. **Held-out (n=24): v12aw 1.227 vs v11w 1.268 — 0.041 edge, within tenths**
(in-sample 0.849 vs 0.871). Wrapper collapses v12a's blocking −1.906 held-out bias
to −0.361 and does ~1.86 pts of MAE work (3.089→1.227); the v11→v12a core swap under
the wrapper is worth ~0.04. Confirms the decomposition thesis on a 2nd core: wrapper
carries the win, core swap worth tenths; arm A earns no wrapper-complementarity
promotion. Table appended to [V12_ARM_A_RESULTS](V12_ARM_A_RESULTS.md) §v12aw probe.

### 2026-07-25 — arm B (field-level-relative + serving add-back) judged. VERDICT: does not promote; do not train arm B′.
8 v12b seeds (42–49, `--climate-mode subtract`, baseline EMA, id-dropout 0.5,
cutoff 07-20), pulled to `/home/patrick/v12b-seeds/`, all load/predict sanely, no
degenerate seed (epochs 24–75, bestDeltaMae 0.355–0.371). Served correctly with the
mandated add-back `served = model + 0.70·field_level_live` (field level =
`TemporalState.fieldSnapshot(2026,div,D).level`, unshrunk, division-wide, computed
on the fly, leakage-safe). Full Phase-3 table + hand-verified worked example in
[V12_ARM_B_RESULTS](V12_ARM_B_RESULTS.md); harness `tools/backtest-v12b.ts`.
Championship-week data ingested since arm A: 4 WC/OC shows scored 07-24 (birmingham,
middle-tennessee, syracuse, drums-on-parade) → contract rebuilt (`…-0725b.db`, 40
shows), held-out now **07-21..07-24, n=50**.

Held-out (n=50): **v12b 3.054 · final2 0.780 · v11w 1.245 · v12bw 1.299 · v12a raw
3.144 · persist 1.954**; v12b bias **−2.021 > 1.25 = BLOCKING**. In-sample (n=50,
separate): v12b 1.439 · v12b-noAB 3.461 · final2 1.020 · v11w 0.871.

Findings: (a) v12b does NOT beat final2 (~4×); (b) built-in climate term does NOT
match the external wrapper (3.054 vs v11w 1.245) — an additive division-wide constant
≠ the per-corps curve+persistence blend; (c) **add-back mechanism PROVEN in-sample**
(pooled bias −3.379→−0.315, MAE 3.461→1.439, ΔMAE +2.022; houston worked example errs
4.9/3.6/4.5→2.2/1.0/1.9), but held-out the field level **collapses** (WC 2.05→0.44→
−0.56) so the add-back does nothing (ΔMAE −0.112) and the core reverts to attenuated
v11-raw. The 0.70 factor is the self-consistent inverse and already lands in-sample
bias near zero; **arm B′ (full-strength factor 1.0) would OVERSHOOT in-sample (+1.0)
and not fix held-out → not worth training.** (d) v12bw 1.299 ≈ v11w 1.245 ≈ v12aw
1.227 — **3rd core, same result: wrapper carries the win, core interchangeable.**
Decision: **do not promote arm B; do not train arm B′; keep final2 serving; Phase-4.1
wrapper permanent.** August lever is cadence (Phase 2 weekly fine-tune) + growth-head
de-attenuation, NOT target-space climate reparametrization.

## Campaign log

- **2026-07-25 — v12t (co-tuned wrapper):** tested whether the v12a gap is
  wrapper-calibration, not core. Co-tuned the wrapper params FOR the v12a core in one
  leakage-safe pass (grid over H∈5..30, β∈0..1, bias d∈0.3..1, cap∈1.25..3; honest
  self-referential bias from each candidate's own pre-correction residuals). Tuned on
  07-17..21, froze, evaluated on untouched 07-22..24. Tuner chose **H=25 (vs final2's
  14 — longer persistence), β=0.45, d=0.5, cap=1.25**. Result: co-tuning helped
  out-of-sample (v12aw 1.001 → **v12t 0.953**) but **did NOT reach final2 (0.813),
  gap +0.140**. v12t carries a −0.443 validation bias (under-predicts the inflating
  championship week) vs final2's +0.108. **Verdict: residual gap is STRUCTURAL, not
  wrapper calibration → arm C** (per-corps curveΔ / craft). Constants were tuned on 5
  days of one regime; any future promotion must re-validate over full championships
  week. Tool `tools/backtest-v12t.ts`; full writeup [V12_COTUNED_RESULTS.md].
