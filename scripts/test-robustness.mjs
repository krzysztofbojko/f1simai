// Anti-overfitting: stress laps (domain randomisation), stagnation-breaking trials, capped migration.
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const output = await mkdtemp(join(tmpdir(), 'f1-robustness-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { islands: resolve('src/ai/Islands.ts'), population: resolve('src/ai/Population.ts'), car: resolve('src/physics/Car.ts'), presets: resolve('src/track/Presets.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { exportDriver, mergeBetterDrivers, migrationLimit } = await import(pathToFileURL(join(output, 'islands.mjs')));
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Car, clampStressShare } = await import(pathToFileURL(join(output, 'car.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  let seed = 321;
  Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
  const track = Presets.createGrandPrixTrack(14);

  // 1. Stress laps: training only, harder randomised conditions, never a record lap.
  const car = new Population(1, track).cars[0];
  Car.config.stressLapShare = 1;
  for (let i = 0; i < 50; i++) {
    car.lapCompromised = false;
    car.rollLapPerformanceVariation();
    assert.equal(car.stressLap, true);
    assert.equal(car.lapCompromised, true, 'a stress lap cannot set a record');
    assert.ok(car.lapGripFactor >= 0.92 && car.lapGripFactor <= 1.03);
    assert.ok(car.lapPowerFactor >= 0.96 && car.lapPowerFactor <= 1.04);
  }
  car.updateSensors(track);
  const noisy = car.planDrive(track).inputs.slice(0, car.rayDistances.length);
  assert.notDeepEqual(noisy, car.rayDistances, 'the network sees noisy LiDAR');
  assert.ok(noisy.every(v => v >= 0 && v <= 1));
  car.isRaceMode = true;
  car.rollLapPerformanceVariation();
  assert.equal(car.stressLap, false, 'qualifying and races always run in nominal conditions');
  assert.deepEqual(car.planDrive(track).inputs.slice(0, car.rayDistances.length), car.rayDistances);
  car.isRaceMode = false;
  Car.config.stressLapShare = 0;
  car.lapCompromised = false;
  for (let i = 0; i < 50; i++) { car.rollLapPerformanceVariation(); assert.equal(car.stressLap, false); }
  assert.equal(car.lapCompromised, false);
  assert.equal(clampStressShare(2), 0.6);
  assert.equal(clampStressShare('x'), 0.25);

  // 2. Stagnation breaker: a trial never worsens the record; a faster trial is kept.
  const pop = new Population(2, track);
  const driver = pop.cars[0], record = pop.teamRecords[0];
  const lap = (lapTime, compromised = false) => pop.recordLap({ compromised, pressure: 0, lapTime, trajectory: [], maxSpeed: 300, avgSpeed: 200, fuelRemaining: 50 }, driver, false, track);
  lap(80);
  const proven = record.bestBrain.toJSON();
  for (let i = 0; i < Population.STAGNATION_LAPS - 1; i++) lap(81);
  assert.equal(driver.explorationTrial, false);
  lap(81);
  assert.equal(driver.explorationTrial, true, 'stagnation starts a trial');
  assert.notEqual(driver.brain.toJSON(), proven, 'the trial drives a mutated brain');
  assert.equal(driver.safeBrainBackup.toJSON(), proven, 'race rescue restores the proven brain');
  assert.equal(record.bestBrain.toJSON(), proven);
  const firstRate = record.currentMutationRate;
  lap(82, true);
  assert.equal(driver.explorationTrial, true, 'a compromised lap does not judge the trial');
  lap(80.5);
  assert.equal(driver.explorationTrial, false);
  assert.equal(driver.brain.toJSON(), proven, 'a slower trial is discarded');
  assert.equal(record.bestLapTime, 80);
  for (let i = 0; i < Population.STAGNATION_LAPS; i++) lap(81);
  assert.equal(driver.explorationTrial, true);
  assert.ok(record.currentMutationRate > firstRate && record.currentMutationRate <= Population.MAX_SHAKE_RATE, 'repeated stagnation explores further');
  const trial = driver.brain.toJSON();
  lap(79);
  assert.equal(driver.explorationTrial, false);
  assert.equal(record.bestLapTime, 79);
  assert.equal(record.bestBrain.toJSON(), trial, 'a faster trial becomes the record brain');
  pop.isRaceMode = true;
  for (let i = 0; i < Population.STAGNATION_LAPS * 2; i++) lap(81);
  assert.equal(driver.explorationTrial, false, 'no trials in a race');
  pop.isRaceMode = false;

  // 3. One migration round replaces at most a quarter of the field, largest gains first.
  const main = new Population(Population.MAX_CARS, track);
  const island = new Population(Population.MAX_CARS, track);
  main.teamRecords.forEach(r => { r.bestLapTime = 90; });
  island.teamRecords.forEach((r, i) => { r.bestLapTime = 89 - i * 0.1; r.bestBrain = island.cars[i].brain.clone(); });
  const drivers = island.cars.map((_, i) => exportDriver(island, i));
  const limit = migrationLimit(main);
  assert.equal(limit, 5);
  assert.equal(mergeBetterDrivers(main, drivers), limit);
  const changed = main.teamRecords.map((r, i) => r.bestLapTime < 90 ? i : -1).filter(i => i >= 0);
  assert.deepEqual(changed, [15, 16, 17, 18, 19], 'largest improvements go first');
  assert.equal(mergeBetterDrivers(main, drivers, Infinity), 15, 'island seeding is not capped');
  console.log('Robustness regressions passed (stress laps, stagnation trials, capped migration).');
} finally {
  await rm(output, { recursive: true, force: true });
}
