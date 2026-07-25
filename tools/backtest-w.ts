/**
 * backtest-w.ts — GATE G1: evaluate the V13 STRUCTURAL LAYER W ALONE (no neural
 * core, no training) against final2-served on the standing held-out window, per
 * V13_PLAN.md §3.1 + §4 (G1: W ≈ final2-served ±0.2).
 *
 * W is computed by the reusable module src/structural/wLayer.ts (the same code that
 * becomes the V13 training-data preprocessor and serve-time layer). This harness is
 * only DATA PLUMBING + the bias-residual pool + reporting; it reuses the exact
 * leakage-safe machinery of tools/backtest-v12t.ts / backtest-final2raw.ts.
 *
 * Columns: W | final2 served | final2 raw | v12t (v12a core + co-tuned wrapper) | persistence.
 * Windows: held-out 2026-07-21..latest-scored (n=50), in-sample 2026-07-17..07-20 (separate).
 *
 * Leakage discipline: history for every (corps, target) is strictly < target date;
 * W's bias correction uses only W's OWN pre-correction residuals on shows strictly
 * before D; v12t uses the frozen co-tuned constants (V12_COTUNED_RESULTS.md).
 *
 * Run:
 *   DCI_DB=/root/corps-place/sdk/dci-relational.db \
 *   CONTRACT_DB=/tmp/sdk-assets-contract-0725b.db \
 *   V12A_DIR=/home/patrick/v12a-seeds/models \
 *   npx tsx tools/backtest-w.ts
 * V12T=off skips the v12a neural column (W verdict is independent of it).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { predict, _clearEnsembleCache } from '../src/predict.js';
import type { AssetProvider } from '../src/assets/provider.js';
import type { IdentityMode } from '../src/model/identity.js';
import type { SeasonData, ShowInput, PerformanceInput, DivisionName } from '../src/features/types.js';
import { CAPTIONS, type Caption } from '../src/model/contract.js';
import {
  wPreCorrection, applyBias, biasCorrectionFromResiduals, estimatePercentThrough as pctThrough,
  type WContext, type WHistoryShow, type CaptionVec, type Residual, DEFAULT_W_CONFIG,
} from '../src/structural/wLayer.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract-0725b.db';
const V12A_DIR = process.env.V12A_DIR ?? '/home/patrick/v12a-seeds/models';
const RUN_V12T = (process.env.V12T ?? 'on') !== 'off';
const IN_START = process.env.IN_START ?? '2026-07-17';
const IN_END = process.env.IN_END ?? '2026-07-20';
const HO_START = process.env.HO_START ?? '2026-07-21';
const HO_END = process.env.HO_END ?? '2026-07-31'; // upper clamp; latest scored auto-detected
const IDENTITY: IdentityMode = 'agnostic';

// v12t frozen co-tuned constants (V12_COTUNED_RESULTS.md)
const V12T = { H: 25, beta: 0.45, d: 0.5, cap: 1.25 };
const BIAS_MIN_SAMPLES = 10;

const REFERENCE_CURVES = JSON.parse(fs.readFileSync('/root/corps-place/sdk/src/training/referenceCurvesV4.json', 'utf-8'));
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

// ── judges + subcaptions (for the v12a neural column only; W ignores them) ──
const judgeRows = q(DB, `SELECT competition_slug AS slug, normalized_caption_name AS caption, judge_id FROM judge_assignments
  WHERE normalized_caption_name IN ('GE1','GE2','VP','VA','CG','MB','MA','MP') AND judge_id IS NOT NULL AND judge_id<>'' AND judge_id NOT LIKE '%unknown%'`);
const judgesByShow = new Map<string, Partial<Record<Caption, string[]>>>();
for (const r of judgeRows) { const b = judgesByShow.get(r.slug) ?? {}; ((b[r.caption as Caption] ??= []) as string[]).push(String(r.judge_id)); judgesByShow.set(r.slug, b); }
const CAPTION_MAP: Record<string, Caption> = { 'General Effect 1': 'GE1', 'General Effect 2': 'GE2', 'Visual Proficiency': 'VP', 'Visual - Proficiency': 'VP', 'Visual Analysis': 'VA', 'Visual - Analysis': 'VA', 'Color Guard': 'CG', 'Music - Brass': 'MB', 'Music Brass': 'MB', Brass: 'MB', 'Music - Analysis': 'MA', 'Music Analysis': 'MA', 'Music - Percussion': 'MP', 'Music Percussion': 'MP', Percussion: 'MP' };
const CONTENT_V = ['content', 'repertoire', 'composition', 'rep', 'comp', 'design', 'repertoire/composition', 'design development', 'composition development', 'repertoire effect', 'design effect'];
const ACH_V = ['achievement', 'performance', 'execution', 'perf', 'excellence', 'clarity & excellence', 'performer excellence', 'performance/showmanship', 'performer effect', 'accuracy', 'technique', 'intonation', 'tone', 'expression'];
const subCat = (n: string): 'Content' | 'Achievement' | 'Other' => { const s = n.toLowerCase().trim(); if (CONTENT_V.some((v) => s.includes(v))) return 'Content'; if (ACH_V.some((v) => s.includes(v))) return 'Achievement'; return 'Other'; };
const subRows = RUN_V12T ? q(DB, `SELECT competition_slug AS slug, corps_key, caption_name, subcaption_name, score FROM subcaption_scores WHERE competition_slug IN (SELECT DISTINCT competition_slug FROM clean_reference_curve_entries WHERE season=2026)`) : [];
const subByShowCorps = new Map<string, Partial<Record<Caption, { content: number; achievement: number }>>>();
for (const r of subRows) { const cap = CAPTION_MAP[String(r.caption_name)]; if (!cap) continue; const cat = subCat(String(r.subcaption_name)); if (cat === 'Other') continue; const key = `${r.slug}|${r.corps_key}`; const b = subByShowCorps.get(key) ?? {}; const e = (b[cap] ??= { content: 0, achievement: 0 }); if (cat === 'Content') e.content += Number(r.score); else e.achievement += Number(r.score); subByShowCorps.set(key, b); }
const toPerf = (r: any): PerformanceInput => ({ corpsKey: String(r.corps_key), corpsName: String(r.corps_key), division: r.division_name as DivisionName, total: Number(r.total_score), captions: Object.fromEntries(CAPTIONS.map((c) => [c, Number(r[c])])) as Partial<Record<Caption, number>>, subcaptions: subByShowCorps.get(`${r.slug}|${r.corps_key}`) });

// ── indexes ──
const bySlug = new Map<string, any[]>();
const slugDate = new Map<string, string>();
for (const r of perfRows) { (bySlug.get(r.slug) ?? bySlug.set(r.slug, []).get(r.slug)!).push(r); slugDate.set(r.slug, String(r.date)); }
const DIVISIONS: DivisionName[] = ['World Class', 'Open Class'];
const capsOf = (r: any): CaptionVec => Object.fromEntries(CAPTIONS.map((c) => [c, Number(r[c])])) as CaptionVec;

const actualBy = new Map<string, number>();
const divBy = new Map<string, DivisionName>();
const dateBy = new Map<string, string>();
for (const r of perfRows) { const k = `${r.slug}|${r.corps_key}`; actualBy.set(k, Number(r.total_score)); divBy.set(k, r.division_name as DivisionName); dateBy.set(k, String(r.date)); }

// per-corps history with caption vectors (leakage-safe filtering happens per target)
const corpsShows = new Map<string, WHistoryShow[]>();
for (const r of perfRows) { const ck = String(r.corps_key); const arr = corpsShows.get(ck) ?? corpsShows.set(ck, []).get(ck)!; arr.push({ slug: String(r.slug), date: String(r.date), division: String(r.division_name), captions: capsOf(r), total: Number(r.total_score) }); }
for (const arr of corpsShows.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));

// rankBefore — currentSeasonRank analog (latest same-season total in division before D)
const rankBefore = (corpsKey: string, div: string, D: string): number => {
  const latestTotal = new Map<string, number>(); const latestDate = new Map<string, string>();
  for (const [k, d] of dateBy) { if (d >= D || divBy.get(k) !== div) continue; const ck = k.split('|')[1]!; if (!latestDate.has(ck) || d > latestDate.get(ck)!) { latestDate.set(ck, d); latestTotal.set(ck, actualBy.get(k)!); } }
  const ordered = [...latestTotal.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
  const i = ordered.indexOf(corpsKey); return i >= 0 ? i + 1 : 12;
};
// priorComparable — getPriorSeasonComparableTotal (DCI_DB corps_scores + competitions)
const comparableCache = new Map<string, { total: number; percentThrough: number } | undefined>();
const priorComparable = (corpsKey: string, priorSeason: string, targetPct: number): { total: number; percentThrough: number } | undefined => {
  const key = `${corpsKey}|${priorSeason}|${targetPct.toFixed(1)}`;
  if (comparableCache.has(key)) return comparableCache.get(key);
  const rows = q(DB, `SELECT cs.total_score AS total_score, comp.percent_through AS percent_through
    FROM corps_scores cs JOIN competitions comp ON comp.slug=cs.competition_slug
    WHERE cs.corps_key='${corpsKey}' AND comp.season='${priorSeason}' AND cs.total_score>0 AND cs.total_score<=100
    ORDER BY ABS(COALESCE(comp.percent_through,50)-${targetPct}) ASC, comp.date ASC LIMIT 1`);
  const row = rows[0];
  let out: { total: number; percentThrough: number } | undefined;
  if (row && row.total_score != null) {
    const matchedPercent = row.percent_through == null ? 50 : Number(row.percent_through);
    out = (targetPct <= 5 && matchedPercent > 10) ? undefined : { total: Number(row.total_score), percentThrough: matchedPercent };
  }
  comparableCache.set(key, out); return out;
};

const ctx: WContext = { curves: REFERENCE_CURVES, seasonStartMs, seasonEndMs, config: DEFAULT_W_CONFIG, rankBefore, priorComparable };
const historyBefore = (ck: string, D: string): WHistoryShow[] => (corpsShows.get(ck) ?? []).filter((h) => h.date < D);
const seasonOf = (D: string) => D.slice(0, 4);

// ── accumulators ──
type Acc = { n: number; abs: number; sum: number };
const mk = (): Acc => ({ n: 0, abs: 0, sum: 0 });
const add = (a: Acc, e: number) => { a.n++; a.abs += Math.abs(e); a.sum += e; };
const mae = (a: Acc) => (a.n ? a.abs / a.n : NaN);
const bias = (a: Acc) => (a.n ? a.sum / a.n : NaN);
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');

// SeasonData builder for the v12a neural column (leakage-safe, same as v12t)
const slugPct = new Map<string, number>();
for (const r of perfRows) slugPct.set(String(r.slug), Number(r.percent_through));
const buildSeasonData = (targetSlug: string): SeasonData => {
  const targetDate = slugDate.get(targetSlug)!; const showMap = new Map<string, ShowInput>();
  for (const r of perfRows) { if (String(r.date) >= targetDate) continue; const show = showMap.get(r.slug) ?? { slug: String(r.slug), date: String(r.date), percentThrough: Number(r.percent_through), results: [] as PerformanceInput[], judges: judgesByShow.get(String(r.slug)) }; show.results.push(toPerf(r)); showMap.set(String(r.slug), show); }
  const lineup = bySlug.get(targetSlug)!.filter((r) => DIVISIONS.includes(r.division_name)).map((r) => ({ corpsKey: String(r.corps_key), corpsName: String(r.corps_key), division: r.division_name as DivisionName }));
  return { seasonInfo: { year: 2026, startDate: seasonBounds.start, endDate: seasonBounds.end }, shows: [...showMap.values()], target: { slug: targetSlug, date: targetDate, percentThrough: slugPct.get(targetSlug), lineup, judges: judgesByShow.get(targetSlug) } };
};
const poolProvider = (root: string): AssetProvider => {
  const members = fs.readdirSync(root).filter((n) => /seed\d+_/.test(n) && fs.existsSync(path.join(root, n, 'model.json'))).sort();
  if (members.length !== 8) throw new Error(`expected 8 seeds in ${root}, found ${members.length}`);
  const resolve = (rel: string) => { const p = rel.split('/'); return path.join(root, p[1]!, p.slice(2).join('/')); };
  return { async readJson(rel: string) { if (rel === 'models/MANIFEST.json') return { seeds: members.map((m) => ({ name: m })) }; return JSON.parse(fs.readFileSync(resolve(rel), 'utf-8')); }, async readBinary(rel: string) { const b = fs.readFileSync(resolve(rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }, async listModelSeeds() { return members; } } as AssetProvider;
};
// v12t pre-correction total forecast (neural core + curveΔ blend). Total-level, per v12t.
const totalFromCaps = (c: CaptionVec) => c.GE1 + c.GE2 + (c.VP + c.VA + c.CG) / 2 + (c.MB + c.MA + c.MP) / 2;
const curveBaseline = (rank: number, pct: number, cap: string) => { const r = Math.max(1, Math.min(25, Math.round(rank))); const b = Math.round(Math.max(0, Math.min(100, pct)) / 5) * 5; const cu = REFERENCE_CURVES.curves; return cu[`${r}-${b}`]?.[cap] ?? cu[`${r}-50`]?.[cap] ?? 15.0; };
const curveGrowthTotal = (rank: number, from: number, to: number) => totalFromCaps(Object.fromEntries(CAPTIONS.map((c) => [c, Math.max(0, curveBaseline(rank, to, c) - curveBaseline(rank, from, c))])) as CaptionVec);

async function main() {
  const allScored = [...bySlug.keys()].filter((s) => bySlug.get(s)!.some((r) => DIVISIONS.includes(r.division_name))).sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : 1));
  const latestScored = allScored.reduce((m, s) => (slugDate.get(s)! > m ? slugDate.get(s)! : m), '0000');
  const inTargets = allScored.filter((s) => { const d = slugDate.get(s)!; return d >= IN_START && d <= IN_END; });
  const hoTargets = allScored.filter((s) => { const d = slugDate.get(s)!; return d >= HO_START && d <= HO_END; });
  process.stderr.write(`latest scored ${latestScored}; in-sample ${inTargets.length} shows, held-out ${hoTargets.length} shows\n`);

  // ── W: pre-correction pool over ALL scored shows, then per-event bias, then W ──
  const wPre = new Map<string, ReturnType<typeof wPreCorrection>>();
  const wResids: Residual[] = [];
  for (const slug of allScored) {
    const D = slugDate.get(slug)!;
    for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue;
      const ck = String(r.corps_key); const key = `${slug}|${ck}`;
      const pre = wPreCorrection(historyBefore(ck, D), { corpsKey: ck, division: String(r.division_name), targetDate: D, season: seasonOf(D) }, ctx);
      wPre.set(key, pre);
      const actual = actualBy.get(key);
      if (pre.components.hasHistory && actual != null) wResids.push({ date: D, err: pre.total - actual }); // W's OWN pre-corr residual
    }
  }

  // ── v12a raw neural inference (for v12t column) ──
  const v12aBy = new Map<string, number>();
  if (RUN_V12T) {
    _clearEnsembleCache(); const prov = poolProvider(V12A_DIR);
    process.stderr.write(`v12a inference over ${allScored.length} scored shows...\n`);
    for (const slug of allScored) { try { const res = await predict(buildSeasonData(slug), { provider: prov, identity: IDENTITY }); for (const p of res.predictions) v12aBy.set(`${slug}|${p.corpsKey}`, p.total); } catch (e) { process.stderr.write(`  [skip v12a] ${slug}: ${e instanceof Error ? e.message : e}\n`); } }
  }
  const targetPctOf = (slug: string) => pctThrough(Date.parse(slugDate.get(slug)!), seasonStartMs, seasonEndMs);
  // v12t pre-correction total + self-referential residual pool
  const v12tPre = new Map<string, number>(); const v12tResids: Residual[] = [];
  if (RUN_V12T) for (const slug of allScored) {
    const D = slugDate.get(slug)!; const tp = targetPctOf(slug);
    for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue; const ck = String(r.corps_key); const key = `${slug}|${ck}`;
      const raw = v12aBy.get(key); if (raw == null) continue;
      const hist = historyBefore(ck, D);
      let pc: number;
      if (hist.length < 1) pc = raw; else { const last = hist[hist.length - 1]!; const lastPct = pctThrough(Date.parse(last.date), seasonStartMs, seasonEndMs); const rank = rankBefore(ck, String(r.division_name), D); const curveDelta = last.total + curveGrowthTotal(rank, lastPct, tp); const modelBlend = V12T.beta * raw + (1 - V12T.beta) * curveDelta; const hd = Math.max(0, (Date.parse(D) - Date.parse(last.date)) / 86_400_000); const pw = Math.max(0, 1 - hd / V12T.H); pc = pw * last.total + (1 - pw) * modelBlend; }
      v12tPre.set(key, pc);
      const actual = actualBy.get(key); if (hist.length >= 1 && actual != null) v12tResids.push({ date: D, err: pc - actual });
    }
  }
  const v12tBiasFor = (D: string) => { const rs = v12tResids.filter((r) => r.date < D); if (rs.length < BIAS_MIN_SAMPLES) return 0; return Math.max(-V12T.cap, Math.min(V12T.cap, V12T.d * (rs.reduce((s, r) => s + r.err, 0) / rs.length))); };

  // ── final2 served + raw from prod payloads ──
  const f2servedBy = new Map<string, number>(); const f2rawBy = new Map<string, number>(); const f2payload = new Map<string, any>();
  for (const slug of [...inTargets, ...hoTargets]) {
    const D = slugDate.get(slug)!;
    const runs = q(DB, `SELECT payload_json, predicted_at FROM model_event_prediction_runs WHERE event_slug='${slug}' AND model_dir LIKE '%final2%' AND substr(predicted_at,1,10)<='${D}' ORDER BY predicted_at DESC`);
    if (!runs.length) { process.stderr.write(`[no final2 run] ${slug}\n`); continue; }
    const latestTs = String(runs[0].predicted_at);
    for (const r of runs) { if (String(r.predicted_at) !== latestTs) break; let pl: any; try { pl = JSON.parse(String(r.payload_json)); } catch { continue; } for (const p of pl.predictions ?? []) { const key = `${slug}|${String(p.corps_key)}`; if (f2servedBy.has(key)) continue; const raw = p.caption_shape_total != null ? Number(p.caption_shape_total) : p.raw_model_total != null ? Number(p.raw_model_total) : Number(p.total); f2rawBy.set(key, raw); f2servedBy.set(key, Number(p.total)); f2payload.set(key, p); } }
  }

  // ── grade ──
  type Cols = { W: Acc; f2s: Acc; f2r: Acc; v12t: Acc; persist: Acc };
  const mkCols = (): Cols => ({ W: mk(), f2s: mk(), f2r: mk(), v12t: mk(), persist: mk() });
  const gradeInto = (cols: Cols, slug: string, wCorr: number, rows: any[]) => {
    const D = slugDate.get(slug)!; const v12tCorr = RUN_V12T ? v12tBiasFor(D) : 0;
    for (const r of rows) {
      if (!DIVISIONS.includes(r.division_name)) continue; const ck = String(r.corps_key); const key = `${slug}|${ck}`;
      const actual = actualBy.get(key); if (actual == null) continue;
      const pre = wPre.get(key); if (pre) add(cols.W, applyBias(pre, wCorr).total - actual);
      const fs2 = f2servedBy.get(key); if (fs2 != null) add(cols.f2s, fs2 - actual);
      const fr = f2rawBy.get(key); if (fr != null) add(cols.f2r, fr - actual);
      if (RUN_V12T) { const pc = v12tPre.get(key); if (pc != null) { const hist = historyBefore(ck, D); add(cols.v12t, (hist.length >= 1 ? pc - v12tCorr : pc) - actual); } }
      const hist = historyBefore(ck, D); if (hist.length >= 1) add(cols.persist, hist[hist.length - 1]!.total - actual);
    }
  };
  const wBiasFor = (D: string) => biasCorrectionFromResiduals(wResids, D, DEFAULT_W_CONFIG).correction;

  const perEvent: { slug: string; date: string; n: number; ho: boolean; cols: Cols }[] = [];
  const pooledHO = mkCols(); const pooledIN = mkCols();
  for (const slug of [...inTargets, ...hoTargets]) {
    const D = slugDate.get(slug)!; const ho = D >= HO_START; const wCorr = wBiasFor(D);
    const cols = mkCols(); const rows = bySlug.get(slug)!;
    gradeInto(cols, slug, wCorr, rows);
    gradeInto(ho ? pooledHO : pooledIN, slug, wCorr, rows);
    perEvent.push({ slug, date: D, n: cols.W.n, ho, cols });
  }
  perEvent.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.slug < b.slug ? -1 : 1));

  // tier splits on held-out (by division + actual-score tier)
  const tierAcc: Record<string, Cols> = { 'WC': mkCols(), 'OC': mkCols(), 'top(>=85)': mkCols(), 'mid(80-85)': mkCols(), 'low(<80)': mkCols() };
  for (const slug of hoTargets) {
    const D = slugDate.get(slug)!; const wCorr = wBiasFor(D); const v12tCorr = RUN_V12T ? v12tBiasFor(D) : 0;
    for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue; const ck = String(r.corps_key); const key = `${slug}|${ck}`; const actual = actualBy.get(key); if (actual == null) continue;
      const buckets = [r.division_name === 'World Class' ? 'WC' : 'OC', actual >= 85 ? 'top(>=85)' : actual >= 80 ? 'mid(80-85)' : 'low(<80)'];
      for (const bkt of buckets) { const c = tierAcc[bkt]; const pre = wPre.get(key); if (pre) add(c.W, applyBias(pre, wCorr).total - actual); const fs2 = f2servedBy.get(key); if (fs2 != null) add(c.f2s, fs2 - actual); const fr = f2rawBy.get(key); if (fr != null) add(c.f2r, fr - actual); if (RUN_V12T) { const pc = v12tPre.get(key); if (pc != null) { const hist = historyBefore(ck, D); add(c.v12t, (hist.length >= 1 ? pc - v12tCorr : pc) - actual); } } const hist = historyBefore(ck, D); if (hist.length >= 1) add(c.persist, hist[hist.length - 1]!.total - actual); }
    }
  }

  // ── component-level comparison: 10 held-out corps, W components vs final2 payload ──
  const compRows: any[] = [];
  const hoAll: { key: string; slug: string; ck: string; D: string }[] = [];
  for (const slug of hoTargets) for (const r of bySlug.get(slug)!) if (DIVISIONS.includes(r.division_name)) hoAll.push({ key: `${slug}|${String(r.corps_key)}`, slug, ck: String(r.corps_key), D: slugDate.get(slug)! });
  for (const { key, ck, D } of hoAll.filter((x) => f2payload.has(x.key)).slice(0, 10)) {
    const pre = wPre.get(key)!; const wCorr = wBiasFor(D); const w = applyBias(pre, wCorr); const c = pre.components; const p = f2payload.get(key); const actual = actualBy.get(key);
    compRows.push({ corps: ck.slice(0, 10), actual, W_total: +w.total.toFixed(3), W_preCorr: +c.preCorrTotal.toFixed(3), W_lastTotal: c.lastTotal, W_curveDeltaTotal: c.curveDeltaTotal != null ? +c.curveDeltaTotal.toFixed(3) : null, W_persistW: +c.persistWeight.toFixed(3), W_inSeasonPreRevert: c.inSeasonPreRevertTotal != null ? +c.inSeasonPreRevertTotal.toFixed(3) : null, W_revert: c.revertWeight, W_comparable: c.comparableTotal, W_bias: +wCorr.toFixed(3), W_rank: c.rank, f2_served: p.total, f2_caption_shape_total: p.caption_shape_total, f2_comparable: p.prior_season_comparable_total ?? null, f2_comparable_revert: p.comparable_revert_weight ?? null, f2_bias: p.season_bias_correction ?? null, f2_mbw: p.model_blend_weight });
  }

  // ── report ──
  const out: string[] = []; const L = (s = '') => { out.push(s); console.log(s); };
  const colLine = (label: string, c: Cols) => L(`${label.padEnd(34)} W ${f3(mae(c.W)).padStart(6)} | f2srv ${f3(mae(c.f2s)).padStart(6)} | f2raw ${f3(mae(c.f2r)).padStart(6)} | v12t ${f3(mae(c.v12t)).padStart(6)} | persist ${f3(mae(c.persist)).padStart(6)}   (n=${c.W.n})`);
  L(`\n=== V13 GATE G1 — W-ALONE vs final2-served ===`);
  L(`held-out ${HO_START}..${latestScored} | in-sample ${IN_START}..${IN_END} | identity ${IDENTITY} | contract ${CONTRACT_DB}`);
  L(`W config: H=${DEFAULT_W_CONFIG.H} d=${DEFAULT_W_CONFIG.biasDamp} cap=${DEFAULT_W_CONFIG.biasCap} minSamples=${DEFAULT_W_CONFIG.biasMinSamples} (co-tuned V12t) | v12t constants H=${V12T.H} beta=${V12T.beta} d=${V12T.d} cap=${V12T.cap}${RUN_V12T ? '' : ' [v12t OFF]'}\n`);
  L(`-- PER-EVENT MAE (points) --`);
  for (const e of perEvent) colLine(`${e.ho ? 'HO ' : 'in '}${e.date} ${e.slug}`, e.cols);
  L(`-- POOLED MAE --`);
  colLine('POOLED HELD-OUT', pooledHO); colLine('POOLED IN-SAMPLE', pooledIN);
  const biasLine = (label: string, c: Cols) => L(`${label.padEnd(20)} W ${f3(bias(c.W)).padStart(7)} | f2srv ${f3(bias(c.f2s)).padStart(7)} | f2raw ${f3(bias(c.f2r)).padStart(7)} | v12t ${f3(bias(c.v12t)).padStart(7)} | persist ${f3(bias(c.persist)).padStart(7)}`);
  L(`-- POOLED BIAS --`); biasLine('HELD-OUT bias', pooledHO); biasLine('IN-SAMPLE bias', pooledIN);
  L(`-- TIER SPLITS (held-out) --`); for (const k of Object.keys(tierAcc)) colLine(k, tierAcc[k]);

  const wHO = mae(pooledHO.W), f2HO = mae(pooledHO.f2s); const gap = wHO - f2HO;
  L(`\n=== G1 VERDICT (held-out, n=${pooledHO.W.n}) ===`);
  L(`W ${f3(wHO)} vs final2-served ${f3(f2HO)}: gap ${gap >= 0 ? '+' : ''}${f3(gap)} MAE.`);
  const pass = Math.abs(gap) <= 0.2;
  L(pass ? `G1 PASS: W is within ±0.2 of final2-served.` : `G1 SHORT: |gap| ${f3(Math.abs(gap))} > 0.2 — iterate (curveΔ fidelity / comparables / bias density).`);

  L(`\n-- COMPONENT COMPARISON (10 held-out corps): W components vs final2 payload --`);
  for (const c of compRows) L(JSON.stringify(c));

  fs.writeFileSync(path.join(REPO, 'tools', 'backtest-w.out.json'), JSON.stringify({
    windows: { heldOut: { start: HO_START, end: latestScored }, inSample: { start: IN_START, end: IN_END } },
    config: DEFAULT_W_CONFIG, v12tConstants: V12T, runV12t: RUN_V12T, contractDb: CONTRACT_DB,
    pooled: { heldOut: colsJson(pooledHO), inSample: colsJson(pooledIN) },
    perEvent: perEvent.map((e) => ({ slug: e.slug, date: e.date, ho: e.ho, n: e.n, cols: colsJson(e.cols) })),
    tiers: Object.fromEntries(Object.entries(tierAcc).map(([k, v]) => [k, colsJson(v)])),
    verdict: { gap, pass, wHO, f2HO },
    componentComparison: compRows,
  }, null, 2));
  L(`\nwrote tools/backtest-w.out.json`);
  function colsJson(c: Cols) { return { W: accJson(c.W), f2served: accJson(c.f2s), f2raw: accJson(c.f2r), v12t: accJson(c.v12t), persist: accJson(c.persist) }; }
  function accJson(a: Acc) { return { n: a.n, mae: mae(a), bias: bias(a) }; }
}
main().catch((e) => { console.error(e); process.exit(1); });
