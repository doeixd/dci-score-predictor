// Simple API (`dci-score-predictor/simple`): loose plain-object input, smart name
// normalization (corps/caption via the domain matchers), division inference from
// the registry, and a full audit of what was inferred — then delegates to the
// same core predict path. One validation, one prediction path (PLAN §3.3).
// Eager Node provider install so sync corps/caption matchers work on import.
import { installNodeProvider } from '../assets/node-provider.js';
installNodeProvider();
import {
  Division,
  matchCorps,
  matchCaption,
  makeCorps,
  type Corps,
} from '../domain/domain.js';
import { CorpsNotFoundError } from '../domain/corps-namespace.js';
import { CAPTIONS, captionDerivedTotal, type Caption } from '../model/contract.js';
import type { DivisionName, ShowInput, TargetEventInput, PerformanceInput } from '../features/types.js';
import {
  predict as corePredict,
  DciValidationError,
  type PredictOptions,
  type PredictedShowResult,
  type NameNormalization,
} from '../predict.js';

// ── Loose input shapes ──

export interface LooseScoreRow {
  corps: string;
  /** Overall total; derived from captions when absent. */
  total?: number;
  /** { GE1: 17.4, ... } or { MA: 8.9, ... } — caption keys/labels normalized. */
  captions?: Record<string, number>;
  /** Alternative sheet form with a judge/breakdown per caption (breakdown summed). */
  sheet?: Array<{ caption: string; judge?: string; breakdown?: number[]; score?: number }>;
  performanceOrder?: number;
  /** Division hint (used when the corps is unknown to the registry). */
  division?: string;
}

export interface LooseShow {
  show: string;
  date: string;
  scores: LooseScoreRow[];
}

export interface LooseTarget {
  show: string;
  date: string;
  lineup: string[];
}

export interface LooseInput {
  seasonInfo?: { year?: number; start?: string; end?: string };
  history: LooseShow[];
  target: LooseTarget;
}

// CorpsNotFoundError now lives in the domain layer (domain/corps-namespace.ts) so
// the type-safe `Corps.lookup` and the simple API share one error. Re-exported
// here for backwards compatibility with `dci-score-predictor/simple` consumers.
export { CorpsNotFoundError };

const WORLD = Division.WorldClass;
const OPEN = Division.OpenClass;

/** Map a registry/hint division string to the two divisions the model covers. */
const normalizeDivision = (raw: string | null | undefined, corpsName: string): DivisionName => {
  const d = (raw ?? '').toLowerCase();
  if (d.includes('open')) return OPEN;
  if (d.includes('world')) return WORLD;
  if (d.includes('all age') || d.includes('all-age') || d.includes('a class') || d.includes('soundsport'))
    throw new DciValidationError(
      `corps "${corpsName}" resolves to division "${raw}", which the model does not cover ` +
        `(World Class / Open Class only). Pass an explicit { division } override.`
    );
  // Unknown/blank → default to World Class (documented).
  return WORLD;
};

interface Resolved {
  corps: Corps;
  division: DivisionName;
  norm?: NameNormalization;
}

const resolveCorps = (input: string, divisionHint: string | undefined, normalizations: NameNormalization[]): Resolved => {
  const match = matchCorps(input);
  if (match.corps) {
    const division = divisionHint
      ? normalizeDivision(divisionHint, input)
      : normalizeDivision(match.corps.division, input);
    // Record any normalization where the raw input differs from the canonical
    // registry name (alias, case, whitespace, or punctuation).
    if (input.trim() !== match.corps.name) {
      const norm: NameNormalization = { input, matched: match.corps.name, method: match.method, kind: 'corps' };
      normalizations.push(norm);
      return { corps: match.corps, division, norm };
    }
    return { corps: match.corps, division };
  }
  // Unknown corps: allowed only with a division hint (model is identity-agnostic).
  if (!divisionHint) throw new CorpsNotFoundError(input, match.suggestions);
  const division = normalizeDivision(divisionHint, input);
  const corps = makeCorps(input, { division });
  normalizations.push({ input, matched: corps.name, method: 'made', kind: 'corps' });
  return { corps, division };
};

const resolveCaptions = (row: LooseScoreRow, showSlug: string, normalizations: NameNormalization[]): Partial<Record<Caption, number>> => {
  const out: Partial<Record<Caption, number>> = {};
  if (row.captions) {
    for (const [rawKey, value] of Object.entries(row.captions)) {
      const cap = matchCaption(rawKey);
      if (!cap) throw new DciValidationError(`unknown caption "${rawKey}" in show ${showSlug} for ${row.corps}`);
      if (rawKey !== cap) normalizations.push({ input: rawKey, matched: cap, method: 'exact', kind: 'caption' });
      out[cap] = value;
    }
  }
  if (row.sheet) {
    for (const entry of row.sheet) {
      const cap = matchCaption(entry.caption);
      if (!cap) throw new DciValidationError(`unknown caption "${entry.caption}" in show ${showSlug} for ${row.corps}`);
      if (entry.caption !== cap) normalizations.push({ input: entry.caption, matched: cap, method: 'exact', kind: 'caption' });
      const score = entry.score ?? (entry.breakdown ? entry.breakdown.reduce((s, v) => s + v, 0) : undefined);
      if (score != null) out[cap] = score;
    }
  }
  return out;
};

/** Loose-input entry point: normalizes and delegates to the core predict. */
export async function predict(loose: LooseInput, options: PredictOptions = {}): Promise<PredictedShowResult> {
  const normalizations: NameNormalization[] = [];

  // Season window: from provided info, else inferred from the supplied dates.
  const allDates = [...loose.history.map((s) => s.date), loose.target.date].filter(Boolean).sort();
  const startDate = loose.seasonInfo?.start ?? allDates[0]!;
  const endDate = loose.seasonInfo?.end ?? allDates[allDates.length - 1]!;
  const year = loose.seasonInfo?.year ?? Number((loose.target.date || startDate).slice(0, 4));

  // History shows.
  const history: ShowInput[] = loose.history.map((show, si) => {
    const results: PerformanceInput[] = show.scores.map((row) => {
      const resolved = resolveCorps(row.corps, row.division, normalizations);
      const captions = resolveCaptions(row, show.show, normalizations);
      const total =
        row.total ??
        (CAPTIONS.every((c) => Number.isFinite(captions[c]))
          ? captionDerivedTotal(CAPTIONS.map((c) => captions[c]!))
          : undefined);
      const perf: PerformanceInput = {
        corpsKey: resolved.corps.key,
        corpsName: resolved.corps.name,
        division: resolved.division,
        captions,
        ...(total != null ? { total } : {}),
        ...(row.performanceOrder != null ? { performanceOrder: { overall: row.performanceOrder } } : {}),
      };
      return perf;
    });
    return { slug: slugify(show.show, si), date: show.date, results };
  });

  // Target lineup.
  const lineup = loose.target.lineup.map((name) => {
    const resolved = resolveCorps(name, undefined, normalizations);
    return { corpsKey: resolved.corps.key, corpsName: resolved.corps.name, division: resolved.division };
  });
  const target: TargetEventInput = { slug: slugify(loose.target.show, 999), date: loose.target.date, lineup };

  const result = await corePredict(
    { seasonInfo: { year, startDate, endDate }, history, target },
    options
  );
  // Attach the normalization audit (dedup by input+kind).
  const seen = new Set<string>();
  result.inputAudit.normalizations = normalizations.filter((n) => {
    const k = `${n.kind}:${n.input}→${n.matched}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return result;
}

const slugify = (name: string, index: number): string =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .trim()
    .replace(/\s+/g, '-') || `show-${index}`;
