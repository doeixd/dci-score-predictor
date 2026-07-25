/**
 * V12 ARM B JUDGING — field-level-relative targets, with the serving ADD-BACK.
 *
 * Arm B trained `recap_target_c = recap_c - field_level_live * w_c/5` (climate
 * removed, per docs/V12_ARM_B_NOTES.md). The model's standard serving path
 * therefore reconstructs the CLIMATE-REMOVED recap; the correct served score
 * ADDS BACK the live, unshrunk field level distributed with the same weights:
 *
 *   served_total = model_total + field_level_live * (Σ w_c²)/5
 *                = model_total + 0.70 * field_level_live      (Σ w_c² = 3.5)
 *
 * field_level_live = TemporalState.fieldSnapshot(2026, division, D).level — the
 * UNSCALED, division-wide, strictly-pre-show field level (same quantity stored in
 * v10_temporal_field_pace.field_level_vs_reference), computed on the fly from the
 * leakage-safe SeasonData, exactly as src/features/build.ts does.
 *
 * Columns per event + pooled (held-out SEPARATED from in-sample):
 *   v12b          — arm-B pool, standard path + field-level add-back (the SERVED core).
 *   v12b-noAB     — arm-B pool, standard path, NO add-back (ablation: proves add-back matters).
 *   v12bw         — v12b (with add-back) + final2's EXACT wrapper (bias from v12b's own residuals).
 *   final2        — what prod actually served (model_dir LIKE '%final2%', latest pre-show).
 *   v11w          — v11 identity-0.5 raw + final2 wrapper (reproduces published v11w).
 *   v12a raw      — arm-A persistence-residual pool, standard path (no wrapper).
 *   persistence   — pure last-real total + leakage-safe reference-curve gain.
 *
 * Leakage safety: for target show at date D, all model inputs / field level use
 * SeasonData built only from shows STRICTLY before D; each wrapper's bias uses only
 * that model's raw pre-show residuals on shows strictly before D. Held-out = date
 * > cutoff 2026-07-20.
 *
 * Run: DCI_DB=/root/corps-place/sdk/dci-relational.db \
 *      CONTRACT_DB=/tmp/sdk-assets-contract-0725b.db \
 *      V12B_DIR=/home/patrick/v12b-seeds/models V12A_DIR=/home/patrick/v12a-seeds/models \
 *      V11_050_DIR=/home/patrick/v11-seeds BT_END=2026-07-24 npx tsx tools/backtest-v12b.ts
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTIONS, type Caption } from '../src/model/contract.js';
import { predict, _clearEnsembleCache } from '../src/predict.js';
import { replayTemporal } from '../src/features/build.js';
import { getJsonSync } from '../src/assets/provider.js';
import type { FeatureContext } from '../src/features/types.js';
import type { AssetProvider } from '../src/assets/provider.js';
import type { IdentityMode } from '../src/model/identity.js';
import type { SeasonData, ShowInput, PerformanceInput, DivisionName } from '../src/features/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const V12B_DIR = process.env.V12B_DIR ?? '/home/patrick/v12b-seeds/models';
const V12A_DIR = process.env.V12A_DIR ?? '/home/patrick/v12a-seeds/models';
const V11_DIR = process.env.V11_050_DIR ?? '/home/patrick/v11-seeds';
const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract-0725b.db';
const WINDOW_START = process.env.BT_START ?? '2026-07-17';
const WINDOW_END = process.env.BT_END ?? '2026-07-24';
const CUTOFF = process.env.V12_CUTOFF ?? '2026-07-20'; // events with date > cutoff are held-out
const IDENTITY: IdentityMode = 'agnostic';

// arm-B add-back: caption weights w=[1,1,.5,.5,.5,.5,.5,.5]; total add-back factor = Σ w_c²/5 = 3.5/5.
const ADDBACK_FACTOR = 3.5 / 5; // 0.70

// final2 wrapper constants (predictEventRecap.ts 231-234)
const BIAS_STRENGTH = 0.67;
const BIAS_CAP = 1.25;
const BIAS_MIN_SAMPLES = 10;

const REFERENCE_CURVES: { curves: Record<string, Record<string, number>> } = JSON.parse(
  fs.readFileSync('/root/corps-place/sdk/src/training/referenceCurvesV4.json', 'utf-8')
);

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
    async readJson(rel: string) { if (rel === 'models/MANIFEST.json') return { seeds: members.map((m) => ({ name: m })) }; return JSON.parse(fs.readFileSync(resolve(rel), 'utf-8')); },
    async readBinary(rel: string) { const b = fs.readFileSync(resolve(rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    async listModelSeeds() { return members; },
  } as AssetProvider;
};

const actualBy = new Map<string, number>();
const divBy = new Map<string, DivisionName>();
const dateBy = new Map<string, string>();
for (const r of perfRows) {
  const k = `${r.slug}|${r.corps_key}`;
  actualBy.set(k, Number(r.total_score));
  divBy.set(k, r.division_name as DivisionName);
  dateBy.set(k, String(r.date));
}

const corpsShows = new Map<string, { date: string; total: number; div: DivisionName }[]>();
for (const r of perfRows) {
  const arr = corpsShows.get(String(r.corps_key)) ?? corpsShows.set(String(r.corps_key), []).get(String(r.corps_key))!;
  arr.push({ date: String(r.date), total: Number(r.total_score), div: r.division_name as DivisionName });
}
for (const arr of corpsShows.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));
const priorShows = (corpsKey: string, D: string) => (corpsShows.get(corpsKey) ?? []).filter((s) => s.date < D);
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

// ── field level (arm-B add-back term): unshrunk, division-wide, strictly-pre-show ──
let _fc: FeatureContext | null = null; // lazily loaded AFTER predict() primes the async asset cache
const featureContext = (): FeatureContext => (_fc ??= getJsonSync<FeatureContext>('registries/featureContext.json'));
const fieldLevelBy = new Map<string, number>(); // key = slug|division
const fieldLevel = (slug: string, division: DivisionName): number => {
  const key = `${slug}|${division}`;
  if (fieldLevelBy.has(key)) return fieldLevelBy.get(key)!;
  const { temporal } = replayTemporal(buildSeasonData(slug), featureContext());
  const lvl = temporal.fieldSnapshot(2026, division, slugDate.get(slug)!).level;
  fieldLevelBy.set(key, lvl);
  return lvl;
};

// ── accumulators ─────────────────────────────────────────────────────────────
type Acc = { n: number; abs: number; sum: number };
const mk = (): Acc => ({ n: 0, abs: 0, sum: 0 });
const add = (a: Acc, e: number) => { a.n++; a.abs += Math.abs(e); a.sum += e; };
const mae = (a: Acc) => (a.n ? a.abs / a.n : NaN);
const bias = (a: Acc) => (a.n ? a.sum / a.n : NaN);
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');

function applyWrapper(rawPred: number, ck: string, div: DivisionName, D: string, targetPct: number, correction: number): number {
  const hist = priorShows(ck, D);
  if (hist.length < 1) return rawPred;
  const last = hist[hist.length - 1]!;
  const lastPct = estimatePercentThrough(Date.parse(last.date), seasonStartMs, seasonEndMs);
  const rank = rankBefore(ck, div, D);
  const curveDelta = last.total + curveGrowthTotal(rank, lastPct, targetPct);
  const modelBlend = (rawPred + curveDelta) / 2;
  const horizonDays = Math.max(0, (Date.parse(D) - Date.parse(last.date)) / 86_400_000);
  const persistW = Math.max(0, 1 - horizonDays / 14);
  const inSeason = persistW * last.total + (1 - persistW) * modelBlend;
  return inSeason - correction;
}

async function main() {
  const allScored = [...bySlug.keys()]
    .filter((s) => bySlug.get(s)!.some((r) => DIVISIONS.includes(r.division_name)))
    .sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : 1));
  const targets = allScored.filter((s) => { const d = slugDate.get(s)!; return d >= WINDOW_START && d <= WINDOW_END; });

  // ── raw pre-show predictions (fresh inference) over all scored shows ──
  const v12bRawBy = new Map<string, number>(); // climate-removed model total (NO add-back)
  const v12aBy = new Map<string, number>();
  const v11rawBy = new Map<string, number>();

  _clearEnsembleCache();
  const provV12b = poolProvider(V12B_DIR);
  process.stderr.write(`v12b inference over ${allScored.length} scored shows...\n`);
  for (const slug of allScored) {
    try {
      const res = await predict(buildSeasonData(slug), { provider: provV12b, identity: IDENTITY });
      for (const p of res.predictions) v12bRawBy.set(`${slug}|${p.corpsKey}`, p.total);
    } catch (e) { process.stderr.write(`  [skip v12b] ${slug}: ${e instanceof Error ? e.message : e}\n`); }
  }

  _clearEnsembleCache();
  const provV12a = poolProvider(V12A_DIR);
  process.stderr.write(`v12a inference over ${allScored.length} scored shows...\n`);
  for (const slug of allScored) {
    try {
      const res = await predict(buildSeasonData(slug), { provider: provV12a, identity: IDENTITY });
      for (const p of res.predictions) v12aBy.set(`${slug}|${p.corpsKey}`, p.total);
    } catch (e) { process.stderr.write(`  [skip v12a] ${slug}: ${e instanceof Error ? e.message : e}\n`); }
  }

  _clearEnsembleCache();
  const provV11 = poolProvider(V11_DIR);
  process.stderr.write(`v11 raw inference over ${allScored.length} scored shows...\n`);
  for (const slug of allScored) {
    try {
      const res = await predict(buildSeasonData(slug), { provider: provV11, identity: IDENTITY });
      for (const p of res.predictions) v11rawBy.set(`${slug}|${p.corpsKey}`, p.total);
    } catch (e) { process.stderr.write(`  [skip v11] ${slug}: ${e instanceof Error ? e.message : e}\n`); }
  }

  // v12b SERVED (with add-back) — this is the promote candidate & the wrapper's core.
  const v12bBy = new Map<string, number>();
  for (const [k, raw] of v12bRawBy) {
    const [slug, ...rest] = k.split('|'); const ck = rest.join('|');
    const div = divBy.get(k)!;
    if (!div) continue;
    v12bBy.set(k, raw + ADDBACK_FACTOR * fieldLevel(slug!, div));
  }

  // Residual pools for wrappers (leakage-safe by date; each sources its OWN core's residuals).
  type Resid = { date: string; err: number };
  const buildResids = (rawBy: Map<string, number>): Resid[] => {
    const out: Resid[] = [];
    for (const slug of allScored) {
      const D = slugDate.get(slug)!;
      for (const r of bySlug.get(slug)!) {
        if (!DIVISIONS.includes(r.division_name)) continue;
        const ck = String(r.corps_key);
        const pred = rawBy.get(`${slug}|${ck}`); const actual = actualBy.get(`${slug}|${ck}`);
        if (pred == null || actual == null) continue;
        if (priorShows(ck, D).length < 1) continue;
        out.push({ date: D, err: pred - actual });
      }
    }
    return out;
  };
  const residsV11 = buildResids(v11rawBy);
  const residsV12b = buildResids(v12bBy); // wrapper uses the SERVED (add-back) core's residuals
  const biasForDate = (resids: Resid[], D: string) => {
    const rs = resids.filter((r) => r.date < D);
    if (!rs.length) return { correction: 0, rawBias: 0, n: 0 };
    const rawBias = rs.reduce((s, r) => s + r.err, 0) / rs.length;
    if (rs.length < BIAS_MIN_SAMPLES) return { correction: 0, rawBias, n: rs.length };
    return { correction: Math.max(-BIAS_CAP, Math.min(BIAS_CAP, BIAS_STRENGTH * rawBias)), rawBias, n: rs.length };
  };

  // final2 served
  const final2By = new Map<string, number>();
  for (const slug of targets) {
    const D = slugDate.get(slug)!;
    const runs = q(DB, `SELECT payload_json, predicted_at FROM model_event_prediction_runs WHERE event_slug='${slug}' AND model_dir LIKE '%final2%' AND substr(predicted_at,1,10) <= '${D}' ORDER BY predicted_at DESC`);
    if (!runs.length) continue;
    const latestTs = String(runs[0].predicted_at);
    for (const r of runs) {
      if (String(r.predicted_at) !== latestTs) break;
      let pl: any; try { pl = JSON.parse(String(r.payload_json)); } catch { continue; }
      for (const p of pl.predictions ?? []) { const ck = String(p.corps_key); if (!final2By.has(`${slug}|${ck}`)) final2By.set(`${slug}|${ck}`, Number(p.total)); }
    }
  }

  // ── grade ──
  type Row = { slug: string; date: string; held: boolean; corps: number; flWC: number; flOC: number;
    v12b: Acc; v12bNoAB: Acc; v12bw: Acc; f2: Acc; v11w: Acc; v12a: Acc; per: Acc; biV12b: any };
  const perEvent: Row[] = [];
  const pool = () => ({ v12b: mk(), v12bNoAB: mk(), v12bw: mk(), f2: mk(), v11w: mk(), v12a: mk(), per: mk() });
  const pools = { held: pool(), ins: pool() };

  for (const slug of targets) {
    const D = slugDate.get(slug)!;
    const held = D > CUTOFF;
    const targetPct = estimatePercentThrough(Date.parse(D), seasonStartMs, seasonEndMs);
    const biV11 = biasForDate(residsV11, D);
    const biV12b = biasForDate(residsV12b, D);
    const ev: Row = { slug, date: D, held, corps: 0,
      flWC: fieldLevel(slug, 'World Class'), flOC: fieldLevel(slug, 'Open Class'),
      v12b: mk(), v12bNoAB: mk(), v12bw: mk(), f2: mk(), v11w: mk(), v12a: mk(), per: mk(), biV12b };
    const P = pools[held ? 'held' : 'ins'];
    for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue;
      const ck = String(r.corps_key);
      const div = r.division_name as DivisionName;
      const actual = actualBy.get(`${slug}|${ck}`)!;
      ev.corps++;
      // v12b (with add-back) + ablation
      const v12bp = v12bBy.get(`${slug}|${ck}`);
      const v12bRawP = v12bRawBy.get(`${slug}|${ck}`);
      if (v12bp != null) { add(ev.v12b, v12bp - actual); add(P.v12b, v12bp - actual); }
      if (v12bRawP != null) { add(ev.v12bNoAB, v12bRawP - actual); add(P.v12bNoAB, v12bRawP - actual); }
      // v12bw = v12b served + wrapper
      if (v12bp != null) { const w = applyWrapper(v12bp, ck, div, D, targetPct, biV12b.correction); add(ev.v12bw, w - actual); add(P.v12bw, w - actual); }
      // final2
      const f2p = final2By.get(`${slug}|${ck}`);
      if (f2p != null) { add(ev.f2, f2p - actual); add(P.f2, f2p - actual); }
      // v11w
      const v11p = v11rawBy.get(`${slug}|${ck}`);
      if (v11p != null) { const w = applyWrapper(v11p, ck, div, D, targetPct, biV11.correction); add(ev.v11w, w - actual); add(P.v11w, w - actual); }
      // v12a raw
      const v12ap = v12aBy.get(`${slug}|${ck}`);
      if (v12ap != null) { add(ev.v12a, v12ap - actual); add(P.v12a, v12ap - actual); }
      // persistence
      const hist = priorShows(ck, D);
      if (hist.length >= 1) {
        const last = hist[hist.length - 1]!;
        const lastPct = estimatePercentThrough(Date.parse(last.date), seasonStartMs, seasonEndMs);
        const rank = rankBefore(ck, div, D);
        const curveDelta = last.total + curveGrowthTotal(rank, lastPct, targetPct);
        add(ev.per, curveDelta - actual); add(P.per, curveDelta - actual);
      }
    }
    perEvent.push(ev);
  }

  // ── report ──
  const out: string[] = [];
  const L = (s = '') => { out.push(s); console.log(s); };
  L(`\n=== V12 ARM B — FULL PROTOCOL TABLE  window ${WINDOW_START}..${WINDOW_END}  (cutoff ${CUTOFF}; identity ${IDENTITY}; add-back factor ${ADDBACK_FACTOR}) ===`);
  L(`contract: ${CONTRACT_DB}\n`);
  L('event                                    date        n  H | fieldLvl(WC/OC) |  v12b   |v12b-noAB|  v12bw  | final2  |  v11w   | v12a raw| persist');
  L('-'.repeat(154));
  const cell = (a: Acc) => `${f3(mae(a)).padStart(6)}`;
  for (const e of perEvent) {
    L(`${e.slug.padEnd(40)} ${e.date}  ${String(e.corps).padStart(2)} ${e.held ? 'HO' : 'in'} | ${f3(e.flWC).padStart(6)}/${f3(e.flOC).padStart(6)} |` +
      ` ${cell(e.v12b)} | ${cell(e.v12bNoAB)} | ${cell(e.v12bw)} | ${cell(e.f2)} | ${cell(e.v11w)} | ${cell(e.v12a)} | ${cell(e.per)}`);
  }
  L('-'.repeat(154));
  const poolLine = (label: string, P: any) => {
    L(`${label.padEnd(40)} ${'          '} ${String(P.v12b.n).padStart(2)}    | ${'      '}/${'      '} |` +
      ` ${cell(P.v12b)} | ${cell(P.v12bNoAB)} | ${cell(P.v12bw)} | ${cell(P.f2)} | ${cell(P.v11w)} | ${cell(P.v12a)} | ${cell(P.per)}`);
  };
  poolLine('POOLED — HELD-OUT (true test)', pools.held);
  poolLine('POOLED — in-sample (NOT pooled w/ HO)', pools.ins);
  L('');
  const biasLine = (label: string, P: any) =>
    L(`${label}:  v12b ${f3(bias(P.v12b))} | v12b-noAB ${f3(bias(P.v12bNoAB))} | v12bw ${f3(bias(P.v12bw))} | final2 ${f3(bias(P.f2))} | v11w ${f3(bias(P.v11w))} | v12a ${f3(bias(P.v12a))} | persist ${f3(bias(P.per))}`);
  biasLine('Bias HELD-OUT   ', pools.held);
  biasLine('Bias in-sample  ', pools.ins);

  // verdicts
  const H = pools.held;
  const hV12b = mae(H.v12b), hNoAB = mae(H.v12bNoAB), hV12bw = mae(H.v12bw), hF2 = mae(H.f2), hV11w = mae(H.v11w), hPer = mae(H.per);
  const bV12b = bias(H.v12b);
  L(`\n=== VERDICTS (held-out ${WINDOW_START <= CUTOFF ? '2026-07-21' : WINDOW_START}..${WINDOW_END}, n=${H.v12b.n}) ===`);
  L(`(a) v12b ${f3(hV12b)} vs final2 ${f3(hF2)} (~0.80): ` +
    (hV12b <= hF2 + 0.05 ? 'v12b MATCHES/BEATS final2.' : hV12b <= hF2 + 0.35 ? 'v12b short of final2 (tenths).' : 'v12b does NOT beat final2.'));
  L(`(b) v12b ${f3(hV12b)} vs v11w ${f3(hV11w)} (built-in climate term vs external wrapper): ` +
    (hV12b <= hV11w + 0.05 ? 'v12b MATCHES the wrapper (climate internalized).' : 'v12b short of the wrapper.'));
  L(`(c) |bias| v12b ${f3(Math.abs(bV12b))} vs clamp ${BIAS_CAP}: ` + (Math.abs(bV12b) <= BIAS_CAP ? 'within clamp capacity.' : 'EXCEEDS clamp — blocking flag.'));
  L(`(d) ADD-BACK ablation: v12b-noAB ${f3(hNoAB)} → v12b ${f3(hV12b)}  (Δ MAE ${f3(hNoAB - hV12b)}; noAB bias ${f3(bias(H.v12bNoAB))} → v12b bias ${f3(bV12b)}).`);
  L(`    v12bw ${f3(hV12bw)} (v12b + wrapper) vs v11w ${f3(hV11w)}; vs persistence ${f3(hPer)}.`);

  fs.writeFileSync(path.join(REPO, 'tools', 'backtest-v12b.out.json'), JSON.stringify({
    window: { start: WINDOW_START, end: WINDOW_END }, cutoff: CUTOFF, contractDb: CONTRACT_DB, addbackFactor: ADDBACK_FACTOR,
    v12bDir: V12B_DIR, v12aDir: V12A_DIR, v11Dir: V11_DIR,
    fieldLevels: Object.fromEntries([...fieldLevelBy.entries()]),
    perEvent: perEvent.map((e) => ({ slug: e.slug, date: e.date, heldOut: e.held, corps: e.corps, fieldLevelWC: e.flWC, fieldLevelOC: e.flOC,
      v12b: { n: e.v12b.n, mae: mae(e.v12b), bias: bias(e.v12b) }, v12bNoAB: { n: e.v12bNoAB.n, mae: mae(e.v12bNoAB), bias: bias(e.v12bNoAB) },
      v12bw: { n: e.v12bw.n, mae: mae(e.v12bw), bias: bias(e.v12bw) }, final2: { n: e.f2.n, mae: mae(e.f2), bias: bias(e.f2) },
      v11w: { n: e.v11w.n, mae: mae(e.v11w), bias: bias(e.v11w) }, v12aRaw: { n: e.v12a.n, mae: mae(e.v12a), bias: bias(e.v12a) },
      persistence: { n: e.per.n, mae: mae(e.per), bias: bias(e.per) }, v12bBias: e.biV12b })),
    pooled: {
      heldOut: Object.fromEntries(Object.entries(pools.held).map(([k, a]) => [k, { n: a.n, mae: mae(a), bias: bias(a) }])),
      inSample: Object.fromEntries(Object.entries(pools.ins).map(([k, a]) => [k, { n: a.n, mae: mae(a), bias: bias(a) }])),
    },
  }, null, 2));
  L(`\nwrote tools/backtest-v12b.out.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
