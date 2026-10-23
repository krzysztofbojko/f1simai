// Race session without the worker: race start, session-best sectors and the classification.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-session-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, emptyOutDir: true, minify: false, lib: { entry: {
    session: resolve('src/race/RaceSession.ts'), population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts'),
    weather: resolve('src/physics/Weather.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { RaceSession } = await import(pathToFileURL(join(dir, 'session.mjs')));
  const { Population } = await import(pathToFileURL(join(dir, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(dir, 'presets.mjs')));
  const { Weather } = await import(pathToFileURL(join(dir, 'weather.mjs')));
  let seed = 321;
  Math.random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };

  const track = Presets.createGrandPrixTrack(14);
  const population = Population.create(track);
  const weather = new Weather('sunny', 7);
  const session = new RaceSession({ population, track, weather, playerCar: null, manualCarColor: null });
  population.onLapCompleted = (car, event) => session.onLapCompleted(car, event);
  const DT = 1 / 60;
  const step = () => {
    const phase = session.beforeStep(DT);
    if (phase !== 'run') return phase;
    population.update(DT, track);
    return session.afterStep() ? 'halt' : 'run';
  };

  // 1. Session-best sectors: only valid sectors count; purple marks the session's fastest.
  const [a, b] = population.cars;
  const sector = (car, gateIndex, sectorTime, valid = true) => {
    car.lastCheckpointDelta = { gateIndex, gateName: `CP ${gateIndex + 1}`, delta: 0, splitTime: sectorTime, sectorTime };
    car.sectorEvent = { gateIndex, sectorTime, splitTime: sectorTime, valid };
    session.recordSector(car);
    return car.lastCheckpointDelta.isPurple;
  };
  assert.equal(sector(a, 1, 20.5), true, 'first valid sector is the session best');
  assert.equal(sector(b, 1, 20.1, false), false, 'an invalid (track limits) sector is never purple');
  assert.equal(session.sessionBestSectors[1], 20.5);
  assert.equal(sector(b, 1, 20.7), false, 'a slower sector is not purple');
  assert.equal(sector(b, 1, 20.2), true, 'a faster valid sector takes the session best');
  assert.equal(session.sessionBestSectors[1], 20.2);
  assert.equal(b.sectorEvent, null, 'the event is taken once');
  session.resetSectors();
  assert.deepEqual(session.sessionBestSectors, [null, null, null, null]);

  // 2. Race start: grid, lights, then the race runs with every car on track.
  session.start({ totalLaps: 10, weatherSeed: 5 });
  assert.equal(session.state, 'GRID_START');
  assert.ok(population.isRaceMode && population.cars.every(c => c.isRaceMode && c.isAlive && c.raceLapsCompleted === 0));
  let lightsSeen = new Set();
  while (session.state === 'GRID_START') { step(); lightsSeen.add(session.startLights); }
  assert.deepEqual([...lightsSeen].sort(), [-1, 0, 1, 2, 3, 4, 5], 'five red lights, then lights out');
  assert.equal(session.state, 'RACING');
  for (let i = 0; i < 60 * 20; i++) step();
  const standings = session.standings();
  assert.equal(standings.length, population.cars.length);
  assert.deepEqual(standings.map(s => s.rank), standings.map((_, i) => i + 1));
  assert.equal(standings[0].gapToLeader, '—');

  // 3. Stop: back to training on the grid.
  session.stop();
  assert.equal(session.state, 'IDLE');
  assert.ok(!population.isRaceMode && population.cars.every(c => !c.isRaceMode && c.isAlive));
  console.log('Race session regressions passed (session-best sectors, start lights, classification, stop).');
} finally {
  await rm(dir, { recursive: true, force: true });
}
