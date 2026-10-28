// Dynamic suspension (heave + pitch): statics, transfer, damping, step-size independence.
// Run: node scripts/test-suspension.mjs
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = await mkdtemp(join(tmpdir(), 'f1-suspension-'));
try {
  await build({ configFile: false, logLevel: 'silent', build: { outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { car: resolve('src/physics/Car.ts'), presets: resolve('src/track/Presets.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' } } });
  let randomState = 123456789;
  Math.random = () => { randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0; return randomState / 4294967296; };
  const { Car } = await import(pathToFileURL(join(output, 'car.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const gp = Presets.createGrandPrixTrack(14);
  const fresh = () => { const c = new Car(gp.startPosition, gp.startAngle); c.resetSuspension(); return c; };
  const run = (c, seconds, dt, load) => { for (let t = 0; t < seconds - 1e-9; t += dt) c.stepSuspension(dt, ...load(t)); };
  const mm = x => +(x * 1000).toFixed(2);

  // At rest the body sits at the static ride heights.
  let c = fresh();
  run(c, 1, 1 / 60, () => [0, 0, 0]);
  assert.ok(Math.abs(c.rideHeightFront - Car.FRH_STATIC) < 1e-9 && Math.abs(c.rideHeightRear - Car.RRH_STATIC) < 1e-9, 'static ride height');

  // Steady downforce compresses each axle by load / stiffness, as the quasi-static model did.
  c = fresh();
  run(c, 3, 1 / 60, () => [6000, 7000, 0]);
  assert.ok(Math.abs(c.rideHeightFront - (Car.FRH_STATIC - 6000 / Car.AXLE_STIFFNESS_FRONT)) < 5e-4, 'front steady compression ' + mm(c.rideHeightFront));
  assert.ok(Math.abs(c.rideHeightRear - (Car.RRH_STATIC - 7000 / Car.AXLE_STIFFNESS_REAR)) < 5e-4, 'rear steady compression ' + mm(c.rideHeightRear));

  // Braking dives the nose and lifts the tail; acceleration squats.
  c = fresh(); run(c, 1, 1 / 60, () => [0, 0, -45]);
  assert.ok(c.rideHeightFront < Car.FRH_STATIC - 0.002 && c.rideHeightRear > Car.RRH_STATIC + 0.001, `brake dive ${mm(c.rideHeightFront)}/${mm(c.rideHeightRear)}`);
  assert.ok(c.pitchAngle === 0 && c.pitch > 0, 'pitch is positive nose-down');
  // Anti-dive keeps 5 g of braking from flattening the floor at top-speed compression.
  assert.ok(Car.FRH_STATIC - c.rideHeightFront < 0.006, 'anti-dive limits dive to ' + mm(Car.FRH_STATIC - c.rideHeightFront) + ' mm');
  c = fresh(); run(c, 1, 1 / 60, () => [0, 0, 12]);
  assert.ok(c.rideHeightFront > Car.FRH_STATIC && c.rideHeightRear < Car.RRH_STATIC, 'acceleration squat');

  // Free vibration decays: the dampers only remove energy.
  c = fresh(); c.heave = 0.012; c.pitch = -0.004;
  const ms = c.totalMass * Car.SPRUNG_MASS_SHARE, a = c.wheelbase * 0.54, b = c.wheelbase * 0.46;
  const energy = () => 0.5 * Car.AXLE_STIFFNESS_FRONT * (c.heave + a * c.pitch) ** 2 + 0.5 * Car.AXLE_STIFFNESS_REAR * (c.heave - b * c.pitch) ** 2
    + 0.5 * ms * c.heaveRate ** 2 + 0.5 * ms * Car.PITCH_INERTIA_FACTOR * c.pitchRate ** 2;
  const e0 = energy(); let peak = 0;
  for (let i = 0; i < 60; i++) { c.stepSuspension(1 / 60, 0, 0, 0); peak = Math.max(peak, energy()); }
  assert.ok(peak <= e0 * 1.02 && energy() < e0 * 0.01, `free vibration decays: peak ${(peak / e0).toFixed(3)}, end ${(energy() / e0).toExponential(1)}`);

  // Sub-stepping makes the response independent of the simulation step.
  const trace = t => [4000 + 2500 * Math.sin(t * 2), 5000 + 3000 * Math.sin(t * 2), t > 1 && t < 1.6 ? -40 : 8];
  const finals = [1 / 30, 1 / 60, 1 / 120].map(dt => { const s = fresh(); run(s, 2, dt, trace); return [s.rideHeightFront, s.rideHeightRear]; });
  for (const f of finals) assert.ok(Math.abs(f[0] - finals[2][0]) < 5e-4 && Math.abs(f[1] - finals[2][1]) < 5e-4, 'step independence ' + finals.map(x => x.map(mm)).join(' | '));

  // Roll: sign follows lateral G, the steady transfer is the whole m·ay·h/t, the front takes ~52%,
  // and a released roll settles (the roll dampers only remove energy).
  c = fresh(); run(c, 2, 1 / 60, () => [0, 0, 0, 30]);
  const total = c.totalMass * 30 * c.cogHeight / c.trackWidthMeters, sum = c.rollTransferFront + c.rollTransferRear;
  assert.ok(c.roll > 0 && Math.abs(sum - total) < total * 0.01, `steady roll transfer ${sum.toFixed(0)} of ${total.toFixed(0)} N`);
  const share = c.rollTransferFront / sum;
  assert.ok(Math.abs(share - 0.52) < 0.02, 'front share of lateral transfer ' + share.toFixed(3));
  assert.ok(c.roll < 0.02, 'roll angle stays small: ' + c.roll.toFixed(4) + ' rad');
  c = fresh(); run(c, 1, 1 / 60, () => [0, 0, 0, -30]); assert.ok(c.roll < 0 && c.rollTransferFront < 0, 'roll follows the sign of lateral G');
  c = fresh(); c.roll = 0.01;
  const rollEnergy = () => 0.5 * (c.rollStiffnessFront + c.rollStiffnessRear) * c.roll ** 2 + 0.5 * c.totalMass * Car.SPRUNG_MASS_SHARE * Car.ROLL_INERTIA_FACTOR * c.rollRate ** 2;
  const r0 = rollEnergy(); let rollPeak = 0;
  for (let i = 0; i < 60; i++) { c.stepSuspension(1 / 60, 0, 0, 0, 0); rollPeak = Math.max(rollPeak, rollEnergy()); }
  assert.ok(rollPeak <= r0 * 1.02 && rollEnergy() < r0 * 0.01, 'roll vibration decays');

  // Plank: a floor forced onto the road is held within a few millimetres; normal top-speed downforce never bottoms.
  c = fresh(); run(c, 2, 1 / 60, () => [30000, 30000, 0]);
  assert.ok(c.plankForce > 0 && c.rideHeightFront > -0.006 && c.rideHeightRear > -0.006, `plank holds the floor: ${mm(c.rideHeightFront)}/${mm(c.rideHeightRear)} mm, ${c.plankForce.toFixed(0)} N`);
  c = fresh(); run(c, 2, 1 / 60, () => [0.46 * 17000, 0.54 * 17000, 0]);
  assert.equal(c.plankForce, 0, 'no bottoming at 340 km/h downforce on smooth asphalt');
  // Off-road bumps shake the car and fade once it is back on the asphalt.
  c = fresh(); c.speed = 30; c.surfaceFractions = { asphalt: 0, kerb: 0, grass: 0, gravel: 1 };
  const heights = []; for (let i = 0; i < 120; i++) { c.stepSuspension(1 / 60, 0, 0, 0, 0); heights.push(c.rideHeightFront); }
  const meanH = heights.reduce((x, y) => x + y) / heights.length, spread = Math.sqrt(heights.reduce((x, y) => x + (y - meanH) ** 2, 0) / heights.length);
  assert.ok(spread > 0.002, 'gravel shakes the ride height: ' + mm(spread) + ' mm rms');
  c.surfaceFractions = { asphalt: 1, kerb: 0, grass: 0, gravel: 0 }; run(c, 2, 1 / 60, () => [0, 0, 0, 0]);
  assert.ok(c.roadFront === 0 && c.roadRear === 0 && Math.abs(c.rideHeightFront - Car.FRH_STATIC) < 1e-4, 'smooth again on asphalt');

  // Full car: heights fall with speed and dive under braking.
  {
    // An open plane (as in audit-physics) so the straight-line run never meets a barrier.
    const plane = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
    const car = new Car({ x: 0, y: 0, clone() { return this; } }, 0);
    car.pos = car.vel.clone(); car.prevPos = car.vel.clone();
    car.vel.set(70, 0); car.speed = 70;
    car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1;
    for (let i = 0; i < 240; i++) car.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, plane);
    const cruise = car.rideHeightFront;
    assert.ok(cruise < Car.FRH_STATIC && car.rideHeightRear < Car.RRH_STATIC, 'downforce compresses the axles at speed');
    let minFront = Infinity;
    for (let i = 0; i < 20; i++) { car.updatePhysics({ throttle: 0, brake: 1, steer: 0 }, 1 / 60, plane); minFront = Math.min(minFront, car.rideHeightFront); }
    assert.ok(car.isAlive && Number.isFinite(car.speed) && minFront < cruise - 0.001, `brake dive at speed: ${mm(cruise)} -> ${mm(minFront)} mm`);
  }
  // A floor pressed onto the road scrubs speed: plank friction acts as extra drag. An extra 30 kN
  // per axle on top of the aero load bottoms the car (the floor-stall model cannot lift it off the
  // road); the same car on its springs alone coasts freely.
  const coast = extra => {
    const plane = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
    const car = new Car({ x: 0, y: 0, clone() { return this; } }, 0);
    car.pos = car.vel.clone(); car.prevPos = car.vel.clone(); car.vel.set(70, 0); car.speed = 70;
    car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1;
    const stepSuspension = car.stepSuspension.bind(car);
    car.stepSuspension = (dt, front, rear, ax, ay) => stepSuspension(dt, front + extra, rear + extra, ax, ay);
    let plank = 0;
    for (let i = 0; i < 60; i++) { car.updatePhysics({ throttle: 0, brake: 0, steer: 0 }, 1 / 60, plane); plank = Math.max(plank, car.plankForce); }
    return { speed: car.speed, plank };
  };
  const scrub = coast(30000), free = coast(0);
  assert.ok(scrub.plank > 0 && free.plank === 0 && scrub.speed < free.speed - 0.5, `plank drag: ${scrub.speed.toFixed(2)} vs ${free.speed.toFixed(2)} m/s`);
  // Porpoising: with the floor working near its stall height the flow hysteresis settles the body
  // into a bounded 3–10 Hz bounce, at any simulation step; a floor clear of the stall runs steady.
  const bounce = (dt, downforceCoeff = 6) => {
    const plane = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
    const car = new Car({ x: 0, y: 0, clone() { return this; } }, 0);
    car.pos = car.vel.clone(); car.prevPos = car.vel.clone();
    car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1; car.downforceCoeff = downforceCoeff;
    const hs = [];
    for (let t = 0; t < 5; t += dt) { car.vel.set(80, 0); car.speed = 80; car.updatePhysics({ throttle: 0, brake: 0, steer: 0 }, dt, plane); if (t > 2) hs.push(car.rideHeightFront); }
    const mean = hs.reduce((x, y) => x + y) / hs.length;
    return { rms: Math.sqrt(hs.reduce((x, y) => x + (y - mean) ** 2, 0) / hs.length), hz: car.porpoisingHz, min: Math.min(...hs), max: Math.max(...hs) };
  };
  for (const dt of [1 / 30, 1 / 60, 1 / 120]) {
    const b = bounce(dt);
    assert.ok(b.rms > 0.001 && b.hz >= 3 && b.hz <= 10 && b.min > -0.006 && b.max < Car.FRH_STATIC, `porpoising at dt ${dt.toFixed(4)}: ${mm(b.rms)} mm rms, ${b.hz} Hz, ${mm(b.min)}..${mm(b.max)} mm`);
  }
  const calm = bounce(1 / 60, 3);
  assert.ok(calm.rms < 1e-4 && calm.hz === 0, 'no bounce with the floor above its stall height');
  // Tyre temperature and wear do not depend on the simulation step: straight, steady corner, braking.
  const planeCar = speed => {
    const car = new Car({ x: 0, y: 0, clone() { return this; } }, 0);
    car.pos = car.vel.clone(); car.prevPos = car.vel.clone(); car.vel.set(speed, 0); car.speed = speed;
    car.lapPowerFactor = car.lapGripFactor = car.lapDragFactor = 1;
    return car;
  };
  const tyrePlane = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
  const tyreRun = (dt, phase) => {
    const car = planeCar(60);
    for (let t = 0; t < 20 - 1e-9; t += dt) {
      const ctrl = phase === 'straight' ? { throttle: 0.6, brake: 0, steer: 0 }
        : phase === 'corner' ? { throttle: 0.45, brake: 0, steer: 0.04 }
        : (t % 4) < 1 ? { throttle: 0, brake: 0.8, steer: 0 } : { throttle: 1, brake: 0, steer: 0 };
      car.timeSinceCheckpoint = 0; // no checkpoints on the open plane
      car.updatePhysics(ctrl, dt, tyrePlane);
    }
    assert.ok(car.isAlive, `tyre run ${phase} at dt ${dt.toFixed(4)} stays alive: ${car.eliminationReason}`);
    return [car.tyreTempFront, car.tyreTempRear, car.tyreWearFront, car.tyreWearRear, car.tyreSurfaceTempFront, car.tyreSurfaceTempRear];
  };
  for (const phase of ['straight', 'corner', 'braking']) {
    const [r30, r60, r120] = [1 / 30, 1 / 60, 1 / 120].map(dt => tyreRun(dt, phase));
    const report = [r30, r60, r120].map(r => `${r[0].toFixed(1)}/${r[1].toFixed(1)}°C tread ${r[4].toFixed(1)}/${r[5].toFixed(1)}°C ${(r[2] * 1000).toFixed(2)}/${(r[3] * 1000).toFixed(2)}‰`).join(' | ');
    if (process.env.VERBOSE) console.log(phase, report);
    for (const r of [r30, r60]) {
      for (const k of [0, 1, 4, 5]) assert.ok(Math.abs(r[k] - r120[k]) < 1.5, `tyre temperature step independence (${phase}): ${report}`);
      for (const k of [2, 3]) assert.ok(Math.abs(r[k] - r120[k]) <= 0.05 * r120[k] + 1e-5, `tyre wear step independence (${phase}): ${report}`);
    }
  }

  // The yaw response to steering (with and without braking) barely depends on the step: the tyres'
  // yaw damping is integrated implicitly.
  for (const ctrl of [{ throttle: 0.3, brake: 0, steer: 0.03 }, { throttle: 0, brake: 0.8, steer: 0.03 }, { throttle: 0.3, brake: 0, steer: 0.1 }]) {
    const runs = [1 / 30, 1 / 60, 1 / 120].map(dt => {
      const car = planeCar(40);
      for (let t = 0; t < 0.5 - 1e-9; t += dt) { car.timeSinceCheckpoint = 0; car.updatePhysics(ctrl, dt, tyrePlane); }
      return car;
    });
    const headings = runs.map(c => c.heading), slips = runs.map(c => c.slipAngleFront);
    assert.ok(Math.max(...headings) - Math.min(...headings) < 0.06 * Math.abs(headings[2]), `yaw step independence ${JSON.stringify(ctrl)}: ${headings.map(h => h.toFixed(4)).join(' / ')} rad`);
    // The relaxed slip angle (a lag of relaxation length / speed) follows the same course at any step.
    assert.ok(slips[2] > 0 && Math.max(...slips) - Math.min(...slips) < 0.1 * slips[2], `front slip angle step independence ${JSON.stringify(ctrl)}: ${slips.map(a => a.toFixed(5)).join(' / ')} rad`);
  }

  // A locked axle's sliding work heats its tread (the discs no longer take it), at any step size.
  // Trail braking on hot discs: the cornering load leaves the fronts too little grip for a full pedal.
  const lockRun = (dt, brake) => {
    const car = planeCar(80);
    car.brakeTempFront = car.brakeTempRear = 600;
    for (let t = 0; t < 1 - 1e-9; t += dt) { car.timeSinceCheckpoint = 0; car.updatePhysics({ throttle: 0.5, brake: 0, steer: 0.06 }, dt, tyrePlane); }
    let locked = 0;
    for (let t = 0; t < 1.2 - 1e-9; t += dt) {
      car.timeSinceCheckpoint = 0;
      car.updatePhysics({ throttle: 0, brake, steer: 0.06 }, dt, tyrePlane);
      if (car.wheelLockFront) locked += dt;
    }
    return { temp: car.tyreTempFront, locked };
  };
  // How long the axle stays locked depends on the lock detector; the heat per locked second must not.
  const lockHeat = Car.LOCKED_TYRE_HEAT;
  const locks = [1 / 30, 1 / 60, 1 / 120].map(dt => {
    Car.LOCKED_TYRE_HEAT = 0; const cold = lockRun(dt, 1);
    Car.LOCKED_TYRE_HEAT = lockHeat; const hot = lockRun(dt, 1);
    return { locked: hot.locked, rate: (hot.temp - cold.temp) / Math.max(1e-9, hot.locked) };
  });
  const lockReport = locks.map(r => `${r.rate.toFixed(1)} K/s over ${r.locked.toFixed(2)} s`).join(' | ');
  assert.ok(locks.every(r => r.locked > 0.3), `full brake in a corner locks the fronts: ${lockReport}`);
  assert.ok(locks[2].rate > 15 && locks[2].rate < 80, `a lock flash-heats the front tread: ${lockReport}`);
  for (const r of locks) assert.ok(Math.abs(r.rate - locks[2].rate) < 0.3 * locks[2].rate, `lock heating step independence: ${lockReport}`);

  // A non-finite value is caught before it reaches the position: the car is retired and respawnable, its state finite.
  for (const poison of [car => { car.heave = NaN; }, car => { car.vel.x = NaN; }, car => { car.angularVelocity = Infinity; }]) {
    const car = planeCar(50), bystander = planeCar(50);
    for (let i = 0; i < 30; i++) { car.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, tyrePlane); bystander.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, tyrePlane); }
    const before = car.pos.clone();
    poison(car);
    car.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, tyrePlane);
    bystander.updatePhysics({ throttle: 1, brake: 0, steer: 0 }, 1 / 60, tyrePlane);
    const finite = [car.pos.x, car.pos.y, car.vel.x, car.vel.y, car.heading, car.angularVelocity, car.heave, car.pitch, car.roll,
      car.rideHeightFront, car.pitchAngle, car.tyreTempFront].every(Number.isFinite);
    assert.ok(finite && !car.isAlive && car.eliminationReason === 'barrier' && car.pos.dist(before) < 1e-9, 'non-finite state is recovered and the car retired');
    assert.ok(bystander.isAlive && Number.isFinite(bystander.speed), 'other cars are unaffected');
  }
  console.log('Suspension: statics, steady compression, dive/squat, damping, step independence, roll transfer, plank contact, off-road bumps, porpoising, full-car dive, tyre step independence and NaN recovery passed.');
} finally { await rm(output, { recursive: true, force: true }); }
