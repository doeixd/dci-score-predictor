// Node asset provider — the fs-backed implementation of the AssetProvider seam.
// This is the ONLY module in the src/assets layer that touches `node:*`; it must
// never be statically imported by browser-reachable code (domain/loader/predict).
// It is reached either by an eager side-effect import from the Node entrypoints
// (src/index.ts, src/simple/simple.ts, src/effect.ts) or lazily via the
// non-analyzable dynamic import in provider.ensureNodeProvider().
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  _installSyncReader,
  setAssetProvider,
  concatArrayBuffers,
  type AssetProvider,
} from './provider.js';

// Resolve the package root by walking up from this module until the shipped
// `assets` dir is found. Layout-independent: correct in the src tree, the tsup
// dist bundle, and an installed node_modules tarball (a fixed `..` count is not).
const packageRoot = (): string => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    // Marker is `assets/models` (not bare `assets`): this module lives in
    // src/assets/, so a bare `assets` check would wrongly match the src tree.
    if (fs.existsSync(path.join(dir, 'assets', 'models'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
};

const assetPath = (rel: string): string => path.join(packageRoot(), 'assets', ...rel.split('/'));

const readJsonSync = (rel: string): unknown => JSON.parse(fs.readFileSync(assetPath(rel), 'utf-8'));

export const nodeAssetProvider: AssetProvider = {
  async readJson(rel) {
    return readJsonSync(rel);
  },
  async readBinary(rel) {
    const buf = fs.readFileSync(assetPath(rel));
    return concatArrayBuffers([
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    ]);
  },
  async listModelSeeds() {
    const dir = assetPath('models');
    return fs
      .readdirSync(dir)
      .filter((entry) => fs.existsSync(path.join(dir, entry, 'model.json')))
      .sort();
  },
};

/**
 * Install the Node fs-backed provider: the sync reader (for the synchronous
 * domain matchers) and the default async provider (for loadEnsemble / predict).
 * Idempotent. Exported as a callable so the eager install from the Node
 * entrypoints survives tree-shaking (`sideEffects: false` drops a bare
 * side-effect-only import; a top-level call expression is retained).
 */
export const installNodeProvider = (): void => {
  _installSyncReader({ readJson: readJsonSync });
  setAssetProvider(nodeAssetProvider);
};

// Also self-install on import, for the ensureNodeProvider() dynamic-import path.
installNodeProvider();
