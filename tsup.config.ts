import { defineConfig, type Options } from 'tsup';

// Each entry is emitted by its OWN sequential tsup invocation (see the "build"
// script). The entries share a `Corps` type that is re-exported through two
// module paths; when several entries' dts workers run concurrently in a single
// tsup invocation they race on that shared declaration and intermittently emit
// TS2300 "Duplicate identifier 'Corps'". One entry per invocation serializes
// the dts build and makes it deterministic. `clean` is handled once by the
// build script (`rm -rf dist`) so later invocations don't wipe earlier output.
const shared = {
  dts: true,
  sourcemap: true,
  clean: false,
} satisfies Partial<Options>;

const targets: Record<string, Options> = {
  index: {
    ...shared,
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    external: ['@tensorflow/tfjs', '@tensorflow/tfjs-backend-wasm', 'effect'],
  },
  simple: {
    ...shared,
    entry: { simple: 'src/simple/simple.ts' },
    format: ['esm', 'cjs'],
    external: ['@tensorflow/tfjs', '@tensorflow/tfjs-backend-wasm', 'effect'],
  },
  effect: {
    ...shared,
    entry: { effect: 'src/effect.ts' },
    format: ['esm', 'cjs'],
    external: ['@tensorflow/tfjs', '@tensorflow/tfjs-backend-wasm', 'effect'],
  },
  // Browser build. platform:'browser' makes esbuild ERROR on any leaked node:*
  // import — that's the guard that keeps the browser bundle pure.
  browser: {
    ...shared,
    entry: { browser: 'src/browser.ts' },
    format: ['esm'],
    platform: 'browser',
    external: ['@tensorflow/tfjs', '@tensorflow/tfjs-backend-wasm'],
  },
};

const target = process.env.TSUP_TARGET ?? 'index';
const config = targets[target];
if (!config) {
  throw new Error(`Unknown TSUP_TARGET "${target}" (expected one of: ${Object.keys(targets).join(', ')})`);
}

export default defineConfig(config);
