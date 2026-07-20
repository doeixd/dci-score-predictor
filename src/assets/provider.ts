// Asset-provider abstraction — the seam that lets this package run in Node AND in
// the browser. Every shipped asset (registries, curves, calibration, model
// weights) is addressed by a *package-relative* path rooted at the `assets/` dir,
// e.g. 'registries/corps.json' or 'models/<seed>/weights.bin'.
//
// Two providers exist:
//   • the Node provider (src/assets/node-provider.ts) — fs walk-up, SYNC-capable,
//     installed automatically in Node. Kept sync internally so the existing sync
//     domain matchers (matchCorps/matchJudge) and the 39 tests work unchanged.
//   • the fetch provider (fetchAssets) — global fetch, works in browsers and in
//     Node ≥20. Async only; the browser entry preloads registries via init().
//
// CRITICAL: this module (and everything it statically imports) must stay free of
// any `node:*` import so it can land in the browser bundle. The Node bits live in
// node-provider.ts, which is reached only through a non-analyzable dynamic import
// (ensureNodeProvider) or an eager side-effect import from the Node entrypoints.

/** Async asset source. `relPath` is package-relative to the shipped `assets/` dir. */
export interface AssetProvider {
  readJson(relPath: string): Promise<unknown>;
  readBinary(relPath: string): Promise<ArrayBuffer>;
  /** Optional: enumerate model seed directory names (Node fallback when no MANIFEST). */
  listModelSeeds?(): Promise<string[]>;
}

/** Sync asset source — Node only, powers the synchronous domain matchers. */
export interface SyncReader {
  readJson(relPath: string): unknown;
}

// ── Shared JSON cache (sync + async paths converge here) ─────────────────────
const jsonCache = new Map<string, unknown>();

let syncReader: SyncReader | null = null;
let activeProvider: AssetProvider | null = null;

/** Node bootstrap installs its sync reader here (see node-provider.ts). */
export const _installSyncReader = (reader: SyncReader): void => {
  syncReader = reader;
};

/** Set the active async provider (Node default, or an explicit browser provider). */
export const setAssetProvider = (provider: AssetProvider): void => {
  activeProvider = provider;
};

export const getActiveProvider = (): AssetProvider => {
  if (!activeProvider)
    throw new Error(
      'no asset provider is active. In Node this installs automatically; in a browser/other runtime ' +
        "call `await init({ assets: { baseUrl } })` or use the 'dci-score-predictor/browser' entry."
    );
  return activeProvider;
};

/** Seed the JSON cache (used by init() to make async-loaded assets available synchronously). */
export const primeJson = (relPath: string, value: unknown): void => {
  jsonCache.set(relPath, value);
};

/**
 * Read a JSON asset synchronously. Serves from cache first (populated by init()
 * on non-Node runtimes), then falls back to the installed Node sync reader.
 * Throws with actionable guidance when neither is available.
 */
export const getJsonSync = <T>(relPath: string): T => {
  if (jsonCache.has(relPath)) return jsonCache.get(relPath) as T;
  if (!syncReader)
    throw new Error(
      `asset "${relPath}" is not available synchronously. In a browser/non-Node runtime, ` +
        "call `await init({ assets: { baseUrl } })` (or use the 'dci-score-predictor/browser' entry) " +
        'to preload registries before calling the synchronous APIs.'
    );
  const value = syncReader.readJson(relPath) as T;
  jsonCache.set(relPath, value);
  return value;
};

// ── Fetch provider (browser + Node ≥20) ──────────────────────────────────────

/**
 * An {@link AssetProvider} backed by global `fetch`, resolving package-relative
 * paths against `baseUrl` (a CDN URL or a statically-hosted copy of the package's
 * `assets/` dir, e.g. '/assets/' or
 * 'https://cdn.jsdelivr.net/npm/dci-score-predictor@latest/assets/').
 */
export function fetchAssets(baseUrl: string): AssetProvider {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = (rel: string) => `${base}${rel.replace(/^\/+/, '')}`;
  return {
    async readJson(rel) {
      const res = await fetch(url(rel));
      if (!res.ok) throw new Error(`fetchAssets: ${res.status} ${res.statusText} for ${url(rel)}`);
      return res.json();
    },
    async readBinary(rel) {
      const res = await fetch(url(rel));
      if (!res.ok) throw new Error(`fetchAssets: ${res.status} ${res.statusText} for ${url(rel)}`);
      return res.arrayBuffer();
    },
  };
}

/** Concatenate ArrayBuffers into one (platform-agnostic; replaces Node Buffer.concat). */
export const concatArrayBuffers = (buffers: ArrayBuffer[]): ArrayBuffer => {
  const total = buffers.reduce((sum, b) => sum + b.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const b of buffers) {
    out.set(new Uint8Array(b), offset);
    offset += b.byteLength;
  }
  return out.buffer;
};

// ── Node auto-install (lazy, browser-safe) ───────────────────────────────────

const isNode = (): boolean =>
  typeof process !== 'undefined' && !!(process as { versions?: { node?: string } }).versions?.node;

let nodeInstall: Promise<void> | null = null;

/**
 * Ensure an async provider is active. In Node, lazily imports the fs-backed
 * provider (via a non-analyzable specifier so the browser bundle never pulls
 * `node:*`). In a browser this is a no-op if a provider was already set by init().
 */
export const ensureNodeProvider = async (): Promise<void> => {
  if (activeProvider) return;
  if (!isNode()) return; // browser: init() must have set a provider
  if (!nodeInstall) {
    // Non-literal specifier: esbuild leaves this as a runtime import for the
    // browser build (no bundling, no node:* leak) and resolves it at runtime in Node.
    const spec = './node-provider.js';
    nodeInstall = import(/* @vite-ignore */ /* webpackIgnore: true */ spec).then(() => undefined);
  }
  await nodeInstall;
};

// ── Preload + init ───────────────────────────────────────────────────────────

/** JSON assets the synchronous APIs read; init() preloads these so they work off-Node. */
export const PRELOAD_JSON = [
  'registries/corps.json',
  'registries/judges.json',
  'registries/featureContext.json',
  'curves/referenceCurvesV4.json',
  'calibration/biasCalibration.json',
] as const;

export interface InitOptions {
  /** Where to fetch assets from — a baseUrl string/object, or a ready AssetProvider. */
  assets?: { baseUrl: string } | AssetProvider;
}

const resolveProvider = (assets: InitOptions['assets']): AssetProvider | null => {
  if (!assets) return null;
  if ('readJson' in assets) return assets;
  if ('baseUrl' in assets) return fetchAssets(assets.baseUrl);
  return null;
};

/**
 * Preload registries/curves/calibration and activate a provider. Required in
 * browsers before the synchronous domain matchers or predict() are used; a no-op
 * beyond provider activation in Node (assets are already reachable via fs).
 */
export async function init(options: InitOptions = {}): Promise<void> {
  const explicit = resolveProvider(options.assets);
  if (explicit) {
    for (const rel of PRELOAD_JSON) {
      // biasCalibration is optional — tolerate its absence.
      try {
        primeJson(rel, await explicit.readJson(rel));
      } catch (err) {
        if (rel !== 'calibration/biasCalibration.json') throw err;
        primeJson(rel, {});
      }
    }
    setAssetProvider(explicit);
    return;
  }
  await ensureNodeProvider();
}
