// Browser entry — dci-score-predictor/browser.
//
// Same prediction internals as the Node entry, but every asset (registries,
// curves, calibration, model weights) is loaded over `fetch` from a baseUrl you
// host (a CDN or a static copy of the package's `assets/` dir). There is NO
// silent Node fs fallback here: an `assets` option (baseUrl or provider) is
// REQUIRED. This module never imports `node:*`, so it bundles for browsers; the
// tsup browser build fails hard if a node builtin ever leaks in.
//
//   import { predict } from 'dci-score-predictor/browser';
//   const result = await predict(input, {
//     assets: { baseUrl: 'https://cdn.jsdelivr.net/npm/dci-score-predictor@latest/assets/' },
//   });
//
// The 8-seed ensemble is ~32 MB of weights — pass `members: N` to load fewer
// seeds (lower accuracy, faster/lighter load), or call init() once up front.
import {
  init as coreInit,
  fetchAssets,
  getActiveProvider,
  type AssetProvider,
  type InitOptions,
} from './assets/provider.js';
import { predict as corePredict, type PredictInput, type PredictOptions, type PredictedShowResult } from './predict.js';
import { predict as coreSimplePredict, type LooseInput } from './simple/simple.js';
import { loadEnsemble as coreLoadEnsemble, type LoadEnsembleOptions } from './model/loader.js';

export type BrowserAssets = { baseUrl: string } | AssetProvider;

/** Coerce the required assets option into a provider. */
const toProvider = (assets: BrowserAssets): AssetProvider =>
  'readJson' in assets ? assets : fetchAssets(assets.baseUrl);

// init() is idempotent per provider — remember what we've preloaded to avoid
// re-fetching registries on every predict() call.
let initializedFor: AssetProvider | null = null;
const ensureInit = async (assets: BrowserAssets): Promise<AssetProvider> => {
  const provider = toProvider(assets);
  if (initializedFor !== provider) {
    await coreInit({ assets: provider });
    initializedFor = provider;
  }
  return provider;
};

/** Preload registries/curves/calibration and activate the fetch provider. */
export async function init(options: { assets: BrowserAssets }): Promise<void> {
  await ensureInit(options.assets);
}

export interface BrowserPredictOptions extends Omit<PredictOptions, 'provider'> {
  /** REQUIRED — where to fetch the package assets from (no Node fallback in the browser build). */
  assets: BrowserAssets;
}

/** Core predict, wired to fetch-loaded assets. */
export async function predict(
  input: PredictInput,
  options: BrowserPredictOptions
): Promise<PredictedShowResult> {
  const provider = await ensureInit(options.assets);
  const { assets: _assets, ...rest } = options;
  return corePredict(input, { ...rest, provider });
}

/** Simple (loose-input) predict, wired to fetch-loaded assets. */
export async function simplePredict(
  input: LooseInput,
  options: BrowserPredictOptions
): Promise<PredictedShowResult> {
  const provider = await ensureInit(options.assets);
  const { assets: _assets, ...rest } = options;
  return coreSimplePredict(input, { ...rest, provider });
}

/** Load the tfjs ensemble over fetch. Pass { assets } or a pre-init'd provider. */
export async function loadEnsemble(
  options: { assets?: BrowserAssets } & Omit<LoadEnsembleOptions, 'provider'> = {}
) {
  const { assets, ...rest } = options;
  const provider = assets ? await ensureInit(assets) : getActiveProvider();
  return coreLoadEnsemble({ ...rest, provider });
}

export { fetchAssets };
export type { AssetProvider, InitOptions, PredictInput, PredictOptions, PredictedShowResult, LooseInput };

// Domain helpers work in the browser once init() has preloaded the registries.
export {
  Division,
  Caption as Captions,
  matchCorps,
  matchJudge,
  matchCaption,
  makeCorps,
  normalizeName,
  type Judge,
  type CaptionDef,
  type CorpsMatch,
} from './domain/domain.js';
// Type-safe corps namespace (PLAN §3.1) — resolves once init() has preloaded registries.
export { Corps, CorpsNotFoundError, type KnownCorpsName } from './domain/corps-namespace.js';
export { CAPTIONS, type Caption } from './model/contract.js';
