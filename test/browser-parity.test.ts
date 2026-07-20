// Browser support proof. There is no real browser here, so we exercise the exact
// browser code path (dist/browser.js + the fetch AssetProvider) and assert two
// things that together mean "this works in a browser":
//   1. dist/browser.js contains ZERO `node:*` imports (static purity check) — the
//      tsup platform:'browser' build already errors on leaks; this is a belt-and-
//      suspenders assertion on the emitted artifact.
//   2. A full predict() run through the fetch provider (assets served over a
//      local HTTP server, global fetch — the same primitive a browser uses)
//      reproduces the Node path's top-corps total to 3 decimals.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { predict as nodePredict } from '../src/predict.js';
import type { SeasonData } from '../src/features/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const distBrowser = path.join(repoRoot, 'dist', 'browser.js');

const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf-8'));

// Minimal static file server rooted at the repo (serves /assets/**). Binds
// 127.0.0.1 on a random free port.
const startServer = (): Promise<http.Server> =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? '/').split('?')[0]!).replace(/^\/+/, '');
      const filePath = path.join(repoRoot, rel);
      if (!filePath.startsWith(repoRoot) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', filePath.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });

describe('browser support (dist/browser.js via fetch provider)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // The artifact must exist — run `npm run build` first.
    expect(fs.existsSync(distBrowser), 'dist/browser.js missing — run `npm run build`').toBe(true);
    server = await startServer();
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}/assets/`;
  });

  afterAll(() => {
    server?.close();
  });

  it('dist/browser.js contains zero node:* imports', () => {
    const code = fs.readFileSync(distBrowser, 'utf-8');
    const nodeImports = code.match(/from\s*["']node:[a-z/]+["']/g) ?? [];
    expect(nodeImports, `leaked node builtins: ${nodeImports.join(', ')}`).toHaveLength(0);
  });

  it('fetch-provider predict reproduces the Node top-corps total (3 decimals)', async () => {
    const season = fixture('season-2026-2026-dci-kentucky.json') as SeasonData;
    const offsets: Record<string, number> = fixture('kentucky-offsets.json');
    const input = { seasonInfo: season.seasonInfo, history: season.shows, target: season.target };

    // Node path (baseline).
    const nodeResult = await nodePredict(input, { recalOffsets: offsets });

    // Browser path: the emitted bundle + fetch provider pointed at the HTTP server.
    const browser = await import(/* @vite-ignore */ distBrowser);
    const browserResult = await browser.predict(input, {
      assets: { baseUrl },
      recalOffsets: offsets,
    });

    expect(browserResult.predictions.length).toBe(nodeResult.predictions.length);
    const nodeTop = nodeResult.predictions[0]!;
    const browserTop = browserResult.predictions[0]!;
    expect(browserTop.corpsKey).toBe(nodeTop.corpsKey);
    expect(browserTop.total).toBeCloseTo(nodeTop.total, 3);

    // Full-field parity, not just the winner.
    const nodeByKey = new Map(nodeResult.predictions.map((p: any) => [p.corpsKey, p.total]));
    for (const p of browserResult.predictions as any[])
      expect(p.total).toBeCloseTo(nodeByKey.get(p.corpsKey)!, 3);
  }, 300_000);
});
