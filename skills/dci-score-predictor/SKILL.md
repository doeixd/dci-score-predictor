---
name: dci-score-predictor
description: >-
  Write correct integration code against the dci-score-predictor SDK — the
  production v10.5 identity-agnostic DCI ensemble model, packaged self-contained
  (no DB, no server, no Python). Use when the task is to predict DCI scores /
  drum corps prediction / score a show from season history, or when the user
  mentions the "dci-score-predictor SDK". Covers the simple API, the typed core
  API, diagnostics fields, and graceful-degradation tiers.
---

# dci-score-predictor SDK

Predicts per-corps DCI recap scores (8 captions + total) for an upcoming show
from prior same-season score history. The model is **identity-agnostic** (corps
identity and judge context are masked at serving), so it needs only the score
history + schedule the user supplies — new/unknown corps are first-class.

## Quickstart (simple API — start here)

Loose plain objects; the SDK smart-matches names, infers divisions, tolerates
missing judges/breakdowns, and reports what it inferred.

```js
import { predict } from 'dci-score-predictor/simple';

const out = await predict({
  history: [
    { show: 'DCI Southwestern Championship', date: '2026-07-18',
      scores: [
        { corps: 'blue devils',
          captions: { GE1: 17.5, GE2: 17.3, VP: 17.0, VA: 17.1,
                      CG: 16.9, MB: 18.0, MA: 17.6, MP: 18.1 } },
      ] },
  ],
  target: { show: 'Prelims', date: '2026-08-06',
            lineup: ['blue devils', 'Bluecoats'] },
});

for (const p of out.predictions)          // ranked by total, desc
  console.log(p.rank, p.corps, p.total.toFixed(3));
console.log(out.caveats);                 // honest degradation notes
console.log(out.inputAudit.normalizations); // {input, matched, method}
```

Caption keys: `GE1 GE2 VP VA CG MB MA MP`. Unknown corps need a `division` hint
(`{ corps, division: 'World Class' }`); World Class / Open Class only.

## Core API (typed, keyed input)

`import { predict, validateInput } from 'dci-score-predictor'` — same result
shape, but you supply canonical `corpsKey`s and an explicit `seasonInfo`.

```js
await predict(
  { seasonInfo: { year, startDate, endDate }, history: shows, target },
  { members: 8, explain: false, strict: false, recalOffsets });
```

`PredictInput`: `{ seasonInfo, history|shows, target, recalObservations? }`.
`PredictOptions`: `members` (1–8 ensemble seeds; fewer = faster/rougher),
`explain` (attach per-corps attribution), `strict` (row problems throw vs drop),
`recalOffsets` (precomputed per-division additive offset). Full surface +
result types: **reference.md**. Worked payloads: **examples.md**.

## Result diagnostics (every prediction carries these)

- `predictions[]` — `{ rank, corps, division, total, GE, Visual, Music,
  captions{8}, intervals }`, ranked by `total` desc.
- `readiness.corps[]` — per-corps `tier` + `tierCode`, `priorShows`,
  `sequenceFill` (of 15), `featureCoverage` (present|defaulted|masked),
  `fieldPace` stats.
- `readiness.recal[]` — per-division `{ offset, poolN, thinTaper, active }`.
- `inputAudit` — `showsCounted`, `corpsCounted`, `scoreRowsCounted`,
  `droppedRows[]` (with reason), `normalizations[]` (simple API).
- `caveats[]` — ordered, `severity: 'info' | 'warn'`, human-readable.
- `explain[]` — only when `explain: true`: baseline recap, trend slopes,
  field-pace, bias offset, recal offset, history bucket.

## Degradation tiers (per corps — always inspect before trusting a number)

| tier | code | condition | meaning |
|---|---|---|---|
| established | T0 | >2 prior shows, confident field-pace | parity with production |
| partial | T1 | ≥3 prior shows, thin field-pace | live but lower-confidence |
| sparse | T2 | 1–2 prior shows | `sparse` bias bucket, wider error |
| cold_start | T3 | 0 prior shows (debut) | curve-anchored, widest error |

Defaults are silent only when free (judge masking); anything that could move a
number emits a caveat. Nothing is imputed without appearing in `readiness`.

## Validate before predicting

Run the bundled script on a payload to catch leakage / out-of-season / caption
mismatches with no model load:

```
node skills/dci-score-predictor/scripts/validate-input.mjs <payload.json>
```

See **reference.md** for the complete API and **examples.md** for full payloads.
Not affiliated with Drum Corps International.
