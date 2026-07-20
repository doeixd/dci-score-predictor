# dci-score-predictor — worked examples

## 1. Simple API: predict from a short history

```js
import { predict } from 'dci-score-predictor/simple';

const out = await predict({
  history: [
    { show: 'DCI Southwestern Championship', date: '2026-07-18', scores: [
      { corps: 'blue devils',   captions: { GE1: 17.5, GE2: 17.3, VP: 17.0, VA: 17.1, CG: 16.9, MB: 18.0, MA: 17.6, MP: 18.1 } },
      { corps: 'bluecoats',     captions: { GE1: 17.1, GE2: 16.9, VP: 16.8, VA: 16.7, CG: 16.5, MB: 17.4, MA: 17.2, MP: 17.5 } },
    ] },
    { show: 'DCI Southeastern',  date: '2026-07-25', scores: [
      { corps: 'blue devils',   captions: { GE1: 18.0, GE2: 17.8, VP: 17.4, VA: 17.5, CG: 17.3, MB: 18.3, MA: 18.0, MP: 18.4 } },
      { corps: 'bluecoats',     captions: { GE1: 17.5, GE2: 17.3, VP: 17.1, VA: 17.0, CG: 16.9, MB: 17.8, MA: 17.6, MP: 17.9 } },
    ] },
  ],
  target: { show: 'World Championship Prelims', date: '2026-08-06',
            lineup: ['blue devils', 'bluecoats'] },
});

out.predictions.forEach(p => console.log(`#${p.rank} ${p.corps}  ${p.total.toFixed(3)}`));
// Inspect degradation: 2 prior shows → 'sparse' tier + caveats.
console.log(out.readiness.corps.map(r => `${r.corps}: ${r.tier}`));
console.log(out.caveats.map(c => `[${c.severity}] ${c.message}`));
```

## 2. Adding an unknown corps (identity-agnostic model)

Corps not in the shipped registry are first-class — supply a `division` hint:

```js
await predict({
  history: [
    { show: 'Debut Regional', date: '2026-07-10', scores: [
      { corps: 'Star of Tomorrow', division: 'World Class',
        captions: { GE1: 15.0, GE2: 14.8, VP: 14.5, VA: 14.6, CG: 14.2, MB: 15.1, MA: 14.9, MP: 15.2 } },
    ] },
  ],
  target: { show: 'Regional B', date: '2026-07-24', lineup: ['Star of Tomorrow'] },
});
// out.inputAudit.normalizations includes { input:'Star of Tomorrow', matched:'Star of Tomorrow', method:'made', kind:'corps' }
```

## 3. Core API: keyed input with explain + precomputed recal

```js
import { predict } from 'dci-score-predictor';

const result = await predict(
  {
    seasonInfo: { year: 2026, startDate: '2026-06-26', endDate: '2026-08-08' },
    history: [
      { slug: 'dci-southwestern', date: '2026-07-18', results: [
        { corpsKey: 'blue-devils', corpsName: 'Blue Devils', division: 'World Class', total: 96.0,
          captions: { GE1: 17.5, GE2: 17.3, VP: 17.0, VA: 17.1, CG: 16.9, MB: 18.0, MA: 17.6, MP: 18.1 } },
      ] },
    ],
    target: { slug: 'wc-prelims', date: '2026-08-06',
      lineup: [{ corpsKey: 'blue-devils', corpsName: 'Blue Devils', division: 'World Class' }] },
  },
  { members: 8, explain: true, strict: false, recalOffsets: { 'World Class': 0.2 } }
);

console.log(result.explain[0]);          // baseline, trend slopes, bias/recal offsets
console.log(result.readiness.recal);     // per-division offset audit
```

## 4. Pre-flight validation only (no model load)

```js
import { validateInput } from 'dci-score-predictor';

const report = validateInput({
  seasonInfo: { year: 2026, startDate: '2026-06-26', endDate: '2026-08-08' },
  history: shows,
  target,
});
if (!report.ok) console.warn('dropped rows:', report.droppedRows);
```

Leakage (history date ≥ target date) and out-of-season target dates throw
`DciValidationError` regardless of `strict`.
