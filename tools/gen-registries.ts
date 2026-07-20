// Build-time registry generator (maintainers only — needs the private prod DB).
// Emits assets/registries/{corps.json,judges.json} consumed by src/domain.
// Run: npx tsx tools/gen-registries.ts [db-path]
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DB = process.argv[2] ?? process.env.DCI_DB ?? 'dci-relational.db';
const outDir = path.resolve(import.meta.dirname, '..', 'assets', 'registries');
fs.mkdirSync(outDir, { recursive: true });

const q = (sql: string): any[] =>
  JSON.parse(execFileSync('sqlite3', ['-json', '-readonly', DB, sql], { encoding: 'utf-8' }) || '[]');

// Corps: canonical name + key + latest division + seasons active, plus aliases.
const corps = q(`
  SELECT cs.corps_key AS key,
         cs.corps_name AS name,
         (SELECT c2.division_name FROM corps_scores c2
          WHERE c2.corps_key = cs.corps_key AND c2.division_name IS NOT NULL
          ORDER BY c2.competition_slug DESC LIMIT 1) AS division,
         COUNT(DISTINCT substr(cs.competition_slug, 1, 4)) AS seasons,
         MAX(substr(cs.competition_slug, 1, 4)) AS last_season
  FROM corps_scores cs
  WHERE cs.corps_key IS NOT NULL AND cs.corps_name IS NOT NULL
  GROUP BY cs.corps_key
  ORDER BY cs.corps_name
`);
const aliases = q(`SELECT alias_name, canonical_name FROM corps_aliases`);
const aliasMap: Record<string, string> = {};
for (const a of aliases) aliasMap[a.alias_name] = a.canonical_name;

// Judges: id + initials + captions seen, for name normalization/smart matching.
const judges = q(`
  SELECT judge_id AS id,
         MAX(judge_initials) AS initials,
         GROUP_CONCAT(DISTINCT normalized_caption_name) AS captions,
         COUNT(*) AS assignments
  FROM judge_assignments
  WHERE judge_id IS NOT NULL AND judge_id != '' AND judge_id NOT LIKE '%unknown%'
  GROUP BY judge_id
  ORDER BY judge_id
`);

fs.writeFileSync(
  path.join(outDir, 'corps.json'),
  JSON.stringify({ generated_from: 'corps_scores/corps_aliases', corps, aliases: aliasMap }, null, 1)
);
fs.writeFileSync(
  path.join(outDir, 'judges.json'),
  JSON.stringify({ generated_from: 'judge_assignments', judges }, null, 1)
);
console.log(`registries: ${corps.length} corps, ${Object.keys(aliasMap).length} aliases, ${judges.length} judges`);
