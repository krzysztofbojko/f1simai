// Training supervisor: pace-search attribution, detection, cooldowns, suggest mode and the selection trial.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = await mkdtemp(join(tmpdir(), 'f1-supervisor-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: {
    outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts'),
      timing: resolve('src/physics/LapTiming.ts'), pace: resolve('src/ai/PaceSearch.ts'), random: resolve('src/math/Random.ts') },
      formats: ['es'], fileName: (_, name) => name + '.mjs' },
  } });
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const { passGate } = await import(pathToFileURL(join(output, 'timing.mjs')));
  const { PaceSearch } = await import(pathToFileURL(join(output, 'pace.mjs')));
  const { seedRandom } = await import(pathToFileURL(join(output, 'random.mjs')));
  seedRandom(7);

  const track = Presets.createGrandPrixTrack(14);

  // Pace search: only the network's own excursions count against it.
  {
    const finishLap = (car, setup) => {
      car.currentCheckpointIdx = 0;
      car.checkpointsCleared = track.checkpoints.length;
      car.lapTime = 100;
      car.lapExcursion = true;
      car.lapCompromised = true;
      car.lapContact = false;
      setup(car);
      return passGate(car, track, null);
    };
    const population = new Population(3, track);
    const [own, stress, mistake] = population.cars;
    finishLap(own, () => {});
    assert.ok(Math.abs(own.pace.margin - 0.94) < 1e-9, 'an excursion of its own steps the pace back');
    finishLap(stress, car => { car.stressLap = true; });
    assert.equal(stress.pace.margin, 1, 'a stress lap excursion leaves the pace alone');
    finishLap(mistake, car => { car.lapIncident = true; });
    assert.equal(mistake.pace.margin, 1, 'an excursion after a scripted mistake leaves the pace alone');
    assert.equal(mistake.lapIncident, false, 'the incident flag ends with its lap');
    const probe = new PaceSearch();
    probe.finishLap(100, true, false);
    const afterBest = probe.margin;
    probe.finishLap(102.5, true, false);
    assert.ok(probe.margin > afterBest, 'a lap slower only by fuel-load noise keeps probing');
    probe.finishLap(104, true, false);
    assert.equal(probe.margin, probe.bestMargin, 'a clearly slower lap returns to the proven margin');
    own.pace.resetProbe();
    assert.deepEqual([own.pace.margin, own.pace.bestMargin, own.pace.ceiling], [1, 1, PaceSearch.MAX]);
  }

  const gen = (generation, o = {}) => ({ generation, simSeconds: 120, wallSeconds: 1, bestLap: 110, medianLap: 120, sessionBest: 98.7,
    cleanLaps: 13, yellowLaps: 0, compromisedLaps: 2, personalBests: 0, reverts: 10, trialsStarted: 1, trialsWon: 0, trialsLost: 1,
    crashes: { barrier: 1, car: 0, stuck: 0, 'wrong-way': 0, other: 0 }, interventionRate: 0.1,
    causes: { steer: 0, guard: 0, brake: 0, launch: 0, clearance: 0 }, onlineTrainSteps: 400, islandAdoptions: 0,
    diversity: 0.02, meanMutationRate: Population.MAX_SHAKE_RATE, hiddenSaturation: 0.1, meanPaceMargin: 0.91, paceAtFloor: 1, drivers: [], ...o });
  /** A field stuck like the session in log1.png: pace at the floor, mutation at the ceiling, no personal best for 70 generations. */
  const stuckField = () => {
    const population = new Population(6, track);
    const history = Array.from({ length: 70 }, (_, i) => gen(i + 1, i === 0 ? { personalBests: 6 } : {}));
    population.learningStats.fullHistory = history;
    population.learningStats.history = history;
    population.generation = 71;
    population.globalBestLap = 98.7;
    population.teamRecords.forEach((record, i) => {
      record.bestLapTime = 98.7 + i;
      record.recentLaps = Array.from({ length: 20 }, (_, k) => 110 + i + k * 0.1);
      record.currentMutationRate = Population.MAX_SHAKE_RATE;
    });
    for (const car of population.cars) { car.pace.margin = 0.9; car.pace.bestMargin = 0.9; }
    return population;
  };

  // Auto mode: every symptom gets its action, once per cooldown.
  {
    const population = stuckField();
    const before = population.cars.map(car => car.brain);
    population.supervisor.review(population);
    const kinds = population.learningStats.supervisorActions.map(a => a.kind).sort();
    assert.deepEqual(kinds, ['mutation-reset', 'pace-reset', 'reference-refresh', 'selection']);
    assert.ok(population.learningStats.supervisorActions.every(a => a.status === 'applied' && a.generation === 70));
    assert.ok(population.cars.every(car => car.pace.margin === 1), 'pace probe restarted');
    assert.ok(population.teamRecords.every(r => r.currentMutationRate === Population.MIN_MUTATION_RATE), 'annealing restarted');
    population.teamRecords.forEach((record, i) => {
      assert.equal(record.bestLapTime, 98.7 + i, 'the record itself stays');
      assert.ok(Math.abs(record.referenceLapTime - (110.4 + i)) < 1e-9, 'reference = 20th percentile of the recent laps');
    });
    const champion = population.championRecord();
    const championIndex = population.teamRecords.indexOf(champion);
    const trials = population.cars.map((car, i) => car.explorationTrial ? i : -1).filter(i => i >= 0);
    assert.deepEqual(trials, [3, 4, 5], 'the three slowest teams try a crossover');
    assert.ok(!trials.includes(championIndex) && population.cars[championIndex].brain === before[championIndex], 'the champion is never touched');
    for (const i of trials) assert.notEqual(population.cars[i].brain, before[i]);
    assert.ok(population.cars[3].safeBrainBackup, 'a failed trial goes back to the record brain');

    // Cooldown: the same history one generation later does nothing new.
    population.learningStats.fullHistory.push(gen(71));
    population.supervisor.review(population);
    assert.equal(population.learningStats.supervisorActions.length, 4);
  }

  // Suggest mode: actions wait, change nothing, and apply on request.
  {
    const population = stuckField();
    population.supervisor.mode = 'suggest';
    population.supervisor.review(population);
    const log = population.learningStats.supervisorActions;
    assert.equal(log.length, 4);
    assert.ok(log.every(a => a.status === 'pending'));
    assert.ok(population.cars.every(car => car.pace.margin === 0.9), 'nothing changes before the user applies it');
    const pace = log.find(a => a.kind === 'pace-reset');
    assert.equal(population.supervisor.apply(population, pace.id), true);
    assert.equal(pace.status, 'applied');
    assert.ok(population.cars.every(car => car.pace.margin === 1));
    assert.equal(population.supervisor.apply(population, pace.id), false, 'an applied action does not run twice');
  }

  // A healthy session: no action.
  {
    const population = new Population(6, track);
    const history = Array.from({ length: 70 }, (_, i) => gen(i + 1, { personalBests: 2, trialsWon: 1, meanMutationRate: 0.05,
      paceAtFloor: 0, meanPaceMargin: 1.05, sessionBest: 100 - i * 0.01 }));
    population.learningStats.fullHistory = history;
    population.learningStats.history = history;
    population.supervisor.review(population);
    assert.equal(population.learningStats.supervisorActions.length, 0);
  }

  // Team reference in lap judging: a lap faster than the refreshed reference is a personal best
  // and the new reference, while the shown record stays the faster time.
  {
    const population = new Population(2, track);
    const car = population.cars[0], record = population.teamRecords[0];
    record.bestLapTime = 98;
    record.referenceLapTime = 110;
    const event = lapTime => ({ lapTime, trajectory: [], maxSpeed: 250, avgSpeed: 200, fuelRemaining: 50, fuelUsed: 1.5, compromised: false, yellow: false, pressure: 0 });
    population.recordLap(event(109), car);
    assert.equal(record.bestLapTime, 98);
    assert.equal(record.referenceLapTime, 109);
    assert.equal(population.learningStats.fullHistory.length, 0);
    population.recordLap(event(97), car);
    assert.equal(record.bestLapTime, 97);
    assert.equal(record.referenceLapTime, null, 'a real record is the reference again');
    assert.deepEqual(record.recentLaps, [109, 97]);
  }

  console.log('supervisor tests passed');
} finally {
  await rm(output, { recursive: true, force: true });
}
