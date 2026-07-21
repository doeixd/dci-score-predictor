export interface SeasonInfo {
  year: number;
  startDate: string;
  endDate: string;
}

/**
 * The 2026 season-to-date, shaped for `dci-score-predictor` — `shows` matches
 * `SeasonData['shows']` / `PredictInput['history']`. No `target` is included;
 * add your own target event before predicting. `shows` is typed loosely here so
 * this package carries no dependency on the SDK's types; assign it to
 * `PredictInput['history']` at the call site.
 */
export interface Season2026Data {
  seasonInfo: SeasonInfo;
  shows: unknown[];
}

/** Load the bundled 2026 season data. */
export function season2026(): Season2026Data;
