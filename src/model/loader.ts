// Model asset loading. The package ships the 8-seed v10.4 field-pace ensemble in
// assets/models/<seed>/{model.json,weights.bin,target-norm.json}. Loading goes
// through the AssetProvider seam (src/assets/provider.ts): the Node provider
// reads from the installed package; the fetch provider reads over HTTP, so the
// same code loads the ensemble in a browser. No node:* import here.
import type * as tf from '@tensorflow/tfjs';
import { loadEnsembleMember, type EnsembleMember, type MemberArtifacts } from './inference.js';
import type { TargetStats } from './contract.js';
import {
  getActiveProvider,
  getJsonSync,
  ensureNodeProvider,
  concatArrayBuffers,
  type AssetProvider,
} from '../assets/provider.js';

interface ModelManifest {
  weightsManifest?: Array<{ paths?: string[]; weights?: tf.io.WeightsManifestEntry[] }>;
  modelTopology?: unknown;
  format?: string;
  generatedBy?: string;
  convertedBy?: string;
}

interface SeedsManifest {
  seeds?: Array<{ name: string }>;
}

const readMemberArtifacts = async (
  provider: AssetProvider,
  seedName: string
): Promise<MemberArtifacts> => {
  const rel = (file: string) => `models/${seedName}/${file}`;
  const manifest = (await provider.readJson(rel('model.json'))) as ModelManifest;
  const stats = (await provider.readJson(rel('target-norm.json'))) as TargetStats;
  const weightPaths = (manifest.weightsManifest ?? []).flatMap((group) => group.paths ?? []);
  const buffers = await Promise.all(weightPaths.map((p) => provider.readBinary(rel(p))));
  return {
    name: seedName,
    modelTopology: manifest.modelTopology,
    format: manifest.format,
    generatedBy: manifest.generatedBy,
    convertedBy: manifest.convertedBy,
    weightSpecs: (manifest.weightsManifest ?? []).flatMap((group) => group.weights ?? []),
    weightData: concatArrayBuffers(buffers),
    stats,
  };
};

/** Discover the seed directory names — prefer the shipped MANIFEST, else enumerate. */
const listSeeds = async (provider: AssetProvider): Promise<string[]> => {
  try {
    const manifest = (await provider.readJson('models/MANIFEST.json')) as SeedsManifest;
    const names = (manifest.seeds ?? []).map((s) => s.name).filter(Boolean);
    if (names.length) return names.sort();
  } catch {
    // no manifest — fall through to enumeration (Node only)
  }
  if (provider.listModelSeeds) return provider.listModelSeeds();
  throw new Error(
    'cannot enumerate model seeds: models/MANIFEST.json is unavailable and the provider cannot list them.'
  );
};

export interface LoadEnsembleOptions {
  /** Explicit asset provider (e.g. fetchAssets(baseUrl)). Defaults to the active provider. */
  provider?: AssetProvider;
  /** Number of seeds to load (accuracy vs load-time/memory). Default: all. */
  members?: number;
}

export async function loadEnsemble(options: LoadEnsembleOptions = {}): Promise<EnsembleMember[]> {
  await ensureNodeProvider();
  const provider = options.provider ?? getActiveProvider();
  const seedNames = await listSeeds(provider);
  if (!seedNames.length) throw new Error('no model seed directories found');
  const selected = options.members ? seedNames.slice(0, options.members) : seedNames;
  const members: EnsembleMember[] = [];
  for (const seedName of selected)
    members.push(await loadEnsembleMember(await readMemberArtifacts(provider, seedName)));
  return members;
}

export const loadBiasCalibration = (): Record<string, number> => {
  try {
    return getJsonSync<Record<string, number>>('calibration/biasCalibration.json');
  } catch {
    return {};
  }
};
