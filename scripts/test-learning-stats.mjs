// Learning diagnostics: pure helpers, verdicts, and the bookkeeping of a short headless training run.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = await mkdtemp(join(tmpdir(), 'f1-learning-stats-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: {
    outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { population: resolve('src/ai/Population.ts'), stats: resolve('src/ai/LearningStats.ts'),
      network: resolve('src/ai/NeuralNetwork.ts'), presets: resolve('src/track/Presets.ts'),
      insights: resolve('src/ai/LearningInsights.ts'), log: resolve('src/ai/LearningLog.ts') },
      formats: ['es'], fileName: (_, name) => name + '.mjs' },
  } });
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const stats = await import(pathToFileURL(join(output, 'stats.mjs')));
  const { NeuralNetwork } = await import(pathToFileURL(join(output, 'network.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const { insights, fitLine } = await import(pathToFileURL(join(output, 'insights.mjs')));
  const { learningLog, stringifyLearningLog } = await import(pathToFileURL(join(output, 'log.mjs')));

  // Pure helpers.
  assert.equal(stats.median([]), null);
  assert.equal(stats.median([3, 1, 2]), 2);
  assert.equal(stats.median([4, 1, 3, 2]), 2.5);
  assert.equal(stats.linearTrend([{ x: 1, y: 5 }]), null);
  assert.ok(Math.abs(stats.linearTrend([{ x: 1, y: 10 }, { x: 2, y: 9.5 }, { x: 3, y: 9 }]) + 0.5) < 1e-12);
  {
    const a = new NeuralNetwork([4, 3, 2]);
    const b = a.clone();
    assert.equal(stats.weightDistance(a, b), 0);
    b.layers[0].weights[0][0] += 1;
    const sizes = a.layerSizes;
    let count = 0;
    for (let l = 0; l + 1 < sizes.length; l++) count += sizes[l] * sizes[l + 1] + sizes[l + 1];
    assert.ok(Math.abs(stats.weightDistance(a, b) - Math.sqrt(1 / count)) < 1e-12);
    assert.equal(stats.weightDistance(a, new NeuralNetwork([4, 5, 2])), null);
    const layers = stats.layerStats(a);
    assert.deepEqual(layers.map(l => [l.inputs, l.outputs]), a.layerSizes.slice(0, -1).map((n, i) => [n, a.layerSizes[i + 1]]));
  }

  // Verdicts: warm-up, learning, plateau, collapse.
  {
    const gen = (generation, bestLap, medianLap, sessionBest, extra = {}) => ({ generation, bestLap, medianLap, sessionBest,
      interventionRate: 0.2, diversity: 0.05, trialsWon: 0, trialsLost: 0, ...extra });
    const trendOf = history => ({ bestSlope: stats.linearTrend(history.map(g => ({ x: g.generation, y: g.bestLap }))),
      medianSlope: stats.linearTrend(history.map(g => ({ x: g.generation, y: g.medianLap }))), interventionSlope: 0, gensSinceRecord: 0, trialSuccess: null, trials: 0 });
    assert.equal(stats.verdicts([gen(1, 90, 95, 90)], trendOf([gen(1, 90, 95, 90)]))[0].title, 'Rozgrzewka');
    const learning = [gen(1, 90, 95, 90), gen(2, 89, 94, 89), gen(3, 88, 93, 88)];
    assert.equal(stats.verdicts(learning, trendOf(learning))[0].level, 'good');
    const flat = Array.from({ length: 12 }, (_, i) => gen(i + 1, 88, 93, 88));
    assert.equal(stats.verdicts(flat, { ...trendOf(flat), gensSinceRecord: 11 })[0].title, 'Plateau');
    const improvingButStale = [...flat.slice(0, -2), gen(11, 88, 92, 88), gen(12, 88, 90, 88)];
    assert.equal(stats.verdicts(improvingButStale, { ...trendOf(improvingButStale), gensSinceRecord: 11 })[0].title, 'Plateau', 'a long wait for a record is a plateau, whatever the median does');
    assert.ok(!stats.verdicts(learning, { ...trendOf(learning), trialSuccess: 0, trials: 3 }).some(v => v.title === 'Eksploracja bez efektu'), 'too few trials to judge');
    assert.ok(stats.verdicts(learning, { ...trendOf(learning), trialSuccess: 0, trials: 12 }).some(v => v.title === 'Eksploracja bez efektu'));
    const collapsed = [...flat.slice(0, -1), gen(12, 88, 93, 88, { diversity: 0 })];
    assert.ok(stats.verdicts(collapsed, { ...trendOf(collapsed), gensSinceRecord: 11 }).some(v => v.title === 'Zapaść różnorodności'));
  }

  // Generations since the record count closed generations back to the last improvement.
  {
    const s = new stats.LearningStats();
    s.history = [{ sessionBest: 90 }, { sessionBest: 88 }, { sessionBest: 88 }, { sessionBest: 88 }].map((g, i) => ({ generation: i + 1, ...g }));
    assert.equal(s.trend({ globalBestLap: 88 }).gensSinceRecord, 2);
    assert.equal(s.trend({ globalBestLap: 87 }).gensSinceRecord, 0, 'a record in the running generation resets the plateau');
    // The charted history is thinned to 400 entries; the count still reaches back over the whole session.
    s.fullHistory = Array.from({ length: 1078 }, (_, i) => ({ generation: i + 1, sessionBest: i === 0 ? 124 : 118.16 }));
    s.history = s.fullHistory.slice(-376);
    assert.equal(s.trend({ globalBestLap: 118.16 }).gensSinceRecord, 1076);
  }

  // Insights: each detector on a synthetic history, and silence on healthy, noisy learning.
  {
    const full = (generation, o = {}) => ({ generation, simSeconds: 120, wallSeconds: 10, bestLap: 85, medianLap: 88, sessionBest: 85,
      cleanLaps: 20, yellowLaps: 0, compromisedLaps: 2, personalBests: 2, reverts: 0, trialsStarted: 1, trialsWon: 1, trialsLost: 0,
      crashes: { barrier: 1, car: 0, stuck: 0, 'wrong-way': 0, other: 0 }, interventionRate: 0.15,
      causes: { steer: 0.05, guard: 0.04, brake: 0.03, launch: 0.01, clearance: 0.02 }, onlineTrainSteps: 50, islandAdoptions: 0,
      diversity: 0.05, meanMutationRate: 0.06 + 0.01 * Math.sin(generation), hiddenSaturation: 0.2, ...o });
    const series = (n, f = () => ({})) => {
      const history = Array.from({ length: n }, (_, i) => full(i + 1, f(i + 1)));
      let record = Infinity;
      for (const g of history) { if (g.bestLap !== null) record = Math.min(record, g.bestLap); g.sessionBest = record; }
      return history;
    };
    const gensSinceRecord = history => {
      let n = 0;
      for (let i = history.length - 1; i > 0 && !(history[i].sessionBest < history[i - 1].sessionBest - 1e-6); i--) n++;
      return n;
    };
    const run = (history, o = {}) => insights(history, { sessionBest: history[history.length - 1].sessionBest,
      trend: { bestSlope: null, medianSlope: null, interventionSlope: null, gensSinceRecord: gensSinceRecord(history), trialSuccess: 0.3, trials: 20 },
      islandCount: 0, mutationFloor: 0.025, mutationCeiling: 0.12, ...o });
    const find = (list, title) => list.find(i => i.title === title);
    const serious = list => list.filter(i => i.level === 'bad' || i.level === 'warn').map(i => i.title);

    assert.ok(Math.abs(fitLine([{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }]).slope - 2) < 1e-12);
    assert.equal(run(series(5))[0].title, 'Za mało danych');

    const healthy = series(40, g => ({ medianLap: 95 - 0.2 * g + 0.5 * Math.sin(g * 2.3), bestLap: 92 - 0.2 * g + 0.4 * Math.cos(g * 1.7),
      interventionRate: 0.3 - 0.005 * g, crashes: { barrier: 1 + (g % 3), car: 0, stuck: 0, 'wrong-way': 0, other: 0 } }));
    assert.deepEqual(serious(run(healthy)), [], 'healthy, noisy learning raises no warnings');
    assert.ok(find(run(healthy), 'Zdrowa nauka'));

    const plateau = series(40, g => ({ medianLap: 88 + 0.6 * Math.sin(g * 2.3), bestLap: g === 1 ? 85 : 85.6 + 0.4 * Math.cos(g * 1.7) }));
    assert.ok(find(run(plateau), 'Postęp w szumie'), 'a flat, noisy median is noise');
    assert.ok(!find(run(plateau), 'Czasy idą w złą stronę'));
    assert.ok(!find(run(plateau), 'Nauka utknęła'), 'stuck needs a second symptom');
    const stuck = plateau.map(g => ({ ...g, diversity: 0.005 }));
    assert.equal(find(run(stuck), 'Nauka utknęła')?.since, 2);

    const worse = series(40, g => g <= 10 ? { bestLap: 95 - g, medianLap: 98 - g } : { bestLap: 85.5 + 0.2 * (g - 10), medianLap: 88 + 0.3 * (g - 10) + 0.2 * Math.sin(g) });
    const worseNotes = run(worse);
    assert.equal(find(worseNotes, 'Czasy idą w złą stronę')?.since, 11);
    assert.equal(worseNotes[0].level, 'bad', 'the most serious note comes first');

    const strayed = series(40, g => g <= 15 ? { bestLap: 85, medianLap: 88 } : { bestLap: 89 + 0.1 * Math.sin(g), medianLap: 92 });
    assert.equal(find(run(strayed), 'Model zbłądził')?.since, 16);
    const outlier = series(40, g => ({ bestLap: g === 1 ? 52 : 56 + Math.sin(g * 1.7), medianLap: 60 + Math.sin(g * 2.3) }));
    assert.ok(!find(run(outlier), 'Model zbłądził'), 'one light-fuel record does not make the field look lost');

    assert.equal(find(run(series(15, g => ({ interventionRate: g > 3 ? 0.5 : 0.2 }))), 'Jedzie strażnik, nie sieć')?.since, 4);
    assert.equal(find(run(series(12, g => ({ onlineTrainSteps: g > 6 ? 0 : 50 }))), 'Korekty online stoją')?.since, 7);
    assert.equal(find(run(series(12, () => ({ causes: { steer: 0.2, guard: 0.01, brake: 0.01, launch: 0, clearance: 0.01 } }))), 'Dominuje: korytarz skrętu')?.level, 'info');

    const surge = find(run(series(20, g => g >= 19 ? { crashes: { barrier: 8, car: 1, stuck: 0, 'wrong-way': 0, other: 0 } } : {})), 'Lawina wypadków');
    assert.equal(surge?.since, 19);
    assert.match(surge.detail, /bariery/);
    assert.match(find(run(series(12, () => ({ reverts: 2, personalBests: 0 }))), 'Więcej cofnięć niż rekordów')?.detail, /Obniż mutację/);
    assert.match(find(run(series(12, () => ({ reverts: 2, personalBests: 0, meanMutationRate: 0.025 }))), 'Więcej cofnięć niż rekordów')?.detail, /już niska/);
    assert.ok(!find(run(series(12, () => ({ reverts: 2, personalBests: 2 }))), 'Więcej cofnięć niż rekordów'), 'reverts on a par with personal bests are normal');
    assert.ok(!find(run(series(12, () => ({ cleanLaps: 8, compromisedLaps: 14 }))), 'Nauka na ślepo'), 'traffic compromising most laps is normal');
    assert.equal(find(run(series(12, g => g > 5 ? { cleanLaps: 1, compromisedLaps: 20 } : {})), 'Nauka na ślepo')?.since, 6);
    assert.equal(find(run(series(14, g => ({ personalBests: g > 2 ? 0 : 3 }))), 'Nikt się nie poprawia')?.since, 3);
    assert.ok(find(run(series(31), { islandCount: 2 }), 'Wyspy bez pożytku'));
    assert.ok(!find(run(series(31)), 'Wyspy bez pożytku'), 'no islands, no note about them');

    assert.equal(find(run(series(12, g => ({ diversity: g > 9 ? 0.001 : 0.05 }))), 'Zapaść różnorodności')?.since, 10);
    assert.ok(find(run(series(12, g => ({ diversity: 0.03 - 0.002 * g }))), 'Zmierza do zapaści'));

    const frozen = find(run(series(35, () => ({ meanMutationRate: 0.025 }))), 'Mutacja stoi');
    assert.equal(frozen?.since, 1);
    assert.match(frozen.detail, /minimum/);
    assert.ok(!find(run(series(35)), 'Mutacja stoi'), 'an annealing rate that moves is not stuck');
    assert.equal(find(run(series(12, g => ({ hiddenSaturation: g > 1 ? 0.7 : 0.2 }))), 'Nasycone neurony')?.since, 2);
  }

  // The session log keeps every generation, however long the session.
  {
    const track = Presets.createGrandPrixTrack(14);
    const population = new Population(6, track);
    const s = population.learningStats;
    const generations = 450;
    for (let g = 1; g <= generations; g++) { population.generation = g; s.closeGeneration(population); }
    population.generation = generations + 1;
    assert.ok(s.history.length < generations, 'the chart history is thinned');
    assert.deepEqual(s.fullHistory.map(g => g.generation), Array.from({ length: generations }, (_, i) => i + 1));
    assert.ok(s.fullHistory.every(g => g.drivers.length === 6));
    const view = s.view(population);
    const log = learningLog(view, s.fullHistory, [], { sessionState: 'IDLE', simTime: 0, config: {} });
    const parsed = JSON.parse(stringifyLearningLog(log));
    assert.equal(parsed.type, 'F1_LEARNING_LOG');
    assert.equal(parsed.generations.length, generations);
    assert.deepEqual(parsed.generations[123].drivers.map(d => d.name), s.fullHistory[123].drivers.map(d => d.name));
    for (const key of Object.keys(s.fullHistory[0])) assert.ok(key in log.schema.generation, `schema describes ${key}`);
    for (const key of Object.keys(s.fullHistory[0].drivers[0])) assert.ok(key in log.schema.driver, `schema describes driver ${key}`);
  }

  // Bookkeeping of a real training run on the Grand Prix track.
  {
    const track = Presets.createGrandPrixTrack(14);
    const population = new Population(6, track);
    population.generationTargetLaps = 1;
    let laps = 0;
    const previous = population.onLapCompleted;
    population.onLapCompleted = (car, event) => { laps++; previous?.(car, event); };
    for (let step = 0; step < 60 * 600 && population.generation < 4; step++) population.update(1 / 60, track);
    assert.ok(population.generation >= 4, `training did not reach generation 4 (at ${population.generation})`);
    const view = population.learningStats.view(population);
    assert.equal(view.history.length, population.generation - 1, 'one summary per finished generation');
    assert.deepEqual(view.history.map(g => g.generation), Array.from({ length: view.history.length }, (_, i) => i + 1));
    const counted = [...view.history, view.current].reduce((sum, g) => sum + g.cleanLaps + g.compromisedLaps, 0);
    assert.equal(counted, laps, 'every lap is counted once, clean or compromised');
    assert.ok(view.history.some(g => g.interventionRate !== null && g.interventionRate > 0), 'guardian interventions are measured');
    assert.ok(view.history.every(g => g.interventionRate === null || (g.interventionRate >= 0 && g.interventionRate <= 1)));
    assert.ok(view.history.every(g => g.simSeconds > 0));
    assert.equal(view.drivers.length, 6);
    assert.equal(view.drivers.filter(d => d.champion).length, population.championRecord() ? 1 : 0);
    assert.ok(view.network === null || view.network.layers.length === view.network.layerSizes.length - 1);
    assert.ok(view.verdicts.length >= 1);
    // The panel receives it through postMessage.
    assert.deepEqual(structuredClone(view), view);
    // Closing a generation hands the cars' counters to the summary and starts them again.
    assert.ok(population.cars.every(car => car.aiSteps < population.generationTimer * 60 + 2));
  }

  console.log('Learning stats tests passed.');
} finally {
  await rm(output, { recursive: true, force: true });
}
