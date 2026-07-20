// Feature-builder parity gate: SeasonData (what a consumer supplies) + packaged
// FeatureContext must reproduce production's inference feature rows exactly.
// Static indices 101–112 (judge Elo) are excluded — production masks them to
// zero before the model ever sees them (see src/features/build.ts header).
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildFeatureRows } from '../src/features/build.js';
import { JUDGE_ELO_START, JUDGE_ELO_END } from '../src/model/contract.js';

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8'));
const asset = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'assets', name), 'utf-8'));

const STATIC_BLOCKS: Array<[string, number, number]> = [
  ['corps_history', 0, 24],
  ['caption_ranges', 25, 40],
  ['recent_residuals', 41, 57],
  ['target_opponents', 58, 100],
  ['judge_elo(masked)', 101, 112],
  ['corps_elo', 113, 120],
  ['rank_baselines', 121, 128],
  ['division', 129, 131],
  ['dates', 132, 136],
  ['subcaptions', 137, 168],
  ['cold_start', 169, 178],
  ['fingerprint', 179, 211],
  ['field_pace', 212, 215],
];
const blockFor = (index: number) =>
  STATIC_BLOCKS.find(([, start, end]) => index >= start && index <= end)?.[0] ?? '?';

describe('feature builder parity vs production rows (2026-dci-kentucky)', () => {
  const season = fixture('season-2026-2026-dci-kentucky.json');
  const prodRows: Array<{
    corps_key: string;
    division_name: string;
    x_sequence_json: string;
    x_static_json: string;
  }> = fixture('kentucky-feature-rows-clean.json');
  const context = asset('registries/featureContext.json');
  const curves = asset('curves/referenceCurvesV4.json');

  const { rows } = buildFeatureRows(season, context, curves);
  const builtByKey = new Map(rows.map((row) => [row.corpsKey, row]));

  it('builds a row for every prod corps', () => {
    for (const prod of prodRows) expect(builtByKey.has(prod.corps_key), prod.corps_key).toBe(true);
  });

  for (const prod of fixture('kentucky-feature-rows-clean.json') as typeof prodRows) {
    it(`matches static for ${prod.corps_key}`, () => {
      const built = builtByKey.get(prod.corps_key)!;
      const expected: number[] = JSON.parse(prod.x_static_json);
      const mismatches: string[] = [];
      for (let i = 0; i < expected.length; i++) {
        if (i >= JUDGE_ELO_START && i <= JUDGE_ELO_END) continue;
        // rank_baselines (121–128): inference-target cold cells drawn from the raw
        // referenceCurvesV4 artifact carry a ±0.001-raw (5e-5 normalized) curve-
        // version skew vs the frozen fixture. Documented in docs/FEATURE_PARITY_NOTES.md
        // (§2) — cell selection is proven correct (same-cell captions match exactly).
        const tol = blockFor(i) === 'rank_baselines' ? 2e-4 : 1e-6;
        if (Math.abs((built.staticFeatures[i] ?? NaN) - expected[i]!) > tol)
          mismatches.push(
            `[${i} ${blockFor(i)}] built=${built.staticFeatures[i]?.toFixed(6)} prod=${expected[i]!.toFixed(6)}`
          );
      }
      expect(mismatches, mismatches.slice(0, 12).join('\n')).toHaveLength(0);
    });

    it(`matches sequence for ${prod.corps_key}`, () => {
      const built = builtByKey.get(prod.corps_key)!;
      const expected: number[][] = JSON.parse(prod.x_sequence_json);
      const mismatches: string[] = [];
      for (let s = 0; s < expected.length; s++)
        for (let f = 0; f < expected[s]!.length; f++) {
          if (Math.abs((built.sequence[s]?.[f] ?? NaN) - expected[s]![f]!) > 1e-6)
            mismatches.push(
              `[step ${s} dim ${f}] built=${built.sequence[s]?.[f]?.toFixed(6)} prod=${expected[s]![f]!.toFixed(6)}`
            );
        }
      expect(mismatches, mismatches.slice(0, 12).join('\n')).toHaveLength(0);
    });
  }
});
