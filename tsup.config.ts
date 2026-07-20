import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Node builds (default). fs-backed asset provider is reachable here.
    entry: { index: 'src/index.ts', simple: 'src/simple/simple.ts', effect: 'src/effect.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    sourcemap: true,
    clean: true,
    external: ['@tensorflow/tfjs', 'effect'],
  },
  {
    // Browser build. platform:'browser' makes esbuild ERROR on any leaked node:*
    // import — that's the guard that keeps the browser bundle pure.
    entry: { browser: 'src/browser.ts' },
    format: ['esm'],
    platform: 'browser',
    dts: true,
    sourcemap: true,
    clean: false,
    external: ['@tensorflow/tfjs'],
  },
]);
