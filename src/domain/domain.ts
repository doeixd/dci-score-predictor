// Domain identities: corps, judges, captions, divisions — with smart matching
// backed by the generated registries (assets/registries). Matching reproduces the
// production normalization: lowercase, punctuation-strip, alias table.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPTIONS, type Caption as CaptionKey } from '../model/contract.js';

const registriesDir = () =>
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'registries');

export const Division = {
  WorldClass: 'World Class',
  OpenClass: 'Open Class',
  AllAge: 'All Age',
} as const;
export type Division = (typeof Division)[keyof typeof Division];

export interface Corps {
  key: string;
  name: string;
  division: Division;
  /** True when the corps is not in the shipped registry (new/unknown — fine: the model is identity-agnostic). */
  unknown?: boolean;
}

export interface Judge {
  id: string;
  initials: string | null;
  captions: string[];
}

export interface CaptionDef {
  key: CaptionKey;
  label: string;
  category: 'GE' | 'Visual' | 'Music';
  breakdown: readonly ['Content', 'Achievement'];
}

const CAPTION_LABELS: Record<CaptionKey, { label: string; category: CaptionDef['category'] }> = {
  GE1: { label: 'General Effect 1', category: 'GE' },
  GE2: { label: 'General Effect 2', category: 'GE' },
  VP: { label: 'Visual Proficiency', category: 'Visual' },
  VA: { label: 'Visual Analysis', category: 'Visual' },
  CG: { label: 'Color Guard', category: 'Visual' },
  MB: { label: 'Music Brass', category: 'Music' },
  MA: { label: 'Music Analysis', category: 'Music' },
  MP: { label: 'Music Percussion', category: 'Music' },
};

export const Caption = Object.fromEntries(
  CAPTIONS.map((key) => [
    key,
    { key, ...CAPTION_LABELS[key], breakdown: ['Content', 'Achievement'] } satisfies CaptionDef,
  ])
) as unknown as Record<CaptionKey, CaptionDef>;

const CAPTION_NAME_LOOKUP: Record<string, CaptionKey> = {
  ge1: 'GE1', 'general effect 1': 'GE1', 'general effect1': 'GE1',
  ge2: 'GE2', 'general effect 2': 'GE2',
  vp: 'VP', 'visual proficiency': 'VP',
  va: 'VA', 'visual analysis': 'VA', 'visual - analysis': 'VA',
  cg: 'CG', 'color guard': 'CG', colorguard: 'CG', guard: 'CG',
  mb: 'MB', 'music brass': 'MB', brass: 'MB',
  ma: 'MA', 'music analysis': 'MA', 'music - analysis': 'MA',
  mp: 'MP', 'music percussion': 'MP', percussion: 'MP',
};

export const matchCaption = (input: string): CaptionKey | null =>
  CAPTION_NAME_LOOKUP[input.trim().toLowerCase()] ?? null;

export const normalizeName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();

interface CorpsRegistry {
  corps: Array<{ key: string; name: string; division: string | null; last_season: string }>;
  aliases: Record<string, string>;
}
interface JudgeRegistry {
  judges: Array<{ id: string; initials: string | null; captions: string | null }>;
}

let corpsRegistryCache: CorpsRegistry | null = null;
let judgeRegistryCache: JudgeRegistry | null = null;
const corpsRegistry = (): CorpsRegistry =>
  (corpsRegistryCache ??= JSON.parse(
    fs.readFileSync(path.join(registriesDir(), 'corps.json'), 'utf-8')
  ));
const judgeRegistry = (): JudgeRegistry =>
  (judgeRegistryCache ??= JSON.parse(
    fs.readFileSync(path.join(registriesDir(), 'judges.json'), 'utf-8')
  ));

let corpsIndex: Map<string, Corps> | null = null;
const buildCorpsIndex = (): Map<string, Corps> => {
  if (corpsIndex) return corpsIndex;
  const reg = corpsRegistry();
  const byName = new Map<string, Corps>();
  for (const c of reg.corps) {
    const corps: Corps = {
      key: c.key,
      name: c.name,
      division: (c.division as Division) ?? Division.WorldClass,
    };
    const norm = normalizeName(c.name);
    // Prefer the most recently active corps when normalized names collide.
    const existing = byName.get(norm);
    if (!existing) byName.set(norm, corps);
  }
  for (const [alias, canonical] of Object.entries(reg.aliases)) {
    const target = byName.get(normalizeName(canonical));
    if (target && !byName.has(normalizeName(alias))) byName.set(normalizeName(alias), target);
  }
  corpsIndex = byName;
  return byName;
};

export type CorpsMatch =
  | { corps: Corps; method: 'exact' | 'alias' }
  | { corps: null; method: 'none'; suggestions: string[] };

/** Smart corps lookup: normalization + alias table; suggestions on miss. */
export const matchCorps = (input: string): CorpsMatch => {
  const index = buildCorpsIndex();
  const norm = normalizeName(input);
  const hit = index.get(norm);
  if (hit) {
    return { corps: hit, method: normalizeName(hit.name) === norm ? 'exact' : 'alias' };
  }
  // Suggestions: registry names sharing a token with the input.
  const tokens = norm.split(' ').filter((t) => t.length > 2);
  const suggestions = [...new Set([...index.values()].map((c) => c.name))]
    .filter((name) => tokens.some((t) => normalizeName(name).includes(t)))
    .slice(0, 5);
  return { corps: null, method: 'none', suggestions };
};

/** A corps not in the registry — first-class input, the model is identity-agnostic. */
export const makeCorps = (name: string, options: { division: Division; key?: string }): Corps => ({
  key: options.key ?? `custom:${normalizeName(name).replace(/\s/g, '-')}`,
  name,
  division: options.division,
  unknown: true,
});

let judgeIndex: Map<string, Judge> | null = null;
const buildJudgeIndex = (): Map<string, Judge> => {
  if (judgeIndex) return judgeIndex;
  const map = new Map<string, Judge>();
  for (const j of judgeRegistry().judges) {
    const judge: Judge = {
      id: j.id,
      initials: j.initials,
      captions: (j.captions ?? '').split(',').filter(Boolean),
    };
    map.set(normalizeName(j.id), judge);
    // "a anderson" ↔ "anderson a" ↔ initials form all resolve.
    const parts = normalizeName(j.id).split(' ');
    if (parts.length === 2) {
      map.set(`${parts[1]} ${parts[0]}`, judge);
      map.set(`${parts[0]![0]} ${parts[1]}`, judge);
    }
  }
  judgeIndex = map;
  return map;
};

export const matchJudge = (input: string): Judge | null =>
  buildJudgeIndex().get(normalizeName(input)) ?? null;
