// Single expert-driven car on the GP preset: node scripts/diag-solo.mjs [seconds]
import { build } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-solo-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { car: resolve('src/physics/Car.ts'), presets: resolve('src/track/Presets.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  const { Car } = await import(pathToFileURL(join(output, 'car.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const gp = Presets.createGrandPrixTrack(14);
  const slot = gp.getGridSlot(0);
  const car = new Car(slot.pos, slot.heading, null, '#fff', 'solo', 100, 25);
  car.currentCheckpointIdx = (slot.checkpointIdx + 1) % gp.checkpoints.length;
  car.mistakesEnabled = false; car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1;
  car.rollLapPerformanceVariation = () => {};
  const seconds = Number(process.argv[2] ?? 100);
  for (let i = 0; i < seconds * 60; i++) {
    car.updateSensors(gp);
    const p = car.planDrive(gp);
    const ev = car.updatePhysics(p.expert, 1 / 60, gp);
    if (i % 30 === 0 || !car.isAlive) console.log((i / 60).toFixed(1), 'cp', car.currentCheckpointIdx, 'v', car.speed.toFixed(1), 'lat', car.lateralG.toFixed(2), 'yaw', car.angularVelocity.toFixed(2), 'steer', p.expert.steer.toFixed(2), 'thr', p.expert.throttle.toFixed(2), 'brk', p.expert.brake.toFixed(2), 'skid', car.isSkidding, car.surface, car.eliminationReason ?? '');
    if (ev) console.log('LAP', ev.lapTime.toFixed(2));
    if (!car.isAlive) break;
  }
} finally { await rm(output, { recursive: true, force: true }); }
