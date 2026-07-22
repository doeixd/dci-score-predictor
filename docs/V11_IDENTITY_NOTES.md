# V11 design note — let the model actually see identity

Status: PROPOSAL (not scheduled). Companion to the measured serving results in
[IDENTITY_BASELINES.md](IDENTITY_BASELINES.md).

## The finding that motivates this

The SDK's opt-in `identity` serving knob re-enables the trained corps/judge/show
embedding inputs that production zeroes. Measured on 27 resolved 2026 events
(197 corps observations, full-fidelity inputs, no recal):

| mode | overall MAE | Δ |
|---|---|---|
| agnostic (default) | 2.494 | — |
| identity-full | 2.475 | −0.8% (tie) |
| identity corps-only | 2.507 | wash |

Corps identity contributes essentially nothing at serving time. **This is not a
bug — it is what the v10 training regime guarantees:**

1. **`identityDropoutRate: 0.95`** (floor 0.05) in the v10 curriculum
   (`trainModelV95.ts` / `v95Curriculum.ts`): the embeddings received real
   identity in only ~5% of training steps, over a 54-corps vocab. They were
   never given the gradient budget to learn much.
2. **Identity is redundant with an always-on channel.** The static caption
   fingerprint block (179–211) is a hand-crafted per-corps residual signature
   across prior seasons; corps history (0–7) and prev-season anchors carry the
   rest. These were never dropped out, so the model learned to read identity
   from *them* at full strength.
3. The small identity-full gain on World Class (2.945 → 2.880) most plausibly
   comes from the judge-Elo block (101–112), which trained live (only masked at
   serving) — unlike the embeddings, it got full gradient.

## The experiment: v11 identity-visible training

Hypothesis: with a moderate dropout rate the embeddings learn real per-corps
style/trajectory signal that the hand-crafted features miss (e.g. design-team
tendencies, mid-season rewrite patterns), improving established-corps accuracy
while the dropout floor keeps agnostic serving in-distribution.

### Training changes (everything else frozen at the v10.4 recipe)

- **Identity dropout 0.95 → sweep {0.3, 0.5, 0.7}.** Keep the schedule shape
  (curriculum start + floor) so early epochs still learn the agnostic pathway.
- Keep the clean-v10 field-pace contract, 8-seed ensemble, same
  splits/curriculum/loss — one variable at a time.
- Optional second arm: **support-weighted dropout** — drop identity more for
  low-support corps (few rows) and less for high-support corps, so embeddings
  concentrate learning where evidence exists (mirrors where identity-full
  helped/hurt in the serving A/B).
- Consider a small embedding-L2 on corps/show embeddings to bound variance for
  thin corps.

### Campaign log

- **2026-07-21**: Arm 1 (A/B rate 0.5, seeds 42–49) launched on the mini-PC via
  the `--identity-dropout-rate` CLI knob (branch `v11-identity-dropout`,
  default 0.95 = v10 unchanged). Logs confirm the rate drives actual ~0.5
  dropout in phases A/B.
- **Phase-C observation (from live logs):** the curriculum ramps identity
  dropout to **1.0** in Phase C regardless of the new knob — final convergence
  is always fully agnostic. So the knob controls A/B exposure only; v11
  embeddings are *trained-then-frozen* (learned in A/B, held while Phase C
  tunes the network around agnostic serving). v10.4's embeddings were both
  under-trained (5% exposure) AND frozen; v11's are trained-then-frozen. If
  Arm 1 shows only partial gains, a follow-up variable is the **Phase-C ramp
  target** (e.g. ramp to 0.5 instead of 1.0) — but that changes the agnostic
  finalization and needs the no-regression gate watched closely.
- **2026-07-21 — Arm 1 JUDGED** (full results:
  [V11_ARM1_RESULTS.md](V11_ARM1_RESULTS.md), harness `tools/backtest-v11.ts`):
  8×v11-agnostic wins decisively on the 27-event window — overall MAE **2.079
  vs 2.494** (−16.6%), better in every tier, bias −2.24 → −1.67; gain
  concentrated in World Class (2.945 → 2.359), Open Class a wash.
  No-regression gate PASSED. v11-full beats v10.4-full (2.146 vs 2.475) but
  LOSES to v11-agnostic — the win is identity as *auxiliary training signal*,
  not identity at serving. **Mixture hypothesis REJECTED**: MAE monotone in
  v11 fraction; pure 8×v11 beats every mixed pool in both modes. Skepticism
  pass: training-args diff = only `identityDropoutRate: 0.5`; one true
  held-out event (mckinney 07-20) confirms direction (v11 better in both
  modes; identity-full helps there — late-season WC regime); no degenerate
  seeds. **Arm 2**: rate sweep (0.3 + 0.7 bracket); mixture-widening dead;
  fold the winner into the August retrain; `backtestPredictionModes.ts` guard
  before any prod flip.

## Heterogeneous expert ensembles (mixture hypothesis)

Since the model is an 8-member ensemble, a stronger use of identity than "one
best dropout rate" may be **members trained with different identity exposure**
("expert families"). Rationale:

1. Current members differ only by init seed — same data, same curriculum.
   Diversifying the *training regime* across members is a stronger source of
   ensemble decorrelation than seed alone; individually-mediocre members can
   pool better if their errors decorrelate.
2. It matches the measured serving structure: identity helps established World
   Class and hurts thin-history/Open Class. A mixed pool creates a serving
   lever — per-mode pool weights, or **per-readiness-tier routing**
   (identity-heavy experts for T0/WC targets, agnostic experts for
   debuts/Open Class): a serving-layer mixture-of-experts, measurable with the
   existing backtest harness.
3. Honest caveat: Phase C finalizes every member agnostic, so families differ
   mainly in embedding quality and in how the network organized around identity
   during A/B — real diversity, not fully independent specialists.

### The free experiment (no new training)

Arm 1 + the shipped v10.4 seeds = 16 members from two families
(A/B-rate 0.95 and 0.5). The judging step evaluates, at zero training cost:

- pure pools: 8×v10.4 vs 8×v11, both serving modes (the original A/B);
- **mixed pools**: 4+4, 6+2, 2+6, all-16 — the mixture hypothesis;
- mode-aware pooling: agnostic serving → v10.4-heavy pool; identity-full →
  v11-heavy pool;
- optional tier-routed weighting (readiness tier → member weights).

Pooling stays a plain mean at first (per-seed target-norms already make members
mean-compatible); learned weights only if plain mixtures show signal.

**Decision rule:** if mixtures win, Arm 2's purpose changes — train at 0.3 (or
with a lowered Phase-C target) to *widen the expert family pool*, not to find a
single best rate.

### Judging the result (all gates must pass)

1. **Both serving modes, same backtest.** Rerun `tools/backtest-identity.ts`
   (SDK, three modes) with the v11 seeds. Success = identity-full beats v10.4
   identity-full AND v11-agnostic ≥ v10.4-agnostic (the agnostic path must not
   regress — it is the production default and the parity surface).
2. The prod backtest guard (`backtestPredictionModes.ts`) before any prod flip —
   per the standing rule: rerun it before changing prediction logic.
3. Per-tier view: expect the gain in T0/established WC; watch T1/T2 and Open
   Class for the variance regression seen in the serving A/B.

### Cost / logistics

- Same shape as the v10.4 campaign: 8 seeds × ~3 dropout arms on the mini-PC
  (train one arm's 8 seeds, judge, then decide whether the sweep continues).
  Feature/temporal builders unchanged — reuse the existing training DB.
- Natural slot: the **August full-season retrain** (already planned for the
  finals-week WC under-projection). Adding the dropout sweep to that campaign
  amortizes the setup.

### If it wins

- Ship v11 seeds to the SDK with the SAME dual-mode contract: default stays
  `agnostic` unless v11-agnostic also improves; the `identity` knob then has a
  measured reason to exist beyond parity curiosity.
- Update IDENTITY_BASELINES.md with the v11 three-mode table; revisit the
  default recommendation only on clear, tier-consistent evidence.

## Campaign log — overfit / memorization audit (2026-07-22)

Before treating the −16.6% agnostic win (V11_ARM1_RESULTS.md) as promotable, ran
a three-check overfit audit. Full numbers: [V11_OVERFIT_AUDIT.md](V11_OVERFIT_AUDIT.md).

- **Split backtest (in-sample vs post-cutoff vs true-held-out), agnostic, pure
  pools.** New harness `tools/backtest-v11-split.ts`; true-held-out event
  (`2026-dci-mckinney`, 07-20, 6 WC obs) injected live from the prod DB since the
  contract snapshot stops at 07-19. v11's relative edge is **constant** across
  buckets: in-sample 2.513→2.106 (−16.2%), post-cutoff 07-12..19 2.472→2.046
  (−17.2%), true-held-out 3.760→3.280 (−12.8%). Memorization would have collapsed
  the post-cutoff edge — it did not.
- **Clean-season signal (mini-PC trainer logs).** 2023 validation and 2024-finals
  test, both families n=8: a **wash** (val total 1.012→0.996, test total
  0.822→0.831, all within seed spread). No off-2026 win — but no off-2026 *tell*
  either; Check 1 supplies the on-2026-out-of-sample proof.
- **Memorization histogram.** In-sample near-zero fraction (<0.5pt) is 13% for
  v11 vs 12% for v10.4 — no spike. v11 shifts the whole error distribution down by
  the same shape in-sample and post-cutoff. Not a lookup table.

**Verdict: GENERALIZES (regime-specific).** The −16% is out-of-sample real,
concentrated in mid-season WC under-projection / sparse-history; it fades toward
zero on the finals regime (hence the 2024 wash). Overfit risk cleared →
promotion may proceed on the existing August-retrain plan, but do not advertise a
season-wide −16% for championship week, and keep the `backtestPredictionModes.ts`
gate before any prod flip.
