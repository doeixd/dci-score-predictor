# V11 Recent-Regime Showdown — all families on the true held-out window

**Generated:** 2026-07-22 · **Tool:** `tools/backtest-recent.ts` · **Data:** `tools/backtest-recent.out.json`

Head-to-head of every model family on the World/Open events that resolved in
**the past few days** — dates **2026-07-17 → 2026-07-21** (all events with scores
in the window; nothing on 07-22 has resolved yet). Both v10.4 and every v11 arm
were trained on data **≤ 2026-07-11**, so this window is **entirely
post-training-cutoff** — a genuinely held-out, out-of-sample comparison rather
than a backtest over data any model has seen.

## Setup

- **Families (8 seeds each, ensemble-averaged, serving mode `agnostic` = prod default, no recal):**
  - `v104` — shipped-family baseline (`v10_4_field_pace`, off-tree; assets swapped it out on `v11-model`)
  - `v11-030` — v11 identity-dropout 0.3
  - `v11-050` — v11 identity-dropout 0.5 (arm-1 promotion candidate)
  - `v11-070` — v11 identity-dropout 0.7
- **`deployed`** — an as-deployed **v10.5** reference: for each window event, the totals
  production **actually served beforehand** (latest `model_event_prediction_runs` row with
  `model_dir LIKE '%fieldpace-recal%'` and `predicted_at` **before** the event date, from
  `payload_json.predictions`), joined to actuals. This is real recal'd output, not a re-run —
  it answers "what did users see", not "what would this family produce". Coverage is thin (below).
- **Inputs:** full-fidelity, leakage-safe per event — real judge panels, subcaptions
  (Content/Achievement), performance order; SeasonData built only from shows strictly
  **before** each target's date. Same construction as `tools/backtest-v11.ts`.
- **2026 rows:** fresh serving-contract DB `/tmp/sdk-assets-contract-0722.db`, regenerated with
  a `--development-cutoff` of **2026-07-22T23:59:59.999Z** (the old contract DB only reached
  ~07-20). The SDK's packaged `featureContext` (seasons ≤2025) is unchanged; only the 2026
  `SeasonData` input uses the fresh rows.

**Window events (6):** dci-houston (10 corps), dci-southwestern-championship (22),
the-buccaneer-classic (2, Open only), dci-dallas (10), dci-mckinney (6), dci-st-louis (7).
57 corps-predictions evaluated per family (47 World Class, 10 Open Class).

## Aggregate — MAE / bias (points), 57 predictions

| Family | overall n | **MAE** | bias | World MAE | World bias | Open MAE | Open bias |
|---|---:|---:|---:|---:|---:|---:|---:|
| v104 (v10.4 baseline) | 57 | 2.874 | −2.567 | 3.225 | −3.221 | 1.221 | +0.505 |
| v11-030 (identity-0.3) | 57 | 2.564 | −2.208 | 2.829 | −2.824 | 1.319 | +0.687 |
| **v11-050 (identity-0.5)** | 57 | **2.413** | **−2.025** | **2.649** | −2.639 | 1.305 | +0.861 |
| v11-070 (identity-0.7) | 57 | 2.808 | −2.503 | 3.133 | −3.133 | 1.281 | +0.460 |
| deployed v10.5 (recal, served) | 7¹ | 3.473 | −3.449 | 4.493 | −4.493 | 0.923 | −0.841 |

¹ `deployed` covers **only dci-st-louis** — see coverage note.

**Ordering by overall MAE:** v11-050 (2.413) < v11-030 (2.564) < v11-070 (2.808) < v104 (2.874).
v11-0.5 beats the v10.4 baseline by **−0.461 MAE (−16%)** and every other v11 arm.

## Per-event MAE (winner = `*`)

| Event (date) | v104 | v11-030 | v11-050 | v11-070 | deployed |
|---|---:|---:|---:|---:|---:|
| dci-houston (07-17) | 2.027 | 1.757 | **1.538** | 2.089 | — |
| dci-southwestern-championship (07-18) | 2.719 | 2.469 | **2.217** | 2.619 | — |
| the-buccaneer-classic (07-18) | 0.807 | 0.736 | **0.569** | 0.742 | — |
| dci-dallas (07-19) | 3.128 | **2.796** | 2.839 | 3.143 | — |
| dci-mckinney (07-20) | 3.760 | 3.313 | **3.280** | 3.753 | — |
| dci-st-louis (07-21) | 4.039 | 3.566 | **3.456** | 3.735 | 3.473 |

**Event wins:** v11-050 = **5 / 6**, v11-030 = 1 (dallas, by 0.043 over 0.5), v104 = 0, v11-070 = 0.
v11-0.5 is first or a statistical tie on every single event; v10.4 is last or near-last on all six.

### As-deployed coverage

The `fieldpace-recal` model only began persisting event runs on **2026-07-20**, so five of the
six window events (houston, southwestern, buccaneer, dallas, mckinney) had **no prior run** and
are uncovered. Only **dci-st-louis** has a pre-event run (2026-07-20T12:11, 7 corps matched).
On that one event the served v10.5 total (MAE 3.473) landed between v11-0.5 (3.456) and
v11-0.7 (3.735) — i.e. v11-0.5 would have edged what prod actually served.

## Verdict

**v11 identity-dropout 0.5 wins the recent regime, and 0.5 remains the correct promotion pick.**

- Lowest overall MAE (2.413), lowest-magnitude bias (−2.025), and the winner or a tie on 5 of 6
  events — the cleanest sweep of any family. This *independently confirms the arm-1 selection* on
  data no model has seen.
- The dropout sweep is **non-monotone with a peak at 0.5**: both neighbours are worse
  (0.3 → 2.564, 0.7 → 2.808). More identity-agnosticism (0.7) does **not** help in the held-out
  regime; it regresses nearly to the v10.4 baseline. 0.3 is a respectable second.
- Every v11 arm beats the shipped v10.4 baseline on overall MAE; the gain is concentrated in
  **World Class** (2.649 vs 3.225, −0.58), which is exactly where identity leakage would most
  distort a familiar-corps-heavy field. Open Class is a near-tie across all families (all ~1.2–1.3
  MAE, only 10 predictions).

## Surprises / anomalies

- **Large systematic under-prediction (negative bias) across all families** (−2.0 to −2.6 pts
  overall; World Class −2.6 to −3.2). Late-July scores ran *above* what every cutoff-≤07-11 model
  expected — the usual late-season score inflation, amplified because the models are frozen a
  fortnight back. v11-0.5 has the **smallest** under-shoot, but no family is unbiased; a light
  positive recal offset would help all of them here. This is a calibration gap, not a ranking one.
- **The as-deployed v10.5 reference is the worst line in the table** (overall MAE 3.473, World 4.493)
  — but on a single event (st-louis) with a heavy negative bias (−4.49 World), so it is not
  comparable to the 57-prediction family rows. Its only honest use is the st-louis head-to-head
  above, where v11-0.5 still wins narrowly. Do not read the aggregate `deployed` row as a family score.
- **Bias flips sign by division:** every family *over*-predicts Open Class (+0.5 to +0.9) while
  heavily *under*-predicting World Class. The two divisions want opposite recal nudges.

---

*Report only — this document does not modify the promotion plan. The coordinator decides next steps.
Regenerate with `npx tsx tools/backtest-recent.ts` (verify pass: `RECENT_VERIFY=1 …`).*
