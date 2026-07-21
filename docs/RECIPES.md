# Recipes

Task-oriented snippets for the common jobs. Every recipe uses the public API only
(see [API.md](./API.md) for signatures, [TYPES.md](./TYPES.md) for shapes).

- [Pre-flight: validate before predicting](#pre-flight-validate-before-predicting)
- [Recalibrate from your own resolved shows](#recalibrate-from-your-own-resolved-shows)
- [What-if lineups with `Corps.make` / `Corps.Unknown`](#what-if-lineups-with-corpsmake--corpsunknown)
- [The `members: 1` speed tier](#the-members-1-speed-tier)
- [Browser end-to-end](#browser-end-to-end)
- [Custom asset hosting](#custom-asset-hosting)
- [Effect integration](#effect-integration)
- [Reading diagnostics to decide trust](#reading-diagnostics-to-decide-trust)

---

## Pre-flight: validate before predicting

`validateInput` runs the input-consistency checks with **no model load** — cheap,
synchronous, ideal for form validation or an API boundary.

```ts
import { validateInput } from 'dci-score-predictor';

const report = validateInput({ seasonInfo, history, target });
if (!report.ok) {
  // Leakage / out-of-season target already threw DciValidationError above;
  // here we have recoverable row problems:
  for (const d of report.droppedRows) console.warn(`drop ${d.corpsKey}@${d.show}: ${d.reason} ${d.detail ?? ''}`);
}
for (const w of report.warnings) console.log(`[${w.severity}] ${w.message}`);
console.log(`would accept ${report.showsAccepted} shows / ${report.scoreRowsAccepted} rows`);
```

To make row problems hard errors instead, pass `{ strict: true }` — the first bad
row throws `DciValidationError`. (Leakage and out-of-season target dates throw
regardless of `strict`.)

---

## Recalibrate from your own resolved shows

The v10.5 division recal corrects the ensemble's residual bias per division using
**only your resolved (already-scored) shows strictly before the target**. It
roughly halves overall MAE (2.49 → 1.64 in the 2026 backtest) — see
[TIER_ACCURACY.md](./TIER_ACCURACY.md). Two ways to supply it.

### A) Let `predict()` fit it — pass `recalObservations`

Each observation pairs your earlier **predicted** total with the **actual**
scored total for a resolved performance:

```ts
import { predict } from 'dci-score-predictor';

const result = await predict(
  { seasonInfo, history, target,
    recalObservations: [
      { predicted: 95.9, actual: 96.35, division: 'World Class', date: '2026-07-18' },
      { predicted: 88.1, actual: 88.6,  division: 'World Class', date: '2026-07-20' },
      { predicted: 74.2, actual: 74.0,  division: 'Open Class',  date: '2026-07-20' },
      // …ideally ≥ 20 per division within the trailing 14 days for full-strength recal…
    ],
  },
);

for (const r of result.readiness.recal)
  console.log(`${r.division}: offset ${r.offset} (n=${r.poolN}, taper ${r.thinTaper}, active ${r.active})`);
```

The residual is `actual − predicted`; the fit is shrunk (`n/(n+8)`), trimmed,
clamped to `±1.5`, and **thin-pool-tapered** (`× min(1, n/20)`) — with a thin or
empty pool it tapers to `0` and emits an `info` caveat. Only rows strictly before
`target.date` and within `recencyDays` (14) participate.

### B) Precompute the offset yourself — pass `recalOffsets`

If you already have a per-division additive offset, pass it directly (it
**overrides** any `recalObservations`):

```ts
const result = await predict({ seasonInfo, history, target },
  { recalOffsets: { 'World Class': 0.35, 'Open Class': -0.1 } });
```

You can also fit offsets standalone with `fitRecalOffsets` (exported) and inspect
the `RecalFit` before deciding to apply them:

```ts
import { fitRecalOffsets } from 'dci-score-predictor';

const fits = fitRecalOffsets(observations, ['World Class', 'Open Class'], '2026-08-06');
// { 'World Class': { offset, poolN, thinTaper }, 'Open Class': { … } }
```

A natural loop: run `predict()` on your already-scored shows (no recal), collect
`{ predicted: p.total, actual, division, date }` per corps, then feed those as
`recalObservations` for the next target. This is exactly the leakage-safe
self-calibration the shipped tier figures measure.

---

## What-if lineups with `Corps.make` / `Corps.Unknown`

Because the model is identity-agnostic, you can score corps that aren't in the
registry — a hypothetical new corps, or a fully anonymous entry.

```ts
import { predict, Corps } from 'dci-score-predictor';

// A brand-new corps (first-class; unknown:true). Give it a division.
const startup = Corps.make('Phoenix Rising', { division: 'Open Class' });

// A fully anonymous entry — the identity-agnostic sentinel.
const anon = Corps.Unknown;

const result = await predict({
  seasonInfo: { year: 2026, startDate: '2026-06-26', endDate: '2026-08-08' },
  history: [
    { slug: 'week-1', date: '2026-07-04', results: [
      { corpsKey: startup.key, corpsName: startup.name, division: startup.division,
        captions: { GE1: 12, GE2: 12, VP: 11, VA: 11, CG: 11, MB: 12, MA: 12, MP: 12 } },
    ] },
  ],
  target: { slug: 'week-3', date: '2026-07-18', lineup: [
    { corpsKey: startup.key, corpsName: startup.name, division: startup.division },
    { corpsKey: anon.key,    corpsName: anon.name,    division: 'World Class' },   // no history → cold_start
  ] },
});
```

`Phoenix Rising` has one prior show → `sparse` (T2); the anonymous entry has no
history → `cold_start` (T3), and you'll get a `warn` caveat for it. Known corps
autocomplete via `Corps.BlueDevils` etc.; use `Corps.lookup('name')` for a
runtime fuzzy match (throws `CorpsNotFoundError` with `.suggestions` on a miss).

---

## The `members: 1` speed tier

The 8-seed ensemble is ~32 MB and ~2 s to load cold. For interactive/what-if
loops or bandwidth-constrained clients, load fewer seeds:

```ts
const fast = await predict(input, { members: 1 });   // 1 of 8 seeds — fastest/lightest
```

`members: N` loads the first `N` seeds; accuracy degrades gracefully (the p50
mean-pool is over fewer seeds, so intervals widen slightly). `result.model_metadata.ensembleSize`
echoes how many were used. `predict()` caches each distinct `members` value's
ensemble across calls, so repeated same-`members` predictions pay the load cost
once. Use the full 8 for a final/headline number.

---

## Browser end-to-end

The `/browser` entry never imports `node:*`; every asset is fetched from a
`baseUrl` you host. There is **no Node fallback** — `assets` is required.

```ts
// app.ts — bundled with Vite / webpack / esbuild / Rollup, etc.
import { predict, init } from 'dci-score-predictor/browser';

// Optional: preload registries once at startup so the sync matchers/Corps namespace resolve.
await init({ assets: { baseUrl: '/dci-assets/' } });

const result = await predict(input, {
  assets: { baseUrl: '/dci-assets/' },
  members: 4,          // load 4 of 8 seeds — lighter/faster, slightly wider error
  explain: true,
});
```

### Hosting the assets

Pick one for `baseUrl`:

- **CDN (zero setup):**
  `{ baseUrl: 'https://cdn.jsdelivr.net/npm/dci-score-predictor@latest/assets/' }`
  (or unpkg). The browser fetches straight from npm.
- **Self-host:** copy the package's `assets/` dir into your static output (e.g.
  `public/dci-assets/`) and pass `{ baseUrl: '/dci-assets/' }`. Pin the version
  to match your installed package.

### Cache the weights

The ~32 MB of weights are fetched once. Cache them so reloads are instant — an
HTTP `Cache-Control: immutable` on your host, or a service worker:

```js
// sw.js — cache-first for the model weights
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/dci-assets/models/')) {
    e.respondWith(caches.open('dci-v1').then(async (c) =>
      (await c.match(e.request)) ?? fetch(e.request).then((r) => (c.put(e.request, r.clone()), r))));
  }
});
```

`simplePredict(looseInput, { assets })` is also exported for the loose-input API,
as are `loadEnsemble`, `fetchAssets`, and the domain helpers.

---

## Custom asset hosting

Beyond a `baseUrl`, you can supply a full `AssetProvider` — load assets from a
bundler virtual FS, a KV store, IndexedDB, an S3 signer, anything:

```ts
import { predict, type AssetProvider } from 'dci-score-predictor';

const provider: AssetProvider = {
  async readJson(rel)   { return (await myStore.get(rel)).json(); },       // rel e.g. 'registries/corps.json'
  async readBinary(rel) { return (await myStore.get(rel)).arrayBuffer(); },// rel e.g. 'models/<seed>/weights.bin'
  // Optional: only needed if you drop models/MANIFEST.json
  async listModelSeeds() { return myStore.listDirs('models'); },
};

const result = await predict(input, { provider });        // core entry
// or, browser entry: predict(input, { assets: provider })
```

`relPath` is always package-relative to the shipped `assets/` dir. The loader
prefers `models/MANIFEST.json` for seed enumeration and integrity hashes; provide
`listModelSeeds()` only if you omit it.

---

## Effect integration

The `/effect` entry adds Schema validation at the boundary and typed, catchable
errors. Prediction internals are the same core `predict()`.

### Decode untrusted input, then predict, catching by tag

```ts
import { Effect } from 'effect';
import { decodePredictInput, predictEffect } from 'dci-score-predictor/effect';

// `decodePredictInput` validates the shape (0–20 captions, ISO dates, division
// literal, …) and fails with a ValidationError carrying the exact field path.
// The decoded value is deeply readonly, so predict from the original input.
const program = decodePredictInput(untrustedJson).pipe(
  Effect.flatMap(() => predictEffect(untrustedJson as never, { members: 8 })),
  Effect.map((r) => r.predictions),
  Effect.catchTag('ValidationError', (e) => Effect.succeed(`invalid input: ${e.message}`)),
  Effect.catchTag('ModelLoadError', (e) => Effect.succeed(`assets unavailable: ${e.message}`)),
  Effect.catchTag('PredictionError', (e) => Effect.succeed(`inference failed: ${e.message}`)),
);

const out = await Effect.runPromise(program);
```

`predictEffect` maps core failures onto tags: `DciValidationError → ValidationError`,
asset/tfjs failures → `ModelLoadError`, anything else during inference →
`PredictionError`. If you already trust the input shape, skip decoding and call
`predictEffect(input, options)` directly.

---

## Reading diagnostics to decide trust

Every prediction carries the evidence you need to decide how much to trust it.
Nothing is imputed silently except judge masking (which costs no accuracy). A
practical gate:

```ts
const result = await predict(input, { explain: true });

for (const p of result.predictions) {
  const r = result.readiness.corps.find((c) => c.corpsKey === p.corpsKey)!;

  // 1) Tier: T0/T1 are trustworthy; T2 wider; T3 (debut) is the weakest regime.
  const shaky = r.tierCode === 'T3' || r.tierCode === 'T2';

  // 2) Coverage: count defaulted feature groups (judge_context is always 'masked' — ignore it).
  const defaulted = Object.entries(r.featureCoverage)
    .filter(([g, v]) => v === 'defaulted' && g !== 'judge_context').length;

  // 3) Interval width as an uncertainty proxy (p90 − p10 on the total's captions).
  const spread = Object.values(p.intervals)
    .reduce((s, i) => s + (i.high_offset - i.low_offset), 0);

  console.log(`${p.rank}. ${p.corps} ${p.total.toFixed(2)} — ${r.tierCode}`,
    shaky ? '⚠ wide' : 'ok', `(defaulted:${defaulted}, spread:${spread.toFixed(1)})`);
}

// Surface caveats to the user; warns first, then infos.
for (const c of result.caveats.filter((c) => c.severity === 'warn')) console.warn(c.message);
```

- **Tier** (`readiness.corps[].tierCode`) is the headline: `T0`/`T1` land near
  production accuracy; `T3` under-projects by ~5 points (curve-anchored debut).
- **`featureCoverage`** shows which signals were real vs. defaulted. A corps with
  everything `present` (bar the always-masked judge context) is on the strongest
  footing.
- **`recal[].active`** tells you whether the bias correction engaged. If it's
  `false` everywhere and your targets are late-season, consider supplying
  `recalObservations` (see [recal](#recalibrate-from-your-own-resolved-shows)) —
  it's exactly what closes the finals-week under-projection gap.
- **`explain`** (`biasOffset`, `recalOffset`, `baselineRecap`, `trendSlopes`)
  decomposes the total when you need to justify a specific number.

See [TIER_ACCURACY.md](./TIER_ACCURACY.md) for the measured per-tier / per-division
error you're trading against.
