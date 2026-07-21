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
