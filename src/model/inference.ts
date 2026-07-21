// tfjs LayersModel inference for one ensemble member — a faithful port of the
// production v9SubcaptionInference.ts (identity-agnostic serving contract).
// Platform-agnostic: models load from in-memory artifacts (see loader.ts for the
// Node filesystem source; a fetch-based source works the same in browsers).
import * as tf from '@tensorflow/tfjs';
import {
  CAPTIONS,
  CAPTION_COUNT,
  SEQ_LEN,
  FEAT_DIM,
  RECAP_OFFSET,
  CAPTION_STRIDE,
  CAPTION_SCALE,
  STATIC_DIM,
  type Caption,
  type TargetStats,
} from './contract.js';

const DELTA_DIM = CAPTION_COUNT * 3;
const RECAP_DIM = CAPTION_COUNT;
const CATEGORY_DIM = 3;

// The saved models reference custom layers whose constructors need the member's
// target-norm stats at deserialization time. Production passes them through a
// global; we preserve that exact mechanism (loads are sequential) to stay
// byte-compatible with the saved topology.
let deserializationStats: TargetStats | undefined;
const currentStats = (): TargetStats => {
  if (!deserializationStats)
    throw new Error('target-norm stats must be set before deserializing model layers');
  return deserializationStats;
};

class MaskedSoftmax extends tf.layers.Layer {
  static className = 'MaskedSoftmax';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return (inputShape as Array<Array<number | null>>)[0]!;
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [scoresRaw, maskRaw] = inputs as tf.Tensor[];
      const scores = tf.reshape(scoresRaw!, [-1, SEQ_LEN]);
      const mask = tf.reshape(maskRaw!, [-1, SEQ_LEN]);
      const boolMask = tf.cast(mask, 'bool');
      const hasAny = tf.any(boolMask, 1, true);
      const defaultMask = tf.oneHot(
        tf.cast(tf.zeros([hasAny.shape[0]!], 'int32'), 'int32'),
        SEQ_LEN,
        1.0,
        0.0
      );
      const safeMask = tf.add(mask, tf.mul(defaultMask, tf.cast(tf.logicalNot(hasAny), 'float32')));
      return tf.softmax(
        tf.where(tf.cast(safeMask, 'bool'), scores, tf.fill(scores.shape, -1e9)),
        1
      );
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(MaskedSoftmax);

class NegationLayer extends tf.layers.Layer {
  static className = 'NegationLayer';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return inputShape as tf.Shape;
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => tf.neg(Array.isArray(inputs) ? inputs[0]! : inputs));
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(NegationLayer);

class AttentionPoolingLayer extends tf.layers.Layer {
  static className = 'AttentionPoolingLayer';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shapes = inputShape as [number[], number[]];
    return [shapes[1][0]!, shapes[1][2]!];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [weights, input] = inputs as [tf.Tensor, tf.Tensor];
      return tf.sum(tf.mul(weights, input), 1);
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(AttentionPoolingLayer);

class LastStepLayer extends tf.layers.Layer {
  static className = 'LastStepLayer';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shape =
      Array.isArray(inputShape) && Array.isArray(inputShape[0])
        ? (inputShape[0] as number[])
        : (inputShape as number[]);
    return [shape[0] ?? null, shape[2] ?? FEAT_DIM];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const seq = Array.isArray(inputs) ? inputs[0]! : inputs;
      return (seq as tf.Tensor).slice([0, SEQ_LEN - 1, 0], [-1, 1, -1]).squeeze([1]);
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(LastStepLayer);

class RecapLayer extends tf.layers.Layer {
  static className = 'RecapLayer';
  private a: tf.Tensor;
  private c: tf.Tensor;
  constructor(config: any) {
    super(config);
    const stats = (config.stats as TargetStats | undefined) ?? currentStats();
    this.a = tf.tensor1d(
      stats.deltaStd.map((std, i) => std / Math.max(stats.recapStd[i] ?? 1, 1e-6))
    );
    this.c = tf.tensor1d(
      stats.deltaMean.map((mean, i) => mean / Math.max(stats.recapStd[i] ?? 1, 1e-6))
    );
  }
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return (inputShape as tf.Shape[])[0]!;
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [delta, base] = inputs as [tf.Tensor, tf.Tensor];
      return tf.add(tf.add(tf.mul(delta, this.a), base), this.c);
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(RecapLayer);

class CategoryLayer extends tf.layers.Layer {
  static className = 'CategoryLayer';
  private catA: tf.Tensor;
  private catC: tf.Tensor;
  constructor(config: any) {
    super(config);
    const stats = (config.stats as TargetStats | undefined) ?? currentStats();
    const m = [
      [1, 1, 0, 0, 0, 0, 0, 0],
      [0, 0, 0.5, 0.5, 0.5, 0, 0, 0],
      [0, 0, 0, 0, 0, 0.5, 0.5, 0.5],
    ];
    this.catA = tf
      .tensor2d(
        m.map((row, i) =>
          row.map(
            (v, j) => (v * (stats.recapStd[j] ?? 1)) / Math.max(stats.categoryStd[i] ?? 1, 1e-6)
          )
        )
      )
      .transpose();
    this.catC = tf.tensor1d(
      m.map((row, i) => {
        const pts = row.reduce((acc, v, j) => acc + v * (stats.recapMean[j] ?? 0), 0);
        return (pts - (stats.categoryMean[i] ?? 0)) / Math.max(stats.categoryStd[i] ?? 1, 1e-6);
      })
    );
  }
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shape = inputShape as number[];
    return [shape[0]!, CATEGORY_DIM];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    const recap = Array.isArray(inputs) ? inputs[0]! : (inputs as tf.Tensor);
    return tf.tidy(() =>
      tf.add(tf.matMul(recap.rank === 1 ? recap.expandDims(0) : recap, this.catA), this.catC)
    );
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(CategoryLayer);

class TotalLayer extends tf.layers.Layer {
  static className = 'TotalLayer';
  private totalA: tf.Tensor;
  private totalC: tf.Tensor;
  constructor(config: any) {
    super(config);
    const stats = (config.stats as TargetStats | undefined) ?? currentStats();
    this.totalA = tf.tensor1d(stats.categoryStd.map((std) => std / Math.max(stats.totalStd, 1e-6)));
    this.totalC = tf.scalar(
      (stats.categoryMean.reduce((a, b) => a + b, 0) - stats.totalMean) /
        Math.max(stats.totalStd, 1e-6)
    );
  }
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    const shape = Array.isArray(inputShape[0]) ? (inputShape[0] as number[]) : (inputShape as number[]);
    return [shape[0]!, 1];
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    const cat = Array.isArray(inputs) ? inputs[0]! : (inputs as tf.Tensor);
    return tf.tidy(() =>
      tf.add(
        tf.sum(tf.mul(cat.rank === 1 ? cat.expandDims(0) : cat, this.totalA), 1, true),
        this.totalC
      )
    );
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(TotalLayer);

class LambdaScale extends tf.layers.Layer {
  static className = 'LambdaScale';
  computeOutputShape(inputShape: tf.Shape | tf.Shape[]) {
    return (inputShape as tf.Shape[])[0]!;
  }
  call(inputs: tf.Tensor | tf.Tensor[]) {
    return tf.tidy(() => {
      const [tensor, scale] = inputs as [tf.Tensor, tf.Tensor];
      return tf.mul(tensor, scale);
    });
  }
  getConfig() {
    return { ...super.getConfig() };
  }
}
tf.serialization.registerClass(LambdaScale);

const norm = (value: number, mean: number, std: number) => (value - mean) / Math.max(std, 1e-6);
const denorm = (value: number, mean: number, std: number) => value * Math.max(std, 1e-6) + mean;

const normalizeSequence = (sequence: number[][]) => {
  const out = sequence.slice(-SEQ_LEN).map((step) => {
    const copy = new Array<number>(FEAT_DIM).fill(0);
    for (let i = 0; i < Math.min(step.length, FEAT_DIM); i++) copy[i] = step[i] ?? 0;
    return copy;
  });
  while (out.length < SEQ_LEN) out.unshift(new Array<number>(FEAT_DIM).fill(0));
  return out;
};

const inferMask = (sequence: number[][], mask?: Array<boolean | number>) => {
  if (mask) {
    const out = mask.slice(-SEQ_LEN).map((value) => (value === true || value === 1 ? 1 : 0));
    while (out.length < SEQ_LEN) out.unshift(0);
    return out;
  }
  return sequence.map((step) => (step.some((value) => value !== 0) ? 1 : 0));
};

const clipEmbeddingId = (value: number | undefined, vocabSize: number, fallback = 0) => {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 0 || id >= vocabSize) return fallback;
  return id;
};

export type PredictionInput = {
  sequence: number[][];
  staticFeatures: number[];
  sequenceMask?: Array<boolean | number>;
  judgeIndices?: number[];
  corpsId?: number;
  agnosticShowId?: number;
  baselineRecap?: number[];
  historyLen?: number;
  judgeBiasScale?: number;
  corpsScale?: number;
};

export type MemberPrediction = {
  captions: Record<Caption, { p10: number; p50: number; p90: number }>;
  categories: { ge: number; visual: number; music: number };
  total: number;
};

type VocabSizes = { judge: number; corps: number; show: number };

export class EnsembleMember {
  constructor(
    private model: tf.LayersModel,
    private stats: TargetStats,
    public readonly name: string,
    private staticDim: number,
    private vocabSizes: VocabSizes
  ) {}

  get staticFeatureDim() {
    return this.staticDim;
  }

  predictOne(input: PredictionInput): MemberPrediction {
    const sequence = normalizeSequence(input.sequence);
    const mask = inferMask(sequence, input.sequenceMask);
    const lastValidIdx = mask.lastIndexOf(1);
    const fallbackBaseline = CAPTIONS.map((_, idx) => this.stats.recapMean[idx] ?? 15);
    const baselineRaw = input.baselineRecap
      ? [...input.baselineRecap]
      : lastValidIdx >= 0
        ? CAPTIONS.map(
            (_, idx) =>
              (sequence[lastValidIdx]?.[RECAP_OFFSET + idx * CAPTION_STRIDE + 2] ?? 0) *
              CAPTION_SCALE
          )
        : fallbackBaseline;
    const baselineNorm = baselineRaw.map((value, idx) =>
      norm(value || fallbackBaseline[idx]!, this.stats.recapMean[idx]!, this.stats.recapStd[idx]!)
    );

    // Leakage guard: zero the caption block of the last valid step (the target).
    if (lastValidIdx >= 0) {
      const step = [...sequence[lastValidIdx]!];
      for (let idx = 0; idx < CAPTION_COUNT; idx++) {
        const base = RECAP_OFFSET + idx * CAPTION_STRIDE;
        for (let j = 0; j < CAPTION_STRIDE; j++) step[base + j] = 0;
      }
      sequence[lastValidIdx] = step;
    }

    const staticFeatures = new Array<number>(this.staticDim).fill(0);
    for (let i = 0; i < Math.min(input.staticFeatures.length, this.staticDim); i++)
      staticFeatures[i] = input.staticFeatures[i] ?? 0;
    const judges = new Array<number>(CAPTION_COUNT).fill(0);
    for (let i = 0; i < Math.min(input.judgeIndices?.length ?? 0, CAPTION_COUNT); i++) {
      judges[i] = clipEmbeddingId(input.judgeIndices![i], this.vocabSizes.judge);
    }
    const corpsId = clipEmbeddingId(input.corpsId ?? 0, this.vocabSizes.corps, 0);
    const agnosticShowId = clipEmbeddingId(input.agnosticShowId ?? 0, this.vocabSizes.show, 0);
    const inferredHistoryLen = Math.max(0, mask.reduce<number>((sum, value) => sum + value, 0) - 1);
    const historyLen = Number.isFinite(input.historyLen)
      ? Math.max(0, Math.min(SEQ_LEN - 1, Number(input.historyLen)))
      : inferredHistoryLen;

    const tensors = {
      sequence: tf.tensor3d([sequence], [1, SEQ_LEN, FEAT_DIM], 'float32'),
      static: tf.tensor2d([staticFeatures], [1, this.staticDim], 'float32'),
      mask: tf.tensor2d([mask], [1, SEQ_LEN], 'float32'),
      judge_ids: tf.tensor2d([judges], [1, CAPTION_COUNT], 'int32'),
      corps_id: tf.tensor2d([[corpsId]], [1, 1], 'int32'),
      baseline_recap: tf.tensor2d([baselineNorm], [1, CAPTION_COUNT], 'float32'),
      history_len: tf.tensor2d([[historyLen]], [1, 1], 'float32'),
      judge_bias_scale: tf.tensor2d([[input.judgeBiasScale ?? 0]], [1, 1], 'float32'),
      corps_scale: tf.tensor2d([[input.corpsScale ?? 1]], [1, 1], 'float32'),
      agnostic_show_id: tf.tensor2d([[agnosticShowId]], [1, 1], 'int32'),
    };

    const output = this.model.predict([
      tensors.sequence,
      tensors.static,
      tensors.mask,
      tensors.judge_ids,
      tensors.corps_id,
      tensors.baseline_recap,
      tensors.history_len,
      tensors.judge_bias_scale,
      tensors.corps_scale,
      tensors.agnostic_show_id,
    ]) as tf.Tensor;
    const row = output.arraySync() as number[][];

    Object.values(tensors).forEach((tensor) => tensor.dispose());
    output.dispose();

    const values = row[0]!;
    const captions = {} as Record<Caption, { p10: number; p50: number; p90: number }>;
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      captions[CAPTIONS[idx]!] = {
        p10:
          denorm(values[idx]!, this.stats.deltaMean[idx]!, this.stats.deltaStd[idx]!) +
          baselineRaw[idx]!,
        p50:
          denorm(values[CAPTION_COUNT + idx]!, this.stats.deltaMean[idx]!, this.stats.deltaStd[idx]!) +
          baselineRaw[idx]!,
        p90:
          denorm(
            values[CAPTION_COUNT * 2 + idx]!,
            this.stats.deltaMean[idx]!,
            this.stats.deltaStd[idx]!
          ) + baselineRaw[idx]!,
      };
    }

    const recapStart = DELTA_DIM;
    for (let idx = 0; idx < CAPTION_COUNT; idx++) {
      captions[CAPTIONS[idx]!]!.p50 = denorm(
        values[recapStart + idx]!,
        this.stats.recapMean[idx]!,
        this.stats.recapStd[idx]!
      );
    }

    const categoryStart = DELTA_DIM + RECAP_DIM;
    const categories = {
      ge: denorm(values[categoryStart]!, this.stats.categoryMean[0]!, this.stats.categoryStd[0]!),
      visual: denorm(values[categoryStart + 1]!, this.stats.categoryMean[1]!, this.stats.categoryStd[1]!),
      music: denorm(values[categoryStart + 2]!, this.stats.categoryMean[2]!, this.stats.categoryStd[2]!),
    };
    const total = denorm(values[categoryStart + CATEGORY_DIM]!, this.stats.totalMean, this.stats.totalStd);

    return { captions, categories, total };
  }

  dispose() {
    this.model.dispose();
  }
}

export interface MemberArtifacts {
  name: string;
  modelTopology: unknown;
  weightSpecs: tf.io.WeightsManifestEntry[];
  weightData: ArrayBuffer;
  stats: TargetStats;
  format?: string;
  generatedBy?: string;
  convertedBy?: string;
}

const embeddingInputDim = (model: tf.LayersModel, layerName: string) => {
  const layer = model.layers.find((candidate) => candidate.name === layerName);
  const config = layer?.getConfig() as { inputDim?: number } | undefined;
  const inputDim = Number(config?.inputDim);
  return Number.isFinite(inputDim) && inputDim > 0 ? inputDim : 1;
};

export async function loadEnsembleMember(artifacts: MemberArtifacts): Promise<EnsembleMember> {
  deserializationStats = artifacts.stats;
  // Default to cpu when nothing has been selected yet; a prior ensureBackend()
  // (e.g. a wasm request from loadEnsemble) is respected and not overridden.
  if (!tf.getBackend()) await tf.setBackend('cpu');
  await tf.ready();
  const model = await tf.loadLayersModel({
    load: async () => ({
      modelTopology: artifacts.modelTopology as {},
      format: artifacts.format,
      generatedBy: artifacts.generatedBy,
      convertedBy: artifacts.convertedBy,
      weightSpecs: artifacts.weightSpecs,
      weightData: artifacts.weightData,
    }),
  });
  deserializationStats = undefined;
  const staticInput = model.inputs.find((input) => input.name.startsWith('static'));
  const staticDim = Number(staticInput?.shape?.[1] ?? STATIC_DIM);
  const vocabSizes = {
    judge: embeddingInputDim(model, 'judge_embedding'),
    corps: embeddingInputDim(model, 'corps_embedding'),
    show: embeddingInputDim(model, 'agnostic_show_embedding'),
  };
  return new EnsembleMember(model, artifacts.stats, artifacts.name, staticDim, vocabSizes);
}
