# dci-score-predictor

Type-safe DCI drum corps score prediction — the **v11
identity-agnostic ensemble model** (v10.4 recipe + identity-dropout-0.5
auxiliary training, −16.6% backtest MAE vs the previously shipped v10.5
family), packaged self-contained. No database, no
server, no Python: everything the model needs ships in the npm package, and it
runs anywhere JavaScript runs (Node, Bun, Deno, browsers, edge workers).

It predicts an upcoming show's recap — per-corps caption scores
(`GE1 GE2 VP VA CG MB MA MP`) and total — from the season score history you
supply. Because the model is identity-agnostic (corps identity and judge context
are masked at serving), it needs only score history + schedule; new and unknown
corps are first-class. The SDK is **prod-parity-tested**: it reproduces the
serving pipeline's totals byte-for-byte on frozen fixtures.

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

## Quickstart with real data (no typing)

Complete DCI seasons (**2013–2019, 2022–2026**) ship with the SDK as ready-made
`SeasonData` — import them from the `dci-score-predictor/data` subpath, set a
target, and go (no second install):

```js
import { season } from 'dci-score-predictor/data';
import { predict } from 'dci-score-predictor';

const { seasonInfo, shows } = season(2026); // or any bundled season
const result = await predict({ seasonInfo, history: shows,
  target: { slug: 'dci-prelims', date: '2026-08-06',
            lineup: [{ corpsKey: 'blue-devils', division: 'World Class' }] } });
```

`season(year)` (plus `seasons()` and a `season2026()` alias) works in ESM and
`require()`. The seasons come from the [`dci-season-data`](https://github.com/doeixd/dci-season-data)
package, vendored here as the `data/` **git submodule** and re-exported through
this subpath. Data-only users (no model) can instead
`npm install dci-season-data` and `import { season } from 'dci-season-data'`.
If you clone this repo and want the data checked out, use `--recursive` (or run
`git submodule update --init` after cloning):

```sh
git clone --recursive https://github.com/doeixd/dci-score-predictor
```

### Batch & what-if

```js
import { predictMany, whatIf } from 'dci-score-predictor';

const base = { seasonInfo, history: shows, target };
// One ensemble load + one temporal replay shared across the batch:
const [asIs, withBluecoats] = await predictMany([
  base,
  whatIf(base, { addCorps: [{ corpsKey: 'bluecoats', division: 'World Class' }] }),
]);
```

### CLI

```bash
npx dci-predict season-2026.json --members 8   # ranked recap table + tiers + caveats
npx dci-predict season-2026.json --json        # raw PredictedShowResult
```

## Typed core API

```js
import { predict, validateInput, Corps } from 'dci-score-predictor';

// The typed DCI.Corps namespace: autocompleted known corps, plus lookup/make/Unknown.
const bd = Corps.BlueDevils;                          // frozen { key, name, division }
const startup = Corps.make('Phoenix Rising', { division: 'Open Class' });  // new/unknown corps

const report = validateInput({ seasonInfo, history, target });   // no model load
if (!report.ok) console.warn(report.droppedRows);

const result = await predict(
  { seasonInfo: { year: 2026, startDate: '2026-06-26', endDate: '2026-08-08' },
    history: shows,               // ShowInput[] with keyed corps + 8 captions
    target: {                     // { slug, date, lineup: [{ corpsKey, division }] }
      slug: 'prelims', date: '2026-08-06',
      lineup: [
        { corpsKey: bd.key, corpsName: bd.name, division: bd.division },
        { corpsKey: startup.key, corpsName: startup.name, division: startup.division },
      ],
    } },
  { members: 8, explain: true, strict: false, recalOffsets: { 'World Class': 0.2 } },
);
```

## Browser usage

The core entries import `node:fs`/`node:path` to read the packaged assets. For
browsers (and other fetch-only runtimes) use the dedicated **`./browser`** entry,
which loads every asset — registries, curves, calibration, and the tfjs model
weights — over `fetch` from a `baseUrl` you host. There is no silent Node
fallback: an `assets` option is required.

```js
import { predict } from 'dci-score-predictor/browser';

const result = await predict(input, {
  // Point at a static copy of the package's assets/ dir, or a CDN:
  assets: { baseUrl: 'https://cdn.jsdelivr.net/npm/dci-score-predictor@latest/assets/' },
  members: 4,        // load 4 of 8 seeds — lighter/faster, slightly wider error
});
```

Host options for `baseUrl`:

- **CDN** — `https://cdn.jsdelivr.net/npm/dci-score-predictor@latest/assets/`
  (or unpkg). Zero setup; the browser fetches assets straight from npm.
- **Self-host** — copy this package's `assets/` dir into your app's static dir
  (e.g. served at `/assets/`) and pass `{ baseUrl: '/assets/' }`.

Also exported from `./browser`: `init({ assets })` (preload registries + activate
the provider once, so the synchronous `matchCorps`/`matchCaption`/`makeCorps`
helpers work), `simplePredict` (loose-input API), `loadEnsemble`, `fetchAssets`,
and the domain helpers.

> **Download size.** The full 8-seed ensemble is ~32 MB of weights. It is fetched
> once (cache it with a service worker / HTTP caching). Pass `members: N` to load
> fewer seeds when bandwidth or memory matters — accuracy degrades gracefully.

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
| `established` | T0 | > 2 prior shows, confident field-pace | tightest well-populated tier (backtest MAE 1.97 / 1.00 with recal) |
| `partial` | T1 | ≥ 3 prior shows, thin field-pace | live, lower-confidence |
| `sparse` | T2 | 1–2 prior shows | `sparse` bias bucket, wider error |
| `cold_start` | T3 | 0 prior shows (debut) | curve-anchored, widest error |

Full accuracy figures and limitations: [docs/MODEL_CARD.md](docs/MODEL_CARD.md).

## Documentation

Full docs live in [`docs/`](docs/):

- [**API.md**](docs/API.md) — complete public API reference for all four entries
  (core, `/simple`, `/effect`, `/browser`): signatures, real TS types,
  param/field tables, runnable examples, and error behavior.
- [**TYPES.md**](docs/TYPES.md) — guided type tour: annotated input graph, a
  real `PredictedShowResult` sample, and every readiness tier, caveat, audit, and
  domain type the SDK can emit.
- [**RECIPES.md**](docs/RECIPES.md) — task recipes: recal from your own resolved
  shows, what-if lineups with `Corps.make`/`Unknown`, the `members:1` speed tier,
  browser end-to-end, Effect integration, and reading diagnostics to decide trust.
- [**ARCHITECTURE.md**](docs/ARCHITECTURE.md) — the prediction pipeline, layer
  map, shipped assets, and the parity-test story.
- [**MODEL_CARD.md**](docs/MODEL_CARD.md) — model lineage, input contract,
  training data/provenance, accuracy, and limitations.
- [**TIER_ACCURACY.md**](docs/TIER_ACCURACY.md) — measured 2026 per-tier and
  per-division accuracy with methodology.

## Agent skills

This package ships two Claude agent skills in `skills/`:
`dci-score-predictor` (SDK-usage reference) and `dci-predict` (run a prediction
from a JSON file). Install into a Claude project:

```sh
npx skills add https://github.com/doeixd/dci-score-predictor
```

## Smoke test

The consumer-fidelity smoke test packs the tarball, installs it into a throwaway
project, and exercises the public API (simple + core + `members:1` + CJS):

```sh
bash test/smoke/consumer-smoke.sh
```

## License

MIT © Patrick Glenn 2026. Model weights included under the same license.
