// Cross-field score-sheet ⇄ judge-panel validation (PLAN §3.2). Uses validateInput
// (no model load) since panel checks run in the validation stage. Panel caveats are
// the only entries in `warnings`, so asserting on them directly is unambiguous.
import { describe, it, expect } from 'vitest';
import { validateInput, type PredictInput } from '../src/predict.js';
import { CAPTIONS, type Caption } from '../src/model/contract.js';

const seasonInfo = { year: 2026, startDate: '2026-06-25', endDate: '2026-08-08' };
const allEight = Object.fromEntries(CAPTIONS.map((c) => [c, 15])) as Record<Caption, number>;
const fullPanel: Partial<Record<Caption, string[]>> = {
  GE1: ['j1'], GE2: ['j1'], VP: ['j2'], VA: ['j2'], CG: ['j2'], MB: ['j3'], MA: ['j3'], MP: ['j3'],
};

const input = (judges?: Partial<Record<Caption, string[]>>, targetJudges?: Partial<Record<Caption, string[]>>): PredictInput => ({
  seasonInfo,
  history: [
    { slug: 'show-1', date: '2026-07-01', judges, results: [{ corpsKey: 'blue-devils', division: 'World Class', captions: allEight }] },
  ],
  target: { slug: 'prelims', date: '2026-08-06', lineup: [{ corpsKey: 'blue-devils', division: 'World Class' }], judges: targetJudges },
});

describe('score-sheet ⇄ judge-panel validation (§3.2)', () => {
  it('a well-formed panel matching the scored captions produces no caveats', () => {
    const report = validateInput(input(fullPanel));
    expect(report.warnings).toHaveLength(0);
  });

  it('scored captions without a judge assignment produce an info caveat (not a drop)', () => {
    const report = validateInput(input({ GE1: ['j1'], GE2: ['j1'] }));
    expect(report.droppedRows).toHaveLength(0);
    const info = report.warnings.filter((c) => c.severity === 'info');
    expect(info.length).toBeGreaterThan(0);
    expect(info.some((c) => /without a declared judge/.test(c.message))).toBe(true);
  });

  it('an empty judge assignment for a scored caption is treated as missing', () => {
    const report = validateInput(input({ ...fullPanel, MP: [] }));
    expect(report.warnings.some((c) => c.severity === 'info' && /MP/.test(c.message))).toBe(true);
  });

  it('a malformed caption key produces a warn caveat naming the show', () => {
    const report = validateInput(input({ GE1: ['j1'], XX: ['jx'] } as Partial<Record<Caption, string[]>>));
    const warn = report.warnings.filter((c) => c.severity === 'warn');
    expect(warn.some((c) => /show-1/.test(c.message) && /XX/.test(c.message))).toBe(true);
  });

  it('validates the target panel the same way (malformed key → warn)', () => {
    const report = validateInput(input(fullPanel, { GE1: ['j1'], ZZ: ['jz'] } as Partial<Record<Caption, string[]>>));
    expect(report.warnings.some((c) => c.severity === 'warn' && /target/.test(c.message) && /ZZ/.test(c.message))).toBe(true);
  });

  it('no panel supplied → no panel caveats', () => {
    const report = validateInput(input(undefined));
    expect(report.warnings).toHaveLength(0);
  });
});
