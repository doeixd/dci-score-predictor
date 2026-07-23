/**
 * DECOMPOSITION BACKTEST — v11w = v11 raw ensemble + final2's exact adaptive
 * wrapper (persistence blend + nightly bias correction), graded on the 9 recent
 * shows (2026-07-17..22). Answers: does the v11 CORE + final2 THERMOSTAT reach
 * final2's ~1.1 late-July MAE? Isolates core vs corrections.
 *
 * Three columns per event + pooled:
 *   final2(served) — what prod ACTUALLY served (model_event_prediction_runs,
 *                    model_dir LIKE '%final2%', latest pre-show run per event).
 *   v11 raw        — 8×v11 identity-0.5 agnostic ensemble, no wrapper (harness).
 *   v11w           — v11 raw + final2 wrapper, leakage-safe.
 *
 * Wrapper math transcribed verbatim from predictEventRecap.ts (see v11wWrapper.ts).
 * Leakage safety: for target show at date D, the bias correction uses ONLY v11's
 * pre-show raw residuals on shows STRICTLY before D; lastTotal/rank/curve use only
 * the corps' shows before D. Reuses backtest-recent.ts's leakage-safe SeasonData.
 *
 * Run: DCI_DB=/root/corps-place/sdk/dci-relational.db \
 *      CONTRACT_DB=/tmp/sdk-assets-contract-0723.db npx tsx tools/backtest-v11w.ts
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

const V11_DIR = process.env.V11_050_DIR ?? '/home/patrick/v11-seeds';
const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract-0723.db';
const WINDOW_START = process.env.BT_START ?? '2026-07-17';
const WINDOW_END = process.env.BT_END ?? '2026-07-22';
const IDENTITY: IdentityMode = 'agnostic';

// final2 wrapper constants (predictEventRecap.ts 231-234)
const BIAS_STRENGTH = 0.67;
const BIAS_CAP = 1.25;
const BIAS_MIN_SAMPLES = 10;

const REFERENCE_CURVES: { curves: Record<string, Record<string, number>> } = JSON.parse(
  fs.readFileSync('/root/corps-place/sdk/src/training/referenceCurvesV4.json', 'utf-8')
);

// ── final2 wrapper helpers (verbatim) ───────────────────────────────────────
const totalFromCaps = (c: Record<string, number>) =>
  c.GE1 + c.GE2 + (c.VP + c.VA + c.CG) / 2 + (c.MB + c.MA + c.MP) / 2;
const estimatePercentThrough = (date: number, start: number, end: number) =>
  Math.max(0, Math.min(100, ((date - start) / Math.max(1, end - start)) * 100));
function curveBaseline(rank: number, pct: number, caption: string): number {
  const r = Math.max(1, Math.min(25, Math.round(Number.isFinite(rank) ? rank : 12)));
  const bucket = Math.round(Math.max(0, Math.min(100, pct)) / 5) * 5;
  const cu = REFERENCE_CURVES.curves;
  return cu[`${r}-${bucket}`]?.[caption] ?? cu[`${r}-50`]?.[caption] ?? 15.0;
}
function curveGrowthTotal(rank: number, fromPct: number, toPct: number): number {
  const g = Object.fromEntries(
    CAPTIONS.map((c) => [c, Math.max(0, curveBaseline(rank, toPct, c) - curveBaseline(rank, fromPct, c))])
  ) as Record<string, number>;
  return totalFromCaps(g);
}
const comparableRevertWeight = (s: number) => (s === 1 ? 0.5 : s === 2 ? 0.3 : s === 3 ? 0.15 : 0);

// ── data (leakage-safe SeasonData; copied from backtest-recent.ts) ──────────
const q = (db: string, sql: string): any[] =>
  JSON.parse(execFileSync('sqlite3', ['-json', '-readonly', db, sql], { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 }) || '[]');

const seasonBounds = q(DB, `SELECT substr(MIN(start_date),1,10) AS start, substr(MAX(start_date),1,10) AS end FROM events WHERE substr(start_date,1,4)='2026'`)[0];
const seasonStartMs = Date.parse(seasonBounds.start);
const seasonEndMs = Date.parse(seasonBounds.end);

const perfRows = q(CONTRACT_DB, `
  SELECT competition_slug AS slug, substr(competition_date,1,10) AS date, percent_through,
         model_corps_key AS corps_key, division_name, total_score, GE1,GE2,VP,VA,CG,MB,MA,MP
  FROM v10_training_performances WHERE season = 2026
  ORDER BY date, competition_slug, model_corps_key`);

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
    async readJson(rel) { if (rel === 'models/MANIFEST.json') return { seeds: members.map((m) => ({ name: m })) }; return JSON.parse(fs.readFileSync(resolve(rel), 'utf-8')); },
    async readBinary(rel) { const b = fs.readFileSync(resolve(rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    async listModelSeeds() { return members; },
  };
};

const actualBy = new Map<string, number>();
const divBy = new Map<string, DivisionName>();
const dateBy = new Map<string, string>();
const pctBy = new Map<string, number>();
for (const r of perfRows) {
  const k = `${r.slug}|${r.corps_key}`;
  actualBy.set(k, Number(r.total_score));
  divBy.set(k, r.division_name as DivisionName);
  dateBy.set(k, String(r.date));
  pctBy.set(k, Number(r.percent_through));
}

// ── corps history helpers from actuals (leakage-safe: only shows before D) ──
const corpsShows = new Map<string, { date: string; total: number; div: DivisionName; pct: number }[]>();
for (const r of perfRows) {
  const arr = corpsShows.get(String(r.corps_key)) ?? corpsShows.set(String(r.corps_key), []).get(String(r.corps_key))!;
  arr.push({ date: String(r.date), total: Number(r.total_score), div: r.division_name as DivisionName, pct: Number(r.percent_through) });
}
for (const arr of corpsShows.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
const priorShows = (corpsKey: string, D: string) => (corpsShows.get(corpsKey) ?? []).filter((s) => s.date < D);
// rank among division by each corps' latest total strictly before D (mirrors
// currentSeasonRank: order by most-recent observed total within the division).
const rankBefore = (corpsKey: string, div: DivisionName, D: string): number => {
  const latestTotal = new Map<string, number>();
  const latestDate = new Map<string, string>();
  for (const [k, d] of dateBy) {
    if (d >= D || divBy.get(k) !== div) continue;
    const ck = k.split('|')[1]!;
    if (!latestDate.has(ck) || d > latestDate.get(ck)!) { latestDate.set(ck, d); latestTotal.set(ck, actualBy.get(k)!); }
  }
  const ordered = [...latestTotal.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const i = ordered.indexOf(corpsKey);
  return i >= 0 ? i + 1 : 12;
};

async function main() {
  // Targets: the graded WC/OC shows in the window.
  const targets = [...bySlug.keys()]
    .filter((s) => { const d = slugDate.get(s)!; return d >= WINDOW_START && d <= WINDOW_END && bySlug.get(s)!.some((r) => DIVISIONS.includes(r.division_name)); })
    .sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : 1));

  // All scored WC/OC shows in 2026 → v11 raw pre-show predictions (residual source + targets).
  const allScored = [...bySlug.keys()]
    .filter((s) => bySlug.get(s)!.some((r) => DIVISIONS.includes(r.division_name)))
    .sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : 1));

  _clearEnsembleCache();
  const provider = poolProvider(V11_DIR);
  // v11 raw pre-show pred per (slug,corps)
  const v11raw = new Map<string, number>();
  process.stderr.write(`Computing v11 raw pre-show predictions for ${allScored.length} scored shows...\n`);
  for (const slug of allScored) {
    try {
      const res = await predict(buildSeasonData(slug), { provider, identity: IDENTITY });
      for (const p of res.predictions) v11raw.set(`${slug}|${p.corpsKey}`, p.total);
    } catch (e) { process.stderr.write(`  [skip resid] ${slug}: ${e instanceof Error ? e.message : e}\n`); }
  }

  // Residual pool: v11 raw pre-show residuals per show (eligible = corps has >=1 prior same-season show).
  type Resid = { date: string; corpsKey: string; err: number };
  const resids: Resid[] = [];
  for (const slug of allScored) {
    const D = slugDate.get(slug)!;
    for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue;
      const ck = String(r.corps_key);
      const pred = v11raw.get(`${slug}|${ck}`);
      const actual = actualBy.get(`${slug}|${ck}`);
      if (pred == null || actual == null) continue;
      if (priorShows(ck, D).length < 1) continue; // eligibility mirrors final2
      resids.push({ date: D, corpsKey: ck, err: pred - actual });
    }
  }
  const biasForDate = (D: string): { correction: number; rawBias: number; n: number } => {
    const rs = resids.filter((r) => r.date < D); // leakage-safe
    if (rs.length === 0) return { correction: 0, rawBias: 0, n: 0 };
    const rawBias = rs.reduce((s, r) => s + r.err, 0) / rs.length;
    if (rs.length < BIAS_MIN_SAMPLES) return { correction: 0, rawBias, n: rs.length };
    const damped = BIAS_STRENGTH * rawBias;
    return { correction: Math.max(-BIAS_CAP, Math.min(BIAS_CAP, damped)), rawBias, n: rs.length };
  };

  // final2 served per (slug,corps) from prod runs — latest pre-show run per event.
  const final2By = new Map<string, number>();
  for (const slug of targets) {
    const D = slugDate.get(slug)!;
    const runs = q(DB, `SELECT payload_json, predicted_at FROM model_event_prediction_runs WHERE event_slug='${slug}' AND model_dir LIKE '%final2%' AND substr(predicted_at,1,10) <= '${D}' ORDER BY predicted_at DESC`);
    if (!runs.length) continue;
    const latestTs = String(runs[0].predicted_at);
    for (const r of runs) {
      if (String(r.predicted_at) !== latestTs) break;
      let pl: any; try { pl = JSON.parse(String(r.payload_json)); } catch { continue; }
      for (const p of pl.predictions ?? []) {
        const ck = String(p.corps_key);
        if (!final2By.has(`${slug}|${ck}`)) final2By.set(`${slug}|${ck}`, Number(p.total));
      }
    }
  }

  // ── grade ──
  type Acc = { n: number; abs: number; sum: number };
  const mk = (): Acc => ({ n: 0, abs: 0, sum: 0 });
  const add = (a: Acc, e: number) => { a.n++; a.abs += Math.abs(e); a.sum += e; };
  const mae = (a: Acc) => (a.n ? a.abs / a.n : NaN);
  const bias = (a: Acc) => (a.n ? a.sum / a.n : NaN);

  const perEvent: { slug: string; date: string; corps: number; f2: Acc; raw: Acc; w: Acc; biasInfo: any }[] = [];
  const poolF2 = mk(), poolRaw = mk(), poolW = mk();

  for (const slug of targets) {
    const D = slugDate.get(slug)!;
    const targetPct = estimatePercentThrough(Date.parse(D), seasonStartMs, seasonEndMs);
    const bi = biasForDate(D);
    const f2 = mk(), raw = mk(), w = mk();
    for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue;
      const ck = String(r.corps_key);
      const actual = actualBy.get(`${slug}|${ck}`)!;
      const rawPred = v11raw.get(`${slug}|${ck}`);
      // v11 raw
      if (rawPred != null) add(raw, rawPred - actual);
      // final2 served
      const f2p = final2By.get(`${slug}|${ck}`);
      if (f2p != null) add(f2, f2p - actual);
      // v11w wrapper
      if (rawPred != null) {
        const hist = priorShows(ck, D);
        let wTotal = rawPred;
        if (hist.length >= 1) {
          const last = hist[hist.length - 1]!;
          const lastPct = estimatePercentThrough(Date.parse(last.date), seasonStartMs, seasonEndMs);
          const rank = rankBefore(ck, r.division_name as DivisionName, D);
          const curveDelta = last.total + curveGrowthTotal(rank, lastPct, targetPct);
          const modelBlend = (rawPred + curveDelta) / 2;
          const horizonDays = Math.max(0, (Date.parse(D) - Date.parse(last.date)) / 86_400_000);
          const persistW = Math.max(0, 1 - horizonDays / 14);
          let inSeason = persistW * last.total + (1 - persistW) * modelBlend;
          // thin-history comparable revert omitted here: prior-season comparable is a
          // separate anchor final2 pulls from corps_scores; for >=4-show corps (all
          // championship-week WC) revert=0, so it is inert on this window. Corps with
          // 1-3 in-season shows in-window are rare; documented in the writeup.
          wTotal = inSeason - bi.correction;
        }
        add(w, wTotal - actual);
      }
    }
    perEvent.push({ slug, date: D, corps: bySlug.get(slug)!.filter((r) => DIVISIONS.includes(r.division_name)).length, f2, raw, w, biasInfo: bi });
    for (const [src, dst] of [[f2, poolF2], [raw, poolRaw], [w, poolW]] as const) { dst.n += src.n; dst.abs += src.abs; dst.sum += src.sum; }
  }

  // ── report ──
  const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');
  console.log(`\n=== DECOMPOSITION BACKTEST  ${WINDOW_START}..${WINDOW_END}  (v11 core = identity-0.5, agnostic) ===\n`);
  console.log('event                                    date        n | final2(served) |  v11 raw  |   v11w    | bias(n,raw→corr)');
  console.log('-'.repeat(122));
  for (const e of perEvent) {
    console.log(
      `${e.slug.padEnd(40)} ${e.date}  ${String(e.corps).padStart(2)} |` +
      `  ${f3(mae(e.f2)).padStart(6)} (${e.f2.n})` +
      `  |  ${f3(mae(e.raw)).padStart(6)}` +
      `  |  ${f3(mae(e.w)).padStart(6)}` +
      `  | n=${e.biasInfo.n} raw=${f3(e.biasInfo.rawBias)}→${f3(e.biasInfo.correction)}`
    );
  }
  console.log('-'.repeat(122));
  console.log(
    `${'POOLED'.padEnd(40)} ${'         '}  ${String(poolRaw.n).padStart(2)} |` +
    `  ${f3(mae(poolF2)).padStart(6)} (${poolF2.n})  |  ${f3(mae(poolRaw)).padStart(6)}  |  ${f3(mae(poolW)).padStart(6)}  |`
  );
  console.log(`\nPooled bias  final2 ${f3(bias(poolF2))}  |  v11 raw ${f3(bias(poolRaw))}  |  v11w ${f3(bias(poolW))}`);
  console.log(`\nVERDICT: v11w pooled MAE ${f3(mae(poolW))} vs final2 served ${f3(mae(poolF2))} (target ~1.1). ` +
    (mae(poolW) <= 1.15 ? 'v11w REACHES final2-class.' : mae(poolW) < mae(poolRaw) ? 'wrapper helps but core still short.' : 'wrapper did not close the gap.'));

  fs.writeFileSync(path.join(REPO, 'tools', 'backtest-v11w.out.json'), JSON.stringify({
    window: { start: WINDOW_START, end: WINDOW_END }, contractDb: CONTRACT_DB, v11Dir: V11_DIR,
    perEvent: perEvent.map((e) => ({ slug: e.slug, date: e.date, corps: e.corps,
      final2: { n: e.f2.n, mae: mae(e.f2), bias: bias(e.f2) }, v11raw: { n: e.raw.n, mae: mae(e.raw), bias: bias(e.raw) },
      v11w: { n: e.w.n, mae: mae(e.w), bias: bias(e.w) }, bias: e.biasInfo })),
    pooled: { final2: { n: poolF2.n, mae: mae(poolF2), bias: bias(poolF2) }, v11raw: { n: poolRaw.n, mae: mae(poolRaw), bias: bias(poolRaw) }, v11w: { n: poolW.n, mae: mae(poolW), bias: bias(poolW) } },
  }, null, 2));
  console.log(`\nwrote tools/backtest-v11w.out.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
