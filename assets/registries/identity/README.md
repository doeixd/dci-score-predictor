# Identity registries (opt-in serving knob)

These maps power the optional `identity` serving knob (`PredictOptions.identity`).
They are the **dev3 v10 artifact maps** — the exact index maps the shipped
`v10.4` ensemble was trained with, so their vocab sizes match the model's
embedding `inputDim` (corps 54, judges 211, shows 290). Do **not** substitute the
`dev1` maps (56/214/301): those index a different run and would push valid indices
past the shipped embeddings' vocab, silently collapsing to the unknown slot.

Production serving is identity-**agnostic** by default (all identity inputs
zeroed / judge-Elo static block 101–112 masked). The knob re-enables the
embeddings/scale that already live in the weights. See docs/IDENTITY_BASELINES.md
for the measured effect and docs/MODEL_CARD.md / docs/API.md for usage.

## Keying

| file | key | value | vocab | fallback |
|------|-----|-------|-------|----------|
| `corpsIndexMap.json` | `corps_key` (registry corps key, e.g. `001j000000f17bwaaa`) | corps embedding index | 54 | `"unknown": 0` |
| `judgeIndexMap.json` | `judge_id` slug (e.g. `a-brown-1`) | judge embedding index | 211 | `"unknown": 0` |
| `showIndexMap.json` | **year-stripped** show slug (e.g. `dci-birmingham`) | agnostic show embedding index | 290 | `"unknown": 0` |
| `corpsAliasMap.json` | alias / variant name form | canonical `corps_key` | 79 | — |

Every map reserves index `0` for the `unknown` (out-of-vocab) slot; any key not
present resolves to `0` (the embedding the model saw for dropped/unseen
identities during training).

## Lookup rules (mirror the training builder)

- **corps**: `corpsIndexMap[corps_key]`, falling back to
  `corpsIndexMap[corpsAliasMap[corps_key]]`, else `0`.
- **show**: strip a leading `^\d{4}-` year prefix from the target slug, then
  `showIndexMap[baseSlug] ?? 0` (`getAgnosticShowId`).
- **judge**: resolve a supplied judge name/id to a canonical `judge_id`
  (`matchJudge`), then `judgeIndexMap[judge_id] ?? 0`. Judge slots are indexed by
  caption order `[GE1, GE2, VP, VA, CG, MB, MA, MP]`.
