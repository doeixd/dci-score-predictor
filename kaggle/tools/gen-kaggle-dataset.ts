/**
 * gen-kaggle-dataset.ts — build the Kaggle dataset CSVs from the (read-only) prod DB.
 *
 * Run:  npx tsx kaggle/tools/gen-kaggle-dataset.ts
 *
 * Source DB (READ-ONLY):  /root/corps-place/sdk/dci-relational.db
 * Output:                 kaggle/dataset/*.csv
 *
 * Everything is sourced from the CLEANED domain view `clean_reference_curve_entries`
 * (name-normalized, division-filtered, caption↔total reconciled, showcase/exhibition
 * excluded). The cleaned data — not the raw recap scrape — is what we publish.
 *
 * All files are restricted to the exact set of performances/events that survive the
 * clean view, so every CSV joins cleanly in pandas on (event_slug, corps_key).
 */
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DB_PATH = process.env.DCI_DB_PATH ?? '/root/corps-place/sdk/dci-relational.db';
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'dataset');
mkdirSync(OUT_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH, { readOnly: true });

// ---- CSV helpers ----------------------------------------------------------
function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = typeof v === 'number' ? String(v) : String(v);
  if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
function writeCsv(name: string, header: string[], rows: unknown[][]): number {
  const lines = [header.join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  const path = join(OUT_DIR, name);
  writeFileSync(path, lines.join('\n') + '\n');
  return rows.length;
}
const round = (x: unknown, d = 3) =>
  x === null || x === undefined ? null : Number(Number(x).toFixed(d));

const counts: Record<string, number> = {};

// ---- 1. scores.csv (wide, one row per performance) ------------------------
{
  const rows = db
    .prepare(
      `SELECT e.season, e.competition_slug AS event_slug, c.event_name, c.date, c.location,
              e.division_name AS division, e.corps_key, e.corps_name,
              e.computed_rank AS rank, e.total_score AS total,
              e.GE1, e.GE2, e.VP, e.VA, e.CG, e.MB, e.MA, e.MP,
              e.percent_through
         FROM clean_reference_curve_entries e
         JOIN competitions c ON c.slug = e.competition_slug
        ORDER BY e.season, c.date, e.division_name, e.computed_rank`
    )
    .all() as Record<string, unknown>[];
  counts['scores.csv'] = writeCsv(
    'scores.csv',
    ['season','event_slug','event_name','date','location','division','corps_key','corps_name',
     'rank','total','GE1','GE2','VP','VA','CG','MB','MA','MP','percent_through'],
    rows.map((r) => [
      r.season, r.event_slug, r.event_name, r.date, r.location, r.division, r.corps_key, r.corps_name,
      r.rank, round(r.total,3), round(r.GE1), round(r.GE2), round(r.VP), round(r.VA),
      round(r.CG), round(r.MB), round(r.MA), round(r.MP), round(r.percent_through,4),
    ])
  );
}

// ---- 2. events.csv (only events that have >=1 clean performance) ----------
{
  const rows = db
    .prepare(
      `SELECT c.slug, c.event_name AS name, c.date, c.location, c.season,
              c.percent_through,
              COUNT(*) AS n_performances
         FROM competitions c
         JOIN clean_reference_curve_entries e ON e.competition_slug = c.slug
        GROUP BY c.slug
        ORDER BY c.season, c.date`
    )
    .all() as Record<string, unknown>[];
  counts['events.csv'] = writeCsv(
    'events.csv',
    ['slug','name','date','location','season','percent_through','n_performances'],
    rows.map((r) => [r.slug, r.name, r.date, r.location, r.season, round(r.percent_through,4), r.n_performances])
  );
}

// ---- 3. corps.csv (only corps that appear in the clean scores) ------------
{
  const rows = db
    .prepare(
      `SELECT e.corps_key,
              MAX(e.corps_name) AS corps_name,
              MAX(e.division_name) AS division,
              GROUP_CONCAT(DISTINCT e.season) AS seasons_active,
              COUNT(*) AS n_performances
         FROM clean_reference_curve_entries e
        GROUP BY e.corps_key
        ORDER BY corps_name`
    )
    .all() as Record<string, unknown>[];

  const aliasStmt = db.prepare(
    `SELECT DISTINCT alias_name FROM corps_aliases WHERE LOWER(canonical_name) = LOWER(?) ORDER BY alias_name`
  );
  counts['corps.csv'] = writeCsv(
    'corps.csv',
    ['corps_key','corps_name','division','seasons_active','n_performances','aliases'],
    rows.map((r) => {
      const seasons = String(r.seasons_active).split(',').sort().join(';');
      const aliases = (aliasStmt.all(r.corps_name) as Record<string, unknown>[])
        .map((a) => String(a.alias_name))
        .filter((a) => a.toLowerCase() !== String(r.corps_name).toLowerCase())
        .join(';');
      return [r.corps_key, r.corps_name, r.division, seasons, r.n_performances, aliases];
    })
  );
}

// ---- 4. subcaptions.csv (long per-caption breakdown, with judged rank) -----
// caption_scores is the finest cleaned grain: one score+rank per adjudication
// caption. (DCI content/achievement sub-boxes are not preserved in the cleaned
// pipeline; the 8 domain captions are the published sheet grain.)
{
  const rows = db
    .prepare(
      `SELECT e.season, e.competition_slug AS event_slug, e.corps_key, e.corps_name,
              dca.caption_key, dc.display_name AS caption_name, dc.category_name AS category,
              cs.score, cs.rank
         FROM clean_reference_curve_entries e
         JOIN caption_scores cs ON cs.competition_slug = e.competition_slug AND cs.corps_key = e.corps_key
         JOIN domain_caption_aliases dca ON dca.raw_caption_name = cs.caption_name
         JOIN domain_captions dc ON dc.caption_key = dca.caption_key
        ORDER BY e.season, e.competition_slug, e.corps_key, dc.sort_order`
    )
    .all() as Record<string, unknown>[];
  counts['subcaptions.csv'] = writeCsv(
    'subcaptions.csv',
    ['season','event_slug','corps_key','corps_name','caption_key','caption_name','category','score','rank'],
    rows.map((r) => [r.season, r.event_slug, r.corps_key, r.corps_name, r.caption_key,
                     r.caption_name, r.category, round(r.score), r.rank])
  );
}

// ---- 5. judges.csv (which judge_id sat which caption at which show) --------
// judge_id is a public slug (first-initial + surname + disambiguator) derived
// from names DCI already posts on every public recap. We publish ONLY the slug
// id + caption assignment — no names, bios, photos, or contact fields.
{
  const rows = db
    .prepare(
      `SELECT DISTINCT e.season, ja.competition_slug AS event_slug,
              dca.caption_key, ja.judge_id, ja.judge_number
         FROM judge_assignments ja
         JOIN (SELECT DISTINCT competition_slug, season FROM clean_reference_curve_entries) e
              ON e.competition_slug = ja.competition_slug
         JOIN domain_caption_aliases dca ON dca.raw_caption_name = ja.caption_name
        ORDER BY e.season, ja.competition_slug, dca.caption_key, ja.judge_number`
    )
    .all() as Record<string, unknown>[];
  counts['judges.csv'] = writeCsv(
    'judges.csv',
    ['season','event_slug','caption_key','judge_id','judge_number'],
    rows.map((r) => [r.season, r.event_slug, r.caption_key, r.judge_id, r.judge_number])
  );
}

db.close();

console.log('Wrote to', OUT_DIR);
for (const [k, v] of Object.entries(counts)) console.log(`  ${k}: ${v} rows`);
