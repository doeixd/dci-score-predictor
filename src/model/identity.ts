// Opt-in identity serving support. Production serving is identity-AGNOSTIC (all
// corps/judge/show embeddings zeroed, judge_bias_scale/corps_scale = 0, and the
// judge-Elo static block 101–112 masked). The v10.4 weights were TRAINED with
// those identity inputs (with heavy identity dropout, so the agnostic state is
// squarely in-distribution) — this module re-enables them as an explicit,
// per-part opt-in and NEVER runs on the default path.
//
// Browser-safe: reads its registries through the asset-provider seam
// (getJsonSync) exactly like domain.ts — no node:* imports. The three index maps
// are the dev3 v10 artifact maps whose vocab (corps 54 / judges 211 / shows 290)
// matches the shipped embeddings. See assets/registries/identity/README.md.
import { CAPTIONS, JUDGE_ELO_START, JUDGE_ELO_END, type Caption } from './contract.js';
import { getJsonSync } from '../assets/provider.js';
import { matchJudge } from '../domain/domain.js';
import type { TemporalState } from '../features/temporal.js';

/** Identity-on scale values fed by training/eval when identity is ACTIVE (=1);
 * the agnostic default feeds 0. (cp-branch trainModelV95.ts:353-356 / :620-623;
 * scripts/replayFinal2Baseline.ts:359-370.) */
export const IDENTITY_ON_SCALE = 1;

const ELO_BLOCK_LEN = JUDGE_ELO_END - JUDGE_ELO_START + 1; // 12: 8 per-caption + 4 panel

/** Public knob. `'agnostic'` (default) = exact current behavior; `'full'` = all
 * three parts on; object form enables parts individually. */
export type IdentityMode =
  | 'agnostic'
  | 'full'
  | { corps?: boolean; judges?: boolean; show?: boolean };

export interface IdentityFlags {
  corps: boolean;
  judges: boolean;
  show: boolean;
}

export const resolveIdentityFlags = (mode: IdentityMode | undefined): IdentityFlags => {
  if (!mode || mode === 'agnostic') return { corps: false, judges: false, show: false };
  if (mode === 'full') return { corps: true, judges: true, show: true };
  return { corps: !!mode.corps, judges: !!mode.judges, show: !!mode.show };
};

export const anyIdentityEnabled = (flags: IdentityFlags): boolean =>
  flags.corps || flags.judges || flags.show;

// ── Registry loading (cached, through the provider seam) ──
type IndexMap = Record<string, number>;
type AliasMap = Record<string, string>;
let corpsMapCache: IndexMap | null = null;
let judgeMapCache: IndexMap | null = null;
let showMapCache: IndexMap | null = null;
let aliasMapCache: AliasMap | null = null;
const corpsMap = (): IndexMap =>
  (corpsMapCache ??= getJsonSync<IndexMap>('registries/identity/corpsIndexMap.json'));
const judgeMap = (): IndexMap =>
  (judgeMapCache ??= getJsonSync<IndexMap>('registries/identity/judgeIndexMap.json'));
const showMap = (): IndexMap =>
  (showMapCache ??= getJsonSync<IndexMap>('registries/identity/showIndexMap.json'));
const aliasMap = (): AliasMap =>
  (aliasMapCache ??= getJsonSync<AliasMap>('registries/identity/corpsAliasMap.json'));

// ── Resolvers ──

/** corps_key → embedding index (with alias fallback). matched = in-vocab (>0). */
export const corpsEmbeddingIndex = (corpsKey: string): { index: number; matched: boolean } => {
  const map = corpsMap();
  const direct = map[corpsKey];
  if (typeof direct === 'number' && direct > 0) return { index: direct, matched: true };
  const aliased = aliasMap()[corpsKey];
  const viaAlias = aliased !== undefined ? map[aliased] : undefined;
  if (typeof viaAlias === 'number' && viaAlias > 0) return { index: viaAlias, matched: true };
  return { index: 0, matched: false };
};

/** Year-stripped target slug → agnostic show embedding index (getAgnosticShowId). */
export const showEmbeddingIndex = (slug: string): { index: number; matched: boolean } => {
  const base = slug.replace(/^\d{4}-/, '');
  const idx = showMap()[base];
  return typeof idx === 'number' && idx > 0 ? { index: idx, matched: true } : { index: 0, matched: false };
};

/** Resolve a supplied judge name OR judge_id to the canonical judge_id. */
export const resolveJudgeId = (name: string): string | undefined => {
  if (judgeMap()[name] !== undefined) return name; // already a known judge_id
  return matchJudge(name)?.id;
};

/** judge_id → embedding index (0 = unknown). */
export const judgeEmbeddingIndex = (judgeId: string | undefined): number =>
  (judgeId !== undefined ? judgeMap()[judgeId] : undefined) ?? 0;

// ── Identity feed passed into servePrediction ──
export interface ServeIdentity {
  corpsId: number; // 0 when corps disabled / unknown
  agnosticShowId: number; // 0 when show disabled / unknown
  judgeIndices: number[]; // [8]; zeros when judges disabled
  corpsScale: number; // IDENTITY_ON_SCALE when corps on, else 0
  judgeBiasScale: number; // IDENTITY_ON_SCALE when judges on, else 0
  /** [12] written into static 101–112 (unmasked); undefined ⇒ mask as usual. */
  judgeEloBlock?: number[];
}

export interface PanelResolution {
  judgeIndices: number[]; // [8]
  eloBlock: number[]; // [12]
  matchedJudges: number;
  unmatchedJudges: string[];
  eloCovered: number; // judges with real (non-neutral) 2026 Elo
  eloTotal: number; // total judge-caption assignments resolved
}

/**
 * Build the judge panel identity (indices[8] + Elo static block[12]) for one
 * (season, division) target panel, mirroring the prod builder: per-caption avg
 * `(elo-1500)/200`, then panel `(mean-1500)/200, std/100, (max-1500)/200,
 * (min-1500)/200` over every resolved judge-caption Elo. Elos come from the
 * caller's own history replay (neutral 1500 when a judge has no 2026 record).
 */
export const resolveJudgePanel = (
  temporal: TemporalState,
  season: number,
  division: string,
  judges: Partial<Record<Caption, string[]>> | undefined
): PanelResolution => {
  const indices = new Array<number>(CAPTIONS.length).fill(0);
  const perCaptionElos: number[][] = CAPTIONS.map(() => []);
  const allElos: number[] = [];
  const unmatchedJudges: string[] = [];
  let matchedJudges = 0;
  let eloCovered = 0;

  CAPTIONS.forEach((caption, slot) => {
    for (const rawName of judges?.[caption] ?? []) {
      const judgeId = resolveJudgeId(rawName);
      const idx = judgeEmbeddingIndex(judgeId);
      if (idx > 0) {
        indices[slot] = idx; // last-wins per slot (matches prod)
        matchedJudges++;
      } else {
        unmatchedJudges.push(rawName);
      }
      const elo = judgeId ? temporal.judgeEloValue(season, division, judgeId, caption) : 1500;
      if (elo !== 1500) eloCovered++;
      allElos.push(elo);
      perCaptionElos[slot]!.push(elo);
    }
  });

  const perCaptionJudgeElo = perCaptionElos.map((elos) =>
    elos.length ? (elos.reduce((a, b) => a + b, 0) / elos.length - 1500) / 200 : 0
  );
  let panelMean = 1500;
  let panelStd = 0;
  let panelMax = 1500;
  let panelMin = 1500;
  if (allElos.length) {
    panelMean = allElos.reduce((a, b) => a + b, 0) / allElos.length;
    panelStd = Math.sqrt(
      allElos.reduce((s, e) => s + (e - panelMean) ** 2, 0) / allElos.length
    );
    panelMax = Math.max(...allElos);
    panelMin = Math.min(...allElos);
  }
  const eloBlock = [
    ...perCaptionJudgeElo,
    (panelMean - 1500) / 200,
    panelStd / 100,
    (panelMax - 1500) / 200,
    (panelMin - 1500) / 200,
  ];
  if (eloBlock.length !== ELO_BLOCK_LEN)
    throw new Error(`judge Elo block dim mismatch: ${eloBlock.length} !== ${ELO_BLOCK_LEN}`);

  return {
    judgeIndices: indices,
    eloBlock,
    matchedJudges,
    unmatchedJudges,
    eloCovered,
    eloTotal: allElos.length,
  };
};

// ── Diagnostics surfaced in readiness.identity ──
export interface IdentityDiagnostics {
  mode: 'agnostic' | 'full' | 'partial';
  enabled: IdentityFlags;
  corps: { matched: number; unmatched: string[] };
  judges: { matched: number; unmatched: string[] };
  show: { matched: boolean; slug: string | null };
  eloCoverage: number; // fraction of resolved judge-caption Elos that are non-neutral
}
