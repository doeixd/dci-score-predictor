// dci-score-predictor-data-2026 — the 2026 DCI season-to-date as SeasonData.
import { readFileSync } from 'node:fs';

/**
 * The full 2026 season-to-date: `{ seasonInfo, shows }` (resolved shows with
 * captions, subcaptions, judge panels, and performance order). No `target` —
 * add your own before predicting. Shaped for `dci-score-predictor`'s
 * `PredictInput.history` / `SeasonData.shows`.
 *
 * @returns {{ seasonInfo: { year: number, startDate: string, endDate: string }, shows: unknown[] }}
 */
export function season2026() {
  const url = new URL('./data/season-2026.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf-8'));
}
