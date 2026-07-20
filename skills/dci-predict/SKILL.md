---
name: dci-predict
description: >-
  Predict DCI drum corps scores for an upcoming show from a season-data JSON
  file. Use when the user says "predict this show", "run a DCI prediction",
  "score this lineup", or hands over a season-history / season-data file. Runs
  the dci-score-predictor SDK end-to-end and presents a ranked recap table with
  degradation caveats.
argument-hint: [season-data.json]
allowed-tools: Bash(node *)
---

# dci-predict — run a DCI score prediction

A runnable workflow that turns a season-data JSON file into a ranked recap
prediction with honest degradation reporting, using the dci-score-predictor SDK.

Requires the SDK installed in the working project (`npm install
dci-score-predictor`). For writing SDK integration code instead of running a
one-off, see the `dci-score-predictor` skill.

## Steps

1. **Locate the input.** Take the season-data file from `$ARGUMENTS` (or ask
   for one). It is either:
   - **core** shape — `{ seasonInfo, history[], target:{ lineup:[{corpsKey,…}] } }`, or
   - **loose** shape — `{ history:[{show,date,scores}], target:{ lineup:[names] } }`.
   The scripts auto-detect which.

2. **Validate first** (core payloads; cheap, no model load):

   ```
   node skills/dci-score-predictor/scripts/validate-input.mjs <season-data.json>
   ```

   If it reports a `VALIDATION ERROR` (leakage: history not strictly before the
   target date, or an out-of-season target date), fix the data before
   predicting — these are hard errors. Dropped rows are safe to proceed with.

3. **Run the prediction:**

   ```
   node skills/dci-predict/scripts/predict.mjs <season-data.json>
   ```

   Options: `--members N` (fewer ensemble seeds = faster, rougher),
   `--explain` (attach per-corps attribution), `--strict` (row problems throw
   instead of being dropped). First run loads the 8-seed ensemble (~2s).

4. **Present the results.** Relay the ranked recap table, then surface the
   caveats and per-corps tiers. Always call out any corps in `sparse` (T2) or
   `cold_start` (T3) — those numbers carry the widest error. Note the recal
   offset per division. Do not present a number without its tier.

## What the output means

- Ranked `total` (and GE / Visual / Music) per corps, plus a per-corps tier:
  `established` (T0, parity) → `partial` (T1) → `sparse` (T2) → `cold_start`
  (T3, curve-anchored, widest error).
- Caveats are severity-tagged (`info` | `warn`) and explain every default
  applied (thin field-pace pool, inactive recal, dropped rows, …).

Not affiliated with Drum Corps International.
