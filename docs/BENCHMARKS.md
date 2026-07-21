# Benchmarks

## tfjs backend: cpu vs wasm

The default backend is the pure-JS tfjs **cpu** backend (zero extra deps). Passing
`{ backend: 'wasm' }` to `predict` / `predictMany` (or `loadEnsemble`) activates
the optional **wasm** (XNNPACK SIMD) backend via the optional peer dependency
`@tensorflow/tfjs-backend-wasm`. If that package is absent or the backend fails
to activate, prediction silently falls back to cpu and emits an `info` caveat
(`backend 'wasm' unavailable — ran on cpu instead`).

Measured with `tools/bench-backends.ts` — one full DCI event (the shipped
kentucky fixture: 7-corps target, full 8-seed ensemble). "load+first" is the
cold call (ensemble load + backend activation + first predict); "warm predict"
is the median of 5 subsequent predicts with the ensemble cached.

| backend | load + first (ms) | warm predict (ms) | note |
|---|---|---|---|
| cpu | ~1950–2140 | ~1590–1850 | default, pure-JS |
| wasm | ~1360–1400 | ~740–830 | XNNPACK SIMD (optional peer dep) |

On this machine (Node v24, 2 vCPU) the wasm backend runs a full-event predict
roughly **2× faster** warm (~800 ms vs ~1700 ms) and also loads faster. Gains
scale with field size and ensemble members; single-corps predicts see less
benefit. Numbers are indicative — re-run `npx tsx tools/bench-backends.ts` on
your hardware.

### Notes / caveats

- wasm is opt-in: it is an **optional** peer dependency, so cpu users never pull
  it. Install it explicitly to use `backend: 'wasm'`:
  `npm i @tensorflow/tfjs-backend-wasm`.
- The wasm path dynamic-imports the backend, so bundlers that don't see the
  optional dep won't error — the import is only reached on the wasm code path.
- Fallback is graceful and reported; it never throws. In browsers the wasm
  backend fetches its `.wasm` binary — host it or use `setWasmPaths` per the
  tfjs-backend-wasm docs.
