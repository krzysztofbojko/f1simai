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
      network: resolve('src/ai/NeuralNetwork.ts'), presets: resolve('src/track/Presets.ts') },
      formats: ['es'], fileName: (_, name) => name + '.mjs' },
  } });
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const stats = await import(pathToFileURL(join(output, 'stats.mjs')));
  const { NeuralNetwork } = await import(pathToFileURL(join(output, 'network.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));

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
