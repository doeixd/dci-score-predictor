// Parity gate: the SDK inference path must reproduce production v10.5 output
// exactly (same feature rows + same recal offsets → same totals/captions to the
// 3-decimal rounding prod stores).
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadEnsemble, loadBiasCalibration } from '../src/model/loader.js';
import { servePrediction } from '../src/model/serve.js';
import { CAPTIONS } from '../src/model/contract.js';
import type { EnsembleMember } from '../src/model/inference.js';

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8'));

describe('inference parity vs production v10.5 (2026-dci-kentucky)', () => {
  let members: EnsembleMember[];
  const rows: Array<{
    corps_key: string;
    division_name: string;
    x_sequence_json: string;
    x_static_json: string;
  }> = fixture('kentucky-feature-rows.json');
  const offsets: Record<string, number> = fixture('kentucky-offsets.json');
  const prodRun = fixture('kentucky-prod-run.json');
  const biasCalibration = loadBiasCalibration();

  beforeAll(async () => {
    members = await loadEnsemble();
  }, 120_000);

  it('loads all 8 seeds', () => {
    expect(members).toHaveLength(8);
  });

  it('reproduces every corps prediction to prod rounding', () => {
    const prodByKey = new Map<string, any>(
      prodRun.predictions.map((p: any) => [String(p.corps_key), p])
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const served = servePrediction(
        members,
        {
          sequence: JSON.parse(row.x_sequence_json),
          staticFeatures: JSON.parse(row.x_static_json),
        },
        { division: row.division_name, biasCalibration, recalOffsets: offsets }
      );
      expect(served, row.corps_key).not.toBeNull();
      const prod = prodByKey.get(row.corps_key);
      expect(prod, `prod prediction missing for ${row.corps_key}`).toBeDefined();
      expect(served!.total).toBeCloseTo(prod.total, 3);
      expect(served!.GE).toBeCloseTo(prod.GE, 3);
      expect(served!.Visual).toBeCloseTo(prod.Visual, 3);
      expect(served!.Music).toBeCloseTo(prod.Music, 3);
      for (const cap of CAPTIONS) expect(served!.captions[cap]).toBeCloseTo(prod[cap], 3);
      for (const cap of CAPTIONS) {
        expect(served!.intervals[cap].low_offset).toBeCloseTo(prod.intervals[cap].low_offset, 3);
        expect(served!.intervals[cap].high_offset).toBeCloseTo(prod.intervals[cap].high_offset, 3);
      }
    }
  }, 300_000);
});
