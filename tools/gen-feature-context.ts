// Build-time generator (maintainers only — needs the private prod DB).
// Replays every prior season through the SDK's own TemporalState machine and
// freezes the state into assets/registries/featureContext.json. Because the
// SAME machine runs at runtime seeded with this context, the 2026 replay is
// byte-identical to production's full-history replay.
// Run: npx tsx tools/gen-feature-context.ts [db-path]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TemporalState, type TemporalPerformance } from '../src/features/temporal.js';
import { CAPTIONS, type Caption } from '../src/model/contract.js';
import type { CorpsHistoricalFallback } from '../src/features/types.js';

const DB = process.argv[2] ?? process.env.DCI_DB ?? 'dci-relational.db';
const SEASONS = [2013, 2014, 2015, 2016, 2017, 2018, 2019, 2022, 2023, 2024, 2025];
const outPath = path.resolve(import.meta.dirname, '..', 'assets', 'registries', 'featureContext.json');

const q = (sql: string): any[] =>
  JSON.parse(
    execFileSync('sqlite3', ['-json', '-readonly', DB, sql], {
      encoding: 'utf-8',
      maxBuffer: 512 * 1024 * 1024,
    }) || '[]'
  );

// Source: a serving-contract DB built by prod's own prepareV10TrainingData
// --serving (the EXACT row set production features are computed from).
const rows = q(`
  SELECT season, competition_slug AS slug, competition_date AS date,
         division_name AS division, model_corps_key AS corps_key, computed_rank, rank_bucket,
         percent_through, percent_bucket, total_score,
         GE1, GE2, VP, VA, CG, MB, MA, MP
  FROM v10_training_performances
  WHERE season IN (${SEASONS.join(',')})
  ORDER BY competition_date, competition_slug, division_name, computed_rank, model_corps_key
`);
console.log(`replaying ${rows.length} performances across ${SEASONS.length} seasons`);

const performances: TemporalPerformance[] = rows.map((r) => ({
  season: Number(r.season),
  slug: String(r.slug),
  date: String(r.date),
  division: String(r.division),
  corpsKey: String(r.corps_key),
  computedRank: Number(r.computed_rank),
  rankBucket: Number(r.rank_bucket),
  percentThrough: Number(r.percent_through),
  percentBucket: Number(r.percent_bucket),
  total: Number(r.total_score),
  captions: Object.fromEntries(CAPTIONS.map((c: Caption) => [c, Number(r[c])])) as Record<
    Caption,
    number
  >,
}));

const state = new TemporalState();
state.replay(performances);
const context = state.freeze(2025);

// corps_historical_features_v6 fallback (diagnostics; lives in the prod DB, not
// the serving-contract DB).
const PROD_DB = process.argv[3] ?? process.env.DCI_DB ?? 'dci-relational.db';
const qProd = (sql: string): any[] =>
  JSON.parse(
    execFileSync('sqlite3', ['-json', '-readonly', PROD_DB, sql], {
      encoding: 'utf-8',
      maxBuffer: 512 * 1024 * 1024,
    }) || '[]'
  );
let historical: any[] = [];
try { historical = qProd('SELECT * FROM corps_historical_features_v6'); } catch { console.warn('no corps_historical_features_v6 — fallback empty'); }
const corpsHistorical: Record<string, CorpsHistoricalFallback> = {};
for (const h of historical) {
  corpsHistorical[String(h.corps_key)] = {
    years_in_world_class: Number(h.years_in_world_class ?? 0),
    historical_mean_rank: Number(h.historical_mean_rank ?? 15),
    historical_std_rank: Number(h.historical_std_rank ?? 0),
    historical_best_rank: Number(h.historical_best_rank ?? 15),
    best_rank_recency: Number(h.best_rank_recency ?? 10),
    made_finals_rate: Number(h.made_finals_rate ?? 0),
    first_season: Number(h.first_season ?? 0),
  };
}
context.corpsHistorical = corpsHistorical;

// Prev-season (2025) best totals per division — mirrors prod
// queryPreviousSeasonFinalRankings: MAX(total_score) per corps from
// corps_competition_results, division-filtered, sorted best_total DESC. Feeds
// static index 173/174 (last-season final score/rank) and the prev-season rank
// fallback for corps with no same-season temporal history.
const PREV_DIVISIONS = ['World Class', 'Open Class'];
const prevSeasonBestTotals: Record<string, Array<{ corpsKey: string; bestTotal: number }>> = {};
for (const division of PREV_DIVISIONS) {
  const prevRows = qProd(
    `SELECT corps_key, MAX(total_score) AS best_total
     FROM corps_competition_results
     WHERE season = '2025' AND division_name = '${division.replace(/'/g, "''")}'
     GROUP BY corps_key
     ORDER BY best_total DESC`
  );
  prevSeasonBestTotals[division] = prevRows.map((r) => ({
    corpsKey: String(r.corps_key),
    bestTotal: Number(r.best_total),
  }));
}
context.prevSeasonBestTotals = prevSeasonBestTotals;

fs.writeFileSync(outPath, JSON.stringify(context));
const sizeMb = (fs.statSync(outPath).size / 1e6).toFixed(1);
console.log(
  `featureContext.json written (${sizeMb} MB): ${Object.keys(context.curve).length} curve cells, ` +
    `${Object.keys(context.priorFinals).length} corps-division finals, ` +
    `${Object.keys(context.fingerprints).length} fingerprint keys, ` +
    `${Object.keys(corpsHistorical).length} historical fallbacks`
);
