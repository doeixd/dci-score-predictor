// Generates assets/models/MANIFEST.json — the authoritative per-seed metadata for
// the shipped ensemble. Used at load time (browser + Node) to enumerate seeds
// without a filesystem readdir, and for provenance/integrity (weights sha256).
//
//   npx tsx tools/gen-model-manifest.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelsDir = path.join(root, 'assets', 'models');

interface InputLayer {
  class_name: string;
  config?: { name?: string; batch_input_shape?: (number | null)[] };
}

const inputDims = (modelJson: any): Record<string, (number | null)[]> => {
  const layers: InputLayer[] = modelJson?.modelTopology?.config?.layers ?? [];
  const dims: Record<string, (number | null)[]> = {};
  for (const l of layers)
    if (l.class_name === 'InputLayer' && l.config?.name && l.config.batch_input_shape)
      dims[l.config.name] = l.config.batch_input_shape;
  return dims;
};

const seeds = fs
  .readdirSync(modelsDir)
  .filter((entry) => fs.existsSync(path.join(modelsDir, entry, 'model.json')))
  .sort()
  .map((name) => {
    const dir = path.join(modelsDir, name);
    const modelJson = JSON.parse(fs.readFileSync(path.join(dir, 'model.json'), 'utf-8'));
    const norm = JSON.parse(fs.readFileSync(path.join(dir, 'target-norm.json'), 'utf-8'));
    const weightsBuf = fs.readFileSync(path.join(dir, 'weights.bin'));
    const dims = inputDims(modelJson);
    const staticShape = dims['static'] ?? dims['static_input'] ?? Object.values(dims).find((s) => s.length === 2 && s[1] === 224);
    const seqShape = dims['sequence'] ?? dims['sequence_input'] ?? Object.values(dims).find((s) => s.length === 3);
    return {
      name,
      seed: Number(name.match(/seed(\d+)/)?.[1] ?? -1),
      format: modelJson.format ?? 'layers-model',
      inputDims: {
        staticInput: staticShape?.[staticShape.length - 1] ?? null,
        sequenceLen: seqShape?.[1] ?? null,
        sequenceFeat: seqShape?.[2] ?? null,
      },
      weightsBytes: weightsBuf.byteLength,
      weightsSha256: createHash('sha256').update(weightsBuf).digest('hex'),
      targetNorm: {
        totalMean: norm.totalMean,
        totalStd: norm.totalStd,
        recapMean: norm.recapMean,
        recapStd: norm.recapStd,
      },
    };
  });

const manifest = {
  model: 'v11 field-pace ensemble (v10.4 recipe + identity-dropout 0.5, agnostic-finalized) + v10.5 division recal',
  description:
    'Identity-agnostic DCI recap-score ensemble. 8 seeds, per-seed tfjs LayersModel. See docs/MODEL_CARD.md.',
  captionScale: '0-20 recap captions; 224-dim static input; 15-step sequence.',
  generatedAt: new Date().toISOString(),
  seedCount: seeds.length,
  seeds,
};

const outPath = path.join(modelsDir, 'MANIFEST.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`wrote ${outPath} (${seeds.length} seeds)`);
