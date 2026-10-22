// Display interpolation: jittery worker snapshots must turn into evenly spaced car motion.
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'f1-interp-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: dir, lib: { entry: {
    interp: resolve('src/rendering/MotionInterpolator.ts') },
    formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { MotionInterpolator } = await import(pathToFileURL(join(dir, 'interp.mjs')));

  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const SPEED = 80, STEER_RATE = 0.3, DT = 1 / 60;

  /**
   * Worker ticks every ~16 ms with timer jitter, steps fixed 1/60 s physics, display runs at 144 Hz.
   * The car drives on while the road wheels steer in at a steady rate.
   */
  function run(interpolate) {
    const motion = new MotionInterpolator();
    const car = { pos: { x: 0, y: 0 }, heading: 0, pitch: 0, roll: 0, heave: 0, wheelAngle: 0 };
    let simX = 0, simTime = 0, acc = 0, nextTick = 0, lastTick = 0, shown = car.pos.x, shownWheel = car.wheelAngle;
    const steps = [], wheelSteps = [];
    for (let now = 0; now < 4000; now += 1000 / 144) {
      while (nextTick <= now) {
        acc += (nextTick - lastTick) / 1000; lastTick = nextTick;
        while (acc >= DT) { acc -= DT; simX += SPEED * DT; simTime += DT; }
        car.pos.x = simX;
        car.wheelAngle = STEER_RATE * simTime;
        motion.push(simTime, [car], nextTick + random() * 2);
        nextTick += 16 + (random() - 0.5) * 6;
      }
      if (interpolate) motion.apply(now);
      if (now > 1000) { steps.push(car.pos.x - shown); wheelSteps.push(car.wheelAngle - shownWheel); }
      shown = car.pos.x; shownWheel = car.wheelAngle;
    }
    const evenness = list => {
      const mean = list.reduce((a, b) => a + b, 0) / list.length;
      return { mean, worst: Math.max(...list.map(s => Math.abs(s - mean))) / mean };
    };
    return { ...evenness(steps), wheel: evenness(wheelSteps) };
  }

  const raw = run(false), smooth = run(true);
  console.log(`per-frame step deviation: raw ${(raw.worst * 100).toFixed(0)}%, interpolated ${(smooth.worst * 100).toFixed(1)}%`);
  assert.ok(raw.worst > 0.5, 'raw snapshots should stutter in this setup');
  assert.ok(smooth.worst < 0.1, 'interpolated motion should be even');
  assert.ok(Math.abs(smooth.mean - SPEED / 144) / (SPEED / 144) < 0.02, 'interpolated motion keeps the simulation speed');
  // The front wheels turn with the pose, not in jumps at the snapshot rate.
  console.log(`per-frame wheel-angle step deviation: raw ${(raw.wheel.worst * 100).toFixed(0)}%, interpolated ${(smooth.wheel.worst * 100).toFixed(1)}%`);
  assert.ok(raw.wheel.worst > 0.5, 'raw wheel angles should jump in this setup');
  assert.ok(smooth.wheel.worst < 0.1, 'interpolated wheel angle should turn evenly');
  assert.ok(Math.abs(smooth.wheel.mean - STEER_RATE / 144) / (STEER_RATE / 144) < 0.02, 'interpolated wheel angle keeps the steering rate');

  // A respawn jump is shown at once instead of sliding the car across the circuit.
  const motion = new MotionInterpolator();
  const car = { pos: { x: 0, y: 0 }, heading: 0, pitch: 0, roll: 0, heave: 0, wheelAngle: 0 };
  for (let i = 0; i < 10; i++) { car.pos.x = i; car.wheelAngle = 0.3; motion.push(i * DT, [car], i * 16); motion.apply(i * 16 + 8); }
  car.pos.x = 5000; car.wheelAngle = 0; motion.push(10 * DT, [car], 160);
  for (let t = 168; t < 260; t += 8) {
    motion.apply(t);
    assert.ok(car.pos.x < 20 || car.pos.x === 5000, `no sliding across the track (x=${car.pos.x})`);
    assert.ok(car.pos.x < 20 || car.wheelAngle === 0, 'a respawned car shows its new wheel angle at once');
  }
  console.log('interpolation: OK');
} finally {
  await rm(dir, { recursive: true, force: true });
}
