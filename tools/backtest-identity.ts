// Identity A/B backtest (maintainers only): reruns the SAME resolved-2026
// per-event backtest as tools/backtest-tiers.ts (no-recal, leakage-safe: only
// shows strictly before each target feed the input), but in THREE identity
// serving modes — 'agnostic' (production default), identity-'full' (corps +
// judges + show), and identity corps-only — and reports per-mode overall +
// per-tier MAE/bias so the effect of the opt-in identity knob is measurable.
//
// Judge panels come from the prod DB's real per-show assignments (judge_id),
// which is fair for a resolved-show backtest (the panel that actually judged the
// target is known). Corps use the registry corps_key. Emits a machine-readable
// JSON next to the tool for docs/IDENTITY_BASELINES.md generation.
//
// Run: npx tsx tools/backtest-identity.ts
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTIONS, type Caption } from '../src/model/contract.js';
import { predict } from '../src/predict.js';
import type { IdentityMode } from '../src/model/identity.js';
import type { SeasonData, ShowInput, PerformanceInput, DivisionName } from '../src/features/types.js';

const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract.db';
const WINDOW_START = process.env.BT_START ?? '2026-07-01';
const WINDOW_END = process.env.BT_END ?? '2026-07-19';
const MEMBERS = Number(process.env.BT_MEMBERS ?? '8');

const q = (db: string, sql: string): any[] =>
  JSON.parse(
    execFileSync('sqlite3', ['-json', '-readonly', db, sql], {
      encoding: 'utf-8',
      maxBuffer: 512 * 1024 * 1024,
    }) || '[]'
  );

const seasonBounds = q(DB, `
  SELECT substr(MIN(start_date),1,10) AS start, substr(MAX(start_date),1,10) AS end
  FROM events WHERE substr(start_date,1,4)='2026'`)[0];

const perfRows = q(CONTRACT_DB, `
  SELECT competition_slug AS slug, substr(competition_date,1,10) AS date, percent_through,
         model_corps_key AS corps_key, division_name, total_score,
         GE1, GE2, VP, VA, CG, MB, MA, MP
  FROM v10_training_performances
  WHERE season = 2026
  ORDER BY date, competition_slug, model_corps_key`);

// Real judge panels per show (caption → judge_id[]).
const judgeRows = q(DB, `
  SELECT competition_slug AS slug, normalized_caption_name AS caption, judge_id
  FROM judge_assignments
  WHERE normalized_caption_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
    AND judge_id IS NOT NULL AND judge_id <> '' AND judge_id NOT LIKE '%unknown%'`);
const judgesByShow = new Map<string, Partial<Record<Caption, string[]>>>();
for (const row of judgeRows) {
  const byCaption = judgesByShow.get(row.slug) ?? {};
  ((byCaption[row.caption as Caption] ??= []) as string[]).push(String(row.judge_id));
  judgesByShow.set(row.slug, byCaption);
}

const toPerf = (row: any): PerformanceInput => ({
  corpsKey: String(row.corps_key),
  corpsName: String(row.corps_key),
  division: row.division_name as DivisionName,
  total: Number(row.total_score),
  captions: Object.fromEntries(CAPTIONS.map((c) => [c, Number(row[c])])) as Partial<Record<Caption, number>>,
});

const bySlug = new Map<string, any[]>();
const slugDate = new Map<string, string>();
const slugPct = new Map<string, number>();
for (const row of perfRows) {
  (bySlug.get(row.slug) ?? bySlug.set(row.slug, []).get(row.slug)!).push(row);
  slugDate.set(row.slug, String(row.date));
  slugPct.set(row.slug, Number(row.percent_through));
}

const DIVISIONS: DivisionName[] = ['World Class', 'Open Class'];
const targets = [...bySlug.keys()]
  .filter((slug) => {
    const d = slugDate.get(slug)!;
    if (d < WINDOW_START || d > WINDOW_END) return false;
    return bySlug.get(slug)!.some((r) => DIVISIONS.includes(r.division_name));
  })
  .sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : 1));

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
    target: { slug: targetSlug, date: targetDate, percentThrough: slugPct.get(targetSlug), lineup, judges: judgesByShow.get(targetSlug) },
  };
};

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
interface PassResult { byTier: Map<string, Cell>; byDivision: Map<string, Cell>; overall: Cell; }
const mkPass = (): PassResult => ({ byTier: new Map(), byDivision: new Map(), overall: mkCell() });
const cell = (m: Map<string, Cell>, k: string) => m.get(k) ?? m.set(k, mkCell()).get(k)!;

const MODES: Array<{ key: string; label: string; identity?: IdentityMode }> = [
  { key: 'agnostic', label: 'agnostic (default)', identity: 'agnostic' },
  { key: 'full', label: 'identity-full', identity: 'full' },
  { key: 'corpsOnly', label: 'identity corps-only', identity: { corps: true } },
];

async function runEvent(slug: string, pass: PassResult, identity: IdentityMode | undefined) {
  const data = buildSeasonData(slug);
  const result = await predict(
    { seasonInfo: data.seasonInfo, shows: data.shows, target: data.target },
    { members: MEMBERS, ...(identity ? { identity } : {}) }
  );
  const tierByKey = new Map(result.readiness.corps.map((c) => [c.corpsKey, c.tierCode]));
  let evaluated = 0;
  for (const p of result.predictions) {
    const actual = actualFor(slug, p.corpsKey);
    if (actual == null) continue;
    const err = p.total - actual;
    add(cell(pass.byTier, tierByKey.get(p.corpsKey) ?? 'T3'), err);
    add(cell(pass.byDivision, p.division), err);
    add(pass.overall, err);
    evaluated++;
  }
  return evaluated;
}

async function main() {
  console.log(`Identity backtest ${WINDOW_START}..${WINDOW_END}: ${targets.length} events × ${MODES.length} modes (members=${MEMBERS})\n`);
  const passes = new Map<string, PassResult>(MODES.map((m) => [m.key, mkPass()]));
  const skips: Array<{ slug: string; error: string }> = [];
  let eventsEvaluated = 0;

  for (const slug of targets) {
    try {
      for (const mode of MODES) await runEvent(slug, passes.get(mode.key)!, mode.identity);
      eventsEvaluated++;
      console.log(`  ${slug} (${slugDate.get(slug)}) ok`);
    } catch (e) {
      skips.push({ slug, error: e instanceof Error ? e.message : String(e) });
      console.log(`  [SKIP] ${slug}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const TIERS = ['T0', 'T1', 'T2', 'T3'];
  const TIER_LABEL: Record<string, string> = { T0: 'T0 established', T1: 'T1 partial', T2: 'T2 sparse', T3: 'T3 cold_start' };
  const fmt = (c: Cell) => `${String(c.n).padStart(4)} | ${mae(c).toFixed(3).padStart(6)} | ${(bias(c) >= 0 ? '+' : '') + bias(c).toFixed(3)}`;

  const lines: string[] = [];
  lines.push(`\n=== Events evaluated: ${eventsEvaluated} | skips: ${skips.length} ===`);
  for (const mode of MODES) {
    const pass = passes.get(mode.key)!;
    lines.push(`\n--- ${mode.label} — (n | MAE | bias) ---`);
    for (const t of TIERS) lines.push(`  ${TIER_LABEL[t]!.padEnd(16)} ${fmt(pass.byTier.get(t) ?? mkCell())}`);
    lines.push(`  ${'overall'.padEnd(16)} ${fmt(pass.overall)}`);
    for (const d of DIVISIONS) lines.push(`    ${d.padEnd(14)} ${fmt(pass.byDivision.get(d) ?? mkCell())}`);
  }
  const report = lines.join('\n');
  console.log(report);

  const json = {
    window: { start: WINDOW_START, end: WINDOW_END },
    eventsEvaluated,
    members: MEMBERS,
    skips,
    modes: Object.fromEntries(
      MODES.map((mode) => {
        const pass = passes.get(mode.key)!;
        return [
          mode.key,
          {
            label: mode.label,
            tiers: Object.fromEntries(TIERS.map((t) => { const c = pass.byTier.get(t) ?? mkCell(); return [t, { n: c.n, mae: mae(c), bias: bias(c) }]; })),
            divisions: Object.fromEntries(DIVISIONS.map((d) => { const c = pass.byDivision.get(d) ?? mkCell(); return [d, { n: c.n, mae: mae(c), bias: bias(c) }]; })),
            overall: { n: pass.overall.n, mae: mae(pass.overall), bias: bias(pass.overall) },
          },
        ];
      })
    ),
  };
  fs.writeFileSync(path.resolve(import.meta.dirname, 'backtest-identity.out.json'), JSON.stringify(json, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
