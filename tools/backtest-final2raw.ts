/**
 * FINAL2 RAW-CORE DECOMPOSITION — is the v9 neural core actually better RAW than
 * the new (v11/v12a/v12b) cores in the late-season regime, or is the ENTIRE final2
 * advantage its serving wrapper (persist blend + curveΔ + comparable revert + season
 * bias correction)?
 *
 * Columns per held-out event + pooled (MAE + bias, points), window 2026-07-21..24
 * (n=50, the same 10 events judged in docs/V12_ARM_B_RESULTS.md):
 *   final2 RAW    — the v9 model core WITHOUT the wrapper. Read directly from the saved
 *                   pre-show serving payloads as `caption_shape_total` = the point
 *                   estimate total totalFromV9Captions(pointCaps). For every held-out
 *                   corps model_blend_weight==1 and point_estimate_source=='model_q50',
 *                   so pointCaps == rawCaps EXACTLY (blendCaps at weight 1 is identity)
 *                   => caption_shape_total is the pure model total, no baseline blend,
 *                   no persist, no comparable revert, no bias correction. PATH (b) of
 *                   the brief (direct read, no inversion needed). Validated against
 *                   PATH (a): a leakage-safe `predictEventRecap.ts --as-of` re-run of
 *                   2026-dci-birmingham reproduced caption_shape_total (2/4 top corps
 *                   exact, rest within 0.17pt; served totals within ~0.5pt).
 *   final2 served — what prod actually served (payload `total`, wrapper ON).
 *   v11 raw       — v11 identity-0.5 core, fresh leakage-safe inference (no wrapper).
 *   v12a raw      — v12a persistence-residual core, no wrapper  (reused from out.json).
 *   v12b raw      — v12b field-relative core + its serving add-back, no wrapper
 *                   (reused from backtest-v12b.out.json `v12b`; == full-recap raw
 *                   prediction, apples-to-apples with the other cores).
 *   v12b-noAB     — v12b climate-removed core with NO add-back (ablation; reused).
 *
 * Leakage safety: final2 payloads were stamped strictly pre-show (as-of the show
 * date). v11 inference builds SeasonData only from shows STRICTLY before the target
 * date. Actuals from CONTRACT_DB v10_training_performances.
 *
 * Run: DCI_DB=/root/corps-place/sdk/dci-relational.db \
 *      CONTRACT_DB=/tmp/sdk-assets-contract-0725b.db \
 *      V11_050_DIR=/home/patrick/v11-seeds npx tsx tools/backtest-final2raw.ts
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTIONS, type Caption } from '../src/model/contract.js';
import { predict, _clearEnsembleCache } from '../src/predict.js';
import type { AssetProvider } from '../src/assets/provider.js';
import type { IdentityMode } from '../src/model/identity.js';
import type { SeasonData, ShowInput, PerformanceInput, DivisionName } from '../src/features/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract-0725b.db';
const V11_DIR = process.env.V11_050_DIR ?? '/home/patrick/v11-seeds';
const WINDOW_START = process.env.BT_START ?? '2026-07-21';
const WINDOW_END = process.env.BT_END ?? '2026-07-24';
const IDENTITY: IdentityMode = 'agnostic';
const V12B_OUT = path.join(REPO, 'tools/backtest-v12b.out.json');

const q = (db: string, sql: string): any[] =>
  JSON.parse(execFileSync('sqlite3', ['-json', '-readonly', db, sql], { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 }) || '[]');

const seasonBounds = q(DB, `SELECT substr(MIN(start_date),1,10) AS start, substr(MAX(start_date),1,10) AS end FROM events WHERE substr(start_date,1,4)='2026'`)[0];

const perfRows = q(CONTRACT_DB, `
  SELECT competition_slug AS slug, substr(competition_date,1,10) AS date, percent_through,
         model_corps_key AS corps_key, division_name, total_score, GE1,GE2,VP,VA,CG,MB,MA,MP
  FROM v10_training_performances WHERE season = 2026
  ORDER BY date, competition_slug, model_corps_key`);

// ── judges + subcaptions for leakage-safe SeasonData (mirrors backtest-v12b.ts) ──
const judgeRows = q(DB, `
  SELECT competition_slug AS slug, normalized_caption_name AS caption, judge_id FROM judge_assignments
  WHERE normalized_caption_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP')
    AND judge_id IS NOT NULL AND judge_id <> '' AND judge_id NOT LIKE '%unknown%'`);
const judgesByShow = new Map<string, Partial<Record<Caption, string[]>>>();
for (const r of judgeRows) {
  const b = judgesByShow.get(r.slug) ?? {};
  ((b[r.caption as Caption] ??= []) as string[]).push(String(r.judge_id));
  judgesByShow.set(r.slug, b);
}
const CAPTION_MAP: Record<string, Caption> = {
  'General Effect 1': 'GE1', 'General Effect 2': 'GE2', 'Visual Proficiency': 'VP', 'Visual - Proficiency': 'VP',
  'Visual Analysis': 'VA', 'Visual - Analysis': 'VA', 'Color Guard': 'CG', 'Music - Brass': 'MB', 'Music Brass': 'MB',
  Brass: 'MB', 'Music - Analysis': 'MA', 'Music Analysis': 'MA', 'Music - Percussion': 'MP', 'Music Percussion': 'MP', Percussion: 'MP',
};
const CONTENT_V = ['content', 'repertoire', 'composition', 'rep', 'comp', 'design', 'repertoire/composition', 'design development', 'composition development', 'repertoire effect', 'design effect'];
const ACH_V = ['achievement', 'performance', 'execution', 'perf', 'excellence', 'clarity & excellence', 'performer excellence', 'performance/showmanship', 'performer effect', 'accuracy', 'technique', 'intonation', 'tone', 'expression'];
const subCat = (n: string): 'Content' | 'Achievement' | 'Other' => {
  const s = n.toLowerCase().trim();
  if (CONTENT_V.some((v) => s.includes(v))) return 'Content';
  if (ACH_V.some((v) => s.includes(v))) return 'Achievement';
  return 'Other';
};
const subRows = q(DB, `SELECT competition_slug AS slug, corps_key, caption_name, subcaption_name, score FROM subcaption_scores WHERE competition_slug IN (SELECT DISTINCT competition_slug FROM clean_reference_curve_entries WHERE season=2026)`);
const subByShowCorps = new Map<string, Partial<Record<Caption, { content: number; achievement: number }>>>();
for (const r of subRows) {
  const cap = CAPTION_MAP[String(r.caption_name)];
  if (!cap) continue;
  const cat = subCat(String(r.subcaption_name));
  if (cat === 'Other') continue;
  const key = `${r.slug}|${r.corps_key}`;
  const b = subByShowCorps.get(key) ?? {};
  const e = (b[cap] ??= { content: 0, achievement: 0 });
  if (cat === 'Content') e.content += Number(r.score); else e.achievement += Number(r.score);
  subByShowCorps.set(key, b);
}
const toPerf = (r: any): PerformanceInput => ({
  corpsKey: String(r.corps_key), corpsName: String(r.corps_key), division: r.division_name as DivisionName,
  total: Number(r.total_score), captions: Object.fromEntries(CAPTIONS.map((c) => [c, Number(r[c])])) as Partial<Record<Caption, number>>,
  subcaptions: subByShowCorps.get(`${r.slug}|${r.corps_key}`),
});
const bySlug = new Map<string, any[]>();
const slugDate = new Map<string, string>();
const slugPct = new Map<string, number>();
for (const r of perfRows) {
  (bySlug.get(r.slug) ?? bySlug.set(r.slug, []).get(r.slug)!).push(r);
  slugDate.set(r.slug, String(r.date));
  slugPct.set(r.slug, Number(r.percent_through));
}
const DIVISIONS: DivisionName[] = ['World Class', 'Open Class'];

const buildSeasonData = (targetSlug: string): SeasonData => {
  const targetDate = slugDate.get(targetSlug)!;
  const showMap = new Map<string, ShowInput>();
  for (const r of perfRows) {
    if (String(r.date) >= targetDate) continue;
    const show = showMap.get(r.slug) ?? { slug: String(r.slug), date: String(r.date), percentThrough: Number(r.percent_through), results: [] as PerformanceInput[], judges: judgesByShow.get(String(r.slug)) };
    show.results.push(toPerf(r));
    showMap.set(String(r.slug), show);
  }
  const lineup = bySlug.get(targetSlug)!.filter((r) => DIVISIONS.includes(r.division_name)).map((r) => ({ corpsKey: String(r.corps_key), corpsName: String(r.corps_key), division: r.division_name as DivisionName }));
  return { seasonInfo: { year: 2026, startDate: seasonBounds.start, endDate: seasonBounds.end }, shows: [...showMap.values()], target: { slug: targetSlug, date: targetDate, percentThrough: slugPct.get(targetSlug), lineup, judges: judgesByShow.get(targetSlug) } };
};

const poolProvider = (root: string): AssetProvider => {
  const members = fs.readdirSync(root).filter((n) => /seed\d+_/.test(n) && fs.existsSync(path.join(root, n, 'model.json'))).sort();
  if (members.length !== 8) throw new Error(`expected 8 seeds in ${root}, found ${members.length}`);
  const resolve = (rel: string) => { const p = rel.split('/'); return path.join(root, p[1]!, p.slice(2).join('/')); };
  return {
    async readJson(rel: string) { if (rel === 'models/MANIFEST.json') return { seeds: members.map((m) => ({ name: m })) }; return JSON.parse(fs.readFileSync(resolve(rel), 'utf-8')); },
    async readBinary(rel: string) { const b = fs.readFileSync(resolve(rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    async listModelSeeds() { return members; },
  } as AssetProvider;
};

const actualBy = new Map<string, number>();
const divBy = new Map<string, DivisionName>();
for (const r of perfRows) {
  const k = `${r.slug}|${r.corps_key}`;
  actualBy.set(k, Number(r.total_score));
  divBy.set(k, r.division_name as DivisionName);
}

// ── accumulators ──
type Acc = { n: number; abs: number; sum: number };
const mk = (): Acc => ({ n: 0, abs: 0, sum: 0 });
const add = (a: Acc, e: number) => { a.n++; a.abs += Math.abs(e); a.sum += e; };
const mae = (a: Acc) => (a.n ? a.abs / a.n : NaN);
const bias = (a: Acc) => (a.n ? a.sum / a.n : NaN);
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');

// ── v12a / v12b raw reused from the committed backtest-v12b.out.json (full n=50) ──
const v12bOut = JSON.parse(fs.readFileSync(V12B_OUT, 'utf-8'));
const v12aRawByEvent = new Map<string, { mae: number; bias: number }>();
const v12bRawByEvent = new Map<string, { mae: number; bias: number }>();
const v12bNoABByEvent = new Map<string, { mae: number; bias: number }>();
for (const e of v12bOut.perEvent) {
  v12aRawByEvent.set(e.slug, e.v12aRaw);
  v12bRawByEvent.set(e.slug, e.v12b);      // full-recap raw core (model + add-back, no wrapper)
  v12bNoABByEvent.set(e.slug, e.v12bNoAB); // climate-removed ablation, no add-back
}

async function main() {
  const targets = [...bySlug.keys()]
    .filter((s) => { const d = slugDate.get(s)!; return d >= WINDOW_START && d <= WINDOW_END; })
    .filter((s) => bySlug.get(s)!.some((r) => DIVISIONS.includes(r.division_name)))
    .sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : 1));

  // ── final2 RAW (caption_shape_total) + SERVED (total) from saved pre-show payloads ──
  const f2rawBy = new Map<string, number>();
  const f2servedBy = new Map<string, number>();
  const mbwCounts = new Map<number, number>();
  for (const slug of targets) {
    const D = slugDate.get(slug)!;
    const runs = q(DB, `SELECT payload_json, predicted_at FROM model_event_prediction_runs WHERE event_slug='${slug}' AND model_dir LIKE '%final2%' AND substr(predicted_at,1,10) <= '${D}' ORDER BY predicted_at DESC`);
    if (!runs.length) { process.stderr.write(`[no final2 run] ${slug}\n`); continue; }
    const latestTs = String(runs[0].predicted_at);
    for (const r of runs) {
      if (String(r.predicted_at) !== latestTs) break;
      let pl: any; try { pl = JSON.parse(String(r.payload_json)); } catch { continue; }
      for (const p of pl.predictions ?? []) {
        const key = `${slug}|${String(p.corps_key)}`;
        if (f2servedBy.has(key)) continue;
        const mbw = Number(p.model_blend_weight);
        mbwCounts.set(mbw, (mbwCounts.get(mbw) ?? 0) + 1);
        // raw core = caption_shape_total (pointCaps total). For non-model_q50 corps
        // (mbw<1, rare in late window) fall back to raw_model_total if present.
        const raw = p.caption_shape_total != null ? Number(p.caption_shape_total)
          : p.raw_model_total != null ? Number(p.raw_model_total) : Number(p.total);
        f2rawBy.set(key, raw);
        f2servedBy.set(key, Number(p.total));
      }
    }
  }

  // ── v11 raw: fresh leakage-safe inference over the held-out targets ──
  const v11rawBy = new Map<string, number>();
  _clearEnsembleCache();
  const provV11 = poolProvider(V11_DIR);
  process.stderr.write(`v11 raw inference over ${targets.length} held-out shows...\n`);
  for (const slug of targets) {
    try {
      const res = await predict(buildSeasonData(slug), { provider: provV11, identity: IDENTITY });
      for (const p of res.predictions) v11rawBy.set(`${slug}|${p.corpsKey}`, p.total);
    } catch (e) { process.stderr.write(`  [skip v11] ${slug}: ${e instanceof Error ? e.message : e}\n`); }
  }

  // ── grade ──
  type Row = { slug: string; date: string; corps: number;
    f2raw: Acc; f2served: Acc; v11raw: Acc; v12a: { mae: number; bias: number }; v12b: { mae: number; bias: number }; v12bNoAB: { mae: number; bias: number } };
  const perEvent: Row[] = [];
  const pool = { f2raw: mk(), f2served: mk(), v11raw: mk() };
  // fresh-graded pools; for the reused v12a/v12b we re-pool from per-event n-weighted below.
  for (const slug of targets) {
    const ev: Row = { slug, date: slugDate.get(slug)!, corps: 0,
      f2raw: mk(), f2served: mk(), v11raw: mk(),
      v12a: v12aRawByEvent.get(slug)!, v12b: v12bRawByEvent.get(slug)!, v12bNoAB: v12bNoABByEvent.get(slug)! };
    for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue;
      const ck = String(r.corps_key);
      const key = `${slug}|${ck}`;
      const actual = actualBy.get(key)!;
      ev.corps++;
      const fr = f2rawBy.get(key); if (fr != null) { add(ev.f2raw, fr - actual); add(pool.f2raw, fr - actual); }
      const fs2 = f2servedBy.get(key); if (fs2 != null) { add(ev.f2served, fs2 - actual); add(pool.f2served, fs2 - actual); }
      const v11 = v11rawBy.get(key); if (v11 != null) { add(ev.v11raw, v11 - actual); add(pool.v11raw, v11 - actual); }
    }
    perEvent.push(ev);
  }
  // n-weighted pooled for reused v12a/v12b (per-event mae/bias * n)
  const poolReused = (get: (e: Row) => { mae: number; bias: number }) => {
    let n = 0, abs = 0, sum = 0;
    for (const e of perEvent) { const c = get(e); if (!c) continue; n += e.corps; abs += c.mae * e.corps; sum += c.bias * e.corps; }
    return { n, mae: abs / n, bias: sum / n };
  };
  const v12aPool = poolReused((e) => e.v12a);
  const v12bPool = poolReused((e) => e.v12b);
  const v12bNoABPool = poolReused((e) => e.v12bNoAB);

  // ── report ──
  const out: string[] = [];
  const L = (s = '') => { out.push(s); console.log(s); };
  L(`\n=== FINAL2 RAW-CORE DECOMPOSITION  window ${WINDOW_START}..${WINDOW_END}  (held-out; identity ${IDENTITY}) ===`);
  L(`contract: ${CONTRACT_DB}   final2 model_blend_weight distribution: ${[...mbwCounts.entries()].map(([w, c]) => `${w}:${c}`).join(' ')}\n`);
  L('event                                    date        n | f2 RAW  | f2 served| v11 raw | v12a raw| v12b raw|v12b-noAB');
  L('-'.repeat(112));
  const c = (a: Acc) => f3(mae(a)).padStart(6);
  const cr = (x: { mae: number }) => (x ? f3(x.mae).padStart(6) : '  -  ');
  for (const e of perEvent) {
    L(`${e.slug.padEnd(40)} ${e.date}  ${String(e.corps).padStart(2)} | ${c(e.f2raw)} | ${c(e.f2served)}  | ${c(e.v11raw)} | ${cr(e.v12a)} | ${cr(e.v12b)} | ${cr(e.v12bNoAB)}`);
  }
  L('-'.repeat(112));
  L(`${'POOLED — HELD-OUT'.padEnd(40)} ${''.padEnd(10)} ${String(pool.f2raw.n).padStart(2)} | ${c(pool.f2raw)} | ${c(pool.f2served)}  | ${c(pool.v11raw)} | ${f3(v12aPool.mae).padStart(6)} | ${f3(v12bPool.mae).padStart(6)} | ${f3(v12bNoABPool.mae).padStart(6)}`);
  L(`\nPooled BIAS (points, held-out): f2 RAW ${f3(bias(pool.f2raw))} · f2 served ${f3(bias(pool.f2served))} · v11 raw ${f3(bias(pool.v11raw))} · v12a raw ${f3(v12aPool.bias)} · v12b raw ${f3(v12bPool.bias)} · v12b-noAB ${f3(v12bNoABPool.bias)}`);

  fs.writeFileSync(path.join(REPO, 'tools/backtest-final2raw.out.json'), JSON.stringify({
    window: { start: WINDOW_START, end: WINDOW_END }, contractDb: CONTRACT_DB, identity: IDENTITY,
    final2MbwDistribution: Object.fromEntries(mbwCounts),
    perEvent: perEvent.map((e) => ({
      slug: e.slug, date: e.date, corps: e.corps,
      f2raw: { n: e.f2raw.n, mae: mae(e.f2raw), bias: bias(e.f2raw) },
      f2served: { n: e.f2served.n, mae: mae(e.f2served), bias: bias(e.f2served) },
      v11raw: { n: e.v11raw.n, mae: mae(e.v11raw), bias: bias(e.v11raw) },
      v12aRaw: e.v12a, v12bRaw: e.v12b, v12bNoAB: e.v12bNoAB,
    })),
    pooled: {
      f2raw: { n: pool.f2raw.n, mae: mae(pool.f2raw), bias: bias(pool.f2raw) },
      f2served: { n: pool.f2served.n, mae: mae(pool.f2served), bias: bias(pool.f2served) },
      v11raw: { n: pool.v11raw.n, mae: mae(pool.v11raw), bias: bias(pool.v11raw) },
      v12aRaw: v12aPool, v12bRaw: v12bPool, v12bNoAB: v12bNoABPool,
    },
  }, null, 1));
  process.stderr.write('\nwrote tools/backtest-final2raw.out.json\n');
}
main();
