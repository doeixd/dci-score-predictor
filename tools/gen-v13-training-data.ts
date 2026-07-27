/**
 * gen-v13-training-data.ts — GATE G2 preprocessor: build the residual-core
 * training data for V13 by running the FROZEN structural layer W (src/structural/
 * wLayer.ts — the exact G1 module, same code that serves later) over every training
 * contract row, chronologically and leakage-safely, and writing per-row:
 *   - the structural forecast W_c per caption (post bias-correction) + its total,
 *     the pre-correction total, and the event bias correction, so the trainer's
 *     delta-target baseline can be W (baseline-mode "w"): residual_c = actual_c - W_c.
 *   - the L3 online channel: division + corps trailing 7/14-day W-residual
 *     statistics (mean/std/support), appended to x_static_json (k=7 features).
 *
 * Leakage discipline (identical to tools/backtest-w.ts, generalised to every season):
 *   - W for row R uses only that corps' contract shows strictly before R's date.
 *   - the rolling bias pool and the rolling-residual features use only W's OWN
 *     pre-correction residuals on shows strictly before R's date.
 *   - everything is computed per season with season-local rank/history; the
 *     prior-season comparable reaches back one season via DCI_DB (getPriorSeason...).
 *
 * Determinism: no randomness, no timestamps written into emitted columns; the
 * original static vector is snapshotted once into x_static_base_json and
 * x_static_json is always rebuilt as base(216) ++ features(k) so re-runs are
 * byte-identical (G2 determinism smoke).
 *
 * Run (main box, then transfer the augmented DB to the mini-PC):
 *   DCI_DB=/root/corps-place/sdk/dci-relational.db \
 *   CONTRACT_DB=/tmp/v13-contract-0724.db \
 *   TRAIN_DB=/tmp/v13-training-cutoff0724.db \
 *   npx tsx tools/gen-v13-training-data.ts
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  wPreCorrection, applyBias, biasCorrectionFromResiduals,
  type WContext, type WHistoryShow, type CaptionVec,
  CAPTIONS, DEFAULT_W_CONFIG, totalFromCaps,
} from '../src/structural/wLayer.js';

const DB = process.env.DCI_DB ?? '/root/corps-place/sdk/dci-relational.db';
const CONTRACT_DB = process.env.CONTRACT_DB ?? '/tmp/v13-contract-0724.db';
const TRAIN_DB = process.env.TRAIN_DB ?? '/tmp/v13-training-cutoff0724.db';
const ML_TABLE = process.env.ML_TABLE ?? 'ml_sequence_rows_v10_field_pace';
const CURVES_PATH = process.env.REFERENCE_CURVES ?? '/root/corps-place/sdk/src/training/referenceCurvesV4.json';
const BASE_STATIC_DIM = Number(process.env.BASE_STATIC_DIM ?? 216);
const K_FEATURES = 7; // v13 L3 rolling-residual channel (see FEATURE_NAMES)
const FEATURE_NAMES = [
  'corps_resid_mean_7d', 'corps_resid_mean_14d', 'corps_resid_support_14d',
  'div_resid_mean_7d', 'div_resid_mean_14d', 'div_resid_std_14d', 'div_resid_support_14d',
] as const;

const REFERENCE_CURVES = JSON.parse(fs.readFileSync(CURVES_PATH, 'utf-8'));
const q = (db: string, sql: string): any[] =>
  JSON.parse(execFileSync('sqlite3', ['-json', '-readonly', db, sql], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 1024 }) || '[]');
const DAY = 86_400_000;

// ── contract: every season's per-corps per-show recap (leakage filtered per target) ──
const perfRows = q(CONTRACT_DB, `
  SELECT season, competition_slug AS slug, substr(competition_date,1,10) AS date, percent_through,
         model_corps_key AS corps_key, division_name, total_score, GE1,GE2,VP,VA,CG,MB,MA,MP
  FROM v10_training_performances
  ORDER BY season, date, competition_slug, model_corps_key`);

const capsOf = (r: any): CaptionVec => Object.fromEntries(CAPTIONS.map((c) => [c, Number(r[c])])) as CaptionVec;
const seasons = [...new Set(perfRows.map((r) => String(r.season)))].sort();

// per-season DCI event bounds (matches G1's season-bound source for byte-parity on 2026)
const seasonBounds = new Map<string, { startMs: number; endMs: number }>();
for (const s of seasons) {
  const b = q(DB, `SELECT substr(MIN(start_date),1,10) AS start, substr(MAX(start_date),1,10) AS end FROM events WHERE substr(start_date,1,4)='${s}'`)[0];
  const start = b?.start ?? perfRows.filter((r) => String(r.season) === s).reduce((m, r) => (r.date < m ? r.date : m), '9999');
  const end = b?.end ?? perfRows.filter((r) => String(r.season) === s).reduce((m, r) => (r.date > m ? r.date : m), '0000');
  seasonBounds.set(s, { startMs: Date.parse(start), endMs: Date.parse(end) });
}

// prior-season comparable (DCI_DB corps_scores + competitions), ported verbatim from backtest-w.ts
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

// ── per-row W + residual features, keyed by season|slug|division|corps ──
interface RowOut { wCaps: CaptionVec; wTotal: number; wPreTotal: number; bias: number; feats: number[] }
const wByKey = new Map<string, RowOut>();
// diagnostics: raw-target (actual−persistence) vs residual-target (actual−W)
type Acc = { n: number; abs: number; sum: number; sq: number };
const mk = (): Acc => ({ n: 0, abs: 0, sum: 0, sq: 0 });
const add = (a: Acc, e: number) => { a.n++; a.abs += Math.abs(e); a.sum += e; a.sq += e * e; };
const mad = (a: Acc) => (a.n ? a.abs / a.n : NaN);
const std = (a: Acc) => (a.n ? Math.sqrt(Math.max(0, a.sq / a.n - (a.sum / a.n) ** 2)) : NaN);
const rawTot = mk(), resTot = mk(), rawCap = mk(), resCap = mk();
const byTier: Record<string, { raw: Acc; res: Acc }> = {};
const tierOf = (t: number) => (t >= 85 ? 'top(>=85)' : t >= 80 ? 'mid(80-85)' : 'low(<80)');

for (const season of seasons) {
  const bounds = seasonBounds.get(season)!;
  const rows = perfRows.filter((r) => String(r.season) === season);
  // season-local indexes
  const bySlug = new Map<string, any[]>(); const slugDate = new Map<string, string>();
  const corpsShows = new Map<string, WHistoryShow[]>();
  const actualBy = new Map<string, number>(); const divBy = new Map<string, string>(); const dateBy = new Map<string, string>();
  for (const r of rows) {
    (bySlug.get(r.slug) ?? bySlug.set(r.slug, []).get(r.slug)!).push(r); slugDate.set(r.slug, String(r.date));
    const ck = String(r.corps_key); const key = `${r.slug}|${ck}`;
    (corpsShows.get(ck) ?? corpsShows.set(ck, []).get(ck)!).push({ slug: String(r.slug), date: String(r.date), division: String(r.division_name), captions: capsOf(r), total: Number(r.total_score) });
    actualBy.set(key, Number(r.total_score)); divBy.set(key, String(r.division_name)); dateBy.set(key, String(r.date));
  }
  for (const arr of corpsShows.values()) arr.sort((a, b) => (a.date < b.date ? -1 : 1));

  const rankBefore = (corpsKey: string, div: string, D: string): number => {
    const latestTotal = new Map<string, number>(); const latestDate = new Map<string, string>();
    for (const [k, d] of dateBy) { if (d >= D || divBy.get(k) !== div) continue; const ck = k.split('|')[1]!; if (!latestDate.has(ck) || d > latestDate.get(ck)!) { latestDate.set(ck, d); latestTotal.set(ck, actualBy.get(k)!); } }
    const ordered = [...latestTotal.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const i = ordered.indexOf(corpsKey); return i >= 0 ? i + 1 : 12;
  };
  const ctx: WContext = { curves: REFERENCE_CURVES, seasonStartMs: bounds.startMs, seasonEndMs: bounds.endMs, config: DEFAULT_W_CONFIG, rankBefore, priorComparable };
  const historyBefore = (ck: string, D: string) => (corpsShows.get(ck) ?? []).filter((h) => h.date < D);

  const scored = [...bySlug.keys()].sort((a, b) => (slugDate.get(a)! < slugDate.get(b)! ? -1 : slugDate.get(a)! > slugDate.get(b)! ? 1 : a < b ? -1 : 1));

  // pass 1: pre-correction W for every row + the self-referential residual pool (carries ck/div for feature windows)
  const wPre = new Map<string, ReturnType<typeof wPreCorrection>>();
  const pool: { date: string; ck: string; div: string; err: number }[] = [];
  for (const slug of scored) {
    const D = slugDate.get(slug)!;
    for (const r of bySlug.get(slug)!) {
      const ck = String(r.corps_key); const div = String(r.division_name); const key = `${slug}|${ck}`;
      const pre = wPreCorrection(historyBefore(ck, D), { corpsKey: ck, division: div, targetDate: D, season }, ctx);
      wPre.set(key, pre);
      const actual = actualBy.get(key);
      if (pre.components.hasHistory && actual != null) pool.push({ date: D, ck, div, err: pre.total - actual });
    }
  }
  const meanOf = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const stdOf = (xs: number[]) => { if (!xs.length) return 0; const m = meanOf(xs); return Math.sqrt(Math.max(0, meanOf(xs.map((x) => (x - m) ** 2)))); };

  // pass 2: apply event bias, compute features, residual target
  for (const slug of scored) {
    const D = slugDate.get(slug)!; const Dms = Date.parse(D);
    const corr = biasCorrectionFromResiduals(pool.map((p) => ({ date: p.date, err: p.err })), D, DEFAULT_W_CONFIG).correction;
    for (const r of bySlug.get(slug)!) {
      const ck = String(r.corps_key); const div = String(r.division_name); const key = `${slug}|${ck}`;
      const pre = wPre.get(key)!; const W = applyBias(pre, corr);
      // rolling-residual features (leakage-safe: pool entries strictly before D)
      const win = (days: number, pred: (p: { ck: string; div: string }) => boolean) =>
        pool.filter((p) => p.date < D && (Dms - Date.parse(p.date)) <= days * DAY && pred(p)).map((p) => p.err);
      const c7 = win(7, (p) => p.ck === ck), c14 = win(14, (p) => p.ck === ck);
      const d7 = win(7, (p) => p.div === div), d14 = win(14, (p) => p.div === div);
      const feats = [
        meanOf(c7), meanOf(c14), Math.min(c14.length, 4) / 4,
        meanOf(d7), meanOf(d14), stdOf(d14), Math.min(d14.length, 40) / 40,
      ];
      wByKey.set(`${season}|${slug}|${div}|${ck}`, { wCaps: W.captions, wTotal: W.total, wPreTotal: pre.total, bias: corr, feats });

      // diagnostics
      const actual = actualBy.get(key); const hist = historyBefore(ck, D);
      if (actual != null) {
        const tier = tierOf(actual); (byTier[tier] ??= { raw: mk(), res: mk() });
        add(resTot, W.total - actual); add(byTier[tier].res, W.total - actual);
        if (hist.length) { const persist = hist[hist.length - 1]!.total; add(rawTot, persist - actual); add(byTier[tier].raw, persist - actual); }
        const rc = capsOf(r);
        for (const c of CAPTIONS) { add(resCap, W.captions[c] - rc[c]); if (hist.length) add(rawCap, hist[hist.length - 1]!.captions[c] - rc[c]); }
      }
    }
  }
  process.stderr.write(`season ${season}: ${scored.length} shows, ${wByKey.size} cumulative W rows\n`);
}

// ── write into the ml table (idempotent / deterministic) ──
const esc = (s: string) => s.replace(/'/g, "''");
const exec = (sql: string) => execFileSync('sqlite3', [TRAIN_DB, sql], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 1024 });
const cols = q(TRAIN_DB, `SELECT name FROM pragma_table_info('${ML_TABLE}')`).map((r) => String(r.name));
for (const [c, t] of [['w_caption_json', 'TEXT'], ['w_total', 'REAL'], ['w_precorr_total', 'REAL'], ['w_bias_correction', 'REAL'], ['x_static_base_json', 'TEXT'], ['v13_resid_features_json', 'TEXT']] as const) {
  if (!cols.includes(c)) exec(`ALTER TABLE ${ML_TABLE} ADD COLUMN ${c} ${t};`);
}
// snapshot the original 216-dim static once (so re-runs rebuild identically)
exec(`UPDATE ${ML_TABLE} SET x_static_base_json = x_static_json WHERE x_static_base_json IS NULL;`);

const mlRows = q(TRAIN_DB, `SELECT season, competition_slug, division_name, corps_key, x_static_base_json FROM ${ML_TABLE}`);
let matched = 0, missing = 0;
const stmts: string[] = ['BEGIN;'];
for (const m of mlRows) {
  const k = `${m.season}|${m.competition_slug}|${m.division_name}|${m.corps_key}`;
  const o = wByKey.get(k);
  const base = JSON.parse(m.x_static_base_json) as number[];
  if (base.length !== BASE_STATIC_DIM) throw new Error(`row ${k}: base static dim ${base.length} != ${BASE_STATIC_DIM}`);
  if (!o) {
    // No W (row absent from contract): keep the row trainable by padding the
    // static vector to the new dim with neutral zero features and leaving the W
    // columns NULL — baseline-mode "w" falls back to the corps' last real recap.
    missing++;
    const padded = [...base, ...new Array(K_FEATURES).fill(0)];
    stmts.push(`UPDATE ${ML_TABLE} SET x_static_json='${esc(JSON.stringify(padded))}', v13_resid_features_json='${esc(JSON.stringify(new Array(K_FEATURES).fill(0)))}' WHERE season='${esc(m.season)}' AND competition_slug='${esc(m.competition_slug)}' AND division_name='${esc(m.division_name)}' AND corps_key='${esc(m.corps_key)}';`);
    continue;
  }
  matched++;
  const stat = [...base, ...o.feats];
  const wj = JSON.stringify(Object.fromEntries(CAPTIONS.map((c) => [c, o.wCaps[c]])));
  stmts.push(
    `UPDATE ${ML_TABLE} SET ` +
    `x_static_json='${esc(JSON.stringify(stat))}', ` +
    `w_caption_json='${esc(wj)}', w_total=${o.wTotal}, w_precorr_total=${o.wPreTotal}, w_bias_correction=${o.bias}, ` +
    `v13_resid_features_json='${esc(JSON.stringify(o.feats))}' ` +
    `WHERE season='${esc(m.season)}' AND competition_slug='${esc(m.competition_slug)}' AND division_name='${esc(m.division_name)}' AND corps_key='${esc(m.corps_key)}';`,
  );
}
stmts.push('COMMIT;');
fs.writeFileSync('/tmp/v13-gen.sql', stmts.join('\n'));
execFileSync('sqlite3', [TRAIN_DB], { input: stmts.join('\n'), encoding: 'utf-8', maxBuffer: 1024 * 1024 * 1024 });

// ── report ──
const f = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');
process.stderr.write('\n=== G2 residual-target smoke ===\n');
process.stderr.write(`ml rows matched=${matched} missing=${missing} (missing rows keep raw static, no W baseline)\n`);
process.stderr.write(`k=${K_FEATURES} features -> new static dim ${BASE_STATIC_DIM + K_FEATURES}: ${FEATURE_NAMES.join(', ')}\n`);
process.stderr.write(`TOTAL-level   raw(actual-persist) mad=${f(mad(rawTot))} std=${f(std(rawTot))}  |  residual(actual-W) mad=${f(mad(resTot))} std=${f(std(resTot))}\n`);
process.stderr.write(`CAPTION-level raw mad=${f(mad(rawCap))} std=${f(std(rawCap))}  |  residual mad=${f(mad(resCap))} std=${f(std(resCap))}  (ref raw caption mads ~0.72/0.97)\n`);
for (const t of Object.keys(byTier).sort()) process.stderr.write(`  tier ${t}: raw mad=${f(mad(byTier[t].raw))} residual mad=${f(mad(byTier[t].res))} n=${byTier[t].res.n}\n`);
const verdict = mad(resTot) < mad(rawTot) && mad(resCap) < mad(rawCap);
process.stderr.write(`G2 bar (residual spread << raw spread): ${verdict ? 'PASS' : 'REVIEW'}\n`);
