// Test-fixture generator (maintainers only): exports the 2026 season-to-date as
// a SeasonData payload — exactly what an SDK consumer would supply — plus the
// target event lineup, from the private prod DB. Used by the feature parity
// suite against prod-built feature rows.
// Run: npx tsx tools/gen-season-fixture.ts <target-slug> [db-path]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTIONS, type Caption } from '../src/model/contract.js';
import type { SeasonData, ShowInput, PerformanceInput } from '../src/features/types.js';

const targetSlug = process.argv[2] ?? '2026-dci-kentucky';
const DB = process.argv[3] ?? process.env.DCI_DB ?? 'dci-relational.db';
const q = (sql: string): any[] =>
  JSON.parse(
    execFileSync('sqlite3', ['-json', '-readonly', DB, sql], {
      encoding: 'utf-8',
      maxBuffer: 512 * 1024 * 1024,
    }) || '[]'
  );

// Subcaption normalization — mirror of the prod builder's variant lists.
const CONTENT_VARIANTS = [
  'content', 'repertoire', 'composition', 'rep', 'comp', 'design',
  'repertoire/composition', 'design development', 'composition development',
  'repertoire effect', 'design effect',
];
const ACHIEVEMENT_VARIANTS = [
  'achievement', 'performance', 'execution', 'perf', 'excellence',
  'clarity & excellence', 'performer excellence', 'performance/showmanship',
  'performer effect', 'accuracy', 'technique', 'intonation', 'tone', 'expression',
];
const CAPTION_MAP: Record<string, Caption> = {
  'General Effect 1': 'GE1', 'General Effect 2': 'GE2',
  'Visual Proficiency': 'VP', 'Visual - Proficiency': 'VP',
  'Visual Analysis': 'VA', 'Visual - Analysis': 'VA',
  'Color Guard': 'CG',
  'Music - Brass': 'MB', 'Music Brass': 'MB', Brass: 'MB',
  'Music - Analysis': 'MA', 'Music Analysis': 'MA',
  'Music - Percussion': 'MP', 'Music Percussion': 'MP', Percussion: 'MP',
};
const subCategory = (name: string): 'Content' | 'Achievement' | 'Other' => {
  const n = name.toLowerCase().trim();
  if (CONTENT_VARIANTS.some((v) => n.includes(v))) return 'Content';
  if (ACHIEVEMENT_VARIANTS.some((v) => n.includes(v))) return 'Achievement';
  return 'Other';
};

const targetRow = q(`SELECT substr(start_date,1,10) AS date FROM events WHERE slug='${targetSlug}'`)[0];
if (!targetRow) throw new Error(`unknown event ${targetSlug}`);
const targetDate: string = targetRow.date;
const seasonBounds = q(`
  SELECT substr(MIN(start_date),1,10) AS start, substr(MAX(start_date),1,10) AS end
  FROM events WHERE substr(start_date,1,4)='2026'`)[0];

// 2026 rows from the serving-contract DB (the exact production row set).
const CONTRACT_DB = process.argv[4] ?? '/tmp/sdk-assets-contract.db';
const qc = (sql: string): any[] =>
  JSON.parse(
    execFileSync('sqlite3', ['-json', '-readonly', CONTRACT_DB, sql], {
      encoding: 'utf-8',
      maxBuffer: 512 * 1024 * 1024,
    }) || '[]'
  );
const perfRows = qc(`
  SELECT competition_slug AS slug, competition_date AS date, percent_through,
         model_corps_key AS corps_key, model_corps_key AS corps_name, division_name, total_score,
         GE1, GE2, VP, VA, CG, MB, MA, MP
  FROM v10_training_performances
  WHERE season = 2026 AND competition_date < '${targetDate}'
  ORDER BY competition_date, competition_slug, model_corps_key
`);

const judgeRows = q(`
  SELECT competition_slug AS slug, normalized_caption_name AS caption, judge_id
  FROM judge_assignments
  WHERE normalized_caption_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
    AND judge_id IS NOT NULL AND judge_id <> '' AND judge_id NOT LIKE '%unknown%'
`);
const judgesByShow = new Map<string, Partial<Record<Caption, string[]>>>();
for (const row of judgeRows) {
  const byCaption = judgesByShow.get(row.slug) ?? {};
  ((byCaption[row.caption as Caption] ??= []) as string[]).push(String(row.judge_id));
  judgesByShow.set(row.slug, byCaption);
}

const subRows = q(`
  SELECT competition_slug AS slug, corps_key, caption_name, subcaption_name, score
  FROM subcaption_scores
  WHERE competition_slug IN (SELECT DISTINCT competition_slug FROM clean_reference_curve_entries WHERE season=2026)
`);
const subByShowCorps = new Map<string, Partial<Record<Caption, { content: number; achievement: number }>>>();
for (const row of subRows) {
  const caption = CAPTION_MAP[String(row.caption_name)];
  if (!caption) continue;
  const category = subCategory(String(row.subcaption_name));
  if (category === 'Other') continue;
  const key = `${row.slug}|${row.corps_key}`;
  const byCaption = subByShowCorps.get(key) ?? {};
  const entry = (byCaption[caption] ??= { content: 0, achievement: 0 });
  if (category === 'Content') entry.content += Number(row.score);
  else entry.achievement += Number(row.score);
  subByShowCorps.set(key, byCaption);
}

// Performance order — the exact prod queryPerformanceOrder SQL (incl. its
// COALESCE quirk where the raw performance_order takes precedence over the
// computed in-class ROW_NUMBER, so "orders" can exceed the class count).
const orderRows = q(`
  WITH scored_corps AS (
    SELECT DISTINCT cs.competition_slug, cs.corps_key, cs.division_name, e.slug AS event_slug
    FROM corps_scores cs
    JOIN competitions c ON c.slug = cs.competition_slug
    JOIN events e ON e.slug = c.slug
    WHERE c.season = '2026'
  ),
  lineup_order AS (
    SELECT sc.competition_slug, sc.corps_key, ele.performance_order,
      ROW_NUMBER() OVER (PARTITION BY sc.event_slug ORDER BY ele.performance_order NULLS LAST, ele.entry_id) AS order_overall,
      ROW_NUMBER() OVER (PARTITION BY sc.event_slug, sc.division_name ORDER BY ele.performance_order NULLS LAST, ele.entry_id) AS order_in_class,
      COUNT(*) OVER (PARTITION BY sc.event_slug, sc.division_name) AS count_in_class,
      COUNT(*) OVER (PARTITION BY sc.event_slug) AS count_overall
    FROM scored_corps sc
    LEFT JOIN event_lineup_entries ele ON ele.event_slug = sc.event_slug
      AND LOWER(REPLACE(REPLACE(ele.unit_name,' ',''),'-','')) =
          LOWER(REPLACE(REPLACE((SELECT name FROM corps WHERE corps_key = sc.corps_key LIMIT 1),' ',''),'-',''))
  ),
  participant_order AS (
    SELECT sc.competition_slug, sc.corps_key, ep.performance_order,
      ROW_NUMBER() OVER (PARTITION BY sc.event_slug ORDER BY ep.performance_order NULLS LAST, ep.participant_id) AS order_overall,
      ROW_NUMBER() OVER (PARTITION BY sc.event_slug, sc.division_name ORDER BY ep.performance_order NULLS LAST, ep.participant_id) AS order_in_class,
      COUNT(*) OVER (PARTITION BY sc.event_slug, sc.division_name) AS count_in_class,
      COUNT(*) OVER (PARTITION BY sc.event_slug) AS count_overall
    FROM scored_corps sc
    LEFT JOIN event_participants ep ON ep.event_slug = sc.event_slug AND ep.corps_key = sc.corps_key
  )
  SELECT sc.competition_slug AS slug, sc.corps_key,
    COALESCE(lo.performance_order, po.performance_order, lo.order_overall, po.order_overall) AS o_overall,
    COALESCE(lo.performance_order, po.performance_order, lo.order_in_class, po.order_in_class) AS o_in_class,
    COALESCE(lo.count_in_class, po.count_in_class) AS c_in_class,
    COALESCE(lo.count_overall, po.count_overall) AS c_overall
  FROM scored_corps sc
  LEFT JOIN lineup_order lo ON lo.competition_slug = sc.competition_slug AND lo.corps_key = sc.corps_key
  LEFT JOIN participant_order po ON po.competition_slug = sc.competition_slug AND po.corps_key = sc.corps_key
`);
const orderByShowCorps = new Map<string, { inClass?: number; inClassCount?: number; overall?: number; overallCount?: number }>();
for (const row of orderRows) {
  orderByShowCorps.set(`${row.slug}|${row.corps_key}`, {
    inClass: row.o_in_class ?? undefined,
    inClassCount: row.c_in_class ?? 0,
    overall: row.o_overall ?? undefined,
    overallCount: row.c_overall ?? 0,
  });
}

const showMap = new Map<string, ShowInput>();
for (const row of perfRows) {
  const show = showMap.get(row.slug) ?? {
    slug: String(row.slug),
    date: String(row.date),
    percentThrough: Number(row.percent_through),
    results: [] as PerformanceInput[],
    judges: judgesByShow.get(String(row.slug)),
  };
  show.results.push({
    corpsKey: String(row.corps_key),
    corpsName: String(row.corps_name),
    division: row.division_name,
    total: Number(row.total_score),
    captions: Object.fromEntries(CAPTIONS.map((c) => [c, Number(row[c])])),
    subcaptions: subByShowCorps.get(`${row.slug}|${row.corps_key}`),
    performanceOrder: orderByShowCorps.get(`${row.slug}|${row.corps_key}`),
  });
  showMap.set(String(row.slug), show);
}

const lineupRows = q(`
  SELECT DISTINCT cel.corps_key, cel.division_name,
         (SELECT cs.corps_name FROM corps_scores cs WHERE cs.corps_key = cel.corps_key LIMIT 1) AS corps_name
  FROM classified_event_lineup cel
  WHERE cel.event_slug = '${targetSlug}' AND cel.effective_is_non_performance = 0
    AND cel.corps_key IS NOT NULL AND cel.corps_key <> ''
    AND cel.division_name IN ('World Class','Open Class')
  ORDER BY cel.division_name, cel.corps_key
`);
const targetPct = q(`
  SELECT 100.0 * (julianday(e.start_date) - (SELECT MIN(julianday(start_date)) FROM events WHERE substr(start_date,1,4)='2026'))
       / MAX(1.0, (SELECT MAX(julianday(start_date)) - MIN(julianday(start_date)) FROM events WHERE substr(start_date,1,4)='2026')) AS pct
  FROM events e WHERE e.slug='${targetSlug}'`)[0];

const data: SeasonData = {
  seasonInfo: { year: 2026, startDate: seasonBounds.start, endDate: seasonBounds.end },
  shows: [...showMap.values()],
  target: {
    slug: targetSlug,
    date: targetDate,
    percentThrough: Number(targetPct.pct),
    lineup: lineupRows.map((row) => ({
      corpsKey: String(row.corps_key),
      corpsName: row.corps_name ? String(row.corps_name) : undefined,
      division: row.division_name,
    })),
  },
};

const outPath = path.resolve(import.meta.dirname, '..', 'test', 'fixtures', `season-2026-${targetSlug}.json`);
fs.writeFileSync(outPath, JSON.stringify(data));
console.log(
  `${outPath}: ${data.shows.length} shows, ${perfRows.length} performances, target lineup ${data.target.lineup.length}`
);
