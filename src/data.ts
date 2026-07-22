// `dci-score-predictor/data` — DCI seasons as ready-made `SeasonData`, sourced
// from the vendored `dci-season-data` git submodule (repo doeixd/dci-season-data)
// checked out at `data/`. This wrapper re-exports the submodule's API with types
// built by the package's own tsup pipeline (ESM + CJS + d.ts/d.cts), and reads
// the season JSON from `data/data/*.json` at runtime.
//
// The submodule's own `data/index.js` anchors its reads to `import.meta.url`;
// bundling it through tsup would inline it and break that anchor. Instead this
// wrapper resolves the JSON dir relative to the package ROOT via an fs walk-up —
// the same layout-independent trick src/assets/node-provider.ts uses for
// `assets/` — so it is correct in the src tree, the dist bundle, and an
// installed node_modules tarball alike.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Season metadata bundled with each season. */
export interface SeasonInfo {
  year: number;
  startDate: string;
  endDate: string;
}

/**
 * One DCI season, shaped for `dci-score-predictor` — `shows` matches
 * `SeasonData['shows']` / `PredictInput['history']`. No `target` is included;
 * add your own target event before predicting. `shows` is typed loosely so this
 * wrapper stays decoupled from the SDK's internal types; assign it straight to
 * `PredictInput['history']` at the call site.
 */
export interface SeasonData {
  seasonInfo: SeasonInfo;
  shows: unknown[];
}

/** Seasons bundled in the vendored data submodule (ascending). */
export const SEASONS: number[] = [
  2013, 2014, 2015, 2016, 2017, 2018, 2019, 2022, 2023, 2024, 2025, 2026,
];

// Resolve the package root by walking up from this module until the vendored
// `data/data` season dir is found (layout-independent; a fixed `..` count is
// not — this module lives at src/data.ts in the tree but dist/data.{js,cjs}
// once built). The FIRST ancestor carrying `data/data` is the package's own.
const seasonDir = (): string => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, 'data', 'data');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "dci-score-predictor/data: could not locate the 'data/data' season dir. " +
      'Publishing requires the git submodule to be initialized ' +
      '(`git submodule update --init`).'
  );
};

/** List the seasons this package ships. */
export function seasons(): number[] {
  return [...SEASONS];
}

/**
 * Load one DCI season as `{ seasonInfo, shows }` — resolved shows with captions,
 * subcaptions (where available), judge panels (where available), and performance
 * order. No `target` is included; add your own before predicting. Reads the JSON
 * fresh from disk on every call.
 *
 * @param year A season in {@link SEASONS} (2013–2019, 2022–2026).
 */
export function season(year: number): SeasonData {
  const file = path.join(seasonDir(), `season-${year}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `dci-score-predictor/data: no data for season ${year}. Available: ${SEASONS.join(', ')}`
    );
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as SeasonData;
}

/** Back-compat alias for the former `data-2026` package; same as `season(2026)`. */
export function season2026(): SeasonData {
  return season(2026);
}
