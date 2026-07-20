// Model asset loading. The package ships the 8-seed v10.4 field-pace ensemble in
// assets/models/<seed>/{model.json,weights.bin,target-norm.json}. In Node we read
// straight from the installed package; other platforms can construct
// MemberArtifacts from fetched bytes and call loadEnsembleMember directly.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as tf from '@tensorflow/tfjs';
import { loadEnsembleMember, type EnsembleMember, type MemberArtifacts } from './inference.js';
import type { TargetStats } from './contract.js';

const packageRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const defaultModelsDir = () => path.join(packageRoot(), 'assets', 'models');
export const defaultBiasCalibrationPath = () =>
  path.join(packageRoot(), 'assets', 'calibration', 'biasCalibration.json');
export const defaultCurvesPath = () =>
  path.join(packageRoot(), 'assets', 'curves', 'referenceCurvesV4.json');

const readMemberArtifacts = (memberDir: string): MemberArtifacts => {
  const manifest = JSON.parse(fs.readFileSync(path.join(memberDir, 'model.json'), 'utf-8'));
  const stats = JSON.parse(
    fs.readFileSync(path.join(memberDir, 'target-norm.json'), 'utf-8')
  ) as TargetStats;
  const weightData = Buffer.concat(
    ((manifest.weightsManifest ?? []) as Array<{ paths?: string[] }>)
      .flatMap((group) => group.paths ?? [])
      .map((weightPath) => fs.readFileSync(path.resolve(memberDir, weightPath)))
  );
  return {
    name: path.basename(memberDir),
    modelTopology: manifest.modelTopology,
    format: manifest.format,
    generatedBy: manifest.generatedBy,
    convertedBy: manifest.convertedBy,
    weightSpecs: ((manifest.weightsManifest ?? []) as Array<{ weights?: tf.io.WeightsManifestEntry[] }>)
      .flatMap((group) => group.weights ?? []),
    weightData: weightData.buffer.slice(
      weightData.byteOffset,
      weightData.byteOffset + weightData.byteLength
    ) as ArrayBuffer,
    stats,
  };
};

export interface LoadEnsembleOptions {
  /** Directory holding one subdirectory per seed. Defaults to the packaged assets. */
  modelsDir?: string;
  /** Number of seeds to load (accuracy vs load-time/memory). Default: all. */
  members?: number;
}

export async function loadEnsemble(options: LoadEnsembleOptions = {}): Promise<EnsembleMember[]> {
  const dir = options.modelsDir ?? defaultModelsDir();
  const seedDirs = fs
    .readdirSync(dir)
    .map((entry) => path.join(dir, entry))
    .filter((entry) => fs.existsSync(path.join(entry, 'model.json')))
    .sort();
  if (!seedDirs.length) throw new Error(`no model seed directories found under ${dir}`);
  const selected = options.members ? seedDirs.slice(0, options.members) : seedDirs;
  const members: EnsembleMember[] = [];
  for (const seedDir of selected) members.push(await loadEnsembleMember(readMemberArtifacts(seedDir)));
  return members;
}

export const loadBiasCalibration = (filePath?: string): Record<string, number> => {
  try {
    return JSON.parse(fs.readFileSync(filePath ?? defaultBiasCalibrationPath(), 'utf-8'));
  } catch {
    return {};
  }
};
