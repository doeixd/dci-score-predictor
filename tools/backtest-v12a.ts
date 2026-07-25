/**
 * V12 ARM A JUDGING — full Phase-3 protocol table.
 *
 * Columns per event + pooled:
 *   v12a        — 8-seed v12a persistence-residual pool (predict(), agnostic).
 *                 The delta head is trained against the LAST-REAL-RECAP baseline,
 *                 which is exactly what the SDK feeds as baselineRecap, so the
 *                 standard serving path IS the correct v12a path — no wrapper.
 *   final2      — what prod ACTUALLY served (model_event_prediction_runs,
 *                 model_dir LIKE '%final2%', latest pre-show run per event).
 *   v11 raw     — 8×v11 identity-0.5 agnostic ensemble, no wrapper.
 *   v11w        — v11 raw + final2 wrapper (persist blend + bias corr), verbatim.
 *   persistence — pure last-real-total + leakage-safe reference-curve gain.
 *
 * Leakage safety: for target show at date D, all model inputs use SeasonData built
 * only from shows STRICTLY before D; the v11w bias correction uses only v11 raw
 * pre-show residuals on shows strictly before D; persistence/curve use only the
 * corps' shows before D. v12a needs FRESH inference per event (buildSeasonData is
 * strictly pre-show → leakage-safe).
 *
 * Windows are classified per event: HELD-OUT (date > v12a cutoff 2026-07-20) vs
 * IN-SAMPLE-for-v12a (date <= cutoff). Pools reported SEPARATELY, never combined.
 * Tier splits (T0..T3 from predict readiness) on the headline pools.
 *
 * Run: DCI_DB=/root/corps-place/sdk/dci-relational.db \
 *      CONTRACT_DB=/tmp/sdk-assets-contract-0725.db \
 *      V12A_DIR=/home/patrick/v12a-seeds/models V11_050_DIR=/home/patrick/v11-seeds \
 *      npx tsx tools/backtest-v12a.ts
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
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/sdk-assets-contract-0725.db';
const WINDOW_START = process.env.BT_START ?? '2026-07-17';
const WINDOW_END = process.env.BT_END ?? '2026-07-22';
const V12A_CUTOFF = process.env.V12A_CUTOFF ?? '2026-07-20'; // events with date > cutoff are held-out
const IDENTITY: IdentityMode = 'agnostic';

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

// ── accumulators ─────────────────────────────────────────────────────────────
type Acc = { n: number; abs: number; sum: number };
const mk = (): Acc => ({ n: 0, abs: 0, sum: 0 });
const add = (a: Acc, e: number) => { a.n++; a.abs += Math.abs(e); a.sum += e; };
const mae = (a: Acc) => (a.n ? a.abs / a.n : NaN);
const bias = (a: Acc) => (a.n ? a.sum / a.n : NaN);
const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');

async function main() {
  const allScored = [...bySlug.keys()]
    .filter((s) => bySlug.get(s)!.some((r) => DIVISIONS.includes(r.division_name)))
    .sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : 1));
  const targets = allScored.filter((s) => { const d = slugDate.get(s)!; return d >= WINDOW_START && d <= WINDOW_END; });

  // ── v12a + v11 raw pre-show predictions (fresh inference) over all scored shows ──
  const v12aBy = new Map<string, number>();
  const v11rawBy = new Map<string, number>();
  const tierBy = new Map<string, string>();

  _clearEnsembleCache();
  const provV12a = poolProvider(V12A_DIR);
  process.stderr.write(`v12a inference over ${allScored.length} scored shows...\n`);
  for (const slug of allScored) {
    try {
      const res = await predict(buildSeasonData(slug), { provider: provV12a, identity: IDENTITY });
      for (const p of res.predictions) v12aBy.set(`${slug}|${p.corpsKey}`, p.total);
      for (const c of res.readiness.corps) tierBy.set(`${slug}|${c.corpsKey}`, c.tierCode);
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

  // v11 raw residual pool for the v11w bias correction (leakage-safe by date)
  type Resid = { date: string; err: number };
  const resids: Resid[] = [];
  for (const slug of allScored) {
    const D = slugDate.get(slug)!;
    for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue;
      const ck = String(r.corps_key);
      const pred = v11rawBy.get(`${slug}|${ck}`); const actual = actualBy.get(`${slug}|${ck}`);
      if (pred == null || actual == null) continue;
      if (priorShows(ck, D).length < 1) continue;
      resids.push({ date: D, err: pred - actual });
    }
  }
  const biasForDate = (D: string) => {
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
  type Row = { slug: string; date: string; held: boolean; corps: number;
    v12a: Acc; f2: Acc; raw: Acc; w: Acc; per: Acc; biasInfo: any };
  const perEvent: Row[] = [];
  // pools split by held-out vs in-sample
  const pool = (h: boolean) => ({ v12a: mk(), f2: mk(), raw: mk(), w: mk(), per: mk() });
  const pools = { held: pool(true), ins: pool(false) };
  // tier splits for held-out headline pools (v12a, final2)
  const tierPools: Record<string, { v12a: Acc; f2: Acc }> = { T0: { v12a: mk(), f2: mk() }, T1: { v12a: mk(), f2: mk() }, T2: { v12a: mk(), f2: mk() }, T3: { v12a: mk(), f2: mk() } };

  for (const slug of targets) {
    const D = slugDate.get(slug)!;
    const held = D > V12A_CUTOFF;
    const targetPct = estimatePercentThrough(Date.parse(D), seasonStartMs, seasonEndMs);
    const bi = biasForDate(D);
    const ev: Row = { slug, date: D, held, corps: 0, v12a: mk(), f2: mk(), raw: mk(), w: mk(), per: mk(), biasInfo: bi };
    for (const r of bySlug.get(slug)!) {
      if (!DIVISIONS.includes(r.division_name)) continue;
      const ck = String(r.corps_key);
      const actual = actualBy.get(`${slug}|${ck}`)!;
      ev.corps++;
      const P = pools[held ? 'held' : 'ins'];
      // v12a
      const v12 = v12aBy.get(`${slug}|${ck}`);
      if (v12 != null) { add(ev.v12a, v12 - actual); add(P.v12a, v12 - actual); }
      // final2
      const f2p = final2By.get(`${slug}|${ck}`);
      if (f2p != null) { add(ev.f2, f2p - actual); add(P.f2, f2p - actual); }
      // v11 raw
      const rawPred = v11rawBy.get(`${slug}|${ck}`);
      if (rawPred != null) { add(ev.raw, rawPred - actual); add(P.raw, rawPred - actual); }
      // persistence + v11w (need prior show)
      const hist = priorShows(ck, D);
      if (hist.length >= 1) {
        const last = hist[hist.length - 1]!;
        const lastPct = estimatePercentThrough(Date.parse(last.date), seasonStartMs, seasonEndMs);
        const rank = rankBefore(ck, r.division_name as DivisionName, D);
        const curveDelta = last.total + curveGrowthTotal(rank, lastPct, targetPct);
        // pure persistence
        add(ev.per, curveDelta - actual); add(P.per, curveDelta - actual);
        // v11w
        if (rawPred != null) {
          const modelBlend = (rawPred + curveDelta) / 2;
          const horizonDays = Math.max(0, (Date.parse(D) - Date.parse(last.date)) / 86_400_000);
          const persistW = Math.max(0, 1 - horizonDays / 14);
          const inSeason = persistW * last.total + (1 - persistW) * modelBlend;
          const wTotal = inSeason - bi.correction;
          add(ev.w, wTotal - actual); add(P.w, wTotal - actual);
        }
      } else if (rawPred != null) {
        // no history: v11w falls back to raw (final2 wrapper leaves it unblended)
        add(ev.w, rawPred - actual);
      }
      // tier splits (held-out only, v12a & final2)
      if (held) {
        const t = tierBy.get(`${slug}|${ck}`) ?? 'T3';
        const tp = tierPools[t] ?? tierPools.T3;
        if (v12 != null) add(tp.v12a, v12 - actual);
        if (f2p != null) add(tp.f2, f2p - actual);
      }
    }
    perEvent.push(ev);
  }

  // ── report ──
  const out: string[] = [];
  const L = (s = '') => { out.push(s); console.log(s); };
  L(`\n=== V12 ARM A — FULL PROTOCOL TABLE  window ${WINDOW_START}..${WINDOW_END}  (v12a cutoff ${V12A_CUTOFF}; identity ${IDENTITY}) ===`);
  L(`contract: ${CONTRACT_DB}\n`);
  L('event                                    date        n  H | v12a(8) | final2  | v11 raw |  v11w   | persist | v11w bias(n,raw→corr)');
  L('-'.repeat(132));
  const cell = (a: Acc) => `${f3(mae(a)).padStart(6)}`;
  for (const e of perEvent) {
    L(`${e.slug.padEnd(40)} ${e.date}  ${String(e.corps).padStart(2)} ${e.held ? 'HO' : 'in'} |` +
      ` ${cell(e.v12a)} | ${cell(e.f2)} | ${cell(e.raw)} | ${cell(e.w)} | ${cell(e.per)} | n=${e.biasInfo.n} ${f3(e.biasInfo.rawBias)}→${f3(e.biasInfo.correction)}`);
  }
  L('-'.repeat(132));
  const poolLine = (label: string, P: any) => {
    L(`${label.padEnd(40)} ${'          '} ${String(P.v12a.n).padStart(2)}    |` +
      ` ${cell(P.v12a)} | ${cell(P.f2)} | ${cell(P.raw)} | ${cell(P.w)} | ${cell(P.per)} |`);
  };
  poolLine('POOLED — HELD-OUT (v12a true test)', pools.held);
  poolLine('POOLED — in-sample-for-v12a (NOT pooled w/ HO)', pools.ins);
  L('');
  const biasLine = (label: string, P: any) =>
    L(`${label}:  v12a ${f3(bias(P.v12a))}  |  final2 ${f3(bias(P.f2))}  |  v11 raw ${f3(bias(P.raw))}  |  v11w ${f3(bias(P.w))}  |  persist ${f3(bias(P.per))}`);
  biasLine('Bias HELD-OUT   ', pools.held);
  biasLine('Bias in-sample  ', pools.ins);

  L(`\n--- HELD-OUT tier splits (n | MAE | bias) ---`);
  L(`tier   v12a: n / MAE / bias        final2: n / MAE / bias`);
  for (const t of ['T0', 'T1', 'T2', 'T3']) {
    const tp = tierPools[t]!;
    L(`  ${t}   ${String(tp.v12a.n).padStart(3)} / ${f3(mae(tp.v12a))} / ${f3(bias(tp.v12a))}` +
      `      ${String(tp.f2.n).padStart(3)} / ${f3(mae(tp.f2))} / ${f3(bias(tp.f2))}`);
  }

  // verdicts
  const hV12a = mae(pools.held.v12a), hF2 = mae(pools.held.f2), hW = mae(pools.held.w), hPer = mae(pools.held.per);
  L(`\n=== VERDICTS (held-out ${WINDOW_START>V12A_CUTOFF?WINDOW_START:'2026-07-21'}..${WINDOW_END}, n=${pools.held.v12a.n}) ===`);
  L(`(a) v12a ${f3(hV12a)} vs final2 ${f3(hF2)} (target ~0.95-1.1): ` +
    (hV12a <= hF2 + 0.05 ? 'v12a MATCHES/BEATS final2.' : hV12a <= 1.15 ? 'v12a final2-class but short.' : 'v12a does NOT beat final2.'));
  L(`(b) v12a ${f3(hV12a)} vs v11w ${f3(hW)} (architecture internalizes wrapper?): ` +
    (hV12a <= hW + 0.05 ? 'v12a >= v11w — anchor internalized.' : 'v12a short of v11w.'));
  L(`(c) |bias| v12a ${f3(Math.abs(bias(pools.held.v12a)))} vs clamp ${BIAS_CAP}: ` +
    (Math.abs(bias(pools.held.v12a)) <= BIAS_CAP ? 'within clamp capacity.' : 'EXCEEDS clamp — blocking flag.'));
  L(`    v12a vs persistence ${f3(hPer)}: ${hV12a < hPer ? 'v12a beats pure persistence.' : 'v12a NOT better than persistence.'}`);

  fs.writeFileSync(path.join(REPO, 'tools', 'backtest-v12a.out.json'), JSON.stringify({
    window: { start: WINDOW_START, end: WINDOW_END }, cutoff: V12A_CUTOFF, contractDb: CONTRACT_DB, v12aDir: V12A_DIR, v11Dir: V11_DIR,
    perEvent: perEvent.map((e) => ({ slug: e.slug, date: e.date, heldOut: e.held, corps: e.corps,
      v12a: { n: e.v12a.n, mae: mae(e.v12a), bias: bias(e.v12a) }, final2: { n: e.f2.n, mae: mae(e.f2), bias: bias(e.f2) },
      v11raw: { n: e.raw.n, mae: mae(e.raw), bias: bias(e.raw) }, v11w: { n: e.w.n, mae: mae(e.w), bias: bias(e.w) },
      persistence: { n: e.per.n, mae: mae(e.per), bias: bias(e.per) }, v11wBias: e.biasInfo })),
    pooled: {
      heldOut: Object.fromEntries(Object.entries(pools.held).map(([k, a]) => [k, { n: a.n, mae: mae(a), bias: bias(a) }])),
      inSample: Object.fromEntries(Object.entries(pools.ins).map(([k, a]) => [k, { n: a.n, mae: mae(a), bias: bias(a) }])),
    },
    tiersHeldOut: Object.fromEntries(Object.entries(tierPools).map(([t, p]) => [t, { v12a: { n: p.v12a.n, mae: mae(p.v12a), bias: bias(p.v12a) }, final2: { n: p.f2.n, mae: mae(p.f2), bias: bias(p.f2) } }])),
  }, null, 2));
  L(`\nwrote tools/backtest-v12a.out.json`);
}
main().catch((e) => { console.error(e); process.exit(1); });
