// The kinematic → dynamic lateral blend (Car.DYNAMIC_FROM to twice that): steady cornering at a held
// speed must not change character across it. The slide flags, the lateral force the brake and lock
// budgets see, the tread heating and the slip angles follow the motion, which barely changes between
// 7.9 and 8.2 m/s, and they agree at 30, 60 and 120 Hz.
// node scripts/test-lateral-blend.mjs [--table]
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const output = await mkdtemp(join(tmpdir(), 'f1-blend-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { car: resolve('src/physics/Car.ts'), vector: resolve('src/math/Vector2.ts') }, formats: ['es'], fileName: (_, n) => n + '.mjs' } } });
  const { Car } = await import(pathToFileURL(join(output, 'car.mjs')));
  const { Vector2 } = await import(pathToFileURL(join(output, 'vector.mjs')));
  const track = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
  const degrees = rad => rad * 180 / Math.PI;

  // Hold the speed (the velocity is rescaled before every step) at a fixed steering command for
  // 1.5 s; the last 0.5 s is the steady state, after the steering lag and the tyre relaxation.
  const corner = (v, steer, dt) => {
    const c = new Car(new Vector2(0, 0), 0);
    c.vel = new Vector2(v, 0); c.speed = v; c.speedKmh = v * 3.6;
    c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    c.setTyreTemps(95);
    const steps = Math.round(1.5 / dt), window = Math.round(0.5 / dt);
    const s = { sliding: 0, skidding: 0, latG: 0, frontInUse: 0, rearInUse: 0, slip: 0, alphaF: 0, alphaR: 0, tread: 0 };
    let treadStart = 0;
    for (let i = 0; i < steps; i++) {
      const m = c.vel.mag(); if (m > 0) c.vel.mulMut(v / m);
      c.speed = v; c.timeSinceCheckpoint = 0;
      if (i === steps - window) treadStart = c.tyreSurfaceTempFront;
      c.updatePhysics({ steer, throttle: 0, brake: 0 }, dt, track);
      if (i < steps - window) continue;
      if (c.isSliding) s.sliding++;
      if (c.isSkidding) s.skidding++;
      s.latG += Math.abs(c.lateralG) / window;
      s.frontInUse += c.frontLateralInUse / window;
      s.rearInUse += c.rearLateralInUse / window;
      s.slip += (c.understeerSlip + c.oversteerSlip) / window;
      s.alphaF = Math.max(s.alphaF, Math.abs(degrees(c.slipAngleFront)));
      s.alphaR = Math.max(s.alphaR, Math.abs(degrees(c.slipAngleRear)));
    }
    s.tread = (c.tyreSurfaceTempFront - treadStart) / 0.5; // °C/s over the window
    s.sliding /= window; s.skidding /= window;
    // The front axle saturates first (its lateral grip is FRONT_GRIP_BIAS of its circle).
    const weight = c.totalMass * Car.GRAVITY, downforce = 0.5 * c.airDensity * c.downforceCoeff * v * v;
    s.availableG = Car.FRONT_GRIP_BIAS * c.baseTireGrip * Math.min(c.tyreGripFront, c.tyreGripRear) * (weight + downforce) / weight;
    return s;
  };

  const speeds = [6, 7, 7.9, 7.95, 8, 8.05, 8.1, 8.2, 9, 10, 11, 12, 14, 16, 18, 20];
  const rates = [1 / 30, 1 / 60, 1 / 120];
  const runs = new Map();
  for (const steer of [0.5, 1.0]) for (const dt of rates) for (const v of speeds) runs.set(`${steer}/${dt}/${v}`, corner(v, steer, dt));
  const at = (steer, dt, v) => runs.get(`${steer}/${dt}/${v}`);
  if (process.argv.includes('--table')) {
    for (const steer of [0.5, 1.0]) console.table(Object.fromEntries(speeds.map(v => { const r = at(steer, 1 / 60, v); return [`${steer} @ ${v}`, Object.fromEntries(Object.entries(r).map(([k, x]) => [k, +x.toFixed(k.includes('InUse') ? 0 : 3)]))]; })));
  }

  const failures = [];
  const check = (ok, message) => { if (!ok) failures.push(message); };
  for (const steer of [0.5, 1.0]) for (const dt of rates) {
    const hz = Math.round(1 / dt);
    for (const v of speeds) {
      const r = at(steer, dt, v);
      // 1. Well inside the grip: no slide, no skid, and both axles below the force peak (~3°).
      if (r.latG < 0.6 * r.availableG) {
        check(r.sliding === 0 && r.skidding === 0, `steer ${steer} ${v} m/s ${hz} Hz: ${r.latG.toFixed(2)} g of ${r.availableG.toFixed(2)} g flagged (slide ${r.sliding.toFixed(2)}, skid ${r.skidding.toFixed(2)})`);
        check(r.alphaF < 3 && r.alphaR < 3, `steer ${steer} ${v} m/s ${hz} Hz: slip angles ${r.alphaF.toFixed(1)}°/${r.alphaR.toFixed(1)}° past the peak at ${r.latG.toFixed(2)} g`);
      }
    }
    // 2. Continuity across DYNAMIC_FROM: the motion barely changes from 7.9 to 8.2 m/s, so neither
    //    do the quantities derived from it (15%, with a floor for values near zero).
    const lo = at(steer, dt, 7.9), hi = at(steer, dt, 8.2);
    const near = (a, b, floor) => Math.abs(a - b) <= 0.15 * Math.max(Math.abs(a), Math.abs(b)) + floor;
    check(near(lo.latG, hi.latG, 0.02), `steer ${steer} ${hz} Hz: lateral g ${lo.latG.toFixed(2)} → ${hi.latG.toFixed(2)}`);
    check(near(lo.frontInUse, hi.frontInUse, 200), `steer ${steer} ${hz} Hz: front force in use ${lo.frontInUse.toFixed(0)} → ${hi.frontInUse.toFixed(0)} N`);
    check(near(lo.rearInUse, hi.rearInUse, 200), `steer ${steer} ${hz} Hz: rear force in use ${lo.rearInUse.toFixed(0)} → ${hi.rearInUse.toFixed(0)} N`);
    check(near(lo.slip, hi.slip, 0.02), `steer ${steer} ${hz} Hz: slip demand ${lo.slip.toFixed(3)} → ${hi.slip.toFixed(3)}`);
    check(near(lo.tread, hi.tread, 0.3), `steer ${steer} ${hz} Hz: front tread ${lo.tread.toFixed(2)} → ${hi.tread.toFixed(2)} °C/s`);
    check(Math.abs(lo.sliding - hi.sliding) <= 0.1, `steer ${steer} ${hz} Hz: slide share ${lo.sliding.toFixed(2)} → ${hi.sliding.toFixed(2)}`);
  }
  // 3. The step rate: the same steady state at 30, 60 and 120 Hz.
  for (const steer of [0.5, 1.0]) for (const v of speeds) {
    const [a, b, c] = rates.map(dt => at(steer, dt, v));
    check(Math.abs(a.latG - c.latG) <= 0.03 + 0.03 * c.latG, `steer ${steer} ${v} m/s: lateral g ${a.latG.toFixed(3)} at 30 Hz, ${c.latG.toFixed(3)} at 120 Hz`);
    check(Math.abs(a.frontInUse - c.frontInUse) <= 300 + 0.08 * c.frontInUse, `steer ${steer} ${v} m/s: front force in use ${a.frontInUse.toFixed(0)} N at 30 Hz, ${c.frontInUse.toFixed(0)} N at 120 Hz`);
    check(Math.abs(b.sliding - c.sliding) <= 0.15, `steer ${steer} ${v} m/s: slide share ${b.sliding.toFixed(2)} at 60 Hz, ${c.sliding.toFixed(2)} at 120 Hz`);
  }
  assert.ok(failures.length === 0, `${failures.length} blend checks failed:\n  ${failures.join('\n  ')}`);
  const r = at(1.0, 1 / 60, 8.1);
  console.log(`Lateral blend checks passed (steady cornering 6–20 m/s at 30/60/120 Hz; full lock at 8.1 m/s: ${r.latG.toFixed(2)} g, front ${(r.frontInUse / 1000).toFixed(2)} kN in use, slip ${r.slip.toFixed(3)}, tread ${r.tread.toFixed(1)} °C/s).`);
} finally { await rm(output, { recursive: true, force: true }); }
