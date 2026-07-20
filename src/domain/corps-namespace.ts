// Type-safe corps namespace (PLAN §3.1). Merges the generated const-object of
// known corps (autocomplete: `Corps.BlueDevils`) with runtime smart matching
// (`lookup`), the strict template-literal-typed `named`, the identity-agnostic
// `make`, and the `Unknown` sentinel. Generated data lives in generated-corps.ts;
// this module keeps hand-written surface separate from the emitted file.
//
// CorpsNotFoundError lives here (not simple.ts) so both the domain namespace and
// the simple API can throw it without a domain → simple import cycle.
import { matchCorps, makeCorps, type Corps as CorpsEntity, type Division } from './domain.js';
import { GENERATED_CORPS, type KnownCorpsName } from './generated-corps.js';

/** Thrown by `Corps.lookup`/`Corps.named` (and the simple API) when a name can't be matched. */
export class CorpsNotFoundError extends Error {
  readonly suggestions: string[];
  constructor(input: string, suggestions: string[]) {
    super(
      `unknown corps "${input}"${suggestions.length ? ` — did you mean: ${suggestions.join(', ')}?` : ''}. ` +
        `Supply a division hint (Corps.make(name, { division }) / { corps, division: 'World Class' }) to add it as a new corps.`
    );
    this.name = 'CorpsNotFoundError';
    this.suggestions = suggestions;
  }
}

/** Smart lookup: canonical/alias/normalized. Throws {@link CorpsNotFoundError} (with suggestions) on a miss. */
const lookup = (name: string): CorpsEntity => {
  const match = matchCorps(name);
  if (match.corps) return match.corps;
  throw new CorpsNotFoundError(name, match.suggestions);
};

/**
 * The `DCI.Corps` namespace-object:
 * - `Corps.BlueDevils` etc. — generated, frozen, autocompleted known corps.
 * - `Corps.Unknown` — the identity-agnostic sentinel.
 * - `Corps.lookup(name)` — fuzzy/alias runtime match, throws on miss.
 * - `Corps.named(name)` — strict: only a {@link KnownCorpsName} typechecks.
 * - `Corps.make(name, { division, key? })` — first-class new/unknown corps.
 */
export const Corps = {
  ...GENERATED_CORPS,
  lookup,
  named: (name: KnownCorpsName): CorpsEntity => lookup(name),
  make: (name: string, options: { division: Division; key?: string }): CorpsEntity =>
    makeCorps(name, options),
} as const;

// Re-export the Corps entity type under the same name so `import { Corps }` carries
// BOTH the namespace value and the `Corps` instance type (a value+type pair in one
// module is legal and merges cleanly when re-exported, unlike two source modules).
export type Corps = CorpsEntity;
export type { KnownCorpsName };
