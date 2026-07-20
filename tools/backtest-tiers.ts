// Backtest harness (maintainers only): measures the SDK's own per-readiness-tier
// accuracy over resolved 2026 shows. For each RESOLVED event in the window it
// rebuilds the SeasonData input from ONLY the shows strictly before that event
// (no leakage — the same construction gen-season-fixture.ts uses, generalized by
// target slug), runs the public predict(), and compares predicted totals to the
// actual scored totals. Aggregates MAE + mean bias per readiness tier (T0..T3),
// per division, and overall, with n counts so thin cells are visible.
//
// Two passes:
//   1. no-recal (recalObservations omitted) — the honest zero-config baseline.
//   2. WITH recal — recalObservations = the SDK's OWN pass-1 predictions on
//      resolved shows within a 14-day trailing window before each target
//      (leakage-safe: only shows strictly before the target feed the pool).
//
// Run: npx tsx tools/backtest-tiers.ts
//   env DCI_DB      = prod relational DB (default /root/corps-place/sdk/dci-relational.db)
//   env CONTRACT_DB = serving-contract DB (default /tmp/sdk-assets-contract.db)
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTIONS, type Caption } from '../src/model/contract.js';
import { predict } from '../src/predict.js';
import type {
  SeasonData,
  ShowInput,
  PerformanceInput,
  DivisionName,
} from '../src/features/types.js';
import type { RecalObservation } from '../src/recal/recal.js';

const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract.db';
const WINDOW_START = process.env.BT_START ?? '2026-07-01';
const WINDOW_END = process.env.BT_END ?? '2026-07-19';
const RECAL_TRAILING_DAYS = 14;

const q = (db: string, sql: string): any[] =>
  JSON.parse(
    execFileSync('sqlite3', ['-json', '-readonly', db, sql], {
      encoding: 'utf-8',
      maxBuffer: 512 * 1024 * 1024,
    }) || '[]'
  );

// ── Subcaption normalization (mirror of gen-season-fixture.ts) ──
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

const seasonBounds = q(DB, `
  SELECT substr(MIN(start_date),1,10) AS start, substr(MAX(start_date),1,10) AS end
  FROM events WHERE substr(start_date,1,4)='2026'`)[0];

// All 2026 performances (the exact serving-contract row set) — pulled once.
const perfRows = q(CONTRACT_DB, `
  SELECT competition_slug AS slug, substr(competition_date,1,10) AS date, percent_through,
         model_corps_key AS corps_key, division_name, total_score,
         GE1, GE2, VP, VA, CG, MB, MA, MP
  FROM v10_training_performances
  WHERE season = 2026
  ORDER BY date, competition_slug, model_corps_key
`);

// Judge panels (all 2026; per-show, caption→judge ids).
const judgeRows = q(DB, `
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

const subRows = q(DB, `
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

// Performance order (exact prod queryPerformanceOrder SQL, all 2026) — from gen-season-fixture.
const orderRows = q(DB, `
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
const orderByShowCorps = new Map<string, PerformanceInput['performanceOrder']>();
for (const row of orderRows) {
  orderByShowCorps.set(`${row.slug}|${row.corps_key}`, {
    inClass: row.o_in_class ?? undefined,
    inClassCount: row.c_in_class ?? 0,
    overall: row.o_overall ?? undefined,
    overallCount: row.c_overall ?? 0,
  });
}

// ── Build a per-corps PerformanceInput row from a contract perf row. ──
const toPerf = (row: any): PerformanceInput => ({
  corpsKey: String(row.corps_key),
  corpsName: String(row.corps_key),
  division: row.division_name as DivisionName,
  total: Number(row.total_score),
  captions: Object.fromEntries(CAPTIONS.map((c) => [c, Number(row[c])])) as Partial<Record<Caption, number>>,
  subcaptions: subByShowCorps.get(`${row.slug}|${row.corps_key}`),
  performanceOrder: orderByShowCorps.get(`${row.slug}|${row.corps_key}`),
});

// Group all perf rows by slug (each a candidate target) and by date for history.
const bySlug = new Map<string, any[]>();
const slugDate = new Map<string, string>();
const slugPct = new Map<string, number>();
for (const row of perfRows) {
  (bySlug.get(row.slug) ?? bySlug.set(row.slug, []).get(row.slug)!).push(row);
  slugDate.set(row.slug, String(row.date));
  slugPct.set(row.slug, Number(row.percent_through));
}

const DIVISIONS: DivisionName[] = ['World Class', 'Open Class'];
// Target events = resolved shows in the window with World/Open corps, sorted by date.
const targets = [...bySlug.keys()]
  .filter((slug) => {
    const d = slugDate.get(slug)!;
    if (d < WINDOW_START || d > WINDOW_END) return false;
    return bySlug.get(slug)!.some((r) => DIVISIONS.includes(r.division_name));
  })
  .sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : 1));

// Build the SeasonData for a target slug from ONLY shows strictly before its date.
const buildSeasonData = (targetSlug: string): SeasonData => {
  const targetDate = slugDate.get(targetSlug)!;
  const showMap = new Map<string, ShowInput>();
  for (const row of perfRows) {
    if (String(row.date) >= targetDate) continue; // strict no-leakage
    const show = showMap.get(row.slug) ?? {
      slug: String(row.slug),
      date: String(row.date),
      percentThrough: Number(row.percent_through),
      results: [] as PerformanceInput[],
      judges: judgesByShow.get(String(row.slug)),
    };
    show.results.push(toPerf(row));
    showMap.set(String(row.slug), show);
  }
  const lineup = bySlug
    .get(targetSlug)!
    .filter((r) => DIVISIONS.includes(r.division_name))
    .map((r) => ({
      corpsKey: String(r.corps_key),
      corpsName: String(r.corps_key),
      division: r.division_name as DivisionName,
    }));
  return {
    seasonInfo: { year: 2026, startDate: seasonBounds.start, endDate: seasonBounds.end },
    shows: [...showMap.values()],
    target: {
      slug: targetSlug,
      date: targetDate,
      percentThrough: slugPct.get(targetSlug),
      lineup,
      judges: judgesByShow.get(targetSlug),
    },
  };
};

// Actual totals per (slug, corpsKey).
const actualFor = (slug: string, corpsKey: string): number | undefined => {
  const row = bySlug.get(slug)!.find((r) => String(r.corps_key) === corpsKey);
  return row ? Number(row.total_score) : undefined;
};

// ── Accumulators ──
interface Cell { n: number; absSum: number; sum: number; }
const mkCell = (): Cell => ({ n: 0, absSum: 0, sum: 0 });
const add = (c: Cell, err: number) => { c.n++; c.absSum += Math.abs(err); c.sum += err; };
const mae = (c: Cell) => (c.n ? c.absSum / c.n : NaN);
const bias = (c: Cell) => (c.n ? c.sum / c.n : NaN);

interface PassResult {
  byTier: Map<string, Cell>;
  byDivision: Map<string, Cell>;
  overall: Cell;
}
const mkPass = (): PassResult => ({ byTier: new Map(), byDivision: new Map(), overall: mkCell() });
const cell = (m: Map<string, Cell>, k: string) => m.get(k) ?? m.set(k, mkCell()).get(k)!;

// Each per-corps observation gathered on pass 1 (predicted, actual, division, date)
// becomes recal fuel for pass 2.
const pass1Observations: RecalObservation[] = [];

async function runEvent(
  slug: string,
  pass: PassResult,
  recalObs?: RecalObservation[]
): Promise<{ evaluated: number; collect: RecalObservation[] }> {
  const data = buildSeasonData(slug);
  const result = await predict(
    { seasonInfo: data.seasonInfo, shows: data.shows, target: data.target, recalObservations: recalObs },
    { members: 8 }
  );
  const tierByKey = new Map(result.readiness.corps.map((c) => [c.corpsKey, c.tierCode]));
  const collect: RecalObservation[] = [];
  let evaluated = 0;
  for (const p of result.predictions) {
    const actual = actualFor(slug, p.corpsKey);
    if (actual == null) continue;
    const err = p.total - actual;
    const tier = tierByKey.get(p.corpsKey) ?? 'T3';
    add(cell(pass.byTier, tier), err);
    add(cell(pass.byDivision, p.division), err);
    add(pass.overall, err);
    collect.push({ predicted: p.total, actual, division: p.division, date: slugDate.get(slug)! });
    evaluated++;
  }
  return { evaluated, collect };
}

async function main() {
  const noRecal = mkPass();
  const withRecal = mkPass();
  const skips: Array<{ slug: string; error: string }> = [];
  let eventsEvaluated = 0;
  let corpsEvaluated = 0;

  console.log(`Backtest window ${WINDOW_START}..${WINDOW_END}: ${targets.length} candidate events\n`);

  // Pass 1: no recal. Collect observations for pass 2's trailing pool.
  for (const slug of targets) {
    try {
      const { evaluated, collect } = await runEvent(slug, noRecal);
      pass1Observations.push(...collect);
      eventsEvaluated++;
      corpsEvaluated += evaluated;
      console.log(`  [no-recal] ${slug} (${slugDate.get(slug)}): ${evaluated} corps`);
    } catch (e) {
      skips.push({ slug, error: e instanceof Error ? e.message : String(e) });
      console.log(`  [SKIP] ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Pass 2: WITH recal, pool = SDK's own pass-1 predictions on shows strictly
  // before the target within RECAL_TRAILING_DAYS.
  for (const slug of targets) {
    const targetDate = slugDate.get(slug)!;
    const cutoff = new Date(new Date(targetDate).getTime() - RECAL_TRAILING_DAYS * 86400_000)
      .toISOString()
      .slice(0, 10);
    const pool = pass1Observations.filter((o) => o.date < targetDate && o.date >= cutoff);
    try {
      await runEvent(slug, withRecal, pool);
    } catch (e) {
      // already reported in pass 1
    }
  }

  // ── Report ──
  const fmt = (c: Cell) =>
    `${String(c.n).padStart(4)} | ${mae(c).toFixed(3).padStart(6)} | ${(bias(c) >= 0 ? '+' : '') + bias(c).toFixed(3)}`;
  const TIER_LABEL: Record<string, string> = {
    T0: 'T0 established', T1: 'T1 partial', T2: 'T2 sparse', T3: 'T3 cold_start',
  };
  const tierRows = (pass: PassResult) =>
    ['T0', 'T1', 'T2', 'T3']
      .map((t) => ({ label: TIER_LABEL[t], c: pass.byTier.get(t) ?? mkCell() }));

  const lines: string[] = [];
  lines.push(`\n=== Events evaluated: ${eventsEvaluated} | corps observations: ${corpsEvaluated} | skips: ${skips.length} ===`);
  for (const [name, pass] of [['NO RECAL', noRecal], ['WITH RECAL', withRecal]] as const) {
    lines.push(`\n--- ${name} — per tier (n | MAE | bias) ---`);
    for (const { label, c } of tierRows(pass)) lines.push(`  ${(label ?? '?').padEnd(16)} ${fmt(c)}`);
    lines.push(`  ${'overall'.padEnd(16)} ${fmt(pass.overall)}`);
    lines.push(`  per division:`);
    for (const d of DIVISIONS) lines.push(`    ${d.padEnd(14)} ${fmt(pass.byDivision.get(d) ?? mkCell())}`);
  }
  if (skips.length) {
    lines.push(`\nSkips:`);
    for (const s of skips) lines.push(`  ${s.slug}: ${s.error}`);
  }
  const report = lines.join('\n');
  console.log(report);

  // Emit a machine-readable JSON next to the tool for doc generation.
  const json = {
    window: { start: WINDOW_START, end: WINDOW_END },
    eventsEvaluated,
    corpsEvaluated,
    skips,
    recalTrailingDays: RECAL_TRAILING_DAYS,
    passes: Object.fromEntries(
      ([['noRecal', noRecal], ['withRecal', withRecal]] as const).map(([k, pass]) => [
        k,
        {
          tiers: Object.fromEntries(
            ['T0', 'T1', 'T2', 'T3'].map((t) => {
              const c = pass.byTier.get(t) ?? mkCell();
              return [t, { n: c.n, mae: mae(c), bias: bias(c) }];
            })
          ),
          divisions: Object.fromEntries(
            DIVISIONS.map((d) => {
              const c = pass.byDivision.get(d) ?? mkCell();
              return [d, { n: c.n, mae: mae(c), bias: bias(c) }];
            })
          ),
          overall: { n: pass.overall.n, mae: mae(pass.overall), bias: bias(pass.overall) },
        },
      ])
    ),
  };
  fs.writeFileSync(
    path.resolve(import.meta.dirname, 'backtest-tiers.out.json'),
    JSON.stringify(json, null, 2)
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
