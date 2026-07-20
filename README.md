# dci-score-predictor

Type-safe DCI drum corps score prediction — the production **v10.5
identity-agnostic ensemble model**, packaged self-contained. No database, no
server, no Python: everything the model needs ships in the npm package, and it
runs anywhere JavaScript runs (Node, Bun, Deno, browsers, edge workers).

It predicts an upcoming show's recap — per-corps caption scores
(`GE1 GE2 VP VA CG MB MA MP`) and total — from the season score history you
supply. Because the model is identity-agnostic (corps identity and judge context
are masked at serving), it needs only score history + schedule; new and unknown
corps are first-class. The SDK is **prod-parity-tested**: it reproduces the
production pipeline's totals byte-for-byte on frozen fixtures.

> Not affiliated with, or endorsed by, Drum Corps International. Trained on
> publicly posted DCI recap scores. See [docs/MODEL_CARD.md](docs/MODEL_CARD.md).

## Install

```sh
npm install dci-score-predictor
```

Peer deps `@tensorflow/tfjs` and `effect` come along. Node ≥ 20.

## Quickstart (simple API)

Loose plain objects in; the SDK smart-matches names, infers divisions, and
reports what it inferred.

```js
import { predict } from 'dci-score-predictor/simple';

const out = await predict({
  history: [
    { show: 'DCI Southwestern', date: '2026-07-18', scores: [
      { corps: 'blue devils', captions: { GE1: 17.5, GE2: 17.3, VP: 17.0, VA: 17.1, CG: 16.9, MB: 18.0, MA: 17.6, MP: 18.1 } },
      { corps: 'bluecoats',   captions: { GE1: 17.1, GE2: 16.9, VP: 16.8, VA: 16.7, CG: 16.5, MB: 17.4, MA: 17.2, MP: 17.5 } },
    ] },
  ],
  target: { show: 'Prelims', date: '2026-08-06', lineup: ['blue devils', 'bluecoats'] },
});

for (const p of out.predictions) console.log(p.rank, p.corps, p.total.toFixed(3));
```

## Typed core API

```js
import { predict, validateInput } from 'dci-score-predictor';

const report = validateInput({ seasonInfo, history, target });   // no model load
if (!report.ok) console.warn(report.droppedRows);

const result = await predict(
  { seasonInfo: { year: 2026, startDate: '2026-06-26', endDate: '2026-08-08' },
    history: shows,               // ShowInput[] with keyed corps + 8 captions
    target },                     // { slug, date, lineup: [{ corpsKey, division }] }
  { members: 8, explain: true, strict: false, recalOffsets: { 'World Class': 0.2 } },
);
```

## Diagnostics (every prediction carries these)

```jsonc
{
  "predictions": [
    { "rank": 1, "corps": "Blue Devils", "division": "World Class",
      "total": 97.312, "GE": 38.9, "Visual": 29.1, "Music": 29.3,
      "captions": { "GE1": 19.5, "GE2": 19.4, "VP": 19.5, "…": 0 },
      "intervals": { "low": { "GE1": -0.3 }, "high": { "GE1": 0.3 } } }
  ],
  "readiness": {
    "corps": [ { "corps": "Blue Devils", "tier": "established", "tierCode": "T0",
                 "priorShows": 9, "sequenceFill": 10,
                 "featureCoverage": { "trajectory": "present", "judge_context": "masked" },
                 "fieldPace": { "corps": 14, "dates": 8, "confidence": 1 } } ],
    "recal": [ { "division": "World Class", "offset": 0.2, "poolN": 12, "thinTaper": 0.6, "active": true } ]
  },
  "inputAudit": { "showsCounted": 31, "corpsCounted": 24, "scoreRowsCounted": 210,
                  "droppedRows": [], "normalizations": [ { "input": "blue devils", "matched": "Blue Devils", "method": "alias", "kind": "corps" } ] },
  "caveats": [ { "severity": "info", "message": "recal pool for Open Class is thin (n=4) — offset damped to 20%." } ],
  "model_metadata": { "model_dir": "clean-v10-fieldpace-recal-sdk", "ensembleSize": 8 }
}
```

Nothing is imputed without appearing in `readiness`; defaults are silent only
when they cost nothing (judge masking).

## Degradation tiers

| tier | code | condition | expected accuracy |
|---|---|---|---|
| `established` | T0 | > 2 prior shows, confident field-pace | parity with production v10.5 |
| `partial` | T1 | ≥ 3 prior shows, thin field-pace | live, lower-confidence |
| `sparse` | T2 | 1–2 prior shows | `sparse` bias bucket, wider error |
| `cold_start` | T3 | 0 prior shows (debut) | curve-anchored, widest error |

Full accuracy figures and limitations: [docs/MODEL_CARD.md](docs/MODEL_CARD.md).

## Agent skills

This package ships two Claude agent skills in `skills/`:
`dci-score-predictor` (SDK-usage reference) and `dci-predict` (run a prediction
from a JSON file). Install into a Claude project:

```sh
npx skills add https://github.com/<org>/dci-score-predictor
```

## Smoke test

The consumer-fidelity smoke test packs the tarball, installs it into a throwaway
project, and exercises the public API (simple + core + `members:1` + CJS):

```sh
bash test/smoke/consumer-smoke.sh
```

## License

MIT © Patrick Glenn 2026. Model weights included under the same license.
