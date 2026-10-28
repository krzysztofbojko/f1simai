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
      car.stressLap = false; // rolled at random after each lap; the cases below set what they test
      setup(car);
      return passGate(car, track, null);
    };
    const population = new Population(3, track);
    const [own, stress, mistake] = population.cars;
    finishLap(own, () => {});
    assert.equal(own.pace.margin, 1, 'one excursion of its own is no verdict yet');
    finishLap(own, () => {});
    assert.ok(Math.abs(own.pace.margin - (1 - PaceSearch.BACK_OFF)) < 1e-9, 'repeated excursions of its own step the pace back');
    for (let i = 0; i < 2; i++) finishLap(stress, car => { car.stressLap = true; });
    assert.equal(stress.pace.margin, 1, 'stress lap excursions leave the pace alone');
    for (let i = 0; i < 2; i++) finishLap(mistake, car => { car.lapIncident = true; });
    assert.equal(mistake.pace.margin, 1, 'excursions after a scripted mistake leave the pace alone');
    assert.equal(mistake.lapIncident, false, 'the incident flag ends with its lap');
    // Probing compares medians of a few laps, never one lap against the fastest.
    const probe = new PaceSearch();
    for (const t of [100, 104, 102]) probe.finishLap(t, true, false);
    assert.ok(probe.margin > probe.bestMargin, 'a few clean laps at the proven margin start a probe');
    const probed = probe.margin;
    probe.finishLap(99, true, false);
    assert.equal(probe.bestMargin, 1, 'one fast lap proves nothing');
    for (const t of [101, 103]) probe.finishLap(t, true, false);
    assert.equal(probe.bestMargin, probed, 'a probe whose median beats the proven median is kept');
    probe.finishLap(101, true, false);
    assert.ok(probe.probing);
    for (const t of [104, 105, 106]) probe.finishLap(t, true, false);
    assert.equal(probe.margin, probed, 'a slower probe returns to the proven margin');
    probe.finishLap(101, true, false);
    const capped = probe.margin;
    assert.ok(probe.probing);
    probe.finishLap(100, true, true);
    assert.equal(probe.margin, probed, 'an excursion on a probe drives the proven margin again');
    assert.ok(probe.ceiling < capped, 'and caps the search below the failed margin');
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
    assert.deepEqual(kinds, ['mutation-reset', 'pace-reset', 'selection']);
    assert.ok(population.learningStats.supervisorActions.every(a => a.status === 'applied' && a.generation === 70));
    assert.ok(population.cars.every(car => car.pace.margin === 1), 'pace probe restarted');
    assert.ok(population.teamRecords.every(r => r.currentMutationRate === Population.MIN_MUTATION_RATE), 'annealing restarted');
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
    assert.equal(population.learningStats.supervisorActions.length, 3);
  }

  // Suggest mode: actions wait, change nothing, and apply on request.
  {
    const population = stuckField();
    population.supervisor.mode = 'suggest';
    population.supervisor.review(population);
    const log = population.learningStats.supervisorActions;
    assert.equal(log.length, 3);
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

  // The champion is the team with the best rating, not the one lucky lap.
  {
    const population = new Population(3, track);
    const [lucky, steady, fresh] = population.teamRecords;
    lucky.bestLapTime = 90; lucky.recentLaps = [90, 112, 113, 112, 114, 113];
    steady.bestLapTime = 104; steady.recentLaps = [104, 105, 106, 105, 104, 105];
    fresh.bestLapTime = 95; fresh.recentLaps = [95, 96];
    assert.equal(population.championRecord(), steady);
    const rated = population.learningStats.view(population).drivers;
    assert.equal(rated[1].rating, 105);
    assert.equal(rated[2].rating, null, 'too few laps for a rating');
  }

  console.log('supervisor tests passed');
} finally {
  await rm(output, { recursive: true, force: true });
}
