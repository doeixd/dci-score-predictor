import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', simple: 'src/simple/simple.ts', effect: 'src/effect.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  external: ['@tensorflow/tfjs', 'effect'],
});
