# dci-score-predictor-data-2026

The 2026 DCI season-to-date as ready-made `SeasonData` (31 shows / 212
performances, with captions, subcaptions, judge panels, and performance order)
for [`dci-score-predictor`](https://www.npmjs.com/package/dci-score-predictor) —
so you never have to type a score sheet. No `target` is bundled: you supply the
event you want to predict.

## Quickstart (3 lines)

```js
import { season2026 } from 'dci-score-predictor-data-2026';
import { predict } from 'dci-score-predictor';

const { seasonInfo, shows } = season2026();
const result = await predict({
  seasonInfo,
  history: shows,
  target: { slug: 'dci-prelims', date: '2026-08-06',
            lineup: [{ corpsKey: 'blue-devils', division: 'World Class' }] },
});
```

`season2026()` returns `{ seasonInfo, shows }`. Set any `target.date` after the
history you want to include (the SDK's leakage guard keeps only shows strictly
before it). MIT-licensed; scores originate from publicly posted DCI recaps. Not
affiliated with Drum Corps International.
