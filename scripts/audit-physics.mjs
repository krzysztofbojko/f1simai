// Reproducible numerical probes; no application sources are modified.
// Run: node scripts/audit-physics.mjs
import { build } from 'vite';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const output = await mkdtemp(join(tmpdir(), 'f1-physics-'));
try {
  await build({ configFile: false, logLevel: 'silent', plugins: [{ name: 'audit-worker-access', transform(code, id) { if (id.endsWith('/src/workers/sim.worker.ts')) return code + '\nexport function auditCars() { return population.cars; } export function auditRace() { return { raceState, raceWinner }; }'; } }], build: {
    outDir: output, emptyOutDir: true, minify: false,
    lib: { entry: { car: resolve('src/physics/Car.ts'), population: resolve('src/ai/Population.ts'), presets: resolve('src/track/Presets.ts'), worker: resolve('src/workers/sim.worker.ts') }, formats: ['es'], fileName: (_, name) => name + '.mjs' },
  } });
  // Stable neural initialization and variations make the integration probe repeatable.
  let randomState = 123456789;
  Math.random = () => { randomState = (Math.imul(1664525, randomState) + 1013904223) >>> 0; return randomState / 4294967296; };
  const { Car } = await import(pathToFileURL(join(output, 'car.mjs')));
  const track = { checkpoints: [], timingGates: [], width: 76, isOutOfBounds: () => false };
  const point = { x: 0, y: 0, clone() { return this; } };
  function car(vx = 0, vy = 0) {
    const c = new Car(point, 0);
    // Replace the constructor's position with real vectors from the module.
    c.pos = c.vel.clone(); c.prevPos = c.vel.clone();
    c.vel.set(vx, vy); c.speed = c.vel.mag(); c.speedKmh = c.speed * 3.6;
    c.lapPowerFactor = c.lapGripFactor = c.lapDragFactor = 1;
    return c;
  }
  const idle = { throttle: 0, brake: 0, steer: 0 };
  const results = {};
  const stopped = car();
  for (let i = 0; i < 120; i++) stopped.updatePhysics({ ...idle, brake: 1 }, 1 / 60, track);
  results.brakeAtRest = { speed: stopped.speed, distance: stopped.pos.mag() };
  for (const kmh of [100, 400]) {
    const c = car(kmh / 3.6), m = c.totalMass, v = c.speed;
    const normal = m * Car.GRAVITY + 0.5 * c.airDensity * c.downforceCoeff * v * v;
    c.updatePhysics({ ...idle, brake: 1 }, 1 / 60, track);
    const decel = (v - c.speed) * 60;
    const drag = 0.5 * c.airDensity * c.dragCoeff * v * v;
    results['brake' + kmh] = { decelerationG: decel / Car.GRAVITY,
      inferredTireBrakeToMuFz: (m * decel - drag - 0.012 * normal) / (c.baseTireGrip * normal),
      displayedG: c.longitudinalG };
  }
  for (const vx of [9.9, 10.1]) {
    const c = car(vx); Object.defineProperty(c, 'baseTireGrip', { value: 0 });
    c.updatePhysics({ ...idle, steer: 1 }, 1 / 60, track);
    results['zeroGrip' + vx] = { yawRate: c.angularVelocity, heading: c.heading, displayedLateralG: c.lateralG };
  }
  const sideways = car(0, 50); Object.defineProperty(sideways, 'baseTireGrip', { value: 0 });
  sideways.updatePhysics(idle, 1 / 60, track);
  results.sidewaysZeroGrip = { vx: sideways.vel.x, vy: sideways.vel.y, speed: sideways.speed };
  for (const vy of [-2, 2]) {
    const c = car(30, vy), v = c.speed, mass = c.totalMass;
    const availableG = c.baseTireGrip * (mass * Car.GRAVITY + 0.5 * c.airDensity * c.downforceCoeff * v * v) / (mass * Car.GRAVITY);
    const dragLateralG = -vy * (0.5 * c.airDensity * c.dragCoeff * v) / mass / Car.GRAVITY;
    c.updatePhysics({ ...idle, steer: 0.1 }, 1 / 60, track);
    results['slideTurn' + vy] = { availableG, measuredInitialFrameLateralG: (c.vel.y - vy) * 60 / Car.GRAVITY,
      displayedG: c.lateralG, inferredTireLateralG: (c.vel.y - vy) * 60 / Car.GRAVITY - dragLateralG };
  }
  for (const steer of [-0.1, 0.1]) {
    const c = car(30); c.updatePhysics({ ...idle, steer }, 1 / 60, track);
    results['turn' + steer] = { yawRate: c.angularVelocity, lateralG: c.lateralG, roll: c.rollAngle };
    c.updatePhysics({ ...idle, steer: 0 }, 1 / 60, track);
    results['release' + steer] = { yawRate: c.angularVelocity };
  }
  const stop400 = car(400 / 3.6);
  let elapsed = 0;
  while (stop400.speed > 0.001 && elapsed < 20) {
    stop400.framesSinceLastCheckpoint = 0;
    stop400.updatePhysics({ ...idle, brake: 1 }, 1 / 60, track); elapsed += 1 / 60;
  }
  results.stop400 = { seconds: elapsed, meters: stop400.pos.x };
  const empty = car(10); empty.fuelKg = 0;
  for (let i = 0; i < 18000; i++) {
    empty.framesSinceLastCheckpoint = 0;
    empty.updatePhysics({ ...idle, throttle: 1 }, 1 / 60, track);
  }
  results.emptyTank = { speedKmh: empty.speedKmh, fuelKg: empty.fuelKg, alive: empty.isAlive };
  const pit = car(); pit.fuelKg = 10; pit.isPitting = true; pit.pitTimer = Math.max(3.2, (Car.MAX_FUEL_CAPACITY - pit.fuelKg) / 28);
  for (let i = 0; i < 215; i++) pit.updatePhysics(idle, 1 / 60, track);
  results.pit = { fuelKg: pit.fuelKg, lapTime: pit.lapTime, totalRaceTime: pit.totalRaceTime, pitting: pit.isPitting };
  results.scale14 = Car.getDimensionsForTrackWidth(14);
  results.aero400 = { downforceN: 0.5 * stopped.airDensity * stopped.downforceCoeff * (400 / 3.6) ** 2 };
  const { Population } = await import(pathToFileURL(join(output, 'population.mjs')));
  const { Presets } = await import(pathToFileURL(join(output, 'presets.mjs')));
  const gp = Presets.createGrandPrixTrack(14);
  const population = new Population(10, gp, 25);
  for (let i = 0; i < 18000; i++) {
    const c = population.cars[0], alive = c.isAlive, priorSpeed = c.speed;
    population.update(1 / 60, gp);
    if (process.argv.includes('--debug') && alive && !c.isAlive && i < 1800) console.error(JSON.stringify({i, cp:c.currentCheckpointIdx, cleared:c.checkpointsCleared, x:c.pos.x,y:c.pos.y,heading:c.heading, priorSpeed, curvature:gp.checkpoints[c.currentCheckpointIdx].curvature, ctrl:c.currentControl}));
  }
  results.trainingGP = { globalBestLap: population.globalBestLap, alive: population.aliveCount, generation: population.generation };
  if (process.argv.includes('--test')) {
    const close = (a, b, tolerance = 1e-6) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
    close(results.brakeAtRest.speed, 0); close(results.brakeAtRest.distance, 0);
    for (const kmh of [100, 400]) {
      assert.ok(results['brake' + kmh].inferredTireBrakeToMuFz <= 1 + 1e-6);
      close(results['brake' + kmh].decelerationG, -results['brake' + kmh].displayedG);
    }
    for (const v of [9.9, 10.1]) close(results['zeroGrip' + v].yawRate, 0);
    close(results.sidewaysZeroGrip.vx, 0); assert.ok(results.sidewaysZeroGrip.speed < 50);
    for (const vy of [-2, 2]) {
      const r = results['slideTurn' + vy];
      assert.ok(Math.abs(r.inferredTireLateralG) <= r.availableG + 1e-6);
      close(r.measuredInitialFrameLateralG, r.displayedG);
    }
    assert.ok(results['turn-0.1'].lateralG < 0 && results['turn0.1'].lateralG > 0);
    close(results['turn-0.1'].lateralG, -results['turn0.1'].lateralG);
    assert.ok(results['turn-0.1'].roll < 0 && results['turn0.1'].roll > 0);
    assert.ok(Math.abs(results['release0.1'].yawRate) > 0 && Math.abs(results['release0.1'].yawRate) < results['turn0.1'].yawRate);
    close(results.emptyTank.speedKmh, 0); close(results.emptyTank.fuelKg, 0);
    close(results.pit.fuelKg, Car.MAX_FUEL_CAPACITY);
    close(results.pit.lapTime, results.pit.totalRaceTime); assert.equal(results.pit.pitting, false);
    assert.equal(results.scale14.effectiveTrackWidth, 14);
    assert.ok(results.trainingGP.globalBestLap > 0, 'AI must complete GP laps after physics changes');
    // Combined throttle/brake/steering, including reverse motion and lateral slip.
    for (const vx of [-30, -2, 0, 2, 30, 110]) for (const vy of [-5, 0, 5]) {
      for (const brake of [0, 0.4, 1]) {
        const c = car(vx, vy), before = c.vel.clone(), mass = c.totalMass, speed = c.speed;
        const limit = c.baseTireGrip * (mass * Car.GRAVITY + 0.5 * c.airDensity * c.downforceCoeff * speed ** 2);
        const dragScale = 0.5 * c.airDensity * c.dragCoeff * speed;
        c.updatePhysics({ throttle: 1, brake, steer: 0.3 }, 1 / 60, track);
        const tireFx = mass * (c.vel.x - before.x) * 60 + vx * dragScale;
        const tireFy = mass * (c.vel.y - before.y) * 60 + vy * dragScale;
        assert.ok(Math.hypot(tireFx, tireFy) <= limit + 0.1, 'combined tire force must respect available friction');
      }
    }
    // Brake impulses must stop in either direction and preserve the sign until rest.
    for (const speed of [-10, -0.1, 0.1, 10]) {
      const c = car(speed);
      for (let i = 0; i < 240; i++) {
        c.updatePhysics({ ...idle, brake: 1 }, 1 / 60, track);
        assert.ok(c.vel.x * speed >= -1e-8);
      }
      close(c.speed, 0);
    }
    // A footprint extending outside a 14 m road must be rejected.
    const boundary = { ...track, isOutOfBounds: p => Math.abs(p.y) > 7 };
    const edge = car(); edge.pos.y = 6.5;
    edge.updatePhysics(idle, 1 / 60, boundary); assert.equal(edge.isAlive, false);
    const center = car(); center.updatePhysics(idle, 1 / 60, boundary); assert.equal(center.isAlive, true);
    const savedSelf = globalThis.self, savedInterval = globalThis.setInterval;
    const performanceDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'performance');
    let time = 0, tick;
    try {
      globalThis.self = { postMessage() {} };
      globalThis.setInterval = callback => { tick = callback; return 0; };
      Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => time } });
      const worker = await import(pathToFileURL(join(output, 'worker.mjs')));
      for (const c of worker.auditCars()) { c.isManual = true; c.manualControl = idle; }
      self.onmessage({ data: { type: 'SET_PAUSED', isPaused: false } });
      for (let i = 0; i < 62; i++) { time += 16; tick(); }
      time = 1000; tick(); close(worker.auditCars()[0].timeAlive, 1);
      self.onmessage({ data: { type: 'SET_PAUSED', isPaused: true } });
      time += 10000; tick(); close(worker.auditCars()[0].timeAlive, 1);
      self.onmessage({ data: { type: 'SET_PAUSED', isPaused: false } });
      for (let i = 0; i < 50; i++) { time += 20; tick(); }
      close(worker.auditCars()[0].timeAlive, 2);
      for (const c of worker.auditCars()) c.isManual = false;
      self.onmessage({ data: { type: 'START_RACE', totalLaps: 10 } });
      for (let i = 0; i < 10; i++) assert.equal(worker.auditCars()[i].currentCheckpointIdx, (gp.getGridSlot(i).checkpointIdx + 1) % gp.checkpoints.length);
      self.onmessage({ data: { type: 'SET_SPEED', speed: 100 } });
      for (let i = 0; i < 1000 && worker.auditRace().raceState !== 'FINISHED'; i++) { time += 20; tick(); }
      assert.equal(worker.auditRace().raceState, 'FINISHED');
      assert.ok(!worker.auditRace().raceWinner.startsWith('BRAK'), 'race must produce a finisher');
      const finishTime = worker.auditCars()[0].totalRaceTime;
      time += 20; tick(); close(worker.auditCars()[0].totalRaceTime, finishTime);
      self.onmessage({ data: { type: 'STOP_RACE' } });
      assert.equal(worker.auditRace().raceState, 'IDLE');
    } finally {
      globalThis.self = savedSelf; globalThis.setInterval = savedInterval;
      Object.defineProperty(globalThis, 'performance', performanceDescriptor);
    }
    console.log('Physics regressions passed (forces, telemetry, fuel, pit, scale, footprint, GP training).');
  } else console.log(JSON.stringify(results, null, 2));
} finally { await rm(output, { recursive: true, force: true }); }
