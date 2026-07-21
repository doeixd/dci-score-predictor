// The replayable temporal state machine — a faithful port of
// prepareV10TemporalFeatures.ts. Rows are processed date-by-date in two phases
// (read features first, update state after the whole date resolves) so every
// derived feature is strictly date-before-target and same-day shows can't leak
// into each other.
//
// The same machine serves two purposes:
//  - asset generation (tools/gen-feature-context.ts): replay ALL prior seasons
//    from the private DB and freeze the state into the packaged FeatureContext;
//  - runtime: seed a machine from the packaged context and replay ONLY the
//    caller's current-season shows.
import { CAPTIONS, type Caption } from '../model/contract.js';
import { bucketPercent, fieldSlope, mean, stdSample } from './helpers.js';
import type { CurveCell, FeatureContext, FingerprintEntry, PriorFinal } from './types.js';

export interface TemporalPerformance {
  season: number;
  slug: string;
  date: string; // YYYY-MM-DD
  division: string;
  corpsKey: string;
  computedRank: number;
  rankBucket: number;
  percentThrough: number;
  percentBucket: number;
  total: number;
  captions: Record<Caption, number>;
  /** caption → judge ids officiating this show (per-season Elo updates). */
  judges?: Partial<Record<Caption, string[]>>;
}

interface FieldObservation {
  season: number;
  division: string;
  date: string;
  corps: string;
  rank: number;
  percentThrough: number;
  residual: number;
}

interface EloState {
  elo: number;
  count: number;
}

export interface CaptionTemporal {
  reference_baseline: number;
  prior_range_min: number;
  prior_range_max: number;
  corps_elo_before: number;
}

export interface CorpsHistoryTemporal {
  years_in_world_class: number;
  historical_mean_rank: number;
  historical_std_rank: number;
  historical_best_rank: number;
  best_rank_recency: number;
  made_finals_rate: number;
  first_season: number;
  previous_season_rank: number;
  last_season_final_score: number;
  last_season_final_date: string;
}

export interface FieldPaceSnapshot {
  level: number;
  shrunkSlope: number;
  ema: number;
  confidence: number;
  priorObservationCount: number;
  priorCorpsCount: number;
  priorShowDateCount: number;
}

export class TemporalState {
  private curve = new Map<string, CurveCell>();
  private ranges = new Map<string, { min: number; max: number }>();
  /** `${corps}|${division}|${season}` → latest row of that season (finals proxy). */
  private latestBySeason = new Map<string, PriorFinal & { corpsKey: string; division: string }>();
  private corpsElo = new Map<string, EloState>();
  private judgeElo = new Map<string, EloState>();
  private fieldObservations: FieldObservation[] = [];
  /** Per-division per-season slopes from PRIOR seasons (frozen asset). */
  private historicalSlopes = new Map<string, number[]>();
  /** Latest prior-season observation date per division (maxSourceDate seed). */
  fingerprints = new Map<string, FingerprintEntry[]>();

  /** Per-row caption temporal features captured during replay: `${rowKey}|${caption}`. */
  captionTemporal = new Map<string, CaptionTemporal>();
  /** Per-row corps history captured during replay: rowKey. */
  corpsHistory = new Map<string, CorpsHistoryTemporal>();

  static seeded(context: FeatureContext): TemporalState {
    const state = new TemporalState();
    for (const [key, cell] of Object.entries(context.curve)) state.curve.set(key, { ...cell });
    for (const [key, range] of Object.entries(context.ranges)) state.ranges.set(key, { ...range });
    for (const [key, finals] of Object.entries(context.priorFinals)) {
      const [division, corpsKey] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      for (const final of finals)
        state.latestBySeason.set(`${corpsKey}|${division}|${final.season}`, {
          ...final,
          corpsKey,
          division,
        });
    }
    for (const [division, slopes] of Object.entries(context.fieldPaceHistoricalSlopes))
      state.historicalSlopes.set(division, [...slopes]);
    for (const [key, entries] of Object.entries(context.fingerprints))
      state.fingerprints.set(key, entries.map((entry) => ({ ...entry })));
    return state;
  }

  static rowKey = (season: number, slug: string, division: string, corpsKey: string) =>
    `${season}|${slug}|${division}|${corpsKey}`;

  curveBaseline(rank: number, bucket: number, caption: Caption, division: string): number {
    const exact = this.curve.get(`${division}|${rank}|${bucket}|${caption}`);
    if (exact) return exact.sum / exact.count;
    const candidates: Array<{ distance: number; value: number }> = [];
    for (const [key, cell] of this.curve) {
      const [candidateDivision, candidateRank, candidateBucket, candidateCaption] = key.split('|');
      if (candidateCaption !== caption) continue;
      const divisionPenalty = candidateDivision === division ? 0 : 100_000;
      candidates.push({
        distance:
          divisionPenalty +
          Math.abs(Number(candidateRank) - rank) * 25 +
          Math.abs(Number(candidateBucket) - bucket),
        value: cell.sum / cell.count,
      });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.value - b.value);
    return candidates[0]?.value ?? 15;
  }

  private referenceTotal(row: TemporalPerformance): number {
    const b = Object.fromEntries(
      CAPTIONS.map((caption) => [
        caption,
        this.curveBaseline(row.rankBucket, row.percentBucket, caption, row.division),
      ])
    ) as Record<Caption, number>;
    return b.GE1 + b.GE2 + (b.VP + b.VA + b.CG + b.MB + b.MA + b.MP) / 2;
  }

  fieldSnapshot(season: number, division: string, beforeDate?: string): FieldPaceSnapshot {
    const priorDate = (observation: FieldObservation) => !beforeDate || observation.date < beforeDate;
    const current = this.fieldObservations.filter(
      (observation) =>
        observation.season === season &&
        observation.division === division &&
        observation.rank <= 25 &&
        priorDate(observation)
    );
    const latestByCorps = new Map<string, FieldObservation>();
    for (const observation of current) latestByCorps.set(observation.corps, observation);
    const latest = [...latestByCorps.values()];
    const dates = new Set(current.map((observation) => observation.date));
    const level = mean(latest.map((observation) => observation.residual));
    const rawSlope = fieldSlope(current);
    // Historical per-season slopes: frozen asset slopes (strictly earlier seasons)
    // plus any earlier same-run seasons (asset generation replays multiple seasons).
    const replayedBySeason = new Map<number, FieldObservation[]>();
    for (const observation of this.fieldObservations) {
      if (observation.division !== division || observation.season >= season || !priorDate(observation))
        continue;
      const group = replayedBySeason.get(observation.season) ?? [];
      group.push(observation);
      replayedBySeason.set(observation.season, group);
    }
    const replayedSlopes = [...replayedBySeason.values()]
      .filter((group) => group.length >= 4 && new Set(group.map((o) => o.date)).size >= 2)
      .map(fieldSlope);
    const historicalSlope = mean([...(this.historicalSlopes.get(division) ?? []), ...replayedSlopes]);
    const confidence = Math.min(1, latest.length / 12) * Math.min(1, dates.size / 6);
    const shrunkSlope = confidence * rawSlope + (1 - confidence) * historicalSlope;
    let ema = 0;
    for (const [index, observation] of current.entries())
      ema = index === 0 ? observation.residual : 0.2 * observation.residual + 0.8 * ema;
    return {
      level,
      shrunkSlope,
      ema: current.length ? ema : 0,
      confidence,
      priorObservationCount: current.length,
      priorCorpsCount: latest.length,
      priorShowDateCount: dates.size,
    };
  }

  private eloKey = (season: number, division: string, identity: string, caption: Caption) =>
    `${season}|${division}|${identity}|${caption}`;

  private getElo(map: Map<string, EloState>, key: string): EloState {
    return map.get(key) ?? { elo: 1500, count: 0 };
  }

  /**
   * Per-season judge Elo for one (season, division, judge_id, caption), as
   * accumulated by the caller's history replay. Neutral 1500 when the judge has
   * no record. Powers the opt-in identity judge-Elo static block (101–112);
   * unused on the default agnostic serving path.
   */
  judgeEloValue(season: number, division: string, judgeId: string, caption: Caption): number {
    return this.getElo(this.judgeElo, this.eloKey(season, division, judgeId, caption)).elo;
  }

  /**
   * Replay all rows of one date: capture per-row features from prior state
   * (phase 1), then fold the date into the state (phase 2).
   */
  processDate(date: string, dateRows: TemporalPerformance[]): void {
    const dateReferenceTotals = new Map<string, number>();
    // Phase 1 — read-only feature capture.
    for (const row of dateRows) {
      const rowKey = TemporalState.rowKey(row.season, row.slug, row.division, row.corpsKey);
      dateReferenceTotals.set(rowKey, this.referenceTotal(row));

      const pastFinals = [...this.latestBySeason.values()].filter(
        (past) =>
          past.corpsKey === row.corpsKey &&
          past.division === row.division &&
          past.season < row.season
      );
      const ranks = pastFinals.map((past) => past.rank);
      const previousSeason = row.season === 2022 ? 2019 : row.season - 1;
      const previousFinal = pastFinals.find((past) => past.season === previousSeason);
      const bestRank = ranks.length ? Math.min(...ranks) : 15;
      const bestSeason = pastFinals
        .filter((past) => past.rank === bestRank)
        .reduce((latestSeason, past) => Math.max(latestSeason, past.season), 0);
      this.corpsHistory.set(rowKey, {
        years_in_world_class: ranks.length,
        historical_mean_rank: mean(ranks) || 15,
        historical_std_rank: stdSample(ranks),
        historical_best_rank: bestRank,
        best_rank_recency: bestSeason ? row.season - bestSeason : 20,
        made_finals_rate: ranks.length ? ranks.filter((rank) => rank <= 12).length / ranks.length : 0,
        first_season: pastFinals.length
          ? Math.min(...pastFinals.map((past) => past.season))
          : row.season,
        previous_season_rank: previousFinal?.rank ?? 15,
        last_season_final_score: previousFinal?.total ?? 70,
        last_season_final_date: previousFinal?.date ?? `${previousSeason}-08-15`,
      });

      for (const caption of CAPTIONS) {
        const baseline = this.curveBaseline(row.rankBucket, row.percentBucket, caption, row.division);
        const range = this.ranges.get(`${row.division}|${row.percentBucket}|${caption}`) ?? {
          min: 0,
          max: 20,
        };
        const corpsBefore = this.getElo(
          this.corpsElo,
          this.eloKey(row.season, row.division, row.corpsKey, caption)
        ).elo;
        this.captionTemporal.set(`${rowKey}|${caption}`, {
          reference_baseline: baseline,
          prior_range_min: range.min,
          prior_range_max: range.max,
          corps_elo_before: corpsBefore,
        });
      }
    }

    // Phase 2 — state update after the whole date is materialized.
    for (const row of dateRows) {
      this.latestBySeason.set(`${row.corpsKey}|${row.division}|${row.season}`, {
        season: row.season,
        rank: row.computedRank,
        total: row.total,
        date: row.date,
        corpsKey: row.corpsKey,
        division: row.division,
      });
      for (const caption of CAPTIONS) {
        const score = row.captions[caption];
        const key = `${row.division}|${row.rankBucket}|${row.percentBucket}|${caption}`;
        const cell = this.curve.get(key) ?? { sum: 0, count: 0 };
        cell.sum += score;
        cell.count++;
        this.curve.set(key, cell);

        const rangeKey = `${row.division}|${row.percentBucket}|${caption}`;
        const range = this.ranges.get(rangeKey);
        this.ranges.set(
          rangeKey,
          range
            ? { min: Math.min(range.min, score), max: Math.max(range.max, score) }
            : { min: score, max: score }
        );

        for (const judgeId of row.judges?.[caption] ?? []) {
          const cKey = this.eloKey(row.season, row.division, row.corpsKey, caption);
          const jKey = this.eloKey(row.season, row.division, judgeId, caption);
          const corps = this.getElo(this.corpsElo, cKey);
          const judge = this.getElo(this.judgeElo, jKey);
          const expected = 1 / (1 + Math.exp(-(corps.elo - judge.elo) / 400));
          const delta = score / 20 - expected;
          corps.elo += (corps.count < 20 ? 32 : 16) * delta;
          judge.elo += (judge.count < 20 ? 32 : 16) * delta;
          corps.count++;
          judge.count++;
          this.corpsElo.set(cKey, corps);
          this.judgeElo.set(jKey, judge);
        }
      }
      const rowKey = TemporalState.rowKey(row.season, row.slug, row.division, row.corpsKey);
      this.fieldObservations.push({
        season: row.season,
        division: row.division,
        date,
        corps: row.corpsKey,
        rank: row.computedRank,
        percentThrough: row.percentThrough,
        residual: row.total - (dateReferenceTotals.get(rowKey) ?? row.total),
      });

      // Fingerprint entry (buildMlSequences builds these from the same rows using
      // the as-of temporal baseline captured in phase 1).
      const residuals = Object.fromEntries(
        CAPTIONS.map((caption) => [
          caption,
          row.captions[caption] -
            (this.captionTemporal.get(`${rowKey}|${caption}`)?.reference_baseline ?? 0),
        ])
      ) as Record<Caption, number>;
      const fingerprintKey = `${row.division}:${row.corpsKey}`;
      const list = this.fingerprints.get(fingerprintKey) ?? [];
      list.push({
        season: row.season,
        date: row.date,
        percentThrough: row.percentThrough,
        residuals,
      });
      this.fingerprints.set(fingerprintKey, list);
    }
  }

  /** Replay a full chronologically-sortable row set. */
  replay(rows: TemporalPerformance[]): void {
    const byDate = new Map<string, TemporalPerformance[]>();
    for (const row of rows) {
      const group = byDate.get(row.date) ?? [];
      group.push(row);
      byDate.set(row.date, group);
    }
    for (const date of [...byDate.keys()].sort()) this.processDate(date, byDate.get(date)!);
  }

  /** Freeze the state into a packaged FeatureContext (asset generation). */
  freeze(contextSeason: number): FeatureContext {
    const priorFinals: Record<string, PriorFinal[]> = {};
    for (const final of this.latestBySeason.values()) {
      const key = `${final.division}:${final.corpsKey}`;
      (priorFinals[key] ??= []).push({
        season: final.season,
        rank: final.rank,
        total: final.total,
        date: final.date,
      });
    }
    for (const finals of Object.values(priorFinals)) finals.sort((a, b) => a.season - b.season);

    // Historical field-pace slopes per division: per-season slopes with the
    // temporal builder's ≥4 observations / ≥2 dates filter.
    const fieldPaceHistoricalSlopes: Record<string, number[]> = {};
    const byDivisionSeason = new Map<string, FieldObservation[]>();
    for (const observation of this.fieldObservations) {
      const key = `${observation.division}|${observation.season}`;
      const group = byDivisionSeason.get(key) ?? [];
      group.push(observation);
      byDivisionSeason.set(key, group);
    }
    const seasonOrder = [...byDivisionSeason.keys()].sort((a, b) => {
      const seasonA = Number(a.split('|')[1]);
      const seasonB = Number(b.split('|')[1]);
      return seasonA - seasonB;
    });
    for (const key of seasonOrder) {
      const division = key.split('|')[0]!;
      const group = byDivisionSeason.get(key)!;
      if (group.length >= 4 && new Set(group.map((o) => o.date)).size >= 2)
        (fieldPaceHistoricalSlopes[division] ??= []).push(fieldSlope(group));
    }

    return {
      curve: Object.fromEntries([...this.curve].map(([key, cell]) => [key, { ...cell }])),
      ranges: Object.fromEntries([...this.ranges].map(([key, range]) => [key, { ...range }])),
      priorFinals,
      fingerprints: Object.fromEntries(
        [...this.fingerprints].map(([key, entries]) => [key, entries])
      ),
      fieldPaceHistoricalSlopes,
      corpsHistorical: {},
      prevSeasonBestTotals: {},
      contextSeason,
    };
  }
}
