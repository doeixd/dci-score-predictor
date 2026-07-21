// V11 identity-experiment backtest (maintainers only). Reuses the SAME resolved-
// 2026 per-event, leakage-safe backtest as tools/backtest-identity.ts (no-recal,
// full-fidelity inputs: real judge panels, subcaptions, performance order), but
// evaluates MULTIPLE ensemble POOLS that can MIX model families (v10.4 shipped
// assets + v11 identity-dropout-0.5 seeds staged in /home/patrick/v11-seeds) in
// two serving modes — 'agnostic' (production default) and identity-'full'.
//
// Family mixing is done through the AssetProvider seam (src/assets/provider.ts):
// each pool gets a synthetic provider whose models/MANIFEST.json lists exactly the
// chosen seeds and whose models/<seed>/* reads from that seed's real source dir.
// predict() is used UNCHANGED (no src/ edits); the per-pool ensemble is swapped by
// clearing predict()'s ensemble cache between pools (_clearEnsembleCache).
//
// Pools: 8×v10.4, 8×v11, mixed 4+4 / 6+2 / 2+6, all-16 (mixture hypothesis).
// Emits tools/backtest-v11.out.json for docs/V11_ARM1_RESULTS.md generation.
//
// Run:        npx tsx tools/backtest-v11.ts
// Verify only: V11_VERIFY=1 npx tsx tools/backtest-v11.ts   (loads each v11 seed
//              + the full v11 pool, predicts the kentucky fixture, no backtest)
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTIONS, type Caption } from '../src/model/contract.js';
import { predict, _clearEnsembleCache } from '../src/predict.js';
import { loadEnsemble } from '../src/model/loader.js';
import type { AssetProvider } from '../src/assets/provider.js';
import type { IdentityMode } from '../src/model/identity.js';
import type { SeasonData, ShowInput, PerformanceInput, DivisionName } from '../src/features/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const V10_DIR = path.join(REPO, 'assets', 'models');
const V11_DIR = process.env.V11_SEEDS_DIR ?? '/home/patrick/v11-seeds';

// ── Pool provider (family-mixing via the AssetProvider seam) ──────────────────
interface PoolMember { name: string; dir: string } // dir contains model.json/weights.bin/target-norm.json
const poolProvider = (members: PoolMember[]): AssetProvider => {
  const byName = new Map(members.map((m) => [m.name, m.dir]));
  const resolve = (rel: string): string => {
    const parts = rel.split('/'); // models/<seed>/<file...>
    const dir = byName.get(parts[1]!);
    if (!dir) throw new Error(`pool provider: unknown seed "${parts[1]}" for ${rel}`);
    return path.join(dir, parts.slice(2).join('/'));
  };
  return {
    async readJson(rel) {
      if (rel === 'models/MANIFEST.json') return { seeds: members.map((m) => ({ name: m.name })) };
      return JSON.parse(fs.readFileSync(resolve(rel), 'utf-8'));
    },
    async readBinary(rel) {
      const buf = fs.readFileSync(resolve(rel));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    },
    async listModelSeeds() {
      return members.map((m) => m.name);
    },
  };
};

// Map seed-number → { name, dir } for a family directory (dir name embeds seedNN).
const familySeeds = (root: string): Map<number, PoolMember> => {
  const out = new Map<number, PoolMember>();
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    if (!fs.statSync(full).isDirectory()) continue;
    const m = /seed(\d+)_/.exec(name);
    if (!m) continue;
    if (!fs.existsSync(path.join(full, 'model.json'))) continue;
    out.set(Number(m[1]), { name, dir: full });
  }
  return out;
};
const V10 = familySeeds(V10_DIR);
const V11 = familySeeds(V11_DIR);
const pick = (fam: Map<number, PoolMember>, seeds: number[]): PoolMember[] =>
  seeds.map((s) => {
    const m = fam.get(s);
    if (!m) throw new Error(`seed ${s} not found`);
    return m;
  });
const ALL = [42, 43, 44, 45, 46, 47, 48, 49];

interface Pool { key: string; label: string; members: PoolMember[] }
const POOLS: Pool[] = [
  { key: 'v104', label: '8×v10.4 (baseline)', members: pick(V10, ALL) },
  { key: 'v11', label: '8×v11 (identity-0.5)', members: pick(V11, ALL) },
  { key: 'mix44', label: 'mixed 4+4 (v10.4 42-45 + v11 42-45)', members: [...pick(V10, [42, 43, 44, 45]), ...pick(V11, [42, 43, 44, 45])] },
  { key: 'mix62', label: 'mixed 6+2 (v10.4 42-47 + v11 42-43)', members: [...pick(V10, [42, 43, 44, 45, 46, 47]), ...pick(V11, [42, 43])] },
  { key: 'mix26', label: 'mixed 2+6 (v10.4 42-43 + v11 42-47)', members: [...pick(V10, [42, 43]), ...pick(V11, [42, 43, 44, 45, 46, 47])] },
  { key: 'all16', label: 'all-16 (8×v10.4 + 8×v11)', members: [...pick(V10, ALL), ...pick(V11, ALL)] },
];

const MODES: Array<{ key: string; label: string; identity?: IdentityMode }> = [
  { key: 'agnostic', label: 'agnostic (default)', identity: 'agnostic' },
  { key: 'full', label: 'identity-full', identity: 'full' },
];

// ────────────────────────────────────────────────────────────────────────────
// Below: data setup copied verbatim from tools/backtest-identity.ts (same window,
// same leakage-safe SeasonData construction, same full-fidelity inputs).
// ────────────────────────────────────────────────────────────────────────────
const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract.db';
const WINDOW_START = process.env.BT_START ?? '2026-07-01';
const WINDOW_END = process.env.BT_END ?? '2026-07-19';

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

const CAPTION_MAP: Record<string, Caption> = {
  'General Effect 1': 'GE1', 'General Effect 2': 'GE2',
  'Visual Proficiency': 'VP', 'Visual - Proficiency': 'VP',
  'Visual Analysis': 'VA', 'Visual - Analysis': 'VA',
  'Color Guard': 'CG',
  'Music - Brass': 'MB', 'Music Brass': 'MB', Brass: 'MB',
  'Music - Analysis': 'MA', 'Music Analysis': 'MA',
  'Music - Percussion': 'MP', 'Music Percussion': 'MP', Percussion: 'MP',
};
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
const subCategory = (name: string): 'Content' | 'Achievement' | 'Other' => {
  const n = name.toLowerCase().trim();
  if (CONTENT_VARIANTS.some((v) => n.includes(v))) return 'Content';
  if (ACHIEVEMENT_VARIANTS.some((v) => n.includes(v))) return 'Achievement';
  return 'Other';
};
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

const toPerf = (row: any): PerformanceInput => ({
  corpsKey: String(row.corps_key),
  corpsName: String(row.corps_key),
  division: row.division_name as DivisionName,
  total: Number(row.total_score),
  captions: Object.fromEntries(CAPTIONS.map((c) => [c, Number(row[c])])) as Partial<Record<Caption, number>>,
  subcaptions: subByShowCorps.get(`${row.slug}|${row.corps_key}`),
  performanceOrder: orderByShowCorps.get(`${row.slug}|${row.corps_key}`),
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
    if (String(row.date) >= targetDate) continue;
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
interface Cell { n: number; absSum: number; sum: number }
const mkCell = (): Cell => ({ n: 0, absSum: 0, sum: 0 });
const add = (c: Cell, err: number) => { c.n++; c.absSum += Math.abs(err); c.sum += err; };
const mae = (c: Cell) => (c.n ? c.absSum / c.n : NaN);
const bias = (c: Cell) => (c.n ? c.sum / c.n : NaN);
interface PassResult { byTier: Map<string, Cell>; byDivision: Map<string, Cell>; overall: Cell }
const mkPass = (): PassResult => ({ byTier: new Map(), byDivision: new Map(), overall: mkCell() });
const cell = (m: Map<string, Cell>, k: string) => m.get(k) ?? m.set(k, mkCell()).get(k)!;

async function runEvent(
  slug: string,
  pass: PassResult,
  identity: IdentityMode | undefined,
  provider: AssetProvider
) {
  const data = buildSeasonData(slug);
  const result = await predict(
    { seasonInfo: data.seasonInfo, shows: data.shows, target: data.target },
    { provider, ...(identity ? { identity } : {}) }
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

const TIERS = ['T0', 'T1', 'T2', 'T3'];
const TIER_LABEL: Record<string, string> = { T0: 'T0 established', T1: 'T1 partial', T2: 'T2 sparse', T3: 'T3 cold_start' };
const fmt = (c: Cell) => `${String(c.n).padStart(4)} | ${mae(c).toFixed(3).padStart(6)} | ${(bias(c) >= 0 ? '+' : '') + bias(c).toFixed(3)}`;

async function verify() {
  console.log('V11 verification: loading each seed + the full pool, predicting the kentucky fixture.\n');
  const season = JSON.parse(
    fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'season-2026-2026-dci-kentucky.json'), 'utf-8')
  ) as SeasonData;
  const offsets = JSON.parse(
    fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'kentucky-offsets.json'), 'utf-8')
  ) as Record<string, number>;

  for (const [seed, m] of [...V11.entries()].sort((a, b) => a[0] - b[0])) {
    _clearEnsembleCache();
    const provider = poolProvider([m]);
    const members = await loadEnsemble({ provider });
    const res = await predict(season, { provider, recalOffsets: offsets });
    const top = res.predictions[0]!;
    console.log(`  v11 seed${seed}: loaded ${members.length} member, ${res.predictions.length} preds, top=${top.corps} ${top.total.toFixed(3)}`);
  }
  _clearEnsembleCache();
  const poolAll = poolProvider(pick(V11, ALL));
  const res = await predict(season, { provider: poolAll, recalOffsets: offsets });
  console.log(`\n  8×v11 pool: ${res.predictions.length} preds, top3:`);
  for (const p of res.predictions.slice(0, 3)) console.log(`    ${p.rank}. ${p.corps}  ${p.total.toFixed(3)}`);
  console.log('\nVerification complete — all v11 seeds load and predict without error.');
}

async function backtest() {
  console.log(`V11 pool backtest ${WINDOW_START}..${WINDOW_END}: ${targets.length} events × ${POOLS.length} pools × ${MODES.length} modes\n`);
  // passes[poolKey][modeKey]
  const passes = new Map<string, Map<string, PassResult>>(
    POOLS.map((p) => [p.key, new Map(MODES.map((m) => [m.key, mkPass()]))])
  );
  const skips: Array<{ pool: string; slug: string; error: string }> = [];
  const eventsEvaluated = new Map<string, number>();

  for (const pool of POOLS) {
    _clearEnsembleCache(); // swap the ensemble to this pool's members
    const provider = poolProvider(pool.members);
    let evtOk = 0;
    console.log(`\n### pool ${pool.key} — ${pool.label} (${pool.members.length} members)`);
    for (const slug of targets) {
      try {
        for (const mode of MODES) await runEvent(slug, passes.get(pool.key)!.get(mode.key)!, mode.identity, provider);
        evtOk++;
      } catch (e) {
        skips.push({ pool: pool.key, slug, error: e instanceof Error ? e.message : String(e) });
        console.log(`  [SKIP] ${slug}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    eventsEvaluated.set(pool.key, evtOk);
    console.log(`  ${evtOk} events ok`);
  }

  const lines: string[] = [];
  for (const pool of POOLS) {
    lines.push(`\n=== pool ${pool.key}: ${pool.label} | events ${eventsEvaluated.get(pool.key)} ===`);
    for (const mode of MODES) {
      const pass = passes.get(pool.key)!.get(mode.key)!;
      lines.push(`--- ${mode.label} — (n | MAE | bias) ---`);
      for (const t of TIERS) lines.push(`  ${TIER_LABEL[t]!.padEnd(16)} ${fmt(pass.byTier.get(t) ?? mkCell())}`);
      lines.push(`  ${'overall'.padEnd(16)} ${fmt(pass.overall)}`);
      for (const d of DIVISIONS) lines.push(`    ${d.padEnd(14)} ${fmt(pass.byDivision.get(d) ?? mkCell())}`);
    }
  }
  const report = lines.join('\n');
  console.log(report);

  const json = {
    window: { start: WINDOW_START, end: WINDOW_END },
    modes: MODES.map((m) => m.key),
    skips,
    pools: Object.fromEntries(
      POOLS.map((pool) => [
        pool.key,
        {
          label: pool.label,
          members: pool.members.map((m) => m.name),
          eventsEvaluated: eventsEvaluated.get(pool.key),
          modes: Object.fromEntries(
            MODES.map((mode) => {
              const pass = passes.get(pool.key)!.get(mode.key)!;
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
        },
      ])
    ),
  };
  fs.writeFileSync(path.join(HERE, 'backtest-v11.out.json'), JSON.stringify(json, null, 2));
  console.log(`\nWrote ${path.join(HERE, 'backtest-v11.out.json')}`);
}

const main = process.env.V11_VERIFY ? verify : backtest;
main().catch((e) => { console.error(e); process.exit(1); });
