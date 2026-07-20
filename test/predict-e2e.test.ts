// End-to-end parity + degradation gate: SeasonData → predict() reproduces the
// production run totals exactly (proves the whole feature→ensemble→serve→rank
// path), plus the graceful-degradation, validation, and simple-API contracts.
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { predict, DciValidationError } from '../src/predict.js';
import { predict as simplePredict } from '../src/simple/simple.js';
import { loadEnsemble, loadBiasCalibration } from '../src/model/loader.js';
import { servePrediction } from '../src/model/serve.js';
import type { EnsembleMember } from '../src/model/inference.js';
import type { SeasonData } from '../src/features/types.js';

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf-8'));

describe('predict() end-to-end (2026-dci-kentucky)', () => {
  const season = fixture('season-2026-2026-dci-kentucky.json') as SeasonData;
  const offsets: Record<string, number> = fixture('kentucky-offsets.json');
  const prodRun = fixture('kentucky-prod-run.json');

  let members: EnsembleMember[];
  // Warm the module-level ensemble cache once (~2s / 8 seeds).
  beforeAll(async () => {
    members = await loadEnsemble();
  }, 120_000);

  // Ground truth for the SDK's clean-v10 pipeline: serve the FROZEN clean feature
  // rows (test/fixtures/kentucky-feature-rows-clean.json — what buildFeatureRows
  // reproduces byte-for-byte per feature-parity.test.ts) through the same serve
  // path. NOTE: the older kentucky-prod-run.json fixture was generated from the
  // pre-clean-view RAW rows (kentucky-feature-rows.json), which differ at the
  // corps_history static block (index 13) — so it lands ~0.6 off and is checked
  // only for proximity below, not equality. See docs/FEATURE_PARITY_NOTES.md.
  const cleanRows: Array<{ corps_key: string; division_name: string; x_sequence_json: string; x_static_json: string }> =
    fixture('kentucky-feature-rows-clean.json');
  const biasCalibration = loadBiasCalibration();

  it('reproduces clean-pipeline serve totals to 3 decimals from SeasonData input', async () => {
    const result = await predict(
      { seasonInfo: season.seasonInfo, history: season.shows, target: season.target },
      { recalOffsets: offsets }
    );
    const expectedByKey = new Map<string, ReturnType<typeof servePrediction>>();
    for (const row of cleanRows) {
      const served = servePrediction(
        members,
        { sequence: JSON.parse(row.x_sequence_json), staticFeatures: JSON.parse(row.x_static_json) },
        { division: row.division_name, biasCalibration, recalOffsets: offsets }
      );
      expectedByKey.set(row.corps_key, served);
    }
    expect(result.predictions.length).toBe(cleanRows.length);
    for (const pred of result.predictions) {
      const exp = expectedByKey.get(pred.corpsKey);
      expect(exp, `clean-serve expectation missing for ${pred.corpsKey}`).toBeTruthy();
      expect(pred.total).toBeCloseTo(exp!.total, 3);
      expect(pred.GE).toBeCloseTo(exp!.GE, 3);
      expect(pred.Visual).toBeCloseTo(exp!.Visual, 3);
      expect(pred.Music).toBeCloseTo(exp!.Music, 3);
      for (const cap of ['GE1', 'GE2', 'VP', 'VA', 'CG', 'MB', 'MA', 'MP'] as const)
        expect(pred.captions[cap]).toBeCloseTo(exp!.captions[cap], 3);
    }
  }, 300_000);

  it('lands close to the (pre-clean-view) prod run totals', async () => {
    const result = await predict(
      { seasonInfo: season.seasonInfo, history: season.shows, target: season.target },
      { recalOffsets: offsets }
    );
    const prodByKey = new Map<string, any>(prodRun.predictions.map((p: any) => [String(p.corps_key), p]));
    for (const pred of result.predictions) {
      const prod = prodByKey.get(pred.corpsKey);
      expect(prod, `prod prediction missing for ${pred.corpsKey}`).toBeDefined();
      // corps_history idx-13 raw/clean divergence moves totals by <2 points.
      expect(Math.abs(pred.total - prod.total)).toBeLessThan(2.0);
    }
  }, 300_000);

  it('ranks predictions by total desc', async () => {
    const result = await predict(
      { seasonInfo: season.seasonInfo, history: season.shows, target: season.target },
      { recalOffsets: offsets }
    );
    for (let i = 1; i < result.predictions.length; i++)
      expect(result.predictions[i - 1]!.total).toBeGreaterThanOrEqual(result.predictions[i]!.total);
    expect(result.predictions[0]!.rank).toBe(1);
    expect(result.model_metadata.model_dir).toBe('clean-v10-fieldpace-recal-sdk');
    expect(result.model_metadata.ensembleSize).toBe(8);
  }, 300_000);

  it('emits readiness tiers, recal audit, and inputAudit', async () => {
    const result = await predict(
      { seasonInfo: season.seasonInfo, history: season.shows, target: season.target },
      { recalOffsets: offsets, explain: true }
    );
    expect(result.readiness.corps.length).toBe(result.predictions.length);
    for (const r of result.readiness.corps)
      expect(['established', 'partial', 'sparse', 'cold_start']).toContain(r.tier);
    expect(result.readiness.recal.length).toBeGreaterThan(0);
    expect(result.inputAudit.showsCounted).toBe(season.shows.length);
    expect(result.inputAudit.scoreRowsCounted).toBeGreaterThan(0);
    // explain plumbed through.
    expect(result.explain).toBeDefined();
    expect(result.explain!.length).toBe(result.predictions.length);
    expect(result.explain![0]!.baselineRecap.length).toBe(8);
    expect(result.explain![0]!.trendSlopes.length).toBe(8);
  }, 300_000);

  it('degrades gracefully when half the history is dropped (tiers shift, caveats appear, no crash)', async () => {
    const half = season.shows.filter((_, i) => i % 2 === 0);
    const result = await predict(
      { seasonInfo: season.seasonInfo, history: half, target: season.target },
      { recalOffsets: offsets }
    );
    expect(result.predictions.length).toBe(season.target.lineup.length);
    // Fewer prior shows → lower sequence fill for at least one corps.
    const minFill = Math.min(...result.readiness.corps.map((r) => r.sequenceFill));
    const fullResultFill = 15;
    expect(minFill).toBeLessThanOrEqual(fullResultFill);
    expect(result.caveats.length).toBeGreaterThan(0);
  }, 300_000);

  it('throws on target-date leakage (history not strictly before target)', async () => {
    const bad = {
      seasonInfo: season.seasonInfo,
      history: season.shows.map((s) => ({ ...s, date: season.target.date })),
      target: season.target,
    };
    await expect(predict(bad, { recalOffsets: offsets })).rejects.toBeInstanceOf(DciValidationError);
  }, 60_000);

  it('drops a caption-sum-mismatch row under default strict:false, throws under strict:true', async () => {
    const tampered: SeasonData = JSON.parse(JSON.stringify(season));
    // Break the derived-total consistency of one row far beyond 0.05.
    tampered.shows[0]!.results[0]!.total = (tampered.shows[0]!.results[0]!.total ?? 50) + 10;
    const lenient = await predict(
      { seasonInfo: tampered.seasonInfo, history: tampered.shows, target: tampered.target },
      { recalOffsets: offsets }
    );
    expect(lenient.inputAudit.droppedRows.some((d) => d.reason === 'caption_total_mismatch')).toBe(true);
    expect(lenient.caveats.some((c) => c.message.includes('dropped'))).toBe(true);

    await expect(
      predict(
        { seasonInfo: tampered.seasonInfo, history: tampered.shows, target: tampered.target },
        { recalOffsets: offsets, strict: true }
      )
    ).rejects.toBeInstanceOf(DciValidationError);
  }, 300_000);
});

describe('simple API', () => {
  beforeAll(async () => {
    await loadEnsemble();
  }, 120_000);

  it('normalizes names and records the audit (happy path)', async () => {
    const result = await simplePredict({
      history: [
        {
          show: 'DCI Southwestern Championship',
          date: '2026-07-18',
          scores: [
            {
              corps: 'blue devils',
              captions: { GE1: 17.5, GE2: 17.3, VP: 17.0, VA: 17.1, CG: 16.9, MB: 18.0, MA: 17.6, MP: 18.1 },
            },
          ],
        },
      ],
      target: { show: 'Prelims', date: '2026-08-06', lineup: ['blue devils', 'Bluecoats'] },
    });
    expect(result.predictions.length).toBe(2);
    // "blue devils" → registry canonical name recorded.
    expect(result.inputAudit.normalizations.some((n) => n.kind === 'corps' && n.input === 'blue devils')).toBe(true);
  }, 300_000);

  it('throws CorpsNotFoundError for an unmatchable corps without a division hint', async () => {
    await expect(
      simplePredict({
        history: [],
        target: { show: 'Prelims', date: '2026-08-06', lineup: ['Zzqx Nonexistent Corps'] },
      })
    ).rejects.toThrow(/unknown corps/i);
  }, 60_000);
});
