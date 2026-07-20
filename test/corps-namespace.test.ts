// Type-safe corps namespace (PLAN §3.1): generated identifiers, smart lookup,
// strict named(), make(), and the Unknown sentinel. The @ts-expect-error below is
// a COMPILE-TIME assertion enforced by `tsc --noEmit` (test/ is in tsconfig).
import { describe, it, expect } from 'vitest';
import * as DCI from '../src/index.js';
import { CorpsNotFoundError } from '../src/index.js';

describe('DCI.Corps namespace', () => {
  it('exposes generated known corps with the correct registry key', () => {
    expect(DCI.Corps.BlueDevils.name).toBe('Blue Devils');
    expect(DCI.Corps.BlueDevils.key).toBe('001j000000i6i9saav');
    expect(DCI.Corps.BlueDevils.division).toBe('World Class');
    // Frozen instance.
    expect(Object.isFrozen(DCI.Corps.BlueDevils)).toBe(true);
  });

  it('lookup() smart-matches to the same corps as the generated entry', () => {
    const bd = DCI.Corps.lookup('blue devils');
    expect(bd.key).toBe(DCI.Corps.BlueDevils.key);
    expect(bd.name).toBe(DCI.Corps.BlueDevils.name);
    // Alias / punctuation / case all normalize to the same corps.
    expect(DCI.Corps.lookup('Blue Devils').key).toBe(bd.key);
  });

  it('lookup() throws CorpsNotFoundError (with suggestions) on a miss', () => {
    expect(() => DCI.Corps.lookup('Zzqx Nonexistent Corps')).toThrow(CorpsNotFoundError);
    try {
      DCI.Corps.lookup('Zzqx Nonexistent Corps');
    } catch (e) {
      expect(e).toBeInstanceOf(CorpsNotFoundError);
      expect((e as CorpsNotFoundError).message).toMatch(/unknown corps/i);
      expect(Array.isArray((e as CorpsNotFoundError).suggestions)).toBe(true);
    }
  });

  it('named() resolves a known name at runtime and typechecks strictly', () => {
    const scv = DCI.Corps.named('Santa Clara Vanguard');
    expect(scv.name).toBe('Santa Clara Vanguard');
    // @ts-expect-error — an unknown literal is NOT a KnownCorpsName (compile error).
    expect(() => DCI.Corps.named('Totally Made Up Corps')).toThrow(CorpsNotFoundError);
  });

  it('make() creates a first-class unknown corps (model is identity-agnostic)', () => {
    const star = DCI.Corps.make('Star of Tomorrow', { division: DCI.Division.WorldClass });
    expect(star.name).toBe('Star of Tomorrow');
    expect(star.division).toBe('World Class');
    expect(star.unknown).toBe(true);
    expect(star.key).toContain('star-of-tomorrow');
  });

  it('exposes the Unknown sentinel', () => {
    expect(DCI.Corps.Unknown.key).toBe('unknown');
    expect(DCI.Corps.Unknown.name).toBe('Unknown');
    expect(DCI.Corps.Unknown.unknown).toBe(true);
    expect(DCI.Corps.Unknown.division).toBe('World Class');
  });
});
