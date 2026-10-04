import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = await mkdtemp(join(tmpdir(), 'f1-learning-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: {
    outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts') },
      formats: ['es'], fileName: (_, name) => name + '.mjs' },
  } });
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const track = Presets.createGrandPrixTrack(14);
  const idle = { throttle: 0, brake: 0, steer: 0 };
  const parameters = brain => JSON.stringify({ sizes: brain.layerSizes,
    layers: brain.layers.map(layer => ({ weights: layer.weights, biases: layer.biases })) });
  function fixture() {
    const population = new Population(1, track);
    population.autoEvolutionEnabled = false;
    const car = population.cars[0];
    car.brain.layers[0].weights[0][0] = 7;
    const event = { lapTime: 60, trajectory: [], maxSpeed: 300, avgSpeed: 180, fuelRemaining: 100 };
    population.recordLap(event, car, false, track);
    return { population, car, record: population.teamRecords[0], event, saved: parameters(car.brain) };
  }
  function noPhysics(car) {
    car.updateSensors = () => {};
    car.getAIControl = () => idle;
    car.updatePhysics = () => null;
  }

  // A growing cumulative fitness cannot replace the model belonging to a PB.
  {
    const { population, car, record, saved } = fixture();
    noPhysics(car); car.fitness = 10000; car.framesSinceLastCheckpoint = 0;
    car.brain.layers[0].weights[0][0] = 12345;
    population.update(1 / 60, track);
    assert.equal(parameters(record.bestBrain), saved, 'checkpoint fitness overwrote the lap champion');
  }
  // Crashing with a higher peak restores the PB instead of saving the failed trial.
  {
    const { population, car, record, saved } = fixture();
    car.brain.layers[0].weights[0][0] = 12345;
    car.peakFitness = 20000; car.isAlive = false; car.respawnTimer = 0;
    car.replayBuffer = [{ inputs: [], targets: [0, 0, 0], reward: 1 }]; car.replayStepTimer = 89;
    population.update(1 / 60, track);
    assert.equal(parameters(record.bestBrain), saved);
    assert.equal(parameters(car.brain), saved, 'respawn restored a failed trial');
    assert.equal(car.replayBuffer.length, 0); assert.equal(car.replayStepTimer, 0);
  }
  // Automatic generation completion preserves the actual moving car and its lap.
  {
    const { population, car, record, saved } = fixture();
    noPhysics(car); population.autoEvolutionEnabled = true;
    population.generationTimer = 100; population.generationMaxLaps = 2;
    population.carGenerationLaps[0] = 2; population.isGracePeriodActive = true;
    population.graceTimer = population.graceMaxTime;
    car.pos.set(450, 200); car.vel.set(20, 3); car.lapTime = 12.34;
    car.currentLap = 7; car.fuelKg = 49; car.currentCheckpointIdx = 42;
    car.fitness = 30000; car.brain.layers[0].weights[0][0] = 12345;
    const active = parameters(car.brain);
    car.replayBuffer = [{ inputs: [], targets: [0, 0, 0], reward: 1 }];
    population.update(1 / 60, track);
    assert.equal(population.generation, 2);
    assert.equal(population.cars[0], car, 'automatic generation teleported a proven driver');
    assert.deepEqual([car.pos.x, car.pos.y, car.vel.x, car.vel.y, car.lapTime, car.currentLap, car.fuelKg], [450, 200, 20, 3, 12.34, 7, 49]);
    assert.equal(parameters(car.brain), active); assert.equal(parameters(record.bestBrain), saved);
    assert.equal(car.replayBuffer.length, 1);
    assert.equal(population.lastCarCheckpointIdx[0], 42);
    // The explicit New Generation action still restarts the run from the PB.
    car.peakFitness = 40000;
    population.evolve(track);
    assert.notEqual(population.cars[0], car);
    assert.equal(parameters(population.cars[0].brain), saved);
    assert.equal(parameters(record.bestBrain), saved);
  }
  // Performance rollback must discard samples from the failed trial.
  {
    const { population, car, record, event, saved } = fixture();
    car.brain.layers[0].weights[0][0] = 12345;
    car.replayBuffer = [{ inputs: [], targets: [0, 0, 0], reward: 1 }]; car.replayStepTimer = 89;
    population.recordLap({ ...event, lapTime: 65 }, car, false, track);
    assert.equal(parameters(car.brain), saved); assert.equal(parameters(car.safeBrainBackup), saved);
    assert.equal(car.replayBuffer.length, 0); assert.equal(car.replayStepTimer, 0);
    // A genuine improvement is still allowed to replace the PB model.
    car.brain.layers[0].weights[0][0] = 8;
    const improved = parameters(car.brain);
    population.recordLap({ ...event, lapTime: 59 }, car, false, track);
    assert.equal(record.bestLapTime, 59); assert.equal(parameters(record.bestBrain), improved);
  }
  // Sparse/dense trajectory samples must not shift coaching into another corner.
  {
    const population = new Population(1, track);
    const trajectory = track.checkpoints.flatMap((checkpoint, i) => [
      { x: checkpoint.center.x + 10000, y: checkpoint.center.y + 10000, speed: 999, throttle: 1, brake: 0 },
      { x: checkpoint.center.x, y: checkpoint.center.y, speed: 50 + i, throttle: 1, brake: 0 },
    ]);
    population.recordLap({ lapTime: 60, trajectory, maxSpeed: 300, avgSpeed: 180, fuelRemaining: 100 }, population.cars[0], false, track);
    assert.deepEqual(population.leaderCheckpointSpeeds, track.checkpoints.map((_, i) => 50 + i));
  }
  // Exercise several real training cycles, including physics and online learning.
  {
    let seed = 34567;
    Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
    const population = new Population(10, track);
    let automaticTransitions = 0, preservedDrivers = 0;
    for (let step = 0; step < 24000; step++) {
      const previousGeneration = population.generation;
      const previousCars = [...population.cars];
      const proven = population.teamRecords.map(record => record.bestLapTime !== null);
      population.update(1 / 60, track);
      if (population.generation !== previousGeneration) {
        automaticTransitions++;
        for (let i = 0; i < previousCars.length; i++) {
          if (proven[i] && previousCars[i].isAlive) {
            assert.equal(population.cars[i], previousCars[i], 'a real automatic cycle restarted a proven car');
            preservedDrivers++;
          }
        }
      }
    }
    assert.ok(automaticTransitions >= 2 && preservedDrivers > 0);
    assert.ok(population.teamRecords.some(record => record.lapsCount >= 3));
    console.log(`400 simulated seconds: ${automaticTransitions} automatic cycles, ${preservedDrivers} proven drivers preserved, ${population.teamRecords.reduce((sum, record) => sum + record.lapsCount, 0)} completed laps.`);
  }
  console.log('Learning regressions passed (PB protection, crash recovery, continuous generations, rollback, coaching).');
} finally { await rm(output, { recursive: true, force: true }); }
