// Race finish: the chequered flag, the winner by race time, lapped finishers, DNFs and the timeout.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-finish-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, emptyOutDir: true, minify: false, lib: { entry: {
    session: resolve('src/race/RaceSession.ts'), population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts'),
    weather: resolve('src/physics/Weather.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { RaceSession } = await import(pathToFileURL(join(dir, 'session.mjs')));
  const { Population } = await import(pathToFileURL(join(dir, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(dir, 'presets.mjs')));
  const { Weather } = await import(pathToFileURL(join(dir, 'weather.mjs')));
  let seed = 4242;
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
  const toLightsOut = laps => {
    session.start({ totalLaps: laps, weatherSeed: 3 });
    while (session.state === 'GRID_START') step();
    assert.equal(session.state, 'RACING');
  };
  // A crossing of the line at race time `time` with `laps` laps done, as LapTiming reports it.
  const cross = (car, laps, time) => {
    car.raceLapsCompleted = laps;
    car.lineCrossingRaceTime = time;
    car.totalRaceTime = time + 0.012;
    session.onLapCompleted(car, { lapTime: 80 });
  };

  // 1. The flag: two cars complete the distance in one step; the smaller race time wins, not the field order.
  toLightsOut(10);
  const [a, b, c, d, e, ...rest] = population.cars;
  cross(a, 10, 800.30);
  cross(b, 10, 800.10);
  cross(c, 9, 800.05);
  session.afterStep();
  assert.equal(session.chequered, true);
  assert.equal(session.winner, b.driverName, 'the winner has the smallest race time at the line');
  assert.ok(a.isFinishedRace && b.isFinishedRace);
  assert.equal(b.totalRaceTime, 800.10, 'the race time stops where the car met the line');
  assert.ok(!c.isFinishedRace, 'a car that met the line just before the winner still has a lap to go');
  assert.equal(session.state, 'RACING', 'the race goes on until the field has crossed the line');

  // 2. Everyone else finishes at the next crossing, lapped cars with their laps; a DNF stays a DNF.
  cross(c, 10, 878.00);
  cross(d, 8, 870.00);
  e.isAlive = false;
  rest.forEach((car, i) => cross(car, 9, 850 + i));
  assert.equal(session.afterStep(), true, 'the race ends once no car is running');
  assert.equal(session.state, 'FINISHED');
  const standings = session.standings();
  const order = standings.map(s => s.driverName);
  assert.deepEqual(order.slice(0, 3), [b.driverName, a.driverName, c.driverName]);
  assert.deepEqual(order.slice(3, 3 + rest.length), rest.map(car => car.driverName), 'one lap down, in the order they crossed');
  assert.equal(order[3 + rest.length], d.driverName, 'two laps down after one lap down');
  assert.equal(order[order.length - 1], e.driverName, 'a DNF is classified last');
  const row = name => standings.find(s => s.driverName === name);
  assert.equal(row(a.driverName).gapToLeader, '+0.20s');
  assert.equal(row(c.driverName).gapToLeader, '+77.90s');
  assert.equal(row(rest[0].driverName).gapToLeader, '+1 OKR');
  assert.equal(row(d.driverName).gapToLeader, '+2 OKR');
  assert.equal(row(e.driverName).gapToLeader, 'DNF');
  assert.ok(row(d.driverName).finished && !row(e.driverName).finished);

  // 3. A car that never reaches the line again: the race ends 1.5 of the winner's last lap after the flag.
  toLightsOut(10);
  const [w, stopped, ...others] = population.cars;
  cross(w, 10, 700);
  w.lastLapTime = 4;
  others.forEach((car, i) => cross(car, 10, 701 + i));
  session.afterStep();
  assert.ok(stopped.isAlive && !stopped.isFinishedRace);
  let after = 1;
  while (!session.afterStep()) after++;
  assert.ok(Math.abs(after * DT - 1.5 * 4) <= DT * 1.5, `ended ${(after * DT).toFixed(2)} s after the flag`);
  assert.equal(session.standings().at(-1).driverName, stopped.driverName, 'not finished: behind every finisher');

  // 4. A real last lap: the whole field drives to the flag; everyone still running crosses the line.
  toLightsOut(10);
  // The two-compound rule already met: a mandatory stop on this lap would end in the pit lane at the timeout.
  for (const car of population.cars) { car.raceLapsCompleted = 9; car.usedCompounds.add('medium').add('hard'); }
  let steps = 0;
  while (session.state === 'RACING' && steps < 60 * 400) { step(); steps++; }
  assert.equal(session.state, 'FINISHED', 'the race ends');
  const field = population.cars;
  const flagTime = Math.min(...field.filter(car => car.raceLapsCompleted >= 10).map(car => car.totalRaceTime));
  const final = session.standings();
  assert.equal(session.winner, final[0].driverName);
  assert.equal(field.find(car => car.driverName === session.winner).totalRaceTime, flagTime, 'P1 has the smallest race time');
  for (const car of field) {
    if (car.isFinishedRace) assert.ok(car.totalRaceTime >= flagTime, 'nobody finishes before the winner');
    else assert.ok(!car.isAlive, `every car still running has taken the flag: ${car.driverName}`);
  }
  const finishers = final.filter(s => s.finished);
  for (let i = 1; i < finishers.length; i++) {
    const prev = finishers[i - 1], cur = finishers[i];
    assert.ok(prev.lapsCompleted > cur.lapsCompleted || (prev.lapsCompleted === cur.lapsCompleted && prev.totalTime <= cur.totalTime), 'finishers by laps, then by race time');
  }
  console.log(`Race finish regressions passed (chequered flag, winner by race time, lapped finishers, DNF, timeout, last lap: ${finishers.length}/${field.length} finished in ${(steps * DT).toFixed(0)} s).`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
