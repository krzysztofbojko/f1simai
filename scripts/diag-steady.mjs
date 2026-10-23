// Steady-state cornering probe of the single-track model: node scripts/diag-steady.mjs
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-steady-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false, lib: { entry: { car: resolve('src/physics/Car.ts'), vector: resolve('src/math/Vector2.ts') }, formats: ['es'], fileName: (_, n) => n + '.mjs' } } });
  const { Car } = await import(pathToFileURL(join(output, 'car.mjs')));
  const { Vector2 } = await import(pathToFileURL(join(output, 'vector.mjs')));
  const track = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
  for (const v of [12, 20, 30, 50, 70]) for (const steer of [0.05, 0.15, 0.3]) {
    const c = new Car(new Vector2(0, 0), 0); c.vel = new Vector2(v, 0); c.speed = v; c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    let log = '';
    for (let i = 0; i < 300; i++) {
      c.framesSinceLastCheckpoint = 0;
      // hold speed roughly with throttle
      c.updatePhysics({ throttle: c.speed < v ? 1 : 0, brake: 0, steer }, 1 / 60, track);
      if (i === 30 || i === 299) log += ` t=${(i / 60).toFixed(1)} yaw=${c.angularVelocity.toFixed(3)} latG=${c.lateralG.toFixed(2)} beta=${Math.atan2(c.vel.dot(Vector2.fromAngle(c.heading).normal()), c.vel.dot(Vector2.fromAngle(c.heading))).toFixed(3)}`;
    }
    const kinYaw = v / 3.6 * Math.tan(steer * 0.4);
    console.log(`v=${v} steer=${steer} kinYaw=${kinYaw.toFixed(3)} (a=${(kinYaw * v / 9.81).toFixed(2)}G)${log} skid=${c.isSkidding} u/o=${c.understeerSlip.toFixed(2)}/${c.oversteerSlip.toFixed(2)}`);
  }
} finally { await rm(output, { recursive: true, force: true }); }
