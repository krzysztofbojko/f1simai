// Learning benchmark: train the full field headless and report how fast and how wide the cars drive.
// node scripts/bench-laptime.mjs [seconds=600] [seeds=145,456,789] [track=gp|oval]
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-bench-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const seconds = Number(process.argv[2] ?? 600);
  const seeds = (process.argv[3] ?? '145,456,789').split(',').map(Number);
  const trackName = process.argv[4] ?? 'gp';
  const seeded = seed => () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const results = [];
  for (const seed of seeds) {
    Math.random = seeded(seed);
    const track = trackName === 'oval' ? Presets.createOvalTrack(14) : Presets.createGrandPrixTrack(14);
    const pop = new Population(Population.MAX_CARS, track);
    // Typical pace late in training: clean laps of the last 20 %, median per car, then across cars.
    const late = new Map();
    let step = 0;
    pop.onLapCompleted = (car, event) => {
      if (event.compromised || step < seconds * 60 * 0.8) return;
      if (!late.has(car.color)) late.set(car.color, []);
      late.get(car.color).push(event.lapTime);
    };
    const half = track.width / 2;
    let offRoad = 0, frames = 0;
    const lateral = [];
    const curve = [];
    for (step = 0; step < seconds * 60; step++) {
      pop.update(1 / 60, track);
      if (step % 10 !== 0) continue;
      for (const car of pop.cars) {
        if (!car.isAlive) continue;
        frames++;
        if (car.surface !== 'asphalt') { offRoad++; continue; }
        const sample = track.sampleSurface(car.pos);
        const usage = Math.abs(sample.lateral) / half;
        lateral.push(usage);
        if (Math.abs(track.points[sample.index].curvature) > 0.004) curve.push(car.speedKmh);
      }
    }
    const bests = pop.teamRecords.map(r => r.bestLapTime).filter(t => t);
    const sorted = [...lateral].sort((a, b) => a - b);
    results.push({
      seed,
      best: +Math.min(...bests).toFixed(2),
      medianBest: +median(bests).toFixed(2),
      timed: bests.length,
      lateMedian: +median([...late.values()].map(median)).toFixed(2),
      laps: pop.teamRecords.reduce((sum, r) => sum + r.lapsCount, 0),
      widthP90: +(sorted[Math.floor(sorted.length * 0.9)] ?? 0).toFixed(2),
      widthMean: +(lateral.reduce((a, b) => a + b, 0) / Math.max(1, lateral.length)).toFixed(2),
      cornerKmh: Math.round(curve.reduce((a, b) => a + b, 0) / Math.max(1, curve.length)),
      offRoadPct: +(100 * offRoad / Math.max(1, frames)).toFixed(2),
    });
    console.log(JSON.stringify(results[results.length - 1]));
  }
  const avg = key => +(results.reduce((s, r) => s + r[key], 0) / results.length).toFixed(2);
  console.log('MEAN', JSON.stringify({ track: trackName, seconds, best: avg('best'), medianBest: avg('medianBest'), lateMedian: avg('lateMedian'), laps: avg('laps'), widthP90: avg('widthP90'), cornerKmh: avg('cornerKmh'), offRoadPct: avg('offRoadPct') }));
} finally { await rm(output, { recursive: true, force: true }); }
