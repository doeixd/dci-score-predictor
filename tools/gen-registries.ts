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

// ── Type-safe corps namespace (PLAN §3.1): src/domain/generated-corps.ts ──
// A committed, generated const object of PascalCase identifiers → frozen Corps
// instances, plus a KnownCorpsName union (canonical names + aliases) for the
// strict Corps.named() form. Derived from the SAME corps rows dumped above, so
// re-running against the prod DB keeps the JSON registry and this file in sync.

// Map a messy registry division string to one of the three the model reasons
// about; null = not a competitive corps we surface as an identifier.
const mapDivision = (raw: string | null): 'World Class' | 'Open Class' | 'All Age' | null => {
  const d = (raw ?? '').toLowerCase();
  if (d.includes('individual') || d.includes('exhibition') || d.includes('soundsport') || d.includes('brass'))
    return null;
  if (d.includes('all age') || d.includes('all-age') || d.includes('a class')) return 'All Age';
  if (d.includes('open')) return 'Open Class';
  if (d.includes('world') || d.includes('international')) return 'World Class';
  return null;
};

const pascalId = (name: string): string | null => {
  const tokens = name
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const id = tokens.map((t) => t[0]!.toUpperCase() + t.slice(1)).join('');
  return /^[A-Za-z][A-Za-z0-9]*$/.test(id) ? id : null; // skip leading-digit / empty (unpronounceable)
};

interface NamespaceEntry {
  id: string;
  key: string;
  name: string;
  division: 'World Class' | 'Open Class' | 'All Age';
  last_season: string;
}

// Dedupe id collisions by most-recent last_season.
const byId = new Map<string, NamespaceEntry>();
const canonicalNames = new Set<string>();
for (const c of corps as Array<{ key: string; name: string; division: string | null; last_season: string }>) {
  const name = (c.name ?? '').trim();
  if (!name) continue;
  const division = mapDivision(c.division);
  if (!division) continue;
  const id = pascalId(name);
  if (!id || id === 'Unknown') continue;
  canonicalNames.add(name);
  const existing = byId.get(id);
  if (!existing || (c.last_season ?? '') > existing.last_season)
    byId.set(id, { id, key: c.key, name, division, last_season: c.last_season ?? '' });
}

const entries = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
// KnownCorpsName: canonical names of surfaced corps + every alias key (all resolve via matchCorps).
const knownNames = [...new Set([...canonicalNames, ...Object.keys(aliasMap)])].sort((a, b) =>
  a.localeCompare(b)
);

const esc = (s: string): string => JSON.stringify(s);
const entryLines = entries
  .map((e) => `  ${e.id}: { key: ${esc(e.key)}, name: ${esc(e.name)}, division: ${esc(e.division)} },`)
  .join('\n');
const unionLines = knownNames.map((n) => `  | ${esc(n)}`).join('\n');

const generated = `// AUTO-GENERATED by tools/gen-registries.ts — DO NOT EDIT BY HAND.
// Type-safe corps identities (PLAN §3.1). Source: prod corps registry snapshot.
// Regenerate: DCI_DB=/path/to/dci-relational.db npx tsx tools/gen-registries.ts
import type { Corps } from './domain.js';

/** PascalCase identifier → frozen {@link Corps} instance. Includes the Unknown sentinel. */
export const GENERATED_CORPS = {
${entryLines}
  Unknown: { key: 'unknown', name: 'Unknown', division: 'World Class', unknown: true },
} as const satisfies Record<string, Corps>;

// Freeze the instances (const-object literal above is compile-time readonly only).
for (const c of Object.values(GENERATED_CORPS)) Object.freeze(c);
Object.freeze(GENERATED_CORPS);

export type GeneratedCorpsId = keyof typeof GENERATED_CORPS;

/** Canonical names + aliases that {@link matchCorps} resolves — the strict Corps.named() domain. */
export type KnownCorpsName =
${unionLines};
`;

const genOut = path.resolve(import.meta.dirname, '..', 'src', 'domain', 'generated-corps.ts');
fs.writeFileSync(genOut, generated);
console.log(
  `generated-corps.ts: ${entries.length} corps identifiers (+Unknown), ${knownNames.length} KnownCorpsName literals`
);
