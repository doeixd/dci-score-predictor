// Pure feature assembly: SeasonData + packaged FeatureContext → the exact
// clean-v10 field-pace inference rows production feeds the ensemble
// (sequence [15][101] + static [216]). Faithful port of the
// buildMlSequencesV9Subcaption.ts inference path (--inference-events).
//
// Serving-irrelevant caveat: static indices 101–112 (judge Elo) are NOT
// reproduced — production zeroes them via maskV9JudgeContext before inference,
// so their raw values never reach the model. The parity suite excludes them.
import { CAPTIONS, SEQ_LEN, FEAT_DIM, STATIC_DIM, type Caption } from '../model/contract.js';
import {
  EMA_ALPHA,
  bucketPercent,
  computeEma,
  computeSeriesStats,
  computeSlope,
  computeStats,
  computeWeightedMean,
  daysBetween,
  mean,
  normalizeCaptionScore,
  normalizeDays,
  normalizeGap,
  normalizeOffseasonGap,
  normalizeRank,
  normalizeRecentGap,
  normalizeScore,
  stdPop,
  stdSample,
} from './helpers.js';
import { TemporalState, type TemporalPerformance } from './temporal.js';
import type {
  BuiltFeatureRow,
  DivisionName,
  FeatureBuildDiagnostics,
  FeatureContext,
  SeasonData,
} from './types.js';

const FINALS_CUTOFF = 12;

export interface ReferenceCurvesArtifact {
  version?: string;
  curves: Record<string, Record<string, number>>;
}

/** Static-artifact curve fallback (used for inference-target rank baselines). */
const artifactBaseline = (
  artifact: ReferenceCurvesArtifact,
  rank: number,
  pct: number,
  caption: string,
  division: string
): number => {
  const safeRank = Math.max(1, Math.min(25, Math.round(Number.isFinite(rank) ? rank : 12)));
  const bucket = Math.max(0, Math.min(100, Math.round((Number.isFinite(pct) ? pct : 50) / 5) * 5));
  const curves = artifact.curves;
  return (
    curves[`${division}|${safeRank}-${bucket}`]?.[caption] ??
    curves[`${division}|${safeRank}-50`]?.[caption] ??
    curves[`${safeRank}-${bucket}`]?.[caption] ??
    curves[`${safeRank}-50`]?.[caption] ??
    15.0
  );
};

interface ShowEntry {
  slug: string;
  date: string;
  percentThrough: number;
  rank: number; // computed within (show, division)
  total: number;
  captions: Partial<Record<Caption, { score: number; rank: number }>>;
  subcaptions?: Partial<Record<Caption, { content: number; achievement: number }>> | undefined;
  performanceOrder?:
    | { inClass?: number; inClassCount?: number; overall?: number; overallCount?: number }
    | undefined;
  isInference?: boolean;
}

const derivedTotal = (captions: Partial<Record<Caption, number>>): number =>
  (captions.GE1 ?? 0) +
  (captions.GE2 ?? 0) +
  ((captions.VP ?? 0) +
    (captions.VA ?? 0) +
    (captions.CG ?? 0) +
    (captions.MB ?? 0) +
    (captions.MA ?? 0) +
    (captions.MP ?? 0)) /
    2;

const percentThroughFor = (
  data: SeasonData,
  date: string,
  explicit: number | undefined
): number => {
  if (explicit !== undefined) return explicit;
  const start = new Date(data.seasonInfo.startDate).getTime();
  const end = new Date(data.seasonInfo.endDate).getTime();
  const day = 86_400_000;
  return (
    (100 * ((new Date(date).getTime() - start) / day)) /
    Math.max(1, (end - start) / day)
  );
};

export interface BuildResult {
  rows: BuiltFeatureRow[];
  diagnostics: FeatureBuildDiagnostics[];
}

/**
 * Result of the history-only temporal replay. Depends solely on
 * (seasonInfo, shows, target.date) — NOT on the target lineup — so it can be
 * memoized and reused across many predictions that share the same history (see
 * `predictMany`). `buildFeatureRows` accepts one to skip re-replaying.
 */
export interface TemporalReplay {
  temporal: TemporalState;
  temporalRows: TemporalPerformance[];
  priorShows: SeasonData['shows'];
}

/**
 * Replay a season's resolved shows (strictly before the target date) into a
 * seeded {@link TemporalState}. Pure function of history + target date; the
 * expensive part of feature building and the only step worth caching when
 * scoring many targets over one history.
 */
export const replayTemporal = (data: SeasonData, context: FeatureContext): TemporalReplay => {
  const season = data.seasonInfo.year;
  const targetDate = data.target.date;
  // Leakage guard: only shows strictly before the target date participate.
  const priorShows = data.shows
    .filter((show) => show.date < targetDate)
    .sort((a, b) => a.date.localeCompare(b.date) || a.slug.localeCompare(b.slug));

  // ── Temporal replay (both divisions together — the curve is shared state) ──
  const temporalRows: TemporalPerformance[] = [];
  for (const show of priorShows) {
    const pct = percentThroughFor(data, show.date, show.percentThrough);
    // Rank within (show, division) by total desc, corpsKey asc (clean-view ROW_NUMBER).
    const byDivision = new Map<string, typeof show.results>();
    for (const result of show.results) {
      const complete = CAPTIONS.every((caption) => Number.isFinite(result.captions[caption]));
      if (!complete) continue;
      const group = byDivision.get(result.division) ?? [];
      group.push(result);
      byDivision.set(result.division, group);
    }
    for (const [division, results] of byDivision) {
      const ranked = [...results].sort(
        (a, b) =>
          derivedTotal(b.captions) - derivedTotal(a.captions) ||
          a.corpsKey.localeCompare(b.corpsKey)
      );
      ranked.forEach((result, index) => {
        const computedRank = index + 1;
        temporalRows.push({
          season,
          slug: show.slug,
          date: show.date,
          division,
          corpsKey: result.corpsKey,
          computedRank,
          rankBucket: Math.max(1, Math.min(25, computedRank)),
          percentThrough: pct,
          percentBucket: bucketPercent(pct),
          total: result.total ?? derivedTotal(result.captions),
          captions: Object.fromEntries(
            CAPTIONS.map((caption) => [caption, result.captions[caption]!])
          ) as Record<Caption, number>,
          judges: show.judges,
        });
      });
    }
  }
  const temporal = TemporalState.seeded(context);
  temporal.replay(temporalRows);
  return { temporal, temporalRows, priorShows };
};

export const buildFeatureRows = (
  data: SeasonData,
  context: FeatureContext,
  referenceCurves: ReferenceCurvesArtifact,
  replay?: TemporalReplay
): BuildResult => {
  const season = data.seasonInfo.year;
  const targetDate = data.target.date;
  const { temporal, temporalRows, priorShows } = replay ?? replayTemporal(data, context);

  const rows: BuiltFeatureRow[] = [];
  const diagnostics: FeatureBuildDiagnostics[] = [];
  const targetPct = percentThroughFor(data, targetDate, data.target.percentThrough);

  const divisions = [...new Set(data.target.lineup.map((entry) => entry.division))];
  for (const division of divisions) {
    // ── Per-division assembly structures (mirrors the prod division loop) ──
    const divisionRows = temporalRows.filter((row) => row.division === division);
    const lineup = data.target.lineup.filter((entry) => entry.division === division);

    // corpsMap: per corps chronological show entries (+ injected inference target).
    const corpsMap = new Map<string, ShowEntry[]>();
    const captionRankIndex = new Map<string, number>(); // `${slug}|${caption}|${corps}` → rank
    const bySlugCaption = new Map<string, TemporalPerformance[]>();
    for (const row of divisionRows) {
      for (const caption of CAPTIONS) {
        const key = `${row.slug}|${caption}`;
        const group = bySlugCaption.get(key) ?? [];
        group.push(row);
        bySlugCaption.set(key, group);
      }
    }
    for (const [key, group] of bySlugCaption) {
      const caption = key.split('|')[1] as Caption;
      const ranked = [...group].sort(
        (a, b) => b.captions[caption] - a.captions[caption] || a.corpsKey.localeCompare(b.corpsKey)
      );
      ranked.forEach((row, index) =>
        captionRankIndex.set(`${row.slug}|${caption}|${row.corpsKey}`, index + 1)
      );
    }
    const inputByShowCorps = new Map<string, ShowEntry['subcaptions'] | undefined>();
    const orderByShowCorps = new Map<string, ShowEntry['performanceOrder'] | undefined>();
    for (const show of priorShows)
      for (const result of show.results) {
        inputByShowCorps.set(`${show.slug}|${result.corpsKey}`, result.subcaptions);
        orderByShowCorps.set(`${show.slug}|${result.corpsKey}`, result.performanceOrder);
      }
    // corpsMap insertion order must match prod's query order (date, slug,
    // corps_key) — it determines corps_present order and thus stable-sort
    // tie-breaks in the opponent top-K blocks.
    const divisionRowsByKey = [...divisionRows].sort(
      (a, b) =>
        a.date.localeCompare(b.date) ||
        a.slug.localeCompare(b.slug) ||
        a.corpsKey.localeCompare(b.corpsKey)
    );
    for (const row of divisionRowsByKey) {
      const entries = corpsMap.get(row.corpsKey) ?? [];
      entries.push({
        slug: row.slug,
        date: row.date,
        percentThrough: row.percentThrough,
        rank: row.computedRank,
        total: row.total,
        captions: Object.fromEntries(
          CAPTIONS.map((caption) => [
            caption,
            {
              score: row.captions[caption],
              rank: captionRankIndex.get(`${row.slug}|${caption}|${row.corpsKey}`) ?? 0,
            },
          ])
        ),
        subcaptions: inputByShowCorps.get(`${row.slug}|${row.corpsKey}`),
        performanceOrder: orderByShowCorps.get(`${row.slug}|${row.corpsKey}`),
      });
      corpsMap.set(row.corpsKey, entries);
    }
    // Inject the inference target for every lineup corps.
    for (const entry of lineup) {
      const entries = corpsMap.get(entry.corpsKey) ?? [];
      entries.push({
        slug: data.target.slug,
        date: targetDate,
        percentThrough: targetPct,
        rank: 0,
        total: 0,
        captions: {},
        performanceOrder: undefined,
        isInference: true,
      });
      entries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
      corpsMap.set(entry.corpsKey, entries);
    }

    // competitionMap: field context per show slug within the division.
    interface Competition {
      corps_present: string[];
      field_size: number;
      leader_score: number;
      score_by_rank: Map<number, number>;
    }
    const competitionMap = new Map<string, Competition>();
    // Past-show competitions: corps_present must follow prod's row-stream order
    // (query ORDER BY competition_date, competition_slug, source_corps_key) — i.e.
    // corps_key ascending within a slug — since it drives the stable-sort tie-break
    // in the opponent top-K blocks. divisionRowsByKey is already in that order.
    for (const row of divisionRowsByKey) {
      const competition = competitionMap.get(row.slug) ?? {
        corps_present: [],
        field_size: 0,
        leader_score: 0,
        score_by_rank: new Map<number, number>(),
      };
      if (!competition.corps_present.includes(row.corpsKey)) {
        competition.corps_present.push(row.corpsKey);
        competition.field_size += 1;
      }
      competitionMap.set(row.slug, competition);
    }
    // Inference-target competition: a fresh context (prod builds infContext anew,
    // replacing any prior entry) with corps_present in lineup order.
    const inferenceCompetition: Competition = {
      corps_present: [],
      field_size: 0,
      leader_score: 0,
      score_by_rank: new Map<number, number>(),
    };
    for (const entry of lineup) {
      if (!inferenceCompetition.corps_present.includes(entry.corpsKey)) {
        inferenceCompetition.corps_present.push(entry.corpsKey);
        inferenceCompetition.field_size += 1;
      }
    }
    competitionMap.set(data.target.slug, inferenceCompetition);
    const showLookup = new Map<string, Map<string, ShowEntry>>();
    for (const [corpsKey, shows] of corpsMap)
      for (const show of shows) {
        const byCorps = showLookup.get(show.slug) ?? new Map<string, ShowEntry>();
        byCorps.set(corpsKey, show);
        showLookup.set(show.slug, byCorps);
      }
    for (const [slug, competition] of competitionMap) {
      const byCorps = showLookup.get(slug);
      if (!byCorps) continue;
      const ranked = competition.corps_present
        .map((corpsKey) => byCorps.get(corpsKey))
        .filter((show): show is ShowEntry => !!show && Number.isFinite(show.total) && show.total > 0)
        .sort((a, b) => b.total - a.total);
      competition.leader_score = ranked[0]?.total ?? 0;
      ranked.forEach((show, index) => {
        show.rank = index + 1;
        competition.score_by_rank.set(index + 1, show.total);
      });
    }

    // Local show aggregates (division-level field averages per show).
    const localShowAggregates = new Map<
      string,
      { avg_total: number; std_total: number; captions: Record<Caption, number> }
    >();
    for (const [slug, byCorps] of showLookup) {
      const complete = [...byCorps.values()].filter(
        (show) =>
          !show.isInference && CAPTIONS.every((caption) => Number.isFinite(show.captions[caption]?.score))
      );
      if (!complete.length) continue;
      localShowAggregates.set(slug, {
        avg_total: mean(complete.map((show) => show.total)),
        std_total: stdSample(complete.map((show) => show.total)),
        captions: Object.fromEntries(
          CAPTIONS.map((caption) => [caption, mean(complete.map((show) => show.captions[caption]!.score))])
        ) as Record<Caption, number>,
      });
    }

    // Prev-season rank fallback: mirrors prod queryPreviousSeasonFinalRankings —
    // MAX(total_score) per corps from corps_competition_results, division-filtered,
    // ranked best_total DESC (rank = index+1, state date = `${prevSeason}-08-15`).
    const defaultRank = Math.max(1, corpsMap.size);
    const prevSeason = season === 2022 ? 2019 : season - 1;
    const prevSeasonRankMap = new Map<string, { rank: number; total: number; date: string }>();
    (context.prevSeasonBestTotals[division] ?? []).forEach((entry, index) =>
      prevSeasonRankMap.set(entry.corpsKey, {
        rank: index + 1,
        total: entry.bestTotal,
        date: `${prevSeason}-08-15`,
      })
    );

    const rowKeyFor = (slug: string, corpsKey: string) =>
      TemporalState.rowKey(season, slug, division, corpsKey);
    // Production serving has NO historical-fallback table: inference targets with
    // no resolved-row temporal history get pure defaults (verified empirically —
    // the serving contract DB contains no corps_historical_features table). The
    // packaged corpsHistorical asset is surfaced in diagnostics only.
    const historyFor = (corpsKey: string, slug: string) =>
      temporal.corpsHistory.get(rowKeyFor(slug, corpsKey));
    const previousRankFor = (corpsKey: string, slug: string) =>
      temporal.corpsHistory.get(rowKeyFor(slug, corpsKey))?.previous_season_rank ??
      prevSeasonRankMap.get(corpsKey)?.rank ??
      defaultRank;

    // Overall standings rank per date (latest total strictly before the date).
    const dateSet = new Set<string>();
    for (const shows of corpsMap.values()) for (const show of shows) dateSet.add(show.date);
    const sortedDates = [...dateSet].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    const rankTrackers = new Map<
      string,
      { shows: ShowEntry[]; idx: number; latest: ShowEntry | null; prevRank: number }
    >();
    for (const [corpsKey, shows] of corpsMap)
      rankTrackers.set(corpsKey, {
        shows,
        idx: 0,
        latest: null,
        prevRank: previousRankFor(corpsKey, shows[0]?.slug ?? ''),
      });
    const overallRankCache = new Map<string, Map<string, number>>();
    for (const date of sortedDates) {
      const standings: Array<{ corpsKey: string; hasScore: boolean; total: number; prevRank: number }> =
        [];
      const targetMs = new Date(date).getTime();
      for (const [corpsKey, tracker] of rankTrackers) {
        while (
          tracker.idx < tracker.shows.length &&
          new Date(tracker.shows[tracker.idx]!.date).getTime() < targetMs
        ) {
          tracker.latest = tracker.shows[tracker.idx]!;
          tracker.idx += 1;
        }
        standings.push({
          corpsKey,
          hasScore: !!tracker.latest && !tracker.latest.isInference,
          total: tracker.latest && !tracker.latest.isInference ? tracker.latest.total : 0,
          prevRank: tracker.prevRank,
        });
      }
      standings.sort((a, b) => {
        if (a.hasScore !== b.hasScore) return (b.hasScore ? 1 : 0) - (a.hasScore ? 1 : 0);
        if (a.hasScore && b.hasScore) return b.total - a.total;
        return a.prevRank - b.prevRank;
      });
      const rankMap = new Map<string, number>();
      standings.forEach((entry, index) => rankMap.set(entry.corpsKey, index + 1));
      overallRankCache.set(date, rankMap);
    }
    const getOverallRank = (date: string, corpsKey: string, fallback: number) =>
      overallRankCache.get(date)?.get(corpsKey) ?? fallback;

    const scoredSeasonDates = [...new Set(
      [...corpsMap.values()].flat().filter((show) => !show.isInference).map((show) => show.date)
    )].sort((a, b) => new Date(a).getTime() - new Date(b).getTime());
    const firstScoredDateOfSeason = scoredSeasonDates[0];

    const baselineForShow = (slug: string, corpsKey: string, rank: number, pct: number, caption: Caption) =>
      temporal.captionTemporal.get(`${rowKeyFor(slug, corpsKey)}|${caption}`)?.reference_baseline ??
      artifactBaseline(referenceCurves, rank, pct, caption, division);

    // Opponent history (resolved shows only).
    interface OpponentHistoryEntry {
      date: string;
      residualMean: number;
      rank: number;
      totalScore: number;
      captionScores: number[];
    }
    const opponentHistoryMap = new Map<string, OpponentHistoryEntry[]>();
    for (const [corpsKey, shows] of corpsMap) {
      const prevRank = previousRankFor(corpsKey, shows[0]?.slug ?? '');
      const history: OpponentHistoryEntry[] = [];
      for (const show of shows) {
        if (show.isInference) continue;
        const rankEntering = getOverallRank(show.date, corpsKey, prevRank);
        let residualSum = 0;
        const captionScores = CAPTIONS.map((caption) => {
          const score = show.captions[caption]?.score ?? 0;
          residualSum += score - baselineForShow(show.slug, corpsKey, rankEntering, show.percentThrough, caption);
          return score;
        });
        history.push({
          date: show.date,
          residualMean: residualSum / CAPTIONS.length,
          rank: show.rank ?? rankEntering,
          totalScore: show.total,
          captionScores,
        });
      }
      opponentHistoryMap.set(corpsKey, history);
    }

    const summarizeOpponents = (
      snapshots: Array<{ residualMean: number; rank: number }>,
      fieldSize: number,
      topK = 3
    ) => {
      const residuals = snapshots.map((snap) => snap.residualMean);
      const ranks = snapshots.map((snap) => snap.rank || fieldSize);
      const residualStats = computeStats(residuals);
      const rankStats = computeStats(ranks);
      const weights = ranks.map((rank) => (fieldSize - Math.min(rank, fieldSize) + 1) / fieldSize);
      const weightedResidualMean = computeWeightedMean(residuals, weights);
      const sortedByRank = [...snapshots].sort((a, b) => (a.rank || fieldSize) - (b.rank || fieldSize));
      const topResiduals: number[] = [];
      const topRanks: number[] = [];
      for (let i = 0; i < topK; i++) {
        const snapshot = sortedByRank[i];
        topResiduals.push(snapshot ? snapshot.residualMean : 0);
        topRanks.push(snapshot ? normalizeRank(snapshot.rank) : normalizeRank(fieldSize));
      }
      return {
        residualStats,
        weightedResidualMean,
        rankMean: normalizeRank(rankStats.mean || fieldSize),
        rankBest: normalizeRank(rankStats.min || fieldSize),
        topResiduals,
        topRanks,
      };
    };

    const summarizeOpponentLast3 = (opponentKeys: string[], cutoffMs: number) => {
      const totalMeans: number[] = [],
        totalSlopes: number[] = [],
        totalVols: number[] = [];
      const captionMeans = CAPTIONS.map(() => [] as number[]);
      const captionSlopes = CAPTIONS.map(() => [] as number[]);
      const captionVols = CAPTIONS.map(() => [] as number[]);
      for (const opponentKey of opponentKeys) {
        const history = opponentHistoryMap.get(opponentKey) ?? [];
        const last3 = history.filter((entry) => new Date(entry.date).getTime() < cutoffMs).slice(-3);
        if (!last3.length) continue;
        const totalStats = computeSeriesStats(last3.map((entry) => entry.totalScore));
        totalMeans.push(totalStats.mean);
        totalSlopes.push(totalStats.slope);
        totalVols.push(totalStats.volatility);
        for (let idx = 0; idx < CAPTIONS.length; idx++) {
          const stats = computeSeriesStats(last3.map((entry) => entry.captionScores[idx] ?? 0));
          captionMeans[idx]!.push(stats.mean);
          captionSlopes[idx]!.push(stats.slope);
          captionVols[idx]!.push(stats.volatility);
        }
      }
      return {
        total: { mean: mean(totalMeans), slope: mean(totalSlopes), volatility: mean(totalVols) },
        captions: {
          mean: captionMeans.map(mean),
          slope: captionSlopes.map(mean),
          volatility: captionVols.map(mean),
        },
      };
    };

    // ── Build one row per lineup corps ──
    for (const entry of lineup) {
      const corpsKey = entry.corpsKey;
      const shows = corpsMap.get(corpsKey)!;
      const targetIdx = shows.findIndex((show) => show.isInference);
      const targetShow = shows[targetIdx]!;
      const pastShows = shows.slice(0, targetIdx).filter((show) => !show.isInference);
      const prevRank = previousRankFor(corpsKey, shows[0]?.slug ?? '');
      const seasonStartDate = pastShows[0]?.date ?? targetShow.date;
      const pastCount = pastShows.length || 1;

      const x_sequence: number[][] = [];
      for (let j = 0; j < SEQ_LEN; j++) {
        const showIdx = pastShows.length - (SEQ_LEN - j);
        if (showIdx < 0) {
          const padding = new Array<number>(FEAT_DIM).fill(0);
          padding[3] = 1;
          x_sequence.push(padding);
          continue;
        }
        const show = pastShows[showIdx]!;
        const prevShow = showIdx > 0 ? pastShows[showIdx - 1]! : null;
        const rankEntering = getOverallRank(show.date, corpsKey, prevRank);
        const competition = competitionMap.get(show.slug);
        const fieldSize = competition?.field_size ?? 25;
        const leaderScore = competition?.leader_score ?? show.total;
        const scoreByRank = competition?.score_by_rank ?? new Map<number, number>();
        const gapToLeader = leaderScore - show.total;
        const gapToNext =
          show.rank > 1 ? (scoreByRank.get(show.rank - 1) ?? leaderScore) - show.total : 0;
        const percentile = fieldSize > 1 ? 1 - (show.rank - 1) / (fieldSize - 1) : 1;
        const totalScoreDelta = prevShow ? show.total - prevShow.total : 0;

        const feats: number[] = [];
        feats.push(show.percentThrough / 100);
        feats.push(prevShow ? Math.min(daysBetween(prevShow.date, show.date), 14) / 14 : 0.5);
        feats.push((showIdx + 1) / SEQ_LEN);
        feats.push(0);
        feats.push(normalizeDays(daysBetween(seasonStartDate, show.date)));
        feats.push((showIdx + 1) / pastCount);
        feats.push((pastCount - (showIdx + 1)) / pastCount);
        const d = new Date(show.date);
        const startOfYear = new Date(d.getFullYear(), 0, 1);
        const dayOfYear = (d.getTime() - startOfYear.getTime()) / 86_400_000;
        const dayRad = (dayOfYear / 366) * 2 * Math.PI;
        feats.push(Math.sin(dayRad), Math.cos(dayRad));
        feats.push((showIdx + 1) / 40.0);
        const rankDelta = prevShow ? show.rank - prevShow.rank : 0;
        feats.push(normalizeScore(show.total));
        feats.push(normalizeRank(show.rank));
        feats.push(rankDelta / 25);
        feats.push(normalizeGap(gapToLeader));
        feats.push(normalizeGap(gapToNext));
        feats.push(percentile);
        feats.push(normalizeGap(totalScoreDelta));
        const perfOrder = show.performanceOrder;
        const orderInClass = perfOrder?.inClass ?? -1;
        const countInClass = perfOrder?.inClassCount ?? fieldSize;
        const orderOverall = perfOrder?.overall ?? -1;
        const countOverall = perfOrder?.overallCount ?? fieldSize;
        feats.push(
          orderInClass,
          orderInClass >= 0 && countInClass > 0 ? orderInClass / countInClass : -1,
          orderOverall,
          orderOverall >= 0 && countOverall > 0 ? orderOverall / countOverall : -1
        );
        for (const caption of CAPTIONS) {
          const captionEntry = show.captions[caption];
          if (captionEntry?.score !== undefined) {
            const baseline = baselineForShow(
              show.slug,
              corpsKey,
              rankEntering,
              show.percentThrough,
              caption
            );
            const prevCaptionScore = prevShow?.captions[caption]?.score ?? captionEntry.score;
            feats.push(captionEntry.score - baseline);
            feats.push(captionEntry.rank ? captionEntry.rank / fieldSize : 0);
            feats.push(normalizeCaptionScore(captionEntry.score));
            feats.push(normalizeCaptionScore(captionEntry.score - (prevCaptionScore ?? captionEntry.score)));
          } else {
            feats.push(0, 0, 0, 0);
          }
        }
        const showDateMs = new Date(show.date).getTime();
        const showCorpsPresent = competition?.corps_present ?? [];
        const opponentSnapshots: Array<{ residualMean: number; rank: number }> = [];
        for (const opponentKey of showCorpsPresent) {
          if (opponentKey === corpsKey) continue;
          const history = opponentHistoryMap.get(opponentKey) ?? [];
          for (let idx = history.length - 1; idx >= 0; idx--) {
            const historyEntry = history[idx]!;
            if (new Date(historyEntry.date).getTime() < showDateMs) {
              opponentSnapshots.push({
                residualMean: historyEntry.residualMean,
                rank: historyEntry.rank ?? fieldSize,
              });
              break;
            }
          }
        }
        const opponentSummary = summarizeOpponents(opponentSnapshots, fieldSize);
        feats.push(
          opponentSummary.residualStats.mean,
          opponentSummary.residualStats.std,
          opponentSummary.rankMean,
          opponentSummary.rankBest,
          ...opponentSummary.topResiduals
        );
        const opponentLast3 = summarizeOpponentLast3(
          showCorpsPresent.filter((key) => key !== corpsKey),
          showDateMs
        );
        feats.push(
          normalizeScore(opponentLast3.total.mean),
          normalizeGap(opponentLast3.total.slope),
          normalizeGap(opponentLast3.total.volatility),
          ...opponentLast3.captions.mean.map(normalizeCaptionScore),
          ...opponentLast3.captions.slope.map(normalizeCaptionScore),
          ...opponentLast3.captions.volatility.map(normalizeCaptionScore)
        );
        const slugLower = show.slug.toLowerCase();
        feats.push(
          slugLower.includes('finals') ? 1 : 0,
          slugLower.includes('semi') ? 1 : 0,
          slugLower.includes('regional') ? 1 : 0,
          new Date(show.date).getMonth() < 6 ? 1 : 0
        );
        const showAgg = localShowAggregates.get(show.slug);
        if (showAgg) {
          feats.push(
            showAgg.std_total > 0 ? (show.total - showAgg.avg_total) / showAgg.std_total : 0
          );
          for (const caption of CAPTIONS) {
            const score = show.captions[caption]?.score;
            feats.push(score !== undefined ? score - showAgg.captions[caption] : 0);
          }
          feats.push(showAgg.std_total / 10);
        } else {
          feats.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
        }
        x_sequence.push(feats);
      }

      // ── Static vector ──
      const rankEntering = getOverallRank(targetShow.date, corpsKey, prevRank);
      const historical = historyFor(corpsKey, targetShow.slug);
      const yearsInWorldClass = historical?.years_in_world_class ?? 0;
      const meanRank = historical?.historical_mean_rank ?? 15;
      const stdRank = historical?.historical_std_rank ?? 0;
      const bestRank = historical?.historical_best_rank ?? 15;
      const bestRankRecency = historical?.best_rank_recency ?? 10;
      const madeFinalsRate = historical?.made_finals_rate ?? 0;
      const firstSeason = historical?.first_season ?? season;
      const isNew = firstSeason === season ? 1 : 0;
      const currentRank = rankEntering;

      const rankEma = (() => {
        const ranks = pastShows.map((show) => getOverallRank(show.date, corpsKey, prevRank));
        if (!ranks.length) return currentRank;
        return computeEma(ranks, EMA_ALPHA);
      })();

      const captionResidualSeries = Object.fromEntries(
        CAPTIONS.map((caption) => [caption, [] as number[]])
      ) as Record<Caption, number[]>;
      const meanResidualSeries: number[] = [];
      for (const show of pastShows) {
        const rankEnter = getOverallRank(show.date, corpsKey, prevRank);
        let residualSum = 0;
        for (const caption of CAPTIONS) {
          const score = show.captions[caption]?.score ?? 0;
          const baseline = baselineForShow(show.slug, corpsKey, rankEnter, show.percentThrough, caption);
          const residual = score - baseline;
          residualSum += residual;
          captionResidualSeries[caption].push(residual);
        }
        meanResidualSeries.push(residualSum / CAPTIONS.length);
      }
      const captionContentSeries = Object.fromEntries(
        CAPTIONS.map((caption) => [caption, [] as number[]])
      ) as Record<Caption, number[]>;
      const captionAchievementSeries = Object.fromEntries(
        CAPTIONS.map((caption) => [caption, [] as number[]])
      ) as Record<Caption, number[]>;
      let subcapShows = 0;
      for (const show of pastShows) {
        if (show.subcaptions && Object.keys(show.subcaptions).length) subcapShows++;
        for (const caption of CAPTIONS) {
          const sub = show.subcaptions?.[caption];
          captionContentSeries[caption].push(sub ? sub.content : 0);
          captionAchievementSeries[caption].push(sub ? sub.achievement : 0);
        }
      }
      const residualEmaMean = computeEma(meanResidualSeries, EMA_ALPHA);
      const residualSlope = computeSlope(meanResidualSeries);
      const residualVolatility =
        meanResidualSeries.length > 1
          ? Math.sqrt(
              meanResidualSeries.reduce((sum, value) => sum + (value - residualEmaMean) ** 2, 0) /
                meanResidualSeries.length
            )
          : 0;
      const lastResidualMean = meanResidualSeries.at(-1) ?? 0;
      const lastResidualByCaption = CAPTIONS.map(
        (caption) => captionResidualSeries[caption].at(-1) ?? 0
      );
      const emaResidualByCaption = CAPTIONS.map((caption) =>
        computeEma(captionResidualSeries[caption], EMA_ALPHA)
      );
      const subNorm = (value: number) => value / 10;
      const lastContentByCaption = CAPTIONS.map((caption) => {
        const series = captionContentSeries[caption];
        return series.length ? subNorm(series.at(-1)!) : 0;
      });
      const lastAchievementByCaption = CAPTIONS.map((caption) => {
        const series = captionAchievementSeries[caption];
        return series.length ? subNorm(series.at(-1)!) : 0;
      });
      const emaContentByCaption = CAPTIONS.map((caption) =>
        subNorm(computeEma(captionContentSeries[caption], EMA_ALPHA))
      );
      const emaAchievementByCaption = CAPTIONS.map((caption) =>
        subNorm(computeEma(captionAchievementSeries[caption], EMA_ALPHA))
      );

      const targetDateObj = new Date(targetShow.date);
      const premiereDate = new Date(pastShows[0]?.date ?? targetShow.date);
      const daysSinceSeasonStart = normalizeDays(
        daysBetween(firstScoredDateOfSeason ?? pastShows[0]?.date ?? targetShow.date, targetShow.date)
      );
      const lastHistoryDate = pastShows.at(-1)?.date;
      const daysSinceLastMatch = lastHistoryDate
        ? normalizeRecentGap(daysBetween(lastHistoryDate, targetShow.date))
        : 0.5;
      const showsRemainingApprox = Math.max(0, SEQ_LEN - (pastShows.length + 1)) / SEQ_LEN;
      const lastPriorSeasonShow = (() => {
        const temporalHistory = temporal.corpsHistory.get(rowKeyFor(targetShow.slug, corpsKey));
        if (temporalHistory)
          return {
            total: temporalHistory.last_season_final_score,
            rank: temporalHistory.previous_season_rank,
            date: temporalHistory.last_season_final_date,
          };
        const prev = prevSeasonRankMap.get(corpsKey);
        return prev ? { total: prev.total, rank: prev.rank, date: prev.date } : undefined;
      })();
      const daysSinceLastScoredAnySeasonNorm = lastHistoryDate
        ? normalizeOffseasonGap(daysBetween(lastHistoryDate, targetShow.date))
        : lastPriorSeasonShow
          ? normalizeOffseasonGap(daysBetween(lastPriorSeasonShow.date, targetShow.date))
          : 1;

      const competition = competitionMap.get(targetShow.slug);
      const fieldSize = competition?.field_size ?? 25;
      const topCorpsPresent =
        competition?.corps_present.filter((corps) => {
          const h = historyFor(corps, targetShow.slug);
          return h ? h.historical_best_rank <= 5 : false;
        }).length ?? 0;
      const divisionStrength = competition?.corps_present.length
        ? mean(
            competition.corps_present.map(
              (corps) => historyFor(corps, targetShow.slug)?.historical_mean_rank ?? 15
            )
          )
        : 15;
      const isMajorShow =
        targetShow.slug.toLowerCase().includes('finals') ||
        targetShow.slug.toLowerCase().includes('regional')
          ? 1
          : 0;
      // Inference-target caption ranges: no temporal row for the target, and the
      // clean-mode season-range fallback map is EMPTY in production → 0/20.
      const captionRangeFeatures = CAPTIONS.flatMap(() => [
        normalizeCaptionScore(0),
        normalizeCaptionScore(20),
      ]);
      // Inference-target rank baselines: artifact curve (no temporal row).
      const rankBaselineFeatures = CAPTIONS.map((caption) =>
        normalizeCaptionScore(
          artifactBaseline(referenceCurves, rankEntering, targetShow.percentThrough, caption, division)
        )
      );

      const targetDateMs = new Date(targetShow.date).getTime();
      const corpsPresent = competition?.corps_present ?? [];
      const opponentSnapshots: Array<{ residualMean: number; rank: number }> = [];
      for (const opponentKey of corpsPresent) {
        if (opponentKey === corpsKey) continue;
        const history = opponentHistoryMap.get(opponentKey) ?? [];
        for (let idx = history.length - 1; idx >= 0; idx--) {
          const historyEntry = history[idx]!;
          if (new Date(historyEntry.date).getTime() < targetDateMs) {
            opponentSnapshots.push({
              residualMean: historyEntry.residualMean,
              rank: historyEntry.rank ?? fieldSize,
            });
            break;
          }
        }
      }
      const opponentSummary = summarizeOpponents(opponentSnapshots, fieldSize);
      const opponentLast3Summary = summarizeOpponentLast3(
        corpsPresent.filter((key) => key !== corpsKey),
        targetDateMs
      );

      const targetOrder = undefined; // announced orders are rarely known pre-show; prod uses -1 sentinel
      const targetOrderInClass = -1;
      const targetOrderInClassNorm = -1;
      const targetOrderOverall = -1;
      const targetOrderOverallNorm = -1;
      void targetOrder;

      // Judge Elo block (101–112): NOT reproduced (masked at serving). Neutral fill.
      const perCaptionJudgeElo = new Array<number>(8).fill(0);
      const panelElo = [0, 0, 0, 0];
      // Corps Elo (113–120): inference target has no temporal caption row and the
      // clean-mode pre-show cache is EMPTY in production → neutral 1500 → 0.
      const perCaptionCorpsElo = new Array<number>(8).fill(0);

      const divisionLower = division.toLowerCase();
      const isWorldClass = divisionLower.includes('world') ? 1 : 0;
      const isOpenClass = divisionLower.includes('open') ? 1 : 0;
      const isAllAgeClass =
        divisionLower.includes('all-age') || divisionLower.includes('all age') ? 1 : 0;

      // Caption fingerprints from the packaged prior-season entries.
      const fingerprintFeatures = buildFingerprintFeatures(
        temporal.fingerprints.get(`${division}:${corpsKey}`) ?? [],
        season
      );

      const fieldPace = temporal.fieldSnapshot(season, division, targetShow.date);
      const fieldPaceFeatures = [
        fieldPace.level / 10,
        fieldPace.shrunkSlope / 10,
        fieldPace.ema / 10,
        fieldPace.confidence,
      ];

      const x_static: number[] = [
        normalizeRank(prevRank),
        yearsInWorldClass / 20,
        normalizeRank(meanRank),
        stdRank / 10,
        normalizeRank(bestRank),
        bestRankRecency / 20,
        madeFinalsRate,
        isNew,
        pastShows.length / SEQ_LEN,
        normalizeRank(rankEma),
        residualEmaMean,
        residualSlope,
        residualVolatility,
        (currentRank - meanRank) / 25,
        daysSinceSeasonStart,
        daysSinceLastMatch,
        showsRemainingApprox,
        fieldSize / 25,
        targetOrderInClass,
        targetOrderInClassNorm,
        targetOrderOverall,
        targetOrderOverallNorm,
        topCorpsPresent / FINALS_CUTOFF,
        normalizeRank(divisionStrength),
        isMajorShow,
        ...captionRangeFeatures,
        lastResidualMean,
        ...lastResidualByCaption,
        ...emaResidualByCaption,
        opponentSummary.residualStats.mean,
        opponentSummary.residualStats.median,
        opponentSummary.residualStats.std,
        opponentSummary.residualStats.min,
        opponentSummary.residualStats.max,
        opponentSummary.residualStats.p25,
        opponentSummary.residualStats.p75,
        opponentSummary.weightedResidualMean,
        opponentSummary.rankMean,
        opponentSummary.rankBest,
        ...opponentSummary.topResiduals,
        ...opponentSummary.topRanks,
        normalizeScore(opponentLast3Summary.total.mean),
        normalizeGap(opponentLast3Summary.total.slope),
        normalizeGap(opponentLast3Summary.total.volatility),
        ...opponentLast3Summary.captions.mean.map(normalizeCaptionScore),
        ...opponentLast3Summary.captions.slope.map(normalizeCaptionScore),
        ...opponentLast3Summary.captions.volatility.map(normalizeCaptionScore),
        ...perCaptionJudgeElo,
        ...panelElo,
        ...perCaptionCorpsElo,
        ...rankBaselineFeatures,
        isWorldClass,
        isOpenClass,
        isAllAgeClass,
        targetDateObj.getMonth() / 12,
        targetDateObj.getDate() / 31,
        premiereDate.getMonth() / 12,
        premiereDate.getDate() / 31,
        pastShows.length / 40.0,
        ...lastContentByCaption,
        ...lastAchievementByCaption,
        ...emaContentByCaption,
        ...emaAchievementByCaption,
        pastShows.length === 0 ? 1 : 0,
        Math.min(pastShows.length, 40) / 40,
        lastHistoryDate ? normalizeRecentGap(daysBetween(lastHistoryDate, targetShow.date)) : 1,
        daysSinceLastScoredAnySeasonNorm,
        lastPriorSeasonShow ? normalizeScore(lastPriorSeasonShow.total) : normalizeScore(70),
        lastPriorSeasonShow ? normalizeRank(lastPriorSeasonShow.rank) : normalizeRank(prevRank),
        firstScoredDateOfSeason === targetShow.date ? 1 : 0,
        firstScoredDateOfSeason
          ? Math.min(Math.floor(daysBetween(firstScoredDateOfSeason, targetShow.date) / 7), 12) / 12
          : 0,
        firstScoredDateOfSeason
          ? normalizeDays(daysBetween(firstScoredDateOfSeason, targetShow.date))
          : 0,
        targetShow.percentThrough / 100,
        ...fingerprintFeatures,
        ...fieldPaceFeatures,
      ];

      if (x_static.length !== STATIC_DIM)
        throw new Error(`static dim mismatch: ${x_static.length} !== ${STATIC_DIM}`);

      rows.push({
        corpsKey,
        corpsName: entry.corpsName,
        division: division as DivisionName,
        sequence: x_sequence,
        staticFeatures: x_static,
      });
      diagnostics.push({
        corpsKey,
        priorShows: pastShows.length,
        seasonDebut: pastShows.length === 0,
        knownPriorSeasons: !!historical,
        subcaptionCoverage: pastShows.length ? subcapShows / pastShows.length : 0,
        performanceOrderKnown: false,
        judgesKnown: !!data.target.judges,
        fieldPace: {
          observations: fieldPace.priorObservationCount,
          corps: fieldPace.priorCorpsCount,
          dates: fieldPace.priorShowDateCount,
          confidence: fieldPace.confidence,
        },
        defaultedBlocks: [
          ...(pastShows.length === 0 ? ['sequence', 'trajectory'] : []),
          ...(historical ? [] : ['corps_history']),
          ...(subcapShows === 0 ? ['subcaption_history'] : []),
          'caption_ranges',
          'corps_elo',
          'judge_elo(masked)',
        ],
      });
    }
  }
  return { rows, diagnostics };
};

// Caption fingerprint block (33) — port of buildCaptionFingerprintFeatures.
const buildFingerprintFeatures = (
  entries: Array<{ season: number; date: string; percentThrough: number; residuals: Record<Caption, number> }>,
  targetSeason: number
): number[] => {
  const prior = entries
    .filter((entry) => entry.season < targetSeason)
    .sort((a, b) => a.season - b.season || a.date.localeCompare(b.date));
  const priorSeason = prior.filter((entry) => entry.season === targetSeason - 1);
  const priorOrLatestSeason = priorSeason.length
    ? priorSeason
    : prior.filter(
        (entry) => entry.season === Math.max(...prior.map((candidate) => candidate.season), -Infinity)
      );
  const lastThreeFloor = targetSeason - 3;
  const multiYear = prior.filter((entry) => entry.season >= lastThreeFloor);
  const pool = multiYear.length ? multiYear : prior;

  const avg = (list: typeof prior, caption: Caption) =>
    mean(list.map((entry) => entry.residuals[caption] ?? 0));
  const features: number[] = [];
  const growth = (caption: Caption) => {
    if (pool.length < 2) return 0;
    const bySeason = new Map<number, { early: number[]; late: number[] }>();
    for (const entry of pool) {
      const bucket = bySeason.get(entry.season) ?? { early: [], late: [] };
      if (entry.percentThrough <= 35) bucket.early.push(entry.residuals[caption] ?? 0);
      if (entry.percentThrough >= 75) bucket.late.push(entry.residuals[caption] ?? 0);
      bySeason.set(entry.season, bucket);
    }
    const growthValues = [...bySeason.values()]
      .filter((bucket) => bucket.early.length > 0 && bucket.late.length > 0)
      .map((bucket) => mean(bucket.late) - mean(bucket.early));
    return mean(growthValues);
  };
  const weighted = (caption: Caption) => {
    if (!pool.length) return 0;
    const maxSeason = Math.max(...pool.map((entry) => entry.season));
    let weightedSum = 0,
      weightSum = 0;
    for (const entry of pool) {
      const weight = Math.pow(0.65, Math.max(0, maxSeason - entry.season));
      weightedSum += (entry.residuals[caption] ?? 0) * weight;
      weightSum += weight;
    }
    return weightSum > 0 ? weightedSum / weightSum : 0;
  };
  for (const caption of CAPTIONS) {
    features.push(
      avg(priorOrLatestSeason, caption) / 2,
      weighted(caption) / 2,
      growth(caption) / 2,
      Math.min(stdSample(pool.map((entry) => entry.residuals[caption] ?? 0)) / 2, 2)
    );
  }
  features.push(Math.min(1, prior.length / 24));
  return features;
};
