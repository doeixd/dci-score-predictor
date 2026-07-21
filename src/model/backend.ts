// tfjs backend selection (PLAN §5 wasm speed knob). The default CPU backend is
// pure-JS and needs no extra deps. The optional `wasm` backend (XNNPACK SIMD)
// is an OPTIONAL peer dependency — it is dynamic-imported only when requested,
// so cpu users never pull it, and if it is absent or fails to activate we fall
// back to cpu with a reported reason (never throw).
import * as tf from '@tensorflow/tfjs';

export type Backend = 'cpu' | 'wasm';

export interface BackendResult {
  /** What the caller asked for. */
  requested: Backend;
  /** The backend actually active after selection. */
  active: string;
  /** True when a wasm request could not be honored and cpu was used instead. */
  fellBack: boolean;
  /** Why the fallback happened (present only when `fellBack`). */
  error?: string;
}

let wasmReady = false;

const activate = async (name: Backend): Promise<string> => {
  await tf.setBackend(name);
  await tf.ready();
  return tf.getBackend();
};

/**
 * Ensure the requested tfjs backend is active. `wasm` dynamic-imports
 * `@tensorflow/tfjs-backend-wasm` (optional peer dep) and activates it; any
 * failure (missing module, no SIMD, activation error) gracefully falls back to
 * the always-present cpu backend and reports it via {@link BackendResult}.
 */
export async function ensureBackend(backend: Backend = 'cpu'): Promise<BackendResult> {
  if (backend === 'wasm') {
    try {
      if (!wasmReady) {
        // Optional peer dependency — resolved only on the wasm path.
        await import('@tensorflow/tfjs-backend-wasm');
        wasmReady = true;
      }
      const active = await activate('wasm');
      if (active === 'wasm') return { requested: 'wasm', active, fellBack: false };
      throw new Error(`wasm backend did not activate (got "${active}")`);
    } catch (e) {
      const active = await activate('cpu');
      return {
        requested: 'wasm',
        active,
        fellBack: true,
        error: (e as Error)?.message ?? String(e),
      };
    }
  }
  return { requested: 'cpu', active: await activate('cpu'), fellBack: false };
}
