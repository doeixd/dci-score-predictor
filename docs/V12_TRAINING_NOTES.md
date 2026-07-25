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
