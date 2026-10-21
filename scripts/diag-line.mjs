// Racing-line geometry per circuit: node scripts/diag-line.mjs [track files...]  (DUMP=<name> prints every point)
import { build } from 'vite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const out = await mkdtemp(join(tmpdir(), 'f1-rl-'));
try {
  const entries = { rl: 'track/RacingLine', track: 'track/Track', vector: 'math/Vector2', spline: 'math/Spline', presets: 'track/Presets' };
  await build({ configFile: false, logLevel: 'silent', build: { outDir: out, emptyOutDir: true, minify: false,
    lib: { entry: Object.fromEntries(Object.entries(entries).map(([k, p]) => [k, resolve('src/' + p + '.ts')])), formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const I = f => import(pathToFileURL(join(out, f + '.mjs')));
  const { getRacingLine } = await I('rl'); const { Track } = await I('track'); const { Vector2 } = await I('vector'); const { Spline } = await I('spline'); const { Presets } = await I('presets');
  const tracks = [['gp', Presets.createGrandPrixTrack(14)]];
  for (const f of process.argv.slice(2)) {
    const data = JSON.parse(await readFile('tracks/' + f, 'utf8'));
    const width = Math.max(5, Math.min(20, Math.round(data.trackWidth)));
    tracks.push([f, new Track(Spline.generateClosedTrack(data.rawPoints.map(p => new Vector2(p.x, p.y)), width, 18, true), width)]);
  }
  for (const [name, t] of tracks) {
    const t0 = performance.now(); const line = getRacingLine(t, 0.6); const ms = performance.now() - t0;
    const n = t.points.length, half = t.width / 2;
    let use = 0, ratioSum = 0, rc = 0;
    for (let i = 0; i < n; i++) { use += Math.abs(line.offsets[i]) / half; const kc = Math.abs(t.points[i].curvature); if (kc > 0.008) { ratioSum += Math.sqrt(kc / Math.max(1e-5, Math.abs(line.curvature[i]))); rc++; } }
    const v = line.speedProfile(1.85 * 0.55, 0.5 * 1.2 * 3.5 * 0.9 / 800, 0.4 * 1.85);
    console.log(name, 'n', n, 'w', t.width, `solve ${ms.toFixed(1)}ms`, 'meanUse', (use / n).toFixed(2), 'cornerSpeedRatio', (ratioSum / rc).toFixed(3), 'vmin', Math.min(...v).toFixed(1));
    if (process.env.DUMP === name) for (let i = 0; i < n; i++) console.log(i, t.points[i].curvature.toFixed(4), line.offsets[i].toFixed(2), line.lower[i].toFixed(2), line.upper[i].toFixed(2), line.curvature[i].toFixed(4), line.cornerDistance[i].toFixed(0), line.cornerSign[i]);
  }
} finally { await rm(out, { recursive: true, force: true }); }
