# Feature parity notes

The pure-TS feature builder (`src/features/`) reproduces production's clean-v10
field-pace inference rows byte-for-byte. The parity gate
(`test/feature-parity.test.ts`) compares built rows against the frozen prod
fixture `test/fixtures/kentucky-feature-rows-clean.json` (the A2 single-event
output baked into the serving-contract DB) for event `2026-dci-kentucky`.

Everything matches to 1e-6 **except** two documented, serving-irrelevant skews:

## 1. Judge-Elo static block (indices 101–112) — excluded by design

Production zeroes this block via `maskV9JudgeContext` before the model ever sees
it, so the raw values never reach the ensemble. The builder fills neutral zeros
and the test skips `JUDGE_ELO_START..JUDGE_ELO_END`. (See the `build.ts` header.)

## 2. Inference-target rank baselines (block `rank_baselines`, indices 121–128) — curve-version skew, ±0.001 raw

The inference target has **no** temporal caption feature row (verified: the
contract DB `v10_temporal_caption_features` has no `2026-dci-kentucky` rows), so
its per-caption rank baselines fall back to `getBaseline` → the static
`referenceCurvesV4.json` artifact (prod `REFERENCE_CURVES`). The SDK ships the
byte-identical curve file (same md5 as `cp-branch/sdk/src/training/referenceCurvesV4.json`).

The lookup logic and cell selection are provably correct: within a single curve
cell, most captions match the frozen fixture **exactly**. Example, corps
`001j000000iwxadaa1`, cell `14-90`:

| caption | curve cell (current) | frozen fixture | match |
|---------|----------------------|----------------|-------|
| GE1     | 16.710               | 16.710         | ✓     |
| MA      | 17.075               | 17.075         | ✓     |
| VP      | 16.721               | 16.720         | ✗ (−0.001) |
| VA      | 16.787               | 16.786         | ✗ (−0.001) |

The fixture was frozen (A2 output persisted into the contract DB) when a handful
of curve cells carried one fewer decimal (e.g. `14-90.VP = 16.72`). The current
packaged `referenceCurvesV4.json` — which prod also ships today — refined those
same cells to `16.721`. The residual is exactly ±0.001 in raw score space
(±5e-5 after `normalizeCaptionScore` = /20), it is inconsistent in direction
across cells (pure rounding, not a systematic offset), and it cannot be
reproduced from single-event inputs because the fixture's cell values are baked
into the frozen contract DB, not regenerable without re-running prod's full
pipeline against the archived curve version.

Because this affects **only** cold-start inference-target baselines from the raw
artifact (the sequence baselines use the replayed temporal `reference_baseline`
and match exactly), the parity gate applies a **block-scoped tolerance of 2e-4**
to `rank_baselines` (comfortably above the observed 5e-5 skew, far below any
value that would mask a real logic error — a wrong cell/rank differs by whole
tenths). All other blocks remain at the strict 1e-6 tolerance.
