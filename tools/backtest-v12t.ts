/**
 * V12t — v12a core + a wrapper whose parameters are CO-TUNED for that core,
 * the leakage-safe one-pass analog of how final2's wrapper constants were tuned
 * for its v9 core over months. Reuses the exact v12aw machinery (cached v12a raw
 * ensemble inference + the final2 wrapper helpers, tools/backtest-v12aw.ts) and
 * replaces the fixed constants with a grid search.
 *
 * CO-TUNED PARAMETERS (wrapper only; the v12a core is frozen):
 *   H     — horizon in persistW = max(0, 1 − horizonDays/H)   grid 5..30
 *   beta  — model-vs-curveΔ blend  modelBlend = beta·raw + (1−beta)·curveΔ  grid 0..1
 *   d     — bias damping           correction = clamp(d·rawBias, ±cap)      grid 0.3..1.0
 *   cap   — bias cap                                                         grid {1.25..3.0}
 *   (comparable-revert schedule NOT applied — the published v11w/v12aw
 *    implementations also omit it; kept out so the comparison is apples-to-apples.)
 *
 * BIAS SOURCE — self-referential, honest option (a): for each candidate (H,beta)
 * the bias is the mean of the WRAPPER's OWN pre-correction (pre-bias) pre-show
 * forecast residuals on prior shows (strictly before D, corps with ≥1 prior
 * same-season score). Excluding the correction term from the residual definition
 * keeps it non-circular while still self-referential to the tuned persist/blend
 * params. This is computed INSIDE the tuning loop for every candidate.
 *
 * LEAKAGE DISCIPLINE: parameters are tuned ONLY on the tuning window
 * (2026-07-17..07-21); the single best candidate is FROZEN and evaluated on the
 * untouched validation window (2026-07-22..latest scored, includes 07-24
 * championship-week shows). final2 / v11w / v12aw (published constants) are graded
 * on the same validation window for comparison.
 *
 * Run: DCI_DB=/root/corps-place/sdk/dci-relational.db \
 *      CONTRACT_DB=/tmp/sdk-assets-contract-0725b.db \
 *      V12A_DIR=/home/patrick/v12a-seeds/models V11_050_DIR=/home/patrick/v11-seeds \
 *      npx tsx tools/backtest-v12t.ts
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

const V12A_DIR = process.env.V12A_DIR ?? '/home/patrick/v12a-seeds/models';
const V11_DIR = process.env.V11_050_DIR ?? '/home/patrick/v11-seeds';
const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract-0725b.db';
const ALL_START = process.env.BT_START ?? '2026-07-17';
const ALL_END = process.env.BT_END ?? '2026-07-31';           // upper clamp; latest scored auto-detected
const TUNE_START = process.env.TUNE_START ?? '2026-07-17';
const TUNE_END = process.env.TUNE_END ?? '2026-07-21';
const VAL_START = process.env.VAL_START ?? '2026-07-22';
const IDENTITY: IdentityMode = 'agnostic';

// final2 published wrapper constants (predictEventRecap.ts 231-234)
const PUB = { H: 14, beta: 0.5, d: 0.67, cap: 1.25 };
const BIAS_MIN_SAMPLES = 10;

// tuning grids
const H_GRID = Array.from({ length: 26 }, (_, i) => 5 + i);          // 5..30
const BETA_GRID = Array.from({ length: 21 }, (_, i) => +(i * 0.05).toFixed(2)); // 0..1 step .05
const D_GRID = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
const CAP_GRID = [1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

const REFERENCE_CURVES: { curves: Record<string, Record<string, number>> } = JSON.parse(
  fs.readFileSync('/root/corps-place/sdk/src/training/referenceCurvesV4.json', 'utf-8')
);

// ── final2 wrapper helpers (verbatim from v12aw.ts) ──────────────────────────
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

// ── accumulators ─────────────────────────────────────────────────────────────
type Acc = { n: number; abs: number; sum: number };
const mk = (): Acc => ({ n: 0, abs: 0, sum: 0 });
const add = (a: Acc, e: number) => { a.n++; a.abs += Math.abs(e); a.sum += e; };
const mae = (a: Acc) => (a.n ? a.abs / a.n : NaN);
const bias = (a: Acc) => (a.n ? a.sum / a.n : NaN);
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');

// Wrapper PRE-correction in-season forecast (persist blend, no bias term).
// Depends on H and beta. hist<1 → raw returned (no wrapper).
function preCorrForecast(rawPred: number, ck: string, div: DivisionName, D: string, targetPct: number, H: number, beta: number): number {
  const hist = priorShows(ck, D);
  if (hist.length < 1) return rawPred;
  const last = hist[hist.length - 1]!;
  const lastPct = estimatePercentThrough(Date.parse(last.date), seasonStartMs, seasonEndMs);
  const rank = rankBefore(ck, div, D);
  const curveDelta = last.total + curveGrowthTotal(rank, lastPct, targetPct);
  const modelBlend = beta * rawPred + (1 - beta) * curveDelta;
  const horizonDays = Math.max(0, (Date.parse(D) - Date.parse(last.date)) / 86_400_000);
  const persistW = Math.max(0, 1 - horizonDays / H);
  return persistW * last.total + (1 - persistW) * modelBlend;
}
const hasHistory = (ck: string, D: string) => priorShows(ck, D).length >= 1;

async function main() {
  const allScored = [...bySlug.keys()]
    .filter((s) => bySlug.get(s)!.some((r) => DIVISIONS.includes(r.division_name)))
    .sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : 1));
  const latestScored = allScored.reduce((m, s) => (slugDate.get(s)! > m ? slugDate.get(s)! : m), '0000');
  const targetsAll = allScored.filter((s) => { const d = slugDate.get(s)!; return d >= ALL_START && d <= ALL_END; });
  const tuneTargets = targetsAll.filter((s) => { const d = slugDate.get(s)!; return d >= TUNE_START && d <= TUNE_END; });
  const valTargets = targetsAll.filter((s) => { const d = slugDate.get(s)!; return d >= VAL_START && d <= ALL_END; });
  process.stderr.write(`latest scored ${latestScored}; tune ${tuneTargets.length} shows, val ${valTargets.length} shows\n`);

  // ── raw pre-show inference (cached; independent of wrapper params) ──
  const runRaw = async (dir: string, label: string) => {
    _clearEnsembleCache();
    const prov = poolProvider(dir);
    const by = new Map<string, number>();
    process.stderr.write(`${label} inference over ${allScored.length} scored shows...\n`);
    for (const slug of allScored) {
      try {
        const res = await predict(buildSeasonData(slug), { provider: prov, identity: IDENTITY });
        for (const p of res.predictions) by.set(`${slug}|${p.corpsKey}`, p.total);
      } catch (e) { process.stderr.write(`  [skip ${label}] ${slug}: ${e instanceof Error ? e.message : e}\n`); }
    }
    return by;
  };
  const v12aBy = await runRaw(V12A_DIR, 'v12a');
  const v11rawBy = await runRaw(V11_DIR, 'v11');

  // final2 served (from prod run table)
  const final2By = new Map<string, number>();
  for (const slug of targetsAll) {
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

  // Precompute pre-correction forecasts for ALL scored corps-shows, per (H,beta).
  // key = `${slug}|${ck}` -> preCorr value. Also actual lookup.
  const pcKey = (H: number, beta: number) => `${H}|${beta}`;
  const preCorrCache = new Map<string, Map<string, number>>();
  const targetPctOf = (slug: string) => estimatePercentThrough(Date.parse(slugDate.get(slug)!), seasonStartMs, seasonEndMs);
  for (const H of H_GRID) for (const beta of BETA_GRID) {
    const m = new Map<string, number>();
    for (const slug of allScored) {
      const D = slugDate.get(slug)!;
      const tp = targetPctOf(slug);
      for (const r of bySlug.get(slug)!) {
        if (!DIVISIONS.includes(r.division_name)) continue;
        const ck = String(r.corps_key);
        const raw = v12aBy.get(`${slug}|${ck}`);
        if (raw == null) continue;
        m.set(`${slug}|${ck}`, preCorrForecast(raw, ck, r.division_name as DivisionName, D, tp, H, beta));
      }
    }
    preCorrCache.set(pcKey(H, beta), m);
  }

  // Bias for a date under (H,beta,d,cap): self-referential, from this candidate's
  // OWN pre-correction residuals on shows strictly before D (history-eligible).
  const residListOf = (H: number, beta: number) => {
    const m = preCorrCache.get(pcKey(H, beta))!;
    const out: { date: string; err: number }[] = [];
    for (const slug of allScored) {
      const D = slugDate.get(slug)!;
      for (const r of bySlug.get(slug)!) {
        if (!DIVISIONS.includes(r.division_name)) continue;
        const ck = String(r.corps_key);
        if (!hasHistory(ck, D)) continue;
        const pc = m.get(`${slug}|${ck}`); const actual = actualBy.get(`${slug}|${ck}`);
        if (pc == null || actual == null) continue;
        out.push({ date: D, err: pc - actual });
      }
    }
    return out;
  };
  const correctionFor = (resids: { date: string; err: number }[], D: string, d: number, cap: number) => {
    const rs = resids.filter((r) => r.date < D);
    if (rs.length < BIAS_MIN_SAMPLES) return 0;
    const raw = rs.reduce((s, r) => s + r.err, 0) / rs.length;
    return Math.max(-cap, Math.min(cap, d * raw));
  };

  // Grade a set of target shows with candidate params using cached preCorr forecasts.
  const gradeV12 = (targets: string[], H: number, beta: number, d: number, cap: number): Acc => {
    const m = preCorrCache.get(pcKey(H, beta))!;
    const resids = residListOf(H, beta);
    const acc = mk();
    for (const slug of targets) {
      const D = slugDate.get(slug)!;
      const corr = correctionFor(resids, D, d, cap);
      for (const r of bySlug.get(slug)!) {
        if (!DIVISIONS.includes(r.division_name)) continue;
        const ck = String(r.corps_key);
        const actual = actualBy.get(`${slug}|${ck}`); if (actual == null) continue;
        const pc = m.get(`${slug}|${ck}`); if (pc == null) continue;
        const fc = hasHistory(ck, D) ? pc - corr : pc; // pc==raw when no history
        add(acc, fc - actual);
      }
    }
    return acc;
  };

  // ── TUNE on the tuning window ──
  process.stderr.write(`grid: ${H_GRID.length}×${BETA_GRID.length}×${D_GRID.length}×${CAP_GRID.length} = ${H_GRID.length * BETA_GRID.length * D_GRID.length * CAP_GRID.length}\n`);
  let best = { H: PUB.H, beta: PUB.beta, d: PUB.d, cap: PUB.cap, mae: Infinity };
  for (const H of H_GRID) for (const beta of BETA_GRID) {
    const resids = residListOf(H, beta); // shared across d,cap for this (H,beta)
    for (const d of D_GRID) for (const cap of CAP_GRID) {
      const acc = mk();
      const m = preCorrCache.get(pcKey(H, beta))!;
      for (const slug of tuneTargets) {
        const D = slugDate.get(slug)!;
        const corr = correctionFor(resids, D, d, cap);
        for (const r of bySlug.get(slug)!) {
          if (!DIVISIONS.includes(r.division_name)) continue;
          const ck = String(r.corps_key);
          const actual = actualBy.get(`${slug}|${ck}`); if (actual == null) continue;
          const pc = m.get(`${slug}|${ck}`); if (pc == null) continue;
          add(acc, (hasHistory(ck, D) ? pc - corr : pc) - actual);
        }
      }
      const v = mae(acc);
      if (v < best.mae) best = { H, beta, d, cap, mae: v };
    }
  }
  process.stderr.write(`best tuned: H=${best.H} beta=${best.beta} d=${best.d} cap=${best.cap} tuneMAE=${f3(best.mae)}\n`);

  // Frozen v12t on both windows.
  const v12tTune = gradeV12(tuneTargets, best.H, best.beta, best.d, best.cap);
  const v12tVal = gradeV12(valTargets, best.H, best.beta, best.d, best.cap);
  // v12aw (published constants) on both windows — reproduces published machinery.
  const v12awTune = gradeV12(tuneTargets, PUB.H, PUB.beta, PUB.d, PUB.cap);
  const v12awVal = gradeV12(valTargets, PUB.H, PUB.beta, PUB.d, PUB.cap);

  // Generic grade for an arbitrary raw source with the PUBLISHED wrapper (v11w).
  const gradeGeneric = (rawBy: Map<string, number>, targets: string[]): Acc => {
    // pre-correction forecasts for this raw source under published H,beta
    const pcm = new Map<string, number>();
    const resids: { date: string; err: number }[] = [];
    for (const slug of allScored) {
      const D = slugDate.get(slug)!; const tp = targetPctOf(slug);
      for (const r of bySlug.get(slug)!) {
        if (!DIVISIONS.includes(r.division_name)) continue;
        const ck = String(r.corps_key);
        const raw = rawBy.get(`${slug}|${ck}`); if (raw == null) continue;
        const pc = preCorrForecast(raw, ck, r.division_name as DivisionName, D, tp, PUB.H, PUB.beta);
        pcm.set(`${slug}|${ck}`, pc);
        const actual = actualBy.get(`${slug}|${ck}`);
        if (hasHistory(ck, D) && actual != null) resids.push({ date: D, err: pc - actual });
      }
    }
    const acc = mk();
    for (const slug of targets) {
      const D = slugDate.get(slug)!;
      const corr = correctionFor(resids, D, PUB.d, PUB.cap);
      for (const r of bySlug.get(slug)!) {
        if (!DIVISIONS.includes(r.division_name)) continue;
        const ck = String(r.corps_key);
        const actual = actualBy.get(`${slug}|${ck}`); if (actual == null) continue;
        const pc = pcm.get(`${slug}|${ck}`); if (pc == null) continue;
        add(acc, (hasHistory(ck, D) ? pc - corr : pc) - actual);
      }
    }
    return acc;
  };
  const v11wTune = gradeGeneric(v11rawBy, tuneTargets);
  const v11wVal = gradeGeneric(v11rawBy, valTargets);

  // final2 served on both windows.
  const gradeFinal2 = (targets: string[]): Acc => {
    const acc = mk();
    for (const slug of targets) for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue;
      const ck = String(r.corps_key);
      const actual = actualBy.get(`${slug}|${ck}`); const p = final2By.get(`${slug}|${ck}`);
      if (actual == null || p == null) continue;
      add(acc, p - actual);
    }
    return acc;
  };
  const f2Tune = gradeFinal2(tuneTargets);
  const f2Val = gradeFinal2(valTargets);

  // ── report ──
  const out: string[] = [];
  const L = (s = '') => { out.push(s); console.log(s); };
  L(`\n=== V12t CO-TUNED — tune ${TUNE_START}..${TUNE_END} | val ${VAL_START}..${latestScored} (identity ${IDENTITY}) ===`);
  L(`contract: ${CONTRACT_DB}`);
  L(`TUNED constants: H=${best.H}  beta=${best.beta}  d=${best.d}  cap=${best.cap}`);
  L(`final2 published: H=${PUB.H}  beta=${PUB.beta}  d=${PUB.d}  cap=${PUB.cap}\n`);
  const row = (label: string, tune: Acc, val: Acc) =>
    L(`${label.padEnd(28)}  tune MAE ${f3(mae(tune)).padStart(6)} (n=${String(tune.n).padStart(3)}, bias ${f3(bias(tune))})   |   val MAE ${f3(mae(val)).padStart(6)} (n=${String(val.n).padStart(3)}, bias ${f3(bias(val))})`);
  L('model                         TUNING WINDOW                              VALIDATION WINDOW (headline)');
  L('-'.repeat(112));
  row('v12t (co-tuned)', v12tTune, v12tVal);
  row('final2 (served)', f2Tune, f2Val);
  row('v11w (published)', v11wTune, v11wVal);
  row('v12aw (published wrapper)', v12awTune, v12awVal);
  L('-'.repeat(112));

  const hV12t = mae(v12tVal), hF2 = mae(f2Val);
  const gap = hV12t - hF2;
  L(`\n=== VERDICT (validation window, frozen params, n=${v12tVal.n}) ===`);
  L(`v12t ${f3(hV12t)} vs final2 ${f3(hF2)}: gap ${f3(gap)} MAE.`);
  L(Math.abs(gap) <= 0.1
    ? 'REACHES final2 (within ±0.1): the residual gap was CO-TUNING. Promotion case reopens post-championships — but constants were tuned on 5 days of one regime; re-validate over championships week before any flip.'
    : gap < -0.1
      ? 'BEATS final2 by >0.1 on validation (treat with caution — 5-day tune regime).'
      : 'SHORT of final2 by >0.1: residual gap is STRUCTURAL (per-corps curveΔ quality / craft) → arm C.');
  L(`horizon read: tuned H=${best.H} vs final2 H=${PUB.H} — ${best.H > PUB.H ? 'LONGER (trusts persistence longer / decays slower)' : best.H < PUB.H ? 'SHORTER (decays persistence faster, leans on model+curve sooner)' : 'same'}.`);
  L(`blend read: tuned beta=${best.beta} vs final2 beta=${PUB.beta} — ${best.beta > PUB.beta ? 'trusts the v12a MODEL more than curveΔ' : best.beta < PUB.beta ? 'trusts the curveΔ more than the v12a model' : 'same as final2'}.`);

  fs.writeFileSync(path.join(REPO, 'tools', 'backtest-v12t.out.json'), JSON.stringify({
    windows: { tune: { start: TUNE_START, end: TUNE_END }, val: { start: VAL_START, end: latestScored } },
    contractDb: CONTRACT_DB, v12aDir: V12A_DIR, v11Dir: V11_DIR,
    tuned: { H: best.H, beta: best.beta, d: best.d, cap: best.cap, tuneMAE: best.mae },
    published: PUB,
    results: {
      v12t: { tune: { n: v12tTune.n, mae: mae(v12tTune), bias: bias(v12tTune) }, val: { n: v12tVal.n, mae: mae(v12tVal), bias: bias(v12tVal) } },
      final2: { tune: { n: f2Tune.n, mae: mae(f2Tune), bias: bias(f2Tune) }, val: { n: f2Val.n, mae: mae(f2Val), bias: bias(f2Val) } },
      v11w: { tune: { n: v11wTune.n, mae: mae(v11wTune), bias: bias(v11wTune) }, val: { n: v11wVal.n, mae: mae(v11wVal), bias: bias(v11wVal) } },
      v12aw: { tune: { n: v12awTune.n, mae: mae(v12awTune), bias: bias(v12awTune) }, val: { n: v12awVal.n, mae: mae(v12awVal), bias: bias(v12awVal) } },
    },
    verdict: { gapToFinal2: gap, reachesFinal2: Math.abs(gap) <= 0.1 },
  }, null, 2));
  L(`\nwrote tools/backtest-v12t.out.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
