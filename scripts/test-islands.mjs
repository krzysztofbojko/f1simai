// Training islands: track transfer between workers and model migration rules.
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const output = await mkdtemp(join(tmpdir(), 'f1-islands-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { islands: resolve('src/ai/Islands.ts'), population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts'), vector: resolve('src/math/Vector2.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { serializeTrack, deserializeTrack, exportDriver, applyDriverModel, mergeBetterDrivers } = await import(pathToFileURL(join(output, 'islands.mjs')));
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const { Vector2 } = await import(pathToFileURL(join(output, 'vector.mjs')));
  let seed = 145;
  Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };

  // 1. A track rebuilt in another worker answers every query identically.
  const track = Presets.createGrandPrixTrack(14);
  const copy = deserializeTrack(JSON.parse(JSON.stringify(serializeTrack(track))));
  for (let i = 0; i < 500; i++) {
    const p = track.points[i % track.points.length].center, pos = new Vector2(p.x + (Math.random() - 0.5) * 60, p.y + (Math.random() - 0.5) * 60);
    assert.deepEqual(copy.sampleSurface(pos), track.sampleSurface(pos));
    const angle = Math.random() * Math.PI * 2;
    assert.equal(copy.castRay(pos, angle, 240).dist, track.castRay(pos, angle, 240).dist);
  }

  // 1b. A new field (new track, clean slate, island) starts with the session's settings, not the defaults.
  const configured = Population.create(copy, { rayCount: 25, topology: 'Standard', driverPressure: 5, mutationRate: 0.17, startingFuelKg: 64 });
  assert.equal(configured.cars.length, Population.MAX_CARS);
  assert.equal(configured.mutationRate, 0.17, 'mutation rate carried over to the new field');
  assert.equal(configured.startingFuelKg, 64);
  assert.ok(configured.cars.every(car => car.fuelKg === 64 && car.driverPressure === 5), 'cars start with the configured fuel and pressure');
  assert.ok(configured.teamRecords.every(record => record.currentMutationRate === 0.17));

  // 2. Migration takes only strictly faster clean laps with matching pressure and inputs.
  const main = new Population(Population.MAX_CARS, track);
  const island = new Population(Population.MAX_CARS, copy);
  const faster = 70, slower = 90;
  island.teamRecords[0].bestLapTime = faster; island.teamRecords[0].bestBrain = island.cars[0].brain.clone();
  island.teamRecords[1].bestLapTime = slower; island.teamRecords[1].bestBrain = island.cars[1].brain.clone();
  main.teamRecords[1].bestLapTime = 80;
  island.teamRecords[2].bestLapTime = faster; island.teamRecords[2].bestBrain = island.cars[2].brain.clone(); island.teamRecords[2].bestLapPressure = 5;
  island.teamRecords[3].bestLapTime = faster; island.teamRecords[3].bestBrain = island.cars[3].brain.clone();
  const drivers = island.cars.map((_, i) => exportDriver(island, i));
  drivers[3].bestBrain.layerSizes = [...drivers[3].bestBrain.layerSizes]; drivers[3].bestBrain.layerSizes[0] += 1;
  const ers = main.cars[0].ersEnergy = 1234;
  const adopted = mergeBetterDrivers(main, drivers);
  assert.equal(adopted, 1, 'only driver 0 qualifies');
  assert.equal(main.teamRecords[0].bestLapTime, faster);
  assert.equal(main.cars[0].brain.toJSON(), island.teamRecords[0].bestBrain.toJSON(), 'the proven network drives');
  assert.equal(main.teamRecords[0].bestBrain.toJSON(), island.teamRecords[0].bestBrain.toJSON());
  assert.equal(main.cars[0].lapCompromised, true, 'the mixed lap cannot evaluate a model');
  assert.equal(main.cars[0].ersEnergy, ers, 'a live car keeps its physical state');
  assert.equal(main.teamRecords[1].bestLapTime, 80, 'a slower island lap never replaces a record');
  assert.equal(main.teamRecords[2].bestLapTime, null, 'another driver pressure is not comparable');
  assert.equal(main.teamRecords[3].bestLapTime, null, 'incompatible network inputs are refused');
  assert.equal(main.globalBestLap, faster);
  assert.equal(mergeBetterDrivers(main, drivers), 0, 'an equal time is not an improvement');

  // 3. File loading (not live) still restores the full driver state.
  const restored = new Population(Population.MAX_CARS, track);
  applyDriverModel(restored.cars[0], restored.teamRecords[0], exportDriver(main, 0));
  assert.equal(restored.cars[0].ersEnergy, Math.round(ers));
  assert.equal(restored.teamRecords[0].bestLapTime, faster);

  // 4. Both fields keep training after migration in both directions.
  for (let step = 0; step < 600; step++) { main.update(1 / 60, track); island.update(1 / 60, copy); }
  mergeBetterDrivers(island, main.cars.map((_, i) => exportDriver(main, i)));
  for (let step = 0; step < 600; step++) island.update(1 / 60, copy);
  assert.ok(island.cars.every(car => Number.isFinite(car.pos.x) && Number.isFinite(car.speed)));
  console.log('Island regressions passed (track transfer, faster-lap migration, pressure/input guards, live state, continued training).');
} finally {
  await rm(output, { recursive: true, force: true });
}
