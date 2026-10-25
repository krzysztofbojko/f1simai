// Lap and sector timing: crossings are interpolated within the physics step, so a lap time
// does not depend on where the steps fall relative to the line.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-timing-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, emptyOutDir: true, minify: false, lib: { entry: {
    car: resolve('src/physics/Car.ts'), presets: resolve('src/track/Presets.ts'), vector: resolve('src/math/Vector2.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { Car } = await import(pathToFileURL(join(dir, 'car.mjs')));
  const { Presets } = await import(pathToFileURL(join(dir, 'presets.mjs')));
  const { Vector2, lineCrossingT, segmentIntersectionT } = await import(pathToFileURL(join(dir, 'vector.mjs')));

  // 1. Crossing parameters.
  const a = new Vector2(0, 0), b = new Vector2(10, 0), c = new Vector2(2.5, -5), d = new Vector2(2.5, 5);
  assert.equal(segmentIntersectionT(a, b, c, d), 0.25);
  assert.equal(segmentIntersectionT(a, new Vector2(2, 0), c, d), null, 'segments that do not reach each other');
  assert.equal(lineCrossingT(a, new Vector2(2, 0), c, d), 1.25, 'the line beyond the segment');
  assert.equal(lineCrossingT(a, b, new Vector2(0, 1), new Vector2(5, 1)), null, 'parallel lines');

  // 2. A car driven along the centreline at a constant speed: the lap is the track length over the
  // speed, whatever the phase of the 1/60 s steps; sectors add up to the lap.
  const track = Presets.createGrandPrixTrack(14);
  const n = track.points.length;
  const cumulative = [0];
  for (let i = 0; i < n; i++) cumulative.push(cumulative[i] + track.points[i].center.dist(track.points[(i + 1) % n].center));
  const length = cumulative[n];
  const at = s => {
    s = ((s % length) + length) % length;
    let i = 0;
    while (cumulative[i + 1] < s) i++;
    const from = track.points[i].center, to = track.points[(i + 1) % n].center;
    const f = (s - cumulative[i]) / (cumulative[i + 1] - cumulative[i]);
    return { pos: Vector2.lerp(from, to, f), dir: to.sub(from).normalize() };
  };
  const DT = 1 / 60, SPEED = 61.3;
  Car.config.stressLapShare = 0; // a stress lap's sectors never count
  function drive(phase) {
    const start = track.getGridSlot(0);
    const car = new Car(start.pos, start.heading);
    car.reset(start.pos, start.heading, true, (start.checkpointIdx + 1) % n);
    car.mistakesEnabled = false;
    let s = length - 40 + phase * SPEED * DT;
    const laps = [], sectors = [];
    for (let step = 0; step < 3.2 * length / SPEED / DT && laps.length < 2; step++) {
      s += SPEED * DT;
      const { pos, dir } = at(s);
      car.prevPos.set(car.pos.x, car.pos.y);
      car.pos = pos;
      car.heading = dir.heading();
      car.vel = dir.mul(SPEED); car.speed = SPEED;
      car.surfaceFractions = { asphalt: 1, grass: 0, gravel: 0 };
      car.lastStepDt = DT; car.sectorEvent = null;
      car.lapTime += DT; car.totalRaceTime += DT;
      const lap = car.checkTrackProgress(track);
      if (car.sectorEvent) sectors.push(car.sectorEvent);
      if (lap) laps.push({ lap: lap.lapTime, crossing: car.lineCrossingRaceTime });
    }
    return { laps, sectors };
  }
  const expected = length / SPEED;
  const runs = [0, 0.13, 0.5, 0.77, 0.99].map(drive);
  for (const { laps, sectors } of runs) {
    assert.equal(laps.length, 2, 'two laps completed');
    for (const { lap } of laps) assert.ok(Math.abs(lap - expected) < 1e-3, `lap ${lap} vs ${expected}`);
    assert.ok(Math.abs(laps[1].crossing - laps[0].crossing - expected) < 1e-3, 'race time at the line is interpolated too');
    const second = sectors.filter(e => e.splitTime > 0).slice(-4);
    assert.deepEqual(second.map(e => e.gateIndex), [0, 1, 2, 3]);
    assert.ok(second.every(e => e.valid), 'a clean flying lap times every sector');
    const sum = second.reduce((t, e) => t + e.sectorTime, 0);
    assert.ok(Math.abs(sum - laps[1].lap) < 1e-9, 'sectors add up to the lap');
  }
  // Each sector is phase independent as well.
  for (let g = 0; g < 4; g++) {
    const times = runs.map(r => r.sectors.filter(e => e.gateIndex === g).at(-1).sectorTime);
    assert.ok(Math.max(...times) - Math.min(...times) < 1e-3, `sector ${g + 1} spread ${Math.max(...times) - Math.min(...times)}`);
  }
  // The first pass from the grid is not a timed lap: no sector before the line.
  const first = runs[0].sectors[0];
  assert.equal(first.gateIndex, 0, 'first sector is timed only after the line');

  // 3. A stopped car is retired as stuck after the same time at 30, 60 and 120 Hz.
  const plane = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
  for (const hz of [30, 60, 120]) {
    const stopped = new Car(new Vector2(0, 0), 0);
    let steps = 0;
    while (stopped.isAlive && steps < 200 * hz) { stopped.updatePhysics({ throttle: 0, brake: 0, steer: 0 }, 1 / hz, plane); steps++; }
    assert.equal(stopped.eliminationReason, 'stuck');
    assert.ok(Math.abs(steps / hz - Car.STUCK_TIMEOUT) <= 1.5 / hz, `stuck after ${(steps / hz).toFixed(3)} s at ${hz} Hz`);
  }
  console.log(`Timing regressions passed (crossing interpolation, phase-independent laps ±1 ms over 5 phases, sectors, race time at the line, stuck timeout at 30/60/120 Hz): ${expected.toFixed(3)} s`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
