# V11 promotion plan — production + npm

Status: PLAN. Gated end-to-end on the overfit audit
([V11_OVERFIT_AUDIT.md](V11_OVERFIT_AUDIT.md)). Nothing ships until Phase 0
passes.

Context: Arm 1 ([V11_ARM1_RESULTS.md](V11_ARM1_RESULTS.md)) showed v11
(identity-dropout 0.5 in phases A/B, agnostic-finalized) beating the deployed
v10.4/v10.5 family by 16.6% MAE in the production serving mode, better in every
tier. The serving contract is UNCHANGED (agnostic; same 224-dim inputs, same
architecture) — v11 is a drop-in weights swap, which is what makes this plan
mostly mechanical.

## Phase 0 — Overfit audit (BLOCKING GATE)

Three checks, all measured (see V11_OVERFIT_AUDIT.md):
1. **In/out-of-sample split**: v11's relative edge must persist on events after
   the 2026-07-11 training cutoff (07-12..19 + true held-out 07-20+). If the
   edge collapses post-cutoff → memorization → STOP (Arm 2 explores lower
   rates/other mitigations instead).
2. **Training-time val/test** (2023 val season, 2024-finals test — cannot
   contain 2026 memorization): v11 seeds must match-or-beat v10.4 seeds.
3. **Error-distribution sanity**: uniform improvement, not near-zero errors on
   in-sample rows.

Additionally, before the prod flip: **live shadow** (Phase 2) provides rolling
true-held-out evidence as new shows score — the strongest possible check.

## Phase 1 — (Parallel, optional) Arm 2 rate sweep

- Train 0.3 and 0.7 arms on the mini-PC (same one-flag mechanism, ~5 h/arm).
- Judge with tools/backtest-v11.ts (+ the Phase-0 split buckets).
- Promotion does NOT wait for this: 0.5 already clears the bar; a better rate
  found later ships the same drop-in way. The August full-season retrain uses
  the sweep winner.

## Phase 2 — Production promotion (mirrors the v10.5 rollout)

> **STATUS: ROLLED BACK TO final2 — 2026-07-23.** Nine graded shows (07-17..22)
> showed final2 at ~1.07 MAE vs the v10/v11 family at 2.4–3.8 (late-season
> score-inflation regime outside the family's 07-11 training support; see
> MODEL_IMPROVEMENT_PLAN + V12_TRAINING_NOTES). v11 remains shadow-writing;
> the emit env is final2; V12 (August) must beat final2 on a matched
> late-season window to re-take serving. Original flip record follows.
>
> **(superseded) STATUS: FLIPPED — 2026-07-22.** v11 (`clean-v11-fp-shadow`) is live on
> drumcorps.app via the authoritative read-model path. Guard
> (backtestPredictionModes, 2026-07-22 09:46) passed: target/ar MAE 3.65/3.90
> beat persist 7.60. Coverage was complete (25/25 upcoming events with a
> non-empty v10.5 run also had a non-empty v11 run; zero gaps). Serving filter
> `PREDICTION_MODEL=v11` → `model_dir LIKE '%v11-fp-shadow%'` added to
> corps-place (predictions.ts + event-prediction-api.ts, commit c24d1aa);
> emit env + auto-ingest/cron publish-roles swapped (v10.5 now shadow,
> PUBLISH=0; v11 now the published primary). v10.5 keeps writing shadow runs.
> Live-verified via Chromium: Birmingham Blue Stars 83.754 (v11) vs 84.196
> (old v10.5). Container `PREDICTION_MODEL` env in Coolify still `v10.5`
> (user-gated) — the on-demand fallback serves v10.5 until the user flips it;
> the read-model path (authoritative) already serves v11. Rollback: set
> `PREDICTION_MODEL=v10.5` + re-emit; `git revert c24d1aa`.


1. **Stage**: copy the 8 v11 seeds + target-norms into the prod serving checkout
   (cp-v10-serving/sdk/models/v11_identity050_field_pace/).
2. **Guard**: run the standing prod backtest guard (backtestPredictionModes.ts)
   with the v11 pool — required before any prediction-logic change.
3. **Shadow**: extend v10.5-serve.sh (or a v11 variant) to ALSO write v11 runs
   tagged `clean-v11-fieldpace-recal` alongside v10.5 (both models write; only
   the flagged one serves). Recal is model-agnostic and refits per-division on
   the v11 pool automatically. Let the shadow run across several scored shows;
   compare v11 vs v10.5 vs actuals (this doubles as Phase-0's rolling held-out).
4. **Flip**: add the `v11` case to the PREDICTION_MODEL flag in
   corps-place (read-model builder + event-prediction-api + emit env), republish
   the read-model. Rollback = flag revert + republish (no data change) — same
   reversible mechanism as the v10.5 flip. USER-GATED: the nightly-script flag
   change is explicitly a user decision.
5. **Retire**: keep v10.5 writing shadow runs (as final2 was kept), retire
   final2's shadow if desired.

## Phase 3 — SDK / npm ship

The SDK's byte-parity contract means model replacement = asset + fixture re-cut:
1. Replace assets/models/* with the v11 seeds (+ MANIFEST regen via
   tools/gen-model-manifest.ts). Same layout, same loader.
2. **Re-cut parity fixtures** against the NEW prod v11 output (kentucky-style
   feature rows + saved run + offsets) once prod serves v11 — the parity target
   follows production. Until the prod flip, pin fixtures to a local v11 serve.
3. Re-run the measurement suite: tier backtest (TIER_ACCURACY.md), identity
   baselines (IDENTITY_BASELINES.md — expect the knob to matter even less),
   benchmarks. Update MODEL_CARD (lineage: v11 = v10.4 recipe +
   identity-dropout 0.5, agnostic-finalized; new measured figures).
4. Version: bump minor (0.x). CHANGELOG entry: model upgrade, no API change.
5. Gate: full test suite + tarball smoke + (first) `npm publish` — the npm
   publish is still pending from Phase 4.5; v11 can be the launch version.
6. data-2026 companion: unchanged (data, not model).

## Phase 4 — Kaggle + docs refresh

1. Kaggle model: new version (v6) of TfJs/default with the v11 seeds +
   updated version notes; refresh the model-page description figures.
2. GitHub docs: V11_* docs already in-repo; update README headline figures.

## Rollback story (every layer)

- Prod: PREDICTION_MODEL flag revert + read-model republish.
- SDK: previous npm version remains installable; git revert of the asset
  commit restores v10.4 seeds + fixtures.
- Kaggle: prior model version stays listed.

## Open items folded in

- August full-season retrain (finals-week WC under-projection) now trains the
  v11 recipe (or the Arm-2 winner) on full-season data — one campaign, both
  goals.
- The serving `identity` knob stays as-is (default agnostic); re-examine
  identity-full on late-season WC once more post-cutoff events accumulate (the
  held-out event hinted it helps there).
