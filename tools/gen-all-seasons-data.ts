// All-seasons data companion generator (maintainers only — needs the DBs).
// Emits data/season-<year>.json for every DCI season the databases cover
// (2013–2019, 2022–2026) as SeasonData-shaped payloads { seasonInfo, shows },
// for the standalone `dci-season-data` package (a git submodule of
// dci-score-predictor). Generalizes tools/gen-season-data.ts (2026-only) to any
// season and joins a corps display name where available. Judges, subcaptions,
// and performance order are included where the prod DB has them and omitted
// gracefully where it does not; per-season coverage is reported at the end.
//
// Sources: performance rows (all seasons) from the serving-contract DB's
// v10_training_performances (preferred); judges, subcaptions, display names, and
// performance order from the prod relational DB.
//
// Run: npx tsx tools/gen-all-seasons-data.ts [out-dir] [prod-db] [contract-db]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTIONS, type Caption } from '../src/model/contract.js';
import type { ShowInput, PerformanceInput } from '../src/features/types.js';

const OUT_DIR = process.argv[2] ?? path.resolve('/home/patrick/dci-season-data/data');
const DB = process.argv[3] ?? process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.argv[4] ?? '/tmp/sdk-assets-contract-0722.db';
const useContract = fs.existsSync(CONTRACT_DB);

const runQ =
  (db: string) =>
  (sql: string): any[] =>
    JSON.parse(
      execFileSync('sqlite3', ['-json', '-readonly', db, sql], {
        encoding: 'utf-8',
        maxBuffer: 512 * 1024 * 1024,
      }) || '[]'
    );
const q = runQ(DB);
const qc = useContract ? runQ(CONTRACT_DB) : q;

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

// Seasons present in the contract DB (v10_training_performances).
const SEASONS: number[] = qc(
  `SELECT DISTINCT season FROM v10_training_performances ORDER BY season`
).map((r) => Number(r.season));

// Corps display-name map (prod DB), keyed by corps_key. Fall back to the key.
const corpsName = new Map<string, string>();
for (const row of q(`SELECT corps_key, name FROM corps WHERE name IS NOT NULL AND name <> ''`)) {
  corpsName.set(String(row.corps_key), String(row.name));
}

type Coverage = {
  year: number;
  shows: number;
  performances: number;
  showsWithJudges: number;
  showsWithSubcaptions: number;
  perfsWithOrder: number;
};
const coverage: Coverage[] = [];

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const year of SEASONS) {
  const seasonBounds = q(`
    SELECT substr(MIN(start_date),1,10) AS start, substr(MAX(start_date),1,10) AS end
    FROM events WHERE substr(start_date,1,4)='${year}'`)[0];

  const perfRows = qc(`
    SELECT competition_slug AS slug, competition_date AS date, percent_through,
           model_corps_key AS corps_key, division_name, total_score,
           GE1, GE2, VP, VA, CG, MB, MA, MP
    FROM v10_training_performances
    WHERE season = ${year}
    ORDER BY competition_date, competition_slug, model_corps_key
  `);

  const judgeRows = q(`
    SELECT ja.competition_slug AS slug, ja.normalized_caption_name AS caption, ja.judge_id
    FROM judge_assignments ja
    JOIN competitions c ON c.slug = ja.competition_slug
    WHERE c.season = '${year}'
      AND ja.normalized_caption_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
      AND ja.judge_id IS NOT NULL AND ja.judge_id <> '' AND ja.judge_id NOT LIKE '%unknown%'
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
    WHERE competition_slug IN (
      SELECT DISTINCT competition_slug FROM clean_reference_curve_entries WHERE season=${year})
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

  const orderRows = q(`
    WITH scored_corps AS (
      SELECT DISTINCT cs.competition_slug, cs.corps_key, cs.division_name, e.slug AS event_slug
      FROM corps_scores cs
      JOIN competitions c ON c.slug = cs.competition_slug
      JOIN events e ON e.slug = c.slug
      WHERE c.season = '${year}'
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
  const orderByShowCorps = new Map<string, PerformanceInput['performanceOrder']>();
  for (const row of orderRows) {
    orderByShowCorps.set(`${row.slug}|${row.corps_key}`, {
      inClass: row.o_in_class ?? undefined,
      inClassCount: row.c_in_class ?? 0,
      overall: row.o_overall ?? undefined,
      overallCount: row.c_overall ?? 0,
    });
  }

  const showMap = new Map<string, ShowInput>();
  let perfsWithOrder = 0;
  for (const row of perfRows) {
    const show = showMap.get(row.slug) ?? {
      slug: String(row.slug),
      date: String(row.date),
      percentThrough: Number(row.percent_through),
      results: [] as PerformanceInput[],
      judges: judgesByShow.get(String(row.slug)),
    };
    const order = orderByShowCorps.get(`${row.slug}|${row.corps_key}`);
    if (order) perfsWithOrder++;
    show.results.push({
      corpsKey: String(row.corps_key),
      corpsName: corpsName.get(String(row.corps_key)) ?? String(row.corps_key),
      division: row.division_name,
      total: Number(row.total_score),
      captions: Object.fromEntries(CAPTIONS.map((c) => [c, Number(row[c])])) as Partial<Record<Caption, number>>,
      subcaptions: subByShowCorps.get(`${row.slug}|${row.corps_key}`),
      performanceOrder: order,
    });
    showMap.set(String(row.slug), show);
  }

  const data = {
    seasonInfo: { year, startDate: seasonBounds.start, endDate: seasonBounds.end },
    shows: [...showMap.values()],
  };

  const outPath = path.join(OUT_DIR, `season-${year}.json`);
  const json = JSON.stringify(data);
  fs.writeFileSync(outPath, json);

  coverage.push({
    year,
    shows: data.shows.length,
    performances: perfRows.length,
    showsWithJudges: data.shows.filter((s) => s.judges && Object.keys(s.judges).length > 0).length,
    showsWithSubcaptions: new Set(
      [...subByShowCorps.keys()].map((k) => k.split('|')[0])
    ).size,
    perfsWithOrder,
  });
  console.log(
    `season-${year}.json: ${data.shows.length} shows, ${perfRows.length} perfs, ${(json.length / 1024).toFixed(0)} KB`
  );
}

console.log('\n=== per-season coverage ===');
console.log(
  'year  shows  perfs  showsWithJudges  showsWithSub  perfsWithOrder'
);
for (const c of coverage) {
  console.log(
    `${c.year}   ${String(c.shows).padStart(4)}  ${String(c.performances).padStart(5)}  ` +
      `${String(c.showsWithJudges).padStart(14)}  ${String(c.showsWithSubcaptions).padStart(12)}  ${String(c.perfsWithOrder).padStart(13)}`
  );
}
fs.writeFileSync(
  path.join(OUT_DIR, '..', 'coverage.json'),
  JSON.stringify(coverage, null, 2)
);
const totalBytes = fs
  .readdirSync(OUT_DIR)
  .filter((f) => f.endsWith('.json'))
  .reduce((n, f) => n + fs.statSync(path.join(OUT_DIR, f)).size, 0);
console.log(`\ntotal data/: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
