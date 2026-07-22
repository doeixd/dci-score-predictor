// Recent-regime head-to-head (maintainers only). Compares ALL model families on
// the genuinely held-out window of World/Open events resolved AFTER the shared
// training cutoff (≤2026-07-11): v10.4 (shipped-family baseline), v11 identity-
// dropout 0.3 / 0.5 / 0.7. Same leakage-safe, full-fidelity per-event backtest
// as tools/backtest-v11.ts (real judge panels, subcaptions, performance order),
// serving in production-default 'agnostic' mode, no recal.
//
// Family dirs are supplied out-of-tree (branch v11-model swapped v10.4 out of
// assets/); each family is a directory of seedNN/ dirs holding model.json +
// weights.bin + target-norm.json, mixed into predict() through the AssetProvider
// seam exactly as tools/backtest-v11.ts does (no src/ edits).
//
// A FIFTH "as-deployed v10.5" reference is included: for each window event, the
// totals production ACTUALLY served beforehand — the latest model_event_predict
// -ion_runs row with model_dir LIKE '%fieldpace-recal%' and predicted_at BEFORE
// the event date, parsed from payload_json.predictions. Events with no prior run
// are skipped (counted separately). This reference is recal'd real output, not a
// re-run, so it is apples-to-oranges vs the no-recal families — it answers "what
// did users see", not "what would this family have produced".
//
// Run:        npx tsx tools/backtest-recent.ts
// Verify only: RECENT_VERIFY=1 npx tsx tools/backtest-recent.ts  (loads each
//              family's 8-seed pool, predicts the kentucky fixture sanely)
// Emits tools/backtest-recent.out.json for docs/V11_RECENT_SHOWDOWN.md.
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

// ── Family sources (out-of-tree; each is a dir of seedNN/ dirs) ───────────────
const FAMILY_DIRS: Record<string, string> = {
  v104: process.env.V104_DIR ?? '/home/patrick/cp-v10-serving/sdk/models/v10_4_field_pace',
  'v11-030': process.env.V11_030_DIR ?? '/home/patrick/v11-arm2-seeds/030',
  'v11-050': process.env.V11_050_DIR ?? '/home/patrick/v11-seeds',
  'v11-070': process.env.V11_070_DIR ?? '/home/patrick/v11-arm2-seeds/070',
};
const FAMILY_LABEL: Record<string, string> = {
  v104: '8×v10.4 (shipped baseline)',
  'v11-030': '8×v11 identity-0.3',
  'v11-050': '8×v11 identity-0.5',
  'v11-070': '8×v11 identity-0.7',
  deployed: 'as-deployed v10.5 (fieldpace-recal, what prod served)',
};
const FAMILY_ORDER = ['v104', 'v11-030', 'v11-050', 'v11-070'];

// ── Pool provider (family-mixing via the AssetProvider seam; from backtest-v11) ─
interface PoolMember { name: string; dir: string }
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

// Every seedNN/ dir under a family root that has a model.json.
const familyMembers = (root: string): PoolMember[] => {
  const out: PoolMember[] = [];
  for (const name of fs.readdirSync(root).sort()) {
    const full = path.join(root, name);
    if (!fs.statSync(full).isDirectory()) continue;
    if (!/seed\d+_/.test(name)) continue;
    if (!fs.existsSync(path.join(full, 'model.json'))) continue;
    if (!fs.existsSync(path.join(full, 'target-norm.json'))) throw new Error(`missing target-norm.json in ${full}`);
    out.push({ name, dir: full });
  }
  if (out.length !== 8) throw new Error(`expected 8 seeds in ${root}, found ${out.length}`);
  return out;
};
const FAMILY_POOL: Record<string, PoolMember[]> = Object.fromEntries(
  FAMILY_ORDER.map((f) => [f, familyMembers(FAMILY_DIRS[f]!)])
);

const IDENTITY: IdentityMode = 'agnostic';

// ────────────────────────────────────────────────────────────────────────────
// Data setup — leakage-safe SeasonData, copied from tools/backtest-v11.ts.
// ────────────────────────────────────────────────────────────────────────────
const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract-0722.db';
const WINDOW_START = process.env.BT_START ?? '2026-07-17';
const WINDOW_END = process.env.BT_END ?? '2026-07-22';

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

const actualByShowCorps = new Map<string, number>();
for (const row of perfRows) actualByShowCorps.set(`${row.slug}|${row.corps_key}`, Number(row.total_score));
const divByShowCorps = new Map<string, DivisionName>();
for (const row of perfRows) divByShowCorps.set(`${row.slug}|${row.corps_key}`, row.division_name as DivisionName);

// ── Accumulators ──
interface Cell { n: number; absSum: number; sum: number }
const mkCell = (): Cell => ({ n: 0, absSum: 0, sum: 0 });
const add = (c: Cell, err: number) => { c.n++; c.absSum += Math.abs(err); c.sum += err; };
const mae = (c: Cell) => (c.n ? c.absSum / c.n : NaN);
const bias = (c: Cell) => (c.n ? c.sum / c.n : NaN);

// per-family: overall + per-division + per-event
const overall = new Map<string, Cell>();
const byDivision = new Map<string, Map<DivisionName, Cell>>();
const byEvent = new Map<string, Map<string, Cell>>(); // slug -> family -> cell
const cellIn = (m: Map<string, Cell>, k: string) => m.get(k) ?? m.set(k, mkCell()).get(k)!;
const divCell = (fam: string, d: DivisionName) => {
  const fm = byDivision.get(fam) ?? byDivision.set(fam, new Map()).get(fam)!;
  return fm.get(d) ?? fm.set(d, mkCell()).get(d)!;
};
const evtCell = (slug: string, fam: string) => {
  const em = byEvent.get(slug) ?? byEvent.set(slug, new Map()).get(slug)!;
  return em.get(fam) ?? em.set(fam, mkCell()).get(fam)!;
};

async function runFamilyEvent(fam: string, slug: string, provider: AssetProvider): Promise<number> {
  const data = buildSeasonData(slug);
  const result = await predict(
    { seasonInfo: data.seasonInfo, shows: data.shows, target: data.target },
    { provider, identity: IDENTITY }
  );
  let evaluated = 0;
  for (const p of result.predictions) {
    const actual = actualByShowCorps.get(`${slug}|${p.corpsKey}`);
    if (actual == null) continue;
    const err = p.total - actual;
    add(cellIn(overall, fam), err);
    add(divCell(fam, p.division), err);
    add(evtCell(slug, fam), err);
    evaluated++;
  }
  return evaluated;
}

// ── As-deployed v10.5 reference (what prod actually served) ──
interface DeployedCov { slug: string; predictedAt: string; n: number }
const deployedCoverage: DeployedCov[] = [];
function runDeployed() {
  for (const slug of targets) {
    const targetDate = slugDate.get(slug)!;
    // latest fieldpace-recal run predicted BEFORE the event date, any division
    const runs = q(DB, `
      SELECT payload_json, predicted_at FROM model_event_prediction_runs
      WHERE event_slug = '${slug}' AND model_dir LIKE '%fieldpace-recal%'
        AND substr(predicted_at,1,10) < '${targetDate}'
      ORDER BY predicted_at DESC`);
    if (!runs.length) { deployedCoverage.push({ slug, predictedAt: '(none)', n: 0 }); continue; }
    // collect predictions across the most-recent predicted_at timestamp (one per division)
    const latestTs = String(runs[0].predicted_at);
    let n = 0;
    const seen = new Set<string>();
    for (const r of runs) {
      if (String(r.predicted_at) !== latestTs) break;
      let payload: any;
      try { payload = JSON.parse(String(r.payload_json)); } catch { continue; }
      for (const p of payload.predictions ?? []) {
        const ck = String(p.corps_key);
        if (seen.has(ck)) continue;
        const actual = actualByShowCorps.get(`${slug}|${ck}`);
        const div = divByShowCorps.get(`${slug}|${ck}`);
        if (actual == null || !div) continue;
        seen.add(ck);
        const err = Number(p.total) - actual;
        add(cellIn(overall, 'deployed'), err);
        add(divCell('deployed', div), err);
        add(evtCell(slug, 'deployed'), err);
        n++;
      }
    }
    deployedCoverage.push({ slug, predictedAt: latestTs, n });
  }
}

const fmt = (c: Cell) => (c.n ? `${String(c.n).padStart(3)} | ${mae(c).toFixed(3)} | ${(bias(c) >= 0 ? '+' : '') + bias(c).toFixed(3)}` : '  - |     - |      -');

async function verify() {
  console.log('Recent-showdown verification: loading each family 8-seed pool, predicting the kentucky fixture.\n');
  const season = JSON.parse(
    fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'season-2026-2026-dci-kentucky.json'), 'utf-8')
  ) as SeasonData;
  const offsets = JSON.parse(
    fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'kentucky-offsets.json'), 'utf-8')
  ) as Record<string, number>;
  for (const fam of FAMILY_ORDER) {
    _clearEnsembleCache();
    const provider = poolProvider(FAMILY_POOL[fam]!);
    const members = await loadEnsemble({ provider });
    const res = await predict(season, { provider, recalOffsets: offsets, identity: IDENTITY });
    const top3 = res.predictions.slice(0, 3).map((p) => `${p.corps} ${p.total.toFixed(2)}`).join(', ');
    console.log(`  ${fam.padEnd(9)}: ${members.length} members, ${res.predictions.length} preds | top3: ${top3}`);
  }
  console.log('\nVerification complete — all families load and predict sanely.');
}

async function backtest() {
  console.log(`Recent showdown ${WINDOW_START}..${WINDOW_END}: ${targets.length} events × ${FAMILY_ORDER.length} families (agnostic)\n`);
  console.log('Window events:');
  for (const slug of targets) console.log(`  ${slugDate.get(slug)}  ${slug}  (${bySlug.get(slug)!.filter((r) => DIVISIONS.includes(r.division_name)).length} corps)`);
  console.log();

  for (const fam of FAMILY_ORDER) {
    _clearEnsembleCache();
    const provider = poolProvider(FAMILY_POOL[fam]!);
    let evtOk = 0;
    for (const slug of targets) {
      try { await runFamilyEvent(fam, slug, provider); evtOk++; }
      catch (e) { console.log(`  [SKIP] ${fam} ${slug}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    console.log(`  ${fam.padEnd(9)} — ${evtOk}/${targets.length} events ok, overall MAE ${mae(overall.get(fam) ?? mkCell()).toFixed(3)}`);
  }
  runDeployed();

  const FAMILIES_ALL = [...FAMILY_ORDER, 'deployed'];

  // ── report ──
  const lines: string[] = [];
  lines.push('\n=== AGGREGATE (n | MAE | bias) ===');
  for (const fam of FAMILIES_ALL) {
    const o = overall.get(fam) ?? mkCell();
    lines.push(`  ${fam.padEnd(9)} overall  ${fmt(o)}   ${FAMILY_LABEL[fam]}`);
    for (const d of DIVISIONS) lines.push(`      ${d.padEnd(12)} ${fmt(divCell(fam, d))}`);
  }

  // per-event winner table (families only; deployed shown when present)
  lines.push('\n=== PER-EVENT MAE (winner*) ===');
  const modelFams = FAMILY_ORDER;
  lines.push(`  ${'event'.padEnd(34)} ${modelFams.map((f) => f.padStart(9)).join(' ')} ${'deployed'.padStart(9)}`);
  const eventWins = new Map<string, number>();
  for (const slug of targets) {
    const em = byEvent.get(slug) ?? new Map();
    let bestFam = ''; let bestMae = Infinity;
    for (const f of modelFams) { const c = em.get(f); if (c && c.n && mae(c) < bestMae) { bestMae = mae(c); bestFam = f; } }
    if (bestFam) eventWins.set(bestFam, (eventWins.get(bestFam) ?? 0) + 1);
    const cells = modelFams.map((f) => { const c = em.get(f); const s = c && c.n ? mae(c).toFixed(3) : '-'; return (f === bestFam ? '*' + s : s).padStart(9); });
    const dep = em.get('deployed'); const depS = dep && dep.n ? mae(dep).toFixed(3) : '-';
    lines.push(`  ${(slugDate.get(slug) + ' ' + slug.replace('2026-', '')).padEnd(34)} ${cells.join(' ')} ${depS.padStart(9)}`);
  }
  lines.push(`  event wins: ${modelFams.map((f) => `${f}=${eventWins.get(f) ?? 0}`).join('  ')}`);

  lines.push('\n=== as-deployed coverage ===');
  for (const c of deployedCoverage) lines.push(`  ${c.slug.padEnd(38)} run=${c.predictedAt}  matched=${c.n}`);

  const report = lines.join('\n');
  console.log(report);

  const json = {
    window: { start: WINDOW_START, end: WINDOW_END },
    contractDb: CONTRACT_DB,
    identity: IDENTITY,
    events: targets.map((s) => ({ slug: s, date: slugDate.get(s), corps: bySlug.get(s)!.filter((r) => DIVISIONS.includes(r.division_name)).length })),
    families: Object.fromEntries(FAMILIES_ALL.map((fam) => {
      const o = overall.get(fam) ?? mkCell();
      return [fam, {
        label: FAMILY_LABEL[fam],
        seeds: fam === 'deployed' ? null : FAMILY_POOL[fam]!.map((m) => m.name),
        overall: { n: o.n, mae: mae(o), bias: bias(o) },
        divisions: Object.fromEntries(DIVISIONS.map((d) => { const c = divCell(fam, d); return [d, { n: c.n, mae: mae(c), bias: bias(c) }]; })),
      }];
    })),
    perEvent: targets.map((slug) => {
      const em = byEvent.get(slug) ?? new Map();
      return {
        slug, date: slugDate.get(slug),
        families: Object.fromEntries(FAMILIES_ALL.map((f) => { const c = em.get(f); return [f, c && c.n ? { n: c.n, mae: mae(c), bias: bias(c) } : null]; })),
      };
    }),
    eventWins: Object.fromEntries(FAMILY_ORDER.map((f) => [f, eventWins.get(f) ?? 0])),
    deployedCoverage,
  };
  fs.writeFileSync(path.join(HERE, 'backtest-recent.out.json'), JSON.stringify(json, null, 2));
  console.log(`\nWrote ${path.join(HERE, 'backtest-recent.out.json')}`);
}

const main = process.env.RECENT_VERIFY ? verify : backtest;
main().catch((e) => { console.error(e); process.exit(1); });
