# Types — a guided tour

A narrative walk through the type system: what you feed in (`SeasonData` /
`PredictInput`), what you get back (`PredictedShowResult`, shown as a **real**
sample), and every readiness tier, caveat, audit, and domain type the code can
emit. For terse signatures see [API.md](./API.md); for measured accuracy see
[MODEL_CARD.md](./MODEL_CARD.md) and [TIER_ACCURACY.md](./TIER_ACCURACY.md).

- [The input graph](#the-input-graph)
- [A real `PredictedShowResult`](#a-real-predictedshowresult)
- [Readiness tiers](#readiness-tiers)
- [Every caveat the code can emit](#every-caveat-the-code-can-emit)
- [inputAudit fields](#inputaudit-fields)
- [explain fields](#explain-fields)
- [featureCoverage groups](#featurecoverage-groups)
- [Panel ⇄ score-sheet caveats](#panel--scoresheet-caveats)
- [Domain types](#domain-types)

---

## The input graph

The core `predict()` takes a `PredictInput`, which is a `SeasonData`-shaped
object: season metadata, the resolved shows so far (`history`), and the `target`
event to predict. Annotated:

```ts
const input: PredictInput = {
  // Season window — drives `percentThrough` (how far into the season each show is).
  seasonInfo: {
    year: 2026,
    startDate: '2026-06-26',   // first event; ISO YYYY-MM-DD
    endDate:   '2026-08-08',   // last event
  },

  // Resolved (already-scored) shows, each STRICTLY BEFORE target.date.
  // (`shows` is an accepted alias if you pass a whole SeasonData object.)
  history: [
    {
      slug: 'dci-southwestern',
      date: '2026-07-18',
      // percentThrough?: 78,           // optional; derived from seasonInfo when omitted
      results: [
        {
          corpsKey: 'blue-devils',       // your stable key; identity is masked at serving
          corpsName: 'Blue Devils',      // optional label echoed back in output
          division: 'World Class',       // 'World Class' | 'Open Class' (All Age is rejected)
          // All 8 captions on the 0–20 scale; a row missing any is dropped for that show.
          captions: { GE1: 19.5, GE2: 19.4, VP: 19.3, VA: 19.2, CG: 19.1, MB: 19.6, MA: 19.4, MP: 19.7 },
          total: 96.35,                  // optional; cross-checked (±0.05) & derived when absent
          // Optional richer signals — surfaced in readiness.featureCoverage:
          subcaptions: { GE1: { content: 9.7, achievement: 9.8 } /* … */ },
          performanceOrder: { inClass: 2, inClassCount: 12, overall: 4, overallCount: 40 },
        },
        // …one entry per corps that scored at this show…
      ],
      // Optional judge panel (caption → judge ids). Cross-checked, never blocking:
      judges: { GE1: ['a-anderson'], MB: ['j-smith'] },
    },
    // …one entry per resolved show, in any order…
  ],

  // The show to predict. `lineup` is the set of corps to score.
  target: {
    slug: 'dci-prelims',
    date: '2026-08-06',                  // MUST be strictly after every history date
    lineup: [
      { corpsKey: 'blue-devils', corpsName: 'Blue Devils', division: 'World Class' },
      // …
    ],
    // judges?: { … },                    // optional target panel (masked at serving)
  },

  // Optional: fit the per-division recal offset from your own resolved shows.
  recalObservations: [
    { predicted: 95.9, actual: 96.35, division: 'World Class', date: '2026-07-18' },
  ],
};
```

Key invariants (enforced by validation — see
[API.md error behavior](./API.md#error-behavior)):

- `target.date` **strictly after** every `history[].date` — else `DciValidationError` (leakage).
- `target.date` within `seasonInfo.startDate..endDate` — else `DciValidationError`.
- A usable scored row needs **all 8** captions in `[0, 20]`; incomplete/out-of-range
  rows are dropped (or throw under `strict: true`).

---

## A real `PredictedShowResult`

Below is **real, unedited** output (trimmed to the first entry of each array),
produced by running the core `predict()` on the shipped fixture
`test/fixtures/season-2026-2026-dci-kentucky.json` with `{ explain: true,
members: 1 }`. Reproduce it with the script in the [ARCHITECTURE.md
appendix](./ARCHITECTURE.md#reproducing-the-typesmd-sample).

> Top line: **rank 1 — Phantom Regiment — total 86.745** (World Class), on the
> 7-corps DCI Kentucky 2026-08-03 target lineup.

```jsonc
{
  "predictions": [
    {
      "corps": "Phantom Regiment",
      "corpsKey": "001j000000h3xrnaav",
      "division": "World Class",
      "rank": 1,
      "total": 86.745,
      "GE": 34.713, "Visual": 25.436, "Music": 26.596,
      "captions": {
        "GE1": 17.244, "GE2": 17.47, "VP": 16.812, "VA": 17.243,
        "CG": 16.816, "MB": 17.617, "MA": 17.311, "MP": 18.265
      },
      // p10/p90 offsets RELATIVE TO the p50 caption score (low is −, high is +):
      "intervals": {
        "GE1": { "low_offset": -1.522, "high_offset": 1.099 },
        "GE2": { "low_offset": -1.254, "high_offset": 1.329 },
        "VP":  { "low_offset": -1.445, "high_offset": 1.097 },
        "VA":  { "low_offset": -1.557, "high_offset": 1.009 },
        "CG":  { "low_offset": -1.77,  "high_offset": 1.037 },
        "MB":  { "low_offset": -1.51,  "high_offset": 1.112 },
        "MA":  { "low_offset": -1.567, "high_offset": 0.85 },
        "MP":  { "low_offset": -1.657, "high_offset": 0.981 }
      }
    },
    { "corps": "The Cavaliers", "corpsKey": "001j000000iwxafaa1", "division": "World Class",
      "rank": 2, "total": 85.487, "GE": 34.13, "Visual": 25.285, "Music": 26.072,
      "captions": "…", "intervals": "…" }
    // …5 more, ranked by total desc…
  ],

  "readiness": {
    "corps": [
      {
        "corpsKey": "001j000000h3xrnaav",
        "corps": "Phantom Regiment",
        "division": "World Class",
        "tier": "established", "tierCode": "T0",
        "priorShows": 9,           // scored shows for this corps → drives the tier
        "sequenceFill": 9,         // non-pad sequence steps used
        "featureCoverage": {
          "trajectory": "present",
          "prior_seasons": "defaulted",
          "subcaptions": "present",
          "performance_order": "defaulted",
          "judge_context": "masked",     // always masked (identity-agnostic; no accuracy cost)
          "field_pace": "present"
        },
        "fieldPace": { "observations": 153, "corps": 19, "dates": 17, "confidence": 1 }
      }
      // …6 more corps…
    ],
    "recal": [
      { "division": "Open Class",  "offset": 0, "poolN": 0, "thinTaper": 0, "active": false },
      { "division": "World Class", "offset": 0, "poolN": 0, "thinTaper": 0, "active": false }
    ]
  },

  "inputAudit": {
    "showsCounted": 31, "corpsCounted": 33, "scoreRowsCounted": 212,
    "droppedRows": [],
    "normalizations": [],       // populated only by the /simple API
    "showsWithPanels": 0, "targetHasPanel": false
  },

  "caveats": [
    { "severity": "info", "message": "recal inactive for Open Class: no resolved observations supplied — offset defaults to 0." },
    { "severity": "info", "message": "recal inactive for World Class: no resolved observations supplied — offset defaults to 0." }
  ],

  "model_metadata": {
    "model_dir": "clean-v10-fieldpace-recal-sdk",
    "ensembleSize": 1,          // = members (this run used members:1; default is 8)
    "generated_at": "2026-07-21T11:38:57.952Z"
  },

  "explain": [                  // present only because we passed { explain: true }
    {
      "corpsKey": "001j000000h3xrnaav",
      "baselineRecap": [17.1, 17.7, 17.3, 17.3, 17.1, 18, 17.475, 17.95],  // per-caption anchor
      "trendSlopes":   [-1, 4.5, 3.5, 1.5, 0, 5, 2.375, 4.25],             // per-caption recent slope
      "fieldPace": { "observations": 153, "corps": 19, "dates": 17, "confidence": 1 },
      "biasOffset": 0, "recalOffset": 0,
      "historyBucket": "established"
    }
    // …6 more…
  ]
}
```

Notes on this real run:
- `recal` is **inactive** for both divisions because no `recalObservations` were
  supplied — hence the two `info` caveats. Supply resolved shows to activate it
  (see [RECIPES.md](./RECIPES.md#recalibrate-from-your-own-resolved-shows)).
- `biasOffset`/`recalOffset` are `0` here: the shipped bias table had no matching
  `${division}|${bucket}` entry for this run and recal was inactive.
- Every corps in this fixture had ≥ 3 prior shows with confident field-pace, so
  all landed in **T0** (`established`) — no tier caveats fired.

---

## Readiness tiers

Each corps is bucketed by its true same-season history depth. The tier is
reported per corps in `readiness.corps[].tier` / `.tierCode`, and drives both the
bias-calibration bucket and the caveats.

| tier | code | condition | measured MAE (recal) |
|---|---|---|---|
| `established` | `T0` | `priorShows > 2` **and** field-pace `confidence >= 1` | 1.27 |
| `partial` | `T1` | `priorShows > 2` **and** field-pace `confidence < 1` | 0.74 (thin n=13) |
| `sparse` | `T2` | `priorShows` is 1 or 2 | 1.27 |
| `cold_start` | `T3` | `priorShows === 0` (debut) | 4.89 (widest) |

The exact tiering logic (from `src/predict.ts`):

```ts
if (priorShows === 0) return { tier: 'cold_start', code: 'T3' };
if (priorShows <= 2)  return { tier: 'sparse',     code: 'T2' };
return fieldPace.confidence >= 1
  ? { tier: 'established', code: 'T0' }
  : { tier: 'partial',     code: 'T1' };
```

MAE figures are the **measured** 2026 backtest (197 corps observations,
recal column) from [TIER_ACCURACY.md](./TIER_ACCURACY.md). The serving-time
history bucket keying bias calibration mirrors this: `debut` (0 steps),
`sparse` (≤2), `established` (>2) — surfaced as `explain[].historyBucket`.

---

## Every caveat the code can emit

`caveats: Caveat[]` where `Caveat = { severity: 'info' | 'warn'; message: string;
corpsKey?: string }`. Exhaustive list of the messages `predict()` can produce
(from `src/predict.ts`), in emission order:

**Judge panel ⇄ score-sheet (from `validatePanel`, non-blocking):**

| severity | message template | when |
|---|---|---|
| `warn` | `<show>: judge panel has caption key(s) not among the 8 (<keys>) — ignored.` | panel uses a key outside the 8 captions |
| `info` | `<show>: N scored caption(s) without a declared judge (<caps>) — panel unknown, judge context is masked anyway.` | a caption was scored but no judge assigned |
| `info` | `<show>: judge assigned for caption(s) not present in scores (<caps>).` | a judge was assigned for an unscored caption |
| `info` | `target <slug>: judge panel lists caption(s) with no judge (<caps>).` | target panel lists well-formed captions with empty assignment |

**Dropped rows (aggregated per reason):**

| severity | message template | reasons |
|---|---|---|
| `warn` | `N score row(s) dropped: caption total mismatch` | `caption_total_mismatch` |
| `warn` | `N score row(s) dropped: caption out of range` | `caption_out_of_range` |
| `warn` | `N score row(s) dropped: duplicate corps show` | `duplicate_corps_show` |
| `warn` | `N score row(s) dropped: out of season date` | `out_of_season_date` |
| `info` | `N score row(s) dropped: missing captions` | `missing_captions` (info, not warn) |

**Per-corps readiness:**

| severity | message template | when |
|---|---|---|
| `warn` | `<corps>: no prior shows supplied — 'debut' calibration bucket, curve-anchored (widest error).` | tier `cold_start` (T3) |
| `warn` | `<corps>: only N prior show(s) — 'sparse' calibration bucket, expect wider error.` | tier `sparse` (T2) |
| `info` | `<corps>: thin field-pace pool (C corps / D dates, confidence X.XX) — trajectory shrunk toward historical.` | field-pace confidence in `(0, 1)` |

**Division recal:**

| severity | message template | when |
|---|---|---|
| `info` | `recal inactive for <division>: no resolved observations supplied — offset defaults to 0.` | no observations for that division |
| `info` | `recal pool for <division> is thin (n=N) — offset damped to P%.` | active but pool below `minPoolN` (tapered) |

> **Read caveats before trusting a number.** Nothing is imputed without appearing
> in `readiness` or `caveats`; the only silent default is judge masking (which
> costs no accuracy). See [RECIPES.md](./RECIPES.md#reading-diagnostics-to-decide-trust).

---

## inputAudit fields

```ts
interface InputAudit {
  showsCounted: number;       // clean shows kept after validation
  corpsCounted: number;       // distinct corps across kept rows
  scoreRowsCounted: number;   // kept score rows
  droppedRows: DroppedRow[];  // every dropped row with reason + detail
  normalizations: NameNormalization[];   // simple API only — see below
  showsWithPanels: number;    // history shows that supplied a judge panel
  targetHasPanel: boolean;    // whether the target supplied a judge panel
}
```

- `normalizations` is **empty for the core API** and populated by the `/simple`
  API to report every name it smart-matched:
  `{ input, matched, method: 'exact'|'alias'|'fuzzy'|'made', kind: 'corps'|'judge'|'caption' }`.
  `method: 'made'` means an unknown corps was added via a division hint.
- `showsWithPanels` / `targetHasPanel` are the NEW panel-tracking fields — see
  [panel caveats](#panel--scoresheet-caveats).

`DroppedRow.reason` is one of: `caption_total_mismatch`, `caption_out_of_range`,
`duplicate_corps_show`, `out_of_season_date`, `missing_captions`.

---

## explain fields

Present only when `options.explain` is `true`. One entry per predicted corps,
each an interpretable additive attribution (cheap by-products of serving):

```ts
interface CorpsExplain {
  corpsKey: string;
  baselineRecap: number[];   // per-caption anchor: last-observed recap, or curve-anchor fallback for a debut
  trendSlopes: number[];     // per-caption slope over the last ≤3 observed recaps
  fieldPace: { observations: number; corps: number; dates: number; confidence: number };
  biasOffset: number;        // additive `${division}|${bucket}` bias applied to the total
  recalOffset: number;       // additive per-division recal applied to the total
  historyBucket: 'debut' | 'sparse' | 'established';
}
```

`total = rawTotal + biasOffset + recalOffset`, then caption scores are rescaled
proportionally so their derived total matches. So `explain` lets you decompose
exactly why a total landed where it did.

---

## featureCoverage groups

`readiness.corps[].featureCoverage` maps each feature group to
`'present' | 'defaulted' | 'masked'`:

| group | `defaulted` when |
|---|---|
| `trajectory` | season debut (no same-season trajectory) or the block was defaulted |
| `prior_seasons` | no known prior-season finals for this corps |
| `subcaptions` | no subcaption sheet coverage in the history |
| `performance_order` | performance order not supplied (`'defaulted'` else `'present'`) |
| `judge_context` | **always `'masked'`** — zeroed at serving (identity-agnostic, no accuracy cost) |
| `field_pace` | field-pace confidence is `0` |

`'present'` means the real signal was used; `'defaulted'` means the
production-trained neutral imputation was used (and should be read as a coverage
gap, not an error).

---

## Panel ⇄ score-sheet caveats

Supplying a judge panel (`ShowInput.judges` / `TargetEventInput.judges`) is
optional. When you do, `predict()` cross-checks it against the scored captions
(§3.2) and records `inputAudit.showsWithPanels` / `targetHasPanel`. Important
caveats:

- The check is **never blocking** — mismatches surface as `info`/`warn` caveats,
  never drops. Production tolerates unknown panels.
- **Judge context is masked (zeroed) at serving regardless**, so a panel —
  matched, mismatched, or absent — does **not** change the prediction. It exists
  purely for input hygiene / auditing.
- Caption keys outside the 8 canonical keys are `warn`-ed and ignored; scored
  captions without a declared judge (and vice-versa) are `info`-ed.

So `targetHasPanel: false` in the real sample above simply means the fixture's
target carried no `judges` — expected, and immaterial to the scores.

---

## Domain types

### Captions

```ts
interface CaptionDef {
  key: Caption;                                  // 'GE1'|'GE2'|'VP'|'VA'|'CG'|'MB'|'MA'|'MP'
  label: string;
  category: 'GE' | 'Visual' | 'Music';
  breakdown: readonly ['Content', 'Achievement'];
}
```

| key | label | category | breakdown |
|---|---|---|---|
| `GE1` | General Effect 1 | GE | Content, Achievement |
| `GE2` | General Effect 2 | GE | Content, Achievement |
| `VP` | Visual Proficiency | Visual | Content, Achievement |
| `VA` | Visual Analysis | Visual | Content, Achievement |
| `CG` | Color Guard | Visual | Content, Achievement |
| `MB` | Music Brass | Music | Content, Achievement |
| `MA` | Music Analysis | Music | Content, Achievement |
| `MP` | Music Percussion | Music | Content, Achievement |

`matchCaption` normalizes labels/aliases to keys: `"Music Analysis"` → `MA`,
`"Visual - Analysis"` → `VA`, `"guard"` / `"colorguard"` → `CG`,
`"brass"` → `MB`, `"percussion"` → `MP`. The scoring identity is
`total = GE1 + GE2 + (VP+VA+CG)/2 + (MB+MA+MP)/2` (`captionDerivedTotal`).

### Division

```ts
const Division = { WorldClass: 'World Class', OpenClass: 'Open Class', AllAge: 'All Age' } as const;
type DivisionName = 'World Class' | 'Open Class' | 'All Age';
```

The model **covers World Class and Open Class only**. `All Age` exists as a
registry/type value, but supplying it (or A-Class / SoundSport) to predict raises
`DciValidationError`.

### Corps matching semantics

```ts
interface Corps { key: string; name: string; division: Division; unknown?: boolean }

type CorpsMatch =
  | { corps: Corps; method: 'exact' | 'alias' }
  | { corps: null; method: 'none'; suggestions: string[] };
```

- `matchCorps(name)` normalizes (lowercase, strip punctuation, collapse
  whitespace) and consults the alias table; on collision it prefers the
  most-recently-active corps. On a miss it returns up to 5 `suggestions` (registry
  names sharing a token).
- `makeCorps(name, { division, key? })` builds a first-class **unknown** corps
  (`unknown: true`, default `key: 'custom:<normalized-name>'`). Because the model
  is identity-agnostic, an unknown corps predicts exactly like a known one.

### The typed `Corps` namespace

```ts
import { Corps, type KnownCorpsName, CorpsNotFoundError } from 'dci-score-predictor';

Corps.BlueDevils            // frozen { key, name:'Blue Devils', division:'World Class' } — autocompleted
Corps.Unknown               // { key:'unknown', name:'Unknown', division:'World Class', unknown:true }
Corps.lookup('bluecoats')   // runtime fuzzy/alias match → Corps; throws CorpsNotFoundError on miss
Corps.named('Blue Devils')  // (name: KnownCorpsName) => Corps — compile-time-checked name
Corps.make('New Corps', { division: 'Open Class' })  // first-class new corps
```

- `Corps.<PascalName>` — generated from the shipped registry snapshot, frozen,
  fully autocompleted (e.g. `Corps.CarolinaCrown`, `Corps.SantaClaraVanguard`).
- `Corps.named(name)` — only a `KnownCorpsName` (a template-literal union of every
  registry name **and alias**) typechecks; same runtime as `lookup`.
- `CorpsNotFoundError` carries `.suggestions: string[]` and a message nudging you
  to pass a `{ division }` hint to add a new corps.

`import { Corps }` brings in **both** the namespace value and the `Corps`
instance type under one name.

### Judge

```ts
interface Judge { id: string; initials: string | null; captions: string[] }
```

`matchJudge(input)` resolves registry ids, `"first last"` ↔ `"last first"`, and
initial forms. Judge identity is masked at serving, so this is for input
labeling/auditing only.
