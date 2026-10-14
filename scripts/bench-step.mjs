// Step throughput benchmark: train the full field headless, report µs per step and a state hash.
// The hash must not change after a pure performance refactor.
// node scripts/bench-step.mjs [seconds=120] [seeds=145,456,789]
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
const output = await mkdtemp(join(tmpdir(), 'f1-step-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const seconds = Number(process.argv[2] ?? 120);
  const seeds = (process.argv[3] ?? '145,456,789').split(',').map(Number);
  const seeded = seed => () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  let total = 0, steps = 0;
  for (const seed of seeds) {
    Math.random = seeded(seed);
    const track = Presets.createGrandPrixTrack(14);
    const pop = new Population(Population.MAX_CARS, track);
    const hash = createHash('sha256');
    const start = performance.now();
    for (let step = 0; step < seconds * 60; step++) pop.update(1 / 60, track);
    const ms = performance.now() - start;
    total += ms; steps += seconds * 60;
    for (const car of pop.cars) hash.update(`${car.pos.x},${car.pos.y},${car.heading},${car.speed},${car.bestLapTime},${car.fitness},${car.currentCheckpointIdx};`);
    console.log(`seed ${seed}: ${(ms / (seconds * 60) * 1000).toFixed(0)} µs/step, ${(seconds * 1000 / ms).toFixed(1)}x real time, state ${hash.digest('hex').slice(0, 16)}`);
  }
  console.log(`mean: ${(total / steps * 1000).toFixed(0)} µs/step, ${(steps / 60 * 1000 / total).toFixed(1)}x real time`);
} finally {
  await rm(output, { recursive: true, force: true });
}
