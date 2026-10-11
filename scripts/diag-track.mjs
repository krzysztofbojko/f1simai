import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-trk-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false, lib: { entry: { presets: resolve('src/track/Presets.ts') }, formats: ['es'], fileName: (_, n) => n + '.mjs' } } });
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const gp = Presets.createGrandPrixTrack(14);
  const [a, b] = process.argv.slice(2).map(Number);
  for (let i = a; i <= b; i++) { const c = gp.checkpoints[i]; console.log(i, 'pos', c.center.x.toFixed(0), c.center.y.toFixed(0), 'curv', c.curvature.toFixed(4), 'R', c.curvature ? (1 / Math.abs(c.curvature)).toFixed(0) : 'inf'); }
  console.log('n', gp.checkpoints.length, 'len', gp.totalLength.toFixed(0));
} finally { await rm(output, { recursive: true, force: true }); }
