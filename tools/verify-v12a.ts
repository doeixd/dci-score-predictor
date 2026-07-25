import { readFileSync, readdirSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import { predict, _clearEnsembleCache } from '../src/predict.js';
import type { AssetProvider } from '../src/assets/provider.js';
import type { SeasonData } from '../src/features/types.js';

const ROOT = process.env.V12A_DIR ?? '/home/patrick/v12a-seeds/models';
const poolProvider = (root: string): AssetProvider => {
  const members = readdirSync(root).filter((n) => /seed\d+_/.test(n) && existsSync(path.join(root, n, 'model.json'))).sort();
  const resolve = (rel: string) => { const p = rel.split('/'); return path.join(root, p[1]!, p.slice(2).join('/')); };
  return {
    async readJson(rel: string) { if (rel === 'models/MANIFEST.json') return { seeds: members.map((m) => ({ name: m })) }; return JSON.parse(readFileSync(resolve(rel), 'utf-8')); },
    async readBinary(rel: string) { const b = readFileSync(resolve(rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    async listModelSeeds() { return members; },
  } as AssetProvider;
};
const season: SeasonData = JSON.parse(readFileSync(new URL('../test/fixtures/season-2026-2026-dci-kentucky.json', import.meta.url), 'utf-8'));
const base = { seasonInfo: season.seasonInfo, history: season.shows, target: season.target };
async function main() {
  const members = readdirSync(ROOT).filter((n) => /seed\d+_/.test(n)).sort();
  console.log('seed dirs:', members.length, members.map(m=>m.match(/seed(\d+)_/)![1]).join(','));
  // per-seed load: load each singly to confirm all 8 load and predict
  for (const m of members) {
    _clearEnsembleCache();
    const single = poolProvider(ROOT);
    // hack: restrict to one member via members option after listing — use members:1 on a single-dir provider
    const one: AssetProvider = { ...single, async listModelSeeds(){ return [m]; }, async readJson(rel:string){ if(rel==='models/MANIFEST.json') return {seeds:[{name:m}]}; return single.readJson(rel);} } as AssetProvider;
    const r = await predict(base as any, { provider: one, identity: 'agnostic' } as any);
    const top = r.predictions.slice().sort((a,b)=>b.total-a.total)[0];
    console.log(`  ${m.match(/seed\d+/)![0]}: n=${r.predictions.length} top=${top.corpsKey}:${top.total.toFixed(2)}`);
  }
  // full 8-seed pool
  _clearEnsembleCache();
  const res = await predict(base as any, { provider: poolProvider(ROOT), identity: 'agnostic' } as any);
  const sorted = res.predictions.slice().sort((a,b)=>b.total-a.total);
  console.log('POOL n:', res.predictions.length, 'range', sorted[sorted.length-1].total.toFixed(2), '..', sorted[0].total.toFixed(2));
  console.log('POOL top5:', sorted.slice(0,5).map(p=>`${p.corpsKey}:${p.total.toFixed(2)}`).join('  '));
  console.log('out-of-range(<20|>110):', res.predictions.filter(p=>p.total<20||p.total>110).length);
}
main().catch(e=>{console.error(e);process.exit(1);});
